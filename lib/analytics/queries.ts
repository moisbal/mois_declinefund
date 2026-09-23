import { supabaseAdmin } from '../supabaseAdmin';
import { calculateKpis, getProjectRate, type AnalyticsProjectValue } from './calculations';
import { resolveAnalyticsRegionLabels, type AnalyticsRegionLabels } from './regions';
import { resolveAnalyticsSourcePolicy } from './sourcePolicy';
import {
  overlayAnalyticsFundingPosition,
  type ProjectFundingPosition,
} from '../fundingManagement';
import { chunkPostgrestInValues } from '../postgrest';
import type {
  AnalyticsFilterOptions,
  AnalyticsFilters,
  AnalyticsGroupBy,
  AnalyticsProjectLifecycle,
  AnalyticsResult,
  AnalyticsRow,
  AnalyticsSource,
} from './types';

const PROJECT_PAGE_SIZE = 1000;
const MAX_VISIBLE_GROUP_ROWS = 500;

// The official Legacy dataset has 3,895 projects. These are the three known
// non-official test rows in this environment. This explicit policy deliberately
// does not infer test status from project_code being NULL.
export const EXCLUDED_TEST_PROJECT_IDS = [
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000102',
  '00000000-0000-4000-8000-000000000103',
] as const;

type AnalyticsProfile = {
  id: string;
  role: 'admin' | 'local_user';
  regionId: string | null;
};

type ProjectRecord = AnalyticsProjectValue & {
  id: string;
  projectId: string;
  projectCode: string | null;
  projectName: string | null;
  fundProjectName: string | null;
  detailProjectName: string | null;
  regionId: string;
  sido: string | null;
  sigungu: string | null;
  year: number | null;
  projectStartYear: number | null;
  status: string | null;
  businessType: 'HW' | 'SW' | 'COMPOSITE' | null;
  largeCategoryId: string | null;
  middleCategoryId: string | null;
};

type CategoryData = Pick<AnalyticsFilterOptions, 'largeCategories' | 'middleCategories' | 'smallCategories'>;

function projectName(project: ProjectRecord) {
  return project.detailProjectName?.trim()
    || project.fundProjectName?.trim()
    || project.projectName?.trim()
    || (project.projectCode ? `사업명 확인 필요 (${project.projectCode})` : '사업명 확인 필요');
}

function normalizeProject(
  row: Record<string, unknown>,
  region: AnalyticsRegionLabels | undefined,
): ProjectRecord {
  const labels = resolveAnalyticsRegionLabels({
    sido: typeof row.sido === 'string' ? row.sido : null,
    sigungu: typeof row.sigungu === 'string' ? row.sigungu : null,
  }, region);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    projectCode: typeof row.project_code === 'string' ? row.project_code : null,
    projectName: typeof row.project_name === 'string' ? row.project_name : null,
    fundProjectName: typeof row.fund_project_name === 'string' ? row.fund_project_name : null,
    detailProjectName: typeof row.detail_project_name === 'string' ? row.detail_project_name : null,
    regionId: String(row.region_id),
    sido: labels.sido,
    sigungu: labels.sigungu,
    year: typeof row.year === 'number' ? row.year : null,
    projectStartYear: typeof row.project_start_year === 'number' ? row.project_start_year : null,
    status: typeof row.status === 'string' ? row.status : null,
    businessType: row.business_type === 'HW' || row.business_type === 'SW' || row.business_type === 'COMPOSITE'
      ? row.business_type
      : null,
    largeCategoryId: typeof row.large_category_id === 'string' ? row.large_category_id : null,
    middleCategoryId: typeof row.middle_category_id === 'string' ? row.middle_category_id : null,
    allocText: typeof row.alloc_text === 'string' ? row.alloc_text : null,
    execText: typeof row.exec_text === 'string' ? row.exec_text : null,
    originalAllocText: typeof row.original_alloc_text === 'string' ? row.original_alloc_text : null,
  };
}

