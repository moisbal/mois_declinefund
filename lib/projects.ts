import { supabase } from './supabaseClient';
import type { Database } from '../types/supabase';
import type { UserProfile } from './auth';
import {
  isBusinessType,
  isCustomClassificationMethod,
  type BusinessType,
  type CustomSmallCategorySuggestion,
  type ProjectCategoryMaster,
  type ProjectClassificationDraft,
} from './projectClassification';
import { overlayFundingPosition, type ProjectFundingPosition } from './fundingManagement';
import { getRawProjectSearchTokens } from './presentationLabels';

export type ProjectRow = Database['public']['Tables']['projects']['Row'];
export type AuditLogRow = Database['public']['Tables']['audit_logs']['Row'];
export type AuditActor = Pick<
  Database['public']['Tables']['profiles']['Row'],
  'id' | 'name' | 'login_id' | 'email'
>;
export type ProjectExecUpdate = Pick<ProjectRow, 'id' | 'project_code' | 'exec' | 'rate' | 'alloc' | 'updated_at'>;
export type ProjectClassificationUpdate = Pick<
  ProjectRow,
  'id' | 'project_code' | 'large_category_id' | 'middle_category_id' | 'business_type' | 'updated_at'
>;
export type ProjectWithRegion = ProjectRow & {
  total_budget_text: string | null;
  alloc_text: string | null;
  exec_text: string | null;
  /** True when displayed amounts come from the immutable funding Ledger projection. */
  projection_ready?: boolean;
  /** True whenever a funding wallet exists, including fail-closed projections. */
  ledger_managed?: boolean;
  regions: {
    sido: string | null;
    sigungu: string | null;
    display_name: string | null;
  } | null;
};

export type ProjectFilters = {
  page?: number;
  pageSize?: number;
  year?: number;
  sido?: string;
  sigungu?: string;
  region_type?: string;
  category?: string;
  business_type?: BusinessType;
  query?: string;
};

export type ProjectFilterOptions = {
  yearCounts: Record<number, number>;
  sidos: string[];
  sigungusBySido: Record<string, string[]>;
  regionTypes: string[];
  categories: string[];
};

export const PROJECTS_PAGE_SIZE = 50;

function applyProjectFilters(query: any, filters: ProjectFilters) {
  if (filters.year) {
    query = query.eq('year', filters.year);
  }
  if (filters.sido) {
    query = query.eq('sido', filters.sido);
  }
  if (filters.sigungu) {
    query = query.eq('sigungu', filters.sigungu);
  }
  if (filters.region_type) {
    query = query.eq('region_type', filters.region_type);
  }
  if (filters.category) {
    query = query.eq('category', filters.category);
  }
  if (filters.business_type) {
    query = query.eq('business_type', filters.business_type);
  }
  const displayQuery = filters.query?.trim();
  if (displayQuery) {
    for (const alternatives of getRawProjectSearchTokens(displayQuery)) {
      const clauses = alternatives.flatMap((term) => [
        `project_name.ilike.%${term}%`,
        `fund_project_name.ilike.%${term}%`,
        `detail_project_name.ilike.%${term}%`,
        `project_code.ilike.%${term}%`,
      ]);
      query = query.or(clauses.join(','));
    }
  }
  return query;
}

