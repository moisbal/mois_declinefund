import { supabase } from './supabaseClient';
import type { UserProfile } from './auth';
import type { Database } from '../types/supabase';
import type { ProjectClassificationDraft } from './projectClassification';
import type { MyProjectEditDraft, RelatedProjectDraft } from './myProjectEdit';
import {
  getProjectReviewDetail,
  type ProjectReviewDetail,
  type ProjectReviewRelatedProject,
} from './projectReview';
import {
  overlayFundingPosition,
  type ProjectFundingPosition,
} from './fundingManagement';
import { getProjectPresentation } from './presentationLabels';
import { requiresExecutionStatusReason } from './myProjectEdit';

type ProjectRow = Database['public']['Tables']['projects']['Row'];

export type MyProjectListItem = ProjectRow & {
  original_alloc_text: string | null;
  increase_amount_text: string | null;
  decrease_amount_text: string | null;
  alloc_text: string | null;
  exec_text: string | null;
};

export type MyProjectDetail = ProjectReviewDetail;

export type MyProjectFilters = {
  year?: number;
  status?: string;
  query?: string;
};

function assertLocalProjectUser(profile: UserProfile) {
  if (profile.role !== 'local_user' || !profile.region_id) {
    throw new Error('지자체 담당자 계정만 내 사업 관리 화면을 사용할 수 있습니다.');
  }
}

export function getMyProjectDisplayName(project: Pick<
  ProjectRow,
  'detail_project_name' | 'fund_project_name' | 'project_name'
> & Partial<Pick<ProjectRow, 'year' | 'project_code'>>) {
  return getProjectPresentation(project).name;
}

export function getMyProjectPresentation(project: Pick<
  ProjectRow,
  'detail_project_name' | 'fund_project_name' | 'project_name'
> & Partial<Pick<ProjectRow, 'year' | 'project_code' | 'status'>>) {
  return getProjectPresentation(project);
}

export function getProjectLifecycleLabel(project: Pick<ProjectRow, 'year' | 'project_start_year'>) {
  if (project.year === null || project.project_start_year === null) return '구분 미입력';
  return project.project_start_year < project.year ? '계속사업' : '신규사업';
}

function toAmount(value: string | null) {
  return value !== null && /^\d+$/.test(value) ? BigInt(value) : null;
}

export function getProjectAllocationMode(project: Pick<
  MyProjectListItem,
  'original_alloc_text' | 'increase_amount_text' | 'decrease_amount_text'
>) {
  const originalAlloc = toAmount(project.original_alloc_text);
  if (originalAlloc === null) {
    return {
      mode: '조정 정보 미입력',
      amountLabel: '현재 배분액',
    };
  }

  const increaseAmount = toAmount(project.increase_amount_text) ?? BigInt(0);
  const decreaseAmount = toAmount(project.decrease_amount_text) ?? BigInt(0);
  const adjusted = increaseAmount > BigInt(0) || decreaseAmount > BigInt(0);
  return {
    mode: adjusted ? '조정 후 배분' : '당초 배분액(조정 없음)',
    amountLabel: adjusted ? '조정 후 배분액' : '당초 배분액',
  };
}

export async function getMyProjects(
  profile: UserProfile,
  filters: MyProjectFilters = {},
): Promise<MyProjectListItem[]> {
  assertLocalProjectUser(profile);

  const { data, error } = await supabase
    .from('projects')
    .select('*, original_alloc_text:original_alloc::text, increase_amount_text:increase_amount::text, decrease_amount_text:decrease_amount::text, alloc_text:alloc::text, exec_text:exec::text')
    .is('deleted_at', null)
    .eq('region_id', profile.region_id)
    .not('project_code', 'is', null)
    .order('year', { ascending: false })
    .order('project_code', { ascending: true });

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

  const normalizedQuery = filters.query?.trim().toLocaleLowerCase('ko-KR') ?? '';
  return ((data ?? []) as MyProjectListItem[]).map((project) => overlayFundingPosition(project, positions)).filter((project) => {
    if (filters.year && project.year !== filters.year) {
      return false;
    }
    if (filters.status && project.status !== filters.status) {
      return false;
    }
    if (!normalizedQuery) {
      return true;
    }
    return [
      project.project_code,
      project.detail_project_name,
      project.fund_project_name,
      project.project_name,
    ].some((value) => value?.toLocaleLowerCase('ko-KR').includes(normalizedQuery));
  });
}

export async function getMyProjectDetail(
  profile: UserProfile,
  projectId: string,
): Promise<{ project: MyProjectDetail; relatedProjects: ProjectReviewRelatedProject[] }> {
  assertLocalProjectUser(profile);
  return getProjectReviewDetail(profile, projectId);
}

export function toRelatedProjectDrafts(rows: ProjectReviewRelatedProject[]): RelatedProjectDraft[] {
  return rows.map((row) => ({
    clientId: row.id,
    projectName: row.project_name,
    totalBudget: row.total_budget_text,
    regionalFundAlloc: row.regional_fund_alloc_text,
    localFundAlloc: row.local_fund_alloc_text,
  }));
}

export async function saveMyProject(
  profile: UserProfile,
  projectId: string,
  draft: MyProjectEditDraft,
  classification: ProjectClassificationDraft,
  saveMode: 'DRAFT' | 'SAVE',
  similarityCandidate = false,
) {
  assertLocalProjectUser(profile);
  if (
    !classification.largeCategoryId
    || !classification.middleCategoryId
    || !classification.primarySmallCategoryId
    || !classification.businessType
  ) {
    throw new Error('사업분류와 사업유형을 모두 선택하세요.');
  }

  const commonParams = {
      p_project_id: projectId,
      p_detail_project_name: draft.detailProjectName.trim(),
      p_project_period: draft.projectPeriod.trim(),
      p_project_start_year: draft.projectStartYear,
      p_status: draft.status,
      p_execution_status_reason: requiresExecutionStatusReason(draft.status)
        ? draft.executionStatusReason.trim()
        : null,
      p_related_projects: draft.relatedProjects.map((relatedProject) => ({
        project_name: relatedProject.projectName.trim(),
        total_budget: relatedProject.totalBudget,
        regional_fund_alloc: relatedProject.regionalFundAlloc,
        local_fund_alloc: relatedProject.localFundAlloc,
      })),
      p_primary_small_category_id: classification.primarySmallCategoryId,
      p_related_small_category_ids: classification.smallCategoryIds.filter(
        (id) => id !== classification.primarySmallCategoryId,
      ),
      p_business_type: classification.businessType,
      p_change_basis_code: draft.nameChange.basisCode,
      p_other_basis: draft.nameChange.otherBasis.trim() || null,
      p_change_reason_codes: draft.nameChange.reasonCodes,
      p_other_reason: draft.nameChange.otherReason.trim() || null,
      p_change_detail: draft.nameChange.detail.trim() || null,
      p_similarity_candidate: similarityCandidate,
      p_save_mode: saveMode,
  };
  const saveQuery = (supabase as any).rpc('update_my_project_metadata_v4', commonParams);
  const { data, error } = await saveQuery.single();

  if (error) {
    throw error;
  }
  if (!data) {
    throw new Error('저장된 사업 정보를 받지 못했습니다.');
  }

  return { ...(data as {
    id: string;
    project_code: string;
    alloc: number;
    exec: number;
    rate: number;
    updated_at: string;
  }), ledgerManaged: true };
}