export async function authenticateAnalyticsUser(accessToken: string): Promise<AnalyticsProfile> {
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(accessToken);
  if (userError || !userData.user?.id) {
    throw new Error('로그인이 필요합니다.');
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('id, role, region_id')
    .eq('id', userData.user.id)
    .single();
  if (profileError || !profile || (profile.role !== 'admin' && profile.role !== 'local_user')) {
    throw new Error('통계 조회 권한이 없습니다.');
  }
  if (profile.role === 'local_user' && !profile.region_id) {
    throw new Error('지역 정보가 없는 사용자는 통계를 조회할 수 없습니다.');
  }

  return { id: profile.id, role: profile.role, regionId: profile.region_id };
}

async function fetchOfficialProjects(profile: AnalyticsProfile): Promise<ProjectRecord[]> {
  const { data: regionData, error: regionError } = await supabaseAdmin
    .from('regions')
    .select('id, sido, sigungu');
  if (regionError) throw regionError;
  const regions = new Map((regionData ?? []).map((region) => [String(region.id), {
    sido: typeof region.sido === 'string' ? region.sido : null,
    sigungu: typeof region.sigungu === 'string' ? region.sigungu : null,
  }]));

  const projects: ProjectRecord[] = [];
  for (let from = 0; ; from += PROJECT_PAGE_SIZE) {
    let query = supabaseAdmin
      .from('projects')
      .select('id, project_id, project_code, project_name, fund_project_name, detail_project_name, region_id, sido, sigungu, year, project_start_year, status, business_type, large_category_id, middle_category_id, original_alloc_text:original_alloc::text, alloc_text:alloc::text, exec_text:exec::text')
      .is('deleted_at', null)
      .not('id', 'in', `(${EXCLUDED_TEST_PROJECT_IDS.join(',')})`)
      .order('id', { ascending: true });
    if (profile.role === 'local_user' && profile.regionId) {
      query = query.eq('region_id', profile.regionId);
    }
    const { data, error } = await query.range(from, from + PROJECT_PAGE_SIZE - 1);
    if (error) throw error;

    const rows = (data ?? []).map((row) => normalizeProject(
      row as Record<string, unknown>,
      regions.get(String(row.region_id)),
    ));
    if (rows.length > 0) {
      // The service-role client is deliberately scoped to ids obtained from
      // the authorized project query above before reading the projection view.
      const positionPages = await Promise.all(
        chunkPostgrestInValues(rows.map((project) => project.id)).map(async (projectIds) => {
          const { data: positionData, error: positionError } = await supabaseAdmin
            .from('financial_project_funding_positions')
            .select('*')
            .in('project_id', projectIds);
          if (positionError) throw positionError;
          return positionData ?? [];
        }),
      );
      const positions = positionPages.flat().map((row) => ({
        ...row,
        project_id: String(row.project_id),
        region_id: String(row.region_id),
        fiscal_year: Number(row.fiscal_year),
        ledger_original_allocation: String(row.ledger_original_allocation ?? '0'),
        ledger_adjusted_allocation: String(row.ledger_adjusted_allocation ?? '0'),
        ledger_increase_amount: String(row.ledger_increase_amount ?? '0'),
        ledger_decrease_amount: String(row.ledger_decrease_amount ?? '0'),
        ledger_execution_amount: String(row.ledger_execution_amount ?? '0'),
        ledger_execution_rate: Number(row.ledger_execution_rate ?? 0),
        current_wallet_balance: String(row.current_wallet_balance ?? '0'),
        unclassified_decrease_amount: String(row.unclassified_decrease_amount ?? '0'),
        projection_ready: Boolean(row.projection_ready),
      })) as ProjectFundingPosition[];
      projects.push(...rows.map((project) => overlayAnalyticsFundingPosition(project, positions)));
    }
    if (rows.length < PROJECT_PAGE_SIZE) break;
  }
  return projects;
}

async function fetchCategoryData(): Promise<CategoryData> {
  const [largeResult, middleResult, smallResult] = await Promise.all([
    supabaseAdmin.from('large_categories').select('id, name').order('name'),
    supabaseAdmin.from('middle_categories').select('id, name, large_category_id').order('name'),
    supabaseAdmin.from('small_categories').select('id, name, middle_category_id, large_category_id').order('name'),
  ]);
  const error = largeResult.error ?? middleResult.error ?? smallResult.error;
  if (error) throw error;
  return {
    largeCategories: (largeResult.data ?? []).map((row) => ({ id: row.id, name: row.name })),
    middleCategories: (middleResult.data ?? []).map((row) => ({ id: row.id, name: row.name, largeCategoryId: row.large_category_id })),
    smallCategories: (smallResult.data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      middleCategoryId: row.middle_category_id,
      largeCategoryId: row.large_category_id,
    })),
  };
}