export async function getProjectsForUser(profile?: UserProfile, filters: ProjectFilters = {}) {
  if (profile?.role === 'local_user' && !profile.region_id) {
    return { data: [] as ProjectWithRegion[], count: 0 };
  }

  const page = filters.page && filters.page > 0 ? filters.page : 1;
  const pageSize = filters.pageSize && filters.pageSize > 0
    ? Math.min(filters.pageSize, PROJECTS_PAGE_SIZE)
    : PROJECTS_PAGE_SIZE;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from('projects')
    .select('*, total_budget_text:total_budget::text, alloc_text:alloc::text, exec_text:exec::text, regions(sido, sigungu, display_name)', { count: 'exact' })
    .is('deleted_at', null)
    .not('project_code', 'is', null)
    .order('year', { ascending: true })
    .order('project_code', { ascending: true });

  if (profile?.role === 'local_user' && profile.region_id) {
    query = query.eq('region_id', profile.region_id);
  }

  query = applyProjectFilters(query, filters);

  const { data, error, count } = await query.range(from, to);
  if (error) {
    throw error;
  }

  const { data: positionData, error: positionError } = await (supabase as any)
    .rpc('get_financial_project_funding_positions', { p_project_id: null });
  if (positionError) throw positionError;
  const positions = (positionData ?? []).map((row: Record<string, unknown>) => ({
    ...row,
    project_id: String(row.project_id),
    ledger_original_allocation: String(row.ledger_original_allocation ?? '0'),
    ledger_adjusted_allocation: String(row.ledger_adjusted_allocation ?? '0'),
    ledger_increase_amount: String(row.ledger_increase_amount ?? '0'),
    ledger_decrease_amount: String(row.ledger_decrease_amount ?? '0'),
    ledger_execution_amount: String(row.ledger_execution_amount ?? '0'),
    ledger_execution_rate: Number(row.ledger_execution_rate ?? 0),
    current_wallet_balance: String(row.current_wallet_balance ?? '0'),
    unclassified_decrease_amount: String(row.unclassified_decrease_amount ?? '0'),
  })) as ProjectFundingPosition[];

  return {
    data: (data as ProjectWithRegion[]).map((project) => overlayFundingPosition(project, positions)),
    count,
  };
}

export async function getProjectSummaryForUser() {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;

  if (sessionError || !accessToken) {
    throw sessionError ?? new Error('로그인 세션을 확인할 수 없습니다.');
  }

  const response = await fetch('/api/projects/summary', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    cache: 'no-store',
  });
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.message ?? '사업 집계를 불러오지 못했습니다.');
  }

  return result as {
    projectCount: number;
    totalBudgetSum: string;
    allocSum: string;
    execSum: string;
    overallRate: number;
  };
}

export async function getProjectCategoryMaster(): Promise<ProjectCategoryMaster> {
  const [largeResult, middleResult, smallResult] = await Promise.all([
    supabase.from('large_categories').select('id, code, name').order('code'),
    supabase.from('middle_categories').select('id, code, name, large_category_id').order('code'),
    supabase
      .from('small_categories')
      .select('id, code, name, large_category_id, middle_category_id')
      .order('code'),
  ]);

  const error = largeResult.error ?? middleResult.error ?? smallResult.error;
  if (error) {
    throw error;
  }

  return {
    largeCategories: largeResult.data ?? [],
    middleCategories: middleResult.data ?? [],
    smallCategories: smallResult.data ?? [],
  };
}

export async function getProjectClassification(projectId: string): Promise<ProjectClassificationDraft> {
  const [projectResult, smallCategoryResult, relatedSmallCategoryResult, customSmallCategoryResult] = await Promise.all([
    (supabase as any)
      .from('projects')
      .select('large_category_id, middle_category_id, primary_small_category_id, business_type')
      .eq('id', projectId)
      .single(),
    supabase
      .from('project_small_categories')
      .select('small_category_id')
      .eq('project_id', projectId)
      .order('small_category_id'),
    (supabase as any)
      .from('project_related_small_categories')
      .select('small_category_id')
      .eq('project_id', projectId)
      .order('small_category_id'),
    supabase
      .from('project_custom_small_categories')
      .select('input_value, normalized_value, large_category_id, middle_category_id, suggested_small_category_id, classification_method, confidence, validation_status')
      .eq('project_id', projectId)
      .neq('validation_status', 'REJECTED')
      .order('normalized_value'),
  ]);

  const error = projectResult.error
    ?? smallCategoryResult.error
    ?? relatedSmallCategoryResult.error
    ?? customSmallCategoryResult.error;
  if (error) {
    throw error;
  }
  if (!projectResult.data) {
    throw new Error('사업 분류 정보를 찾을 수 없습니다.');
  }

  const project = projectResult.data;
  const businessType = project.business_type;
  const primarySmallCategoryId = project.primary_small_category_id
    ?? smallCategoryResult.data?.[0]?.small_category_id
    ?? null;
  const smallCategoryIds = [...new Set([
    ...(primarySmallCategoryId ? [primarySmallCategoryId] : []),
    ...(relatedSmallCategoryResult.data ?? []).map((row: any) => row.small_category_id),
  ])] as string[];
  return {
    largeCategoryId: project.large_category_id,
    middleCategoryId: project.middle_category_id,
    primarySmallCategoryId,
    smallCategoryIds,
    customSmallCategories: (customSmallCategoryResult.data ?? []).flatMap((row) => (
      isCustomClassificationMethod(row.classification_method)
        ? [{
          inputValue: row.input_value,
          normalizedValue: row.normalized_value,
          largeCategoryId: row.large_category_id,
          middleCategoryId: row.middle_category_id,
          suggestedSmallCategoryId: row.suggested_small_category_id,
          classificationMethod: row.classification_method,
          confidence: row.confidence,
          validationStatus: row.validation_status,
        }]
        : []
    )),
    businessType: isBusinessType(businessType) ? businessType : null,
  };
}

export async function getCustomSmallCategorySuggestions(
  inputValue: string,
  largeCategoryId: string | null,
  middleCategoryId: string | null,
): Promise<CustomSmallCategorySuggestion[]> {
  const { data, error } = await supabase.rpc('suggest_custom_small_category', {
    p_input_value: inputValue,
    p_large_category_id: largeCategoryId,
    p_middle_category_id: middleCategoryId,
  });

  if (error) {
    throw error;
  }

  return (data ?? []).flatMap((row: any) => {
    if (!isCustomClassificationMethod(row.classification_method) || row.classification_method === 'MANUAL_CONTEXT') {
      return [];
    }
    return [{
      largeCategoryId: row.large_category_id,
      middleCategoryId: row.middle_category_id,
      smallCategoryId: row.small_category_id,
      largeCategoryName: row.large_category_name,
      middleCategoryName: row.middle_category_name,
      smallCategoryName: row.small_category_name,
      confidence: Number(row.confidence),
      classificationMethod: row.classification_method,
    }];
  });
}

export async function getProjectFilterOptionsForUser(profile?: UserProfile): Promise<ProjectFilterOptions> {
  const emptyOptions: ProjectFilterOptions = {
    yearCounts: {},
    sidos: [],
    sigungusBySido: {},
    regionTypes: [],
    categories: [],
  };

  if (profile?.role === 'local_user' && !profile.region_id) {
    return emptyOptions;
  }

  const { data, error } = await supabase.rpc('get_dashboard_filter_options');
  if (error) {
    throw error;
  }

  const payload = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  const getTextList = (value: unknown) => (
    Array.isArray(value)
      ? value.flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim()] : [])
      : []
  );
  const rawSigungusBySido = payload.sigungus_by_sido;
  const sigungusBySido = rawSigungusBySido
    && typeof rawSigungusBySido === 'object'
    && !Array.isArray(rawSigungusBySido)
    ? Object.fromEntries(Object.entries(rawSigungusBySido).flatMap(([sido, sigungus]) => {
      const normalizedSido = sido.trim();
      return normalizedSido ? [[normalizedSido, getTextList(sigungus)]] : [];
    }))
    : {};
  const rawYearCounts = payload.year_counts;
  const yearCounts: Record<number, number> = {};
  if (rawYearCounts && typeof rawYearCounts === 'object' && !Array.isArray(rawYearCounts)) {
    for (const [year, count] of Object.entries(rawYearCounts)) {
      const parsedYear = Number(year);
      const parsedCount = Number(count);
      if (Number.isInteger(parsedYear) && Number.isFinite(parsedCount) && parsedCount >= 0) {
        yearCounts[parsedYear] = parsedCount;
      }
    }
  }

  return {
    yearCounts,
    sidos: getTextList(payload.sidos),
    sigungusBySido,
    regionTypes: getTextList(payload.region_types),
    categories: getTextList(payload.categories),
  };
}