async function getSmallCategoryProjectIds(smallCategoryId: string | null) {
  if (!smallCategoryId) return null;
  const { data, error } = await supabaseAdmin
    .from('project_small_categories')
    .select('project_id')
    .eq('small_category_id', smallCategoryId);
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.project_id));
}

function buildOptions(projects: ProjectRecord[], categories: CategoryData): AnalyticsFilterOptions {
  const sidos = [...new Set(projects.flatMap((project) => project.sido ? [project.sido] : []))].sort();
  const sigungusBySido: Record<string, string[]> = {};
  for (const sido of sidos) {
    sigungusBySido[sido] = [...new Set(projects.flatMap((project) => (
      project.sido === sido && project.sigungu ? [project.sigungu] : []
    )))].sort();
  }
  return {
    years: [...new Set(projects.flatMap((project) => Number.isInteger(project.year) ? [project.year!] : []))].sort((a, b) => a - b),
    sidos,
    sigungusBySido,
    statuses: [...new Set(projects.flatMap((project) => project.status?.trim() ? [project.status.trim()] : []))].sort(),
    ...categories,
  };
}

function matchesRateBand(project: ProjectRecord, filters: AnalyticsFilters) {
  if (filters.rateBand === 'all') return true;
  const rate = getProjectRate(project, filters.rateBasis);
  if (rate === null) return false;
  if (filters.rateBand === 'below30') return rate < 30;
  if (filters.rateBand === 'below50') return rate < 50;
  if (filters.rateBand === 'below70') return rate < 70;
  if (filters.rateBand === 'below90') return rate < 90;
  return (filters.rateMin === null || rate >= filters.rateMin)
    && (filters.rateMax === null || rate <= filters.rateMax);
}

function matchesAllocationRange(project: ProjectRecord, filters: AnalyticsFilters) {
  const allocation = project.allocText && /^-?\d+$/.test(project.allocText) ? BigInt(project.allocText) : null;
  if (allocation === null) return false;
  if (filters.allocationMin !== null && allocation < BigInt(filters.allocationMin)) return false;
  if (filters.allocationMax !== null && allocation > BigInt(filters.allocationMax)) return false;
  return true;
}

function projectLifecycle(project: ProjectRecord): Exclude<AnalyticsProjectLifecycle, 'all'> {
  if (project.year !== null && project.projectStartYear !== null) {
    if (project.projectStartYear === project.year) return 'new';
    if (project.projectStartYear < project.year) return 'continuing';
  }
  // Missing or chronologically inconsistent source years are deliberately not
  // guessed as new/continuing, because that would distort the requested totals.
  return 'needs_review';
}

function applyFilters(
  projects: ProjectRecord[],
  filters: AnalyticsFilters,
  profile: AnalyticsProfile,
  smallCategoryProjectIds: Set<string> | null,
) {
  return projects.filter((project) => {
    if (profile.role === 'local_user' && project.regionId !== profile.regionId) return false;
    if (filters.year !== null && project.year !== filters.year) return false;
    if (filters.sido && project.sido !== filters.sido) return false;
    if (filters.sigungu && project.sigungu !== filters.sigungu) return false;
    if (filters.largeCategoryId && project.largeCategoryId !== filters.largeCategoryId) return false;
    if (filters.middleCategoryId && project.middleCategoryId !== filters.middleCategoryId) return false;
    if (filters.projectLifecycle !== 'all' && projectLifecycle(project) !== filters.projectLifecycle) return false;
    if (filters.businessType && project.businessType !== filters.businessType) return false;
    if (filters.status && project.status !== filters.status) return false;
    if (smallCategoryProjectIds && !smallCategoryProjectIds.has(project.id)) return false;
    if (!matchesAllocationRange(project, filters)) return false;
    return matchesRateBand(project, filters);
  });
}