export async function updateProjectExec(projectId: string, newExec: string, userId: string, profile?: UserProfile) {
  // The RPC derives the audit user from auth.uid(); keep this argument temporarily for caller compatibility.
  void userId;

  if (profile?.role === 'local_user' && !profile.region_id) {
    throw new Error('지역 정보가 없는 사용자는 프로젝트를 수정할 수 없습니다.');
  }
  if (!/^\d+$/.test(newExec)) {
    throw new Error('집행액은 유효한 숫자로 입력해야 합니다.');
  }
  const parsedExec = BigInt(newExec);
  if (parsedExec < BigInt(0)) {
    throw new Error('집행액은 0 이상이어야 합니다.');
  }
  if (parsedExec > BigInt('9223372036854775807')) {
    throw new Error('집행액은 DB bigint 범위 이내로 입력해야 합니다.');
  }

  const { data: updatedProject, error } = await supabase
    .rpc('update_project_exec_with_audit', {
      p_project_id: projectId,
      p_new_exec: newExec,
    })
    .single();

  if (error) {
    throw error;
  }

  if (!updatedProject) {
    throw new Error('수정된 프로젝트 정보를 받지 못했습니다.');
  }

  return updatedProject as ProjectExecUpdate;
}

export async function updateProjectClassification(
  projectId: string,
  classification: ProjectClassificationDraft,
  profile?: UserProfile,
) {
  if (profile?.role === 'local_user' && !profile.region_id) {
    throw new Error('지역 정보가 없는 사용자는 프로젝트를 수정할 수 없습니다.');
  }

  if (
    !classification.largeCategoryId
    || !classification.middleCategoryId
    || !classification.primarySmallCategoryId
    || !classification.businessType
    || classification.smallCategoryIds.length === 0
  ) {
    throw new Error('대표 소분류, 관련 소분류, 사업유형을 확인하세요.');
  }

  const [projectResult, relatedResult] = await Promise.all([
    supabase.from('projects')
      .select('detail_project_name, fund_project_name, project_name, project_period, period, project_start_year, year, status')
      .eq('id', projectId)
      .single(),
    supabase.from('project_related_projects')
      .select('project_name, total_budget, regional_fund_alloc, local_fund_alloc')
      .eq('project_id', projectId),
  ]);
  const readError = projectResult.error ?? relatedResult.error;
  if (readError) throw readError;
  const project = projectResult.data;
  if (!project) throw new Error('사업정보를 찾을 수 없습니다.');

  const { data, error } = await (supabase as any)
    .rpc('update_my_project_metadata_v2', {
      p_project_id: projectId,
      p_detail_project_name: project.detail_project_name?.trim()
        || project.fund_project_name?.trim()
        || project.project_name?.trim(),
      p_project_period: project.project_period?.trim() || project.period?.trim() || '기간 미입력',
      p_project_start_year: project.project_start_year ?? project.year,
      p_status: project.status ?? '정상추진',
      p_related_projects: (relatedResult.data ?? []).map((row) => ({
        project_name: row.project_name,
        total_budget: String(row.total_budget ?? 0),
        regional_fund_alloc: String(row.regional_fund_alloc ?? 0),
        local_fund_alloc: String(row.local_fund_alloc ?? 0),
      })),
      p_primary_small_category_id: classification.primarySmallCategoryId,
      p_related_small_category_ids: classification.smallCategoryIds.filter(
        (id) => id !== classification.primarySmallCategoryId,
      ),
      p_business_type: classification.businessType,
      p_change_basis_code: null,
      p_other_basis: null,
      p_change_reason_codes: [],
      p_other_reason: null,
      p_change_detail: null,
      p_similarity_candidate: false,
      p_save_mode: 'SAVE',
    })
    .single();

  if (error) {
    throw error;
  }
  if (!data) {
    throw new Error('수정된 사업 분류 정보를 받지 못했습니다.');
  }

  return {
    ...(data as ProjectClassificationUpdate),
    large_category_id: classification.largeCategoryId,
    middle_category_id: classification.middleCategoryId,
    business_type: classification.businessType,
  };
}

export async function getProjectChangeLogs(projectId: string) {
  const { data, error } = await supabase
    .from('audit_logs')
    .select('*')
    .eq('project_id', projectId)
    .order('changed_at', { ascending: false });

  if (error) {
    throw error;
  }

  return data as AuditLogRow[];
}

export async function getAuditActors(actorIds: string[]) {
  const ids = [...new Set(actorIds.filter((id) => id.trim() !== ''))];
  if (!ids.length) return [] as AuditActor[];

  const { data, error } = await supabase
    .from('profiles')
    .select('id, name, login_id, email')
    .in('id', ids);

  if (error) {
    throw error;
  }

  return (data ?? []) as AuditActor[];
}