function groupKey(project: ProjectRecord, groupBy: AnalyticsGroupBy) {
  if (groupBy === 'national') return 'national';
  if (groupBy === 'sido') return `sido:${project.sido ?? 'unassigned'}`;
  if (groupBy === 'sigungu') return `sigungu:${project.sido ?? 'unassigned'}:${project.sigungu ?? 'unassigned'}`;
  return `project:${project.id}`;
}

function groupLabel(project: ProjectRecord, groupBy: AnalyticsGroupBy) {
  if (groupBy === 'national') return '전국';
  if (groupBy === 'sido') return project.sido ?? '지역 미분류';
  if (groupBy === 'sigungu') return [project.sido, project.sigungu].filter(Boolean).join(' ') || '지역 미분류';
  return `${project.year ?? '-'} · ${projectName(project)}${project.projectCode && !projectName(project).includes(`(${project.projectCode})`) ? ` (${project.projectCode})` : ''}`;
}

function categoryName(categories: CategoryData, type: 'large' | 'middle', id: string | null) {
  if (!id) return null;
  const list = type === 'large' ? categories.largeCategories : categories.middleCategories;
  return list.find((category) => category.id === id)?.name ?? null;
}

function groupProjects(projects: ProjectRecord[], filters: AnalyticsFilters, categories: CategoryData): AnalyticsRow[] {
  const groups = new Map<string, ProjectRecord[]>();
  for (const project of projects) {
    const key = groupKey(project, filters.groupBy);
    groups.set(key, [...(groups.get(key) ?? []), project]);
  }

  return [...groups.entries()].map(([key, group]) => {
    const first = group[0];
    return {
      key,
      label: groupLabel(first, filters.groupBy),
      sido: first.sido,
      sigungu: first.sigungu,
      projectId: filters.groupBy === 'project' ? first.id : null,
      projectCode: filters.groupBy === 'project' ? first.projectCode : null,
      year: first.year,
      projectName: projectName(first),
      largeCategoryName: categoryName(categories, 'large', first.largeCategoryId),
      middleCategoryName: categoryName(categories, 'middle', first.middleCategoryId),
      businessType: first.businessType,
      status: first.status,
      ...calculateKpis(group, filters.rateBasis),
    };
  }).sort((left, right) => left.label.localeCompare(right.label, 'ko-KR'));
}

async function resolveSource(filters: AnalyticsFilters): Promise<{ source: AnalyticsSource; sourceMessage: string }> {
  if (filters.timeBasis === 'current') {
    return resolveAnalyticsSourcePolicy(filters, null);
  }

  const { data: cutover, error } = await supabaseAdmin
    .from('financial_ledger_cutovers')
    .select('status, operating_start_date')
    .eq('status', 'CONFIRMED')
    .maybeSingle();
  if (error) throw error;

  return resolveAnalyticsSourcePolicy(filters, cutover?.operating_start_date ?? null);
}

export async function getAnalyticsResult(
  filters: AnalyticsFilters,
  profile: AnalyticsProfile,
  visibleRowLimit = MAX_VISIBLE_GROUP_ROWS,
): Promise<AnalyticsResult> {
  const [source, projects, categories, smallCategoryProjectIds] = await Promise.all([
    resolveSource(filters), fetchOfficialProjects(profile), fetchCategoryData(), getSmallCategoryProjectIds(filters.smallCategoryId),
  ]);
  const scopedProjects = profile.role === 'local_user'
    ? projects.filter((project) => project.regionId === profile.regionId)
    : projects;
  const options = buildOptions(scopedProjects, categories);

  if (source.source === 'ledger_not_implemented' || source.source === 'historical_unavailable') {
    return {
      ...source,
      filters,
      options,
      kpis: null,
      rows: [],
      totalGroupCount: 0,
      rowsTruncated: false,
      regionRestricted: profile.role === 'local_user',
    };
  }

  const filteredProjects = applyFilters(scopedProjects, filters, profile, smallCategoryProjectIds);
  const allRows = groupProjects(filteredProjects, filters, categories);
  return {
    ...source,
    filters,
    options,
    kpis: calculateKpis(filteredProjects, filters.rateBasis),
    rows: allRows.slice(0, visibleRowLimit),
    totalGroupCount: allRows.length,
    rowsTruncated: allRows.length > visibleRowLimit,
    regionRestricted: profile.role === 'local_user',
  };
}
