export type WorkspaceProjectStatus = '정상추진' | '지연' | '완료' | '추진곤란' | '미입력';

import { formatProjectName, formatStoredUserText, formatSystemTerm } from './presentationLabels.ts';

export type WorkspaceProject = {
  id: string;
  project_code: string | null;
  year: number | null;
  project_name: string;
  project_period: string | null;
  project_start_year: number | null;
  project_end_year: number | null;
  status: string | null;
  execution_status_reason: string | null;
  business_type: 'HW' | 'SW' | 'COMPOSITE' | null;
  large_category_id: string | null;
  large_category_name: string | null;
  middle_category_id: string | null;
  middle_category_name: string | null;
  primary_small_category_id: string | null;
  small_category_ids: string[];
  small_category_names: string[];
  original_alloc_text: string | null;
  increase_amount_text: string | null;
  decrease_amount_text: string | null;
  alloc_text: string | null;
  exec_text: string | null;
  rate: number | null;
  projection_ready: boolean;
  classification_review_needed: boolean;
  updated_at: string | null;
};

export type WorkspaceProjectFilters = {
  query: string;
  year: string;
  lifecycle: string;
  status: string;
  largeCategoryId: string;
  middleCategoryId: string;
  smallCategoryId: string;
  funding: string;
  completeness: string;
  executionRate: string;
};

export type WorkspaceProjectSort =
  | 'updated'
  | 'year'
  | 'name'
  | 'rate-low'
  | 'allocation-high'
  | 'attention';

export type WorkspaceTab = 'projects' | 'active' | 'completed';

export type WorkspaceUrlState = {
  tab: WorkspaceTab;
  filters: WorkspaceProjectFilters;
  sort: WorkspaceProjectSort;
  page: number;
  pageSize: 20 | 50;
  requestQuery: string;
  requestStatus: string;
  requestYear: string;
  newProject: boolean;
};

export type WorkspaceRequestKind = 'BUDGET_CHANGE' | 'NEW_PROJECT' | 'PENDING_LINK';

export type WorkspaceRequestRow = {
  id: string;
  correlation_id: string | null;
  kind: WorkspaceRequestKind;
  requested_at: string;
  processed_at: string | null;
  fiscal_year: number;
  source_label: string;
  destination_label: string;
  amount: string;
  status: string;
  stage: string;
  rejection_reason: string | null;
  detail_href: string | null;
  can_edit: boolean;
  steps: Array<{ key: string; label: string; occurred_at: string | null; state: 'done' | 'current' | 'blocked' }>;
};

export type WorkspaceRequestGroup = WorkspaceRequestRow & {
  is_completed: boolean;
  raw_row_count: number;
  related_rows: WorkspaceRequestRow[];
};

export const EMPTY_PROJECT_FILTERS: WorkspaceProjectFilters = {
  query: '',
  year: '',
  lifecycle: '',
  status: '',
  largeCategoryId: '',
  middleCategoryId: '',
  smallCategoryId: '',
  funding: '',
  completeness: '',
  executionRate: '',
};

const PROJECT_SORTS = new Set<WorkspaceProjectSort>([
  'updated', 'year', 'name', 'rate-low', 'allocation-high', 'attention',
]);

export function parseWorkspaceSearchParams(params: URLSearchParams): WorkspaceUrlState {
  const tab = params.get('tab');
  const rawSort = params.get('sort');
  return {
    tab: tab === 'active' || tab === 'completed' ? tab : 'projects',
    filters: {
      query: params.get('q') ?? '',
      year: params.get('year') ?? '',
      lifecycle: params.get('lifecycle') ?? '',
      status: params.get('status') ?? '',
      largeCategoryId: params.get('large') ?? '',
      middleCategoryId: params.get('middle') ?? '',
      smallCategoryId: params.get('small') ?? '',
      funding: params.get('funding') ?? '',
      completeness: params.get('info') ?? '',
      executionRate: params.get('rate') ?? '',
    },
    sort: rawSort && PROJECT_SORTS.has(rawSort as WorkspaceProjectSort)
      ? rawSort as WorkspaceProjectSort : 'updated',
    page: Math.max(1, Number(params.get('page') ?? 1) || 1),
    pageSize: Number(params.get('size')) === 50 ? 50 : 20,
    requestQuery: params.get('rq') ?? '',
    requestStatus: params.get('rstatus') ?? '',
    requestYear: params.get('ryear') ?? '',
    newProject: params.get('newProject') === '1',
  };
}

export function buildWorkspaceSearchParams(state: WorkspaceUrlState) {
  const params = new URLSearchParams();
  if (state.tab !== 'projects') params.set('tab', state.tab);
  if (state.filters.query) params.set('q', state.filters.query);
  if (state.filters.year) params.set('year', state.filters.year);
  if (state.filters.lifecycle) params.set('lifecycle', state.filters.lifecycle);
  if (state.filters.status) params.set('status', state.filters.status);
  if (state.filters.largeCategoryId) params.set('large', state.filters.largeCategoryId);
  if (state.filters.middleCategoryId) params.set('middle', state.filters.middleCategoryId);
  if (state.filters.smallCategoryId) params.set('small', state.filters.smallCategoryId);
  if (state.filters.funding) params.set('funding', state.filters.funding);
  if (state.filters.completeness) params.set('info', state.filters.completeness);
  if (state.filters.executionRate) params.set('rate', state.filters.executionRate);
  if (state.sort !== 'updated') params.set('sort', state.sort);
  if (state.page > 1) params.set('page', String(state.page));
  if (state.pageSize !== 20) params.set('size', String(state.pageSize));
  if (state.requestQuery) params.set('rq', state.requestQuery);
  if (state.requestStatus) params.set('rstatus', state.requestStatus);
  if (state.requestYear) params.set('ryear', state.requestYear);
  if (state.newProject) params.set('newProject', '1');
  return params;
}

const PROJECT_STATUSES = new Set(['정상추진', '지연', '완료', '추진곤란']);
const TERMINAL_REQUEST_STATUSES = new Set(['APPLIED', 'LINKED', 'COMPLETED', 'CANCELLED', 'DUPLICATE']);

function amount(value: string | null | undefined) {
  return value !== null && value !== undefined && /^-?\d+$/.test(value) ? BigInt(value) : BigInt(0);
}

function compareBigInt(left: bigint, right: bigint) {
  return left === right ? 0 : left > right ? 1 : -1;
}

export function getWorkspaceProjectStatus(project: Pick<WorkspaceProject, 'status'>): WorkspaceProjectStatus {
  return PROJECT_STATUSES.has(project.status ?? '')
    ? project.status as WorkspaceProjectStatus
    : '미입력';
}

export function getWorkspaceProjectLifecycle(project: Pick<WorkspaceProject, 'year' | 'project_start_year'>) {
  if (project.year === null || project.project_start_year === null) return '미입력';
  return project.project_start_year < project.year ? '계속사업' : '신규사업';
}

export function getProjectInformationIssues(project: WorkspaceProject) {
  const issues: string[] = [];
  if (!project.project_name.trim() || project.project_name === '사업명 미입력') issues.push('사업명');
  if (project.year === null) issues.push('사업연도');
  if (!project.project_period?.trim()) issues.push('사업기간');
  if (project.project_start_year === null || project.project_end_year === null) issues.push('신규/계속 구분');
  if (getWorkspaceProjectStatus(project) === '미입력') issues.push('집행상태');
  if (!project.large_category_id) issues.push('대분류');
  if (!project.middle_category_id) issues.push('중분류');
  if (!project.primary_small_category_id && project.small_category_ids.length === 0) issues.push('소분류');
  if (!project.business_type) issues.push('사업유형');
  if (project.original_alloc_text === null) issues.push('당초 배분액');
  if (project.alloc_text === null) issues.push('조정 후 배분액');
  if (project.exec_text === null) issues.push('집행액');
  return issues;
}

export function getProjectAttentionCount(project: WorkspaceProject) {
  return getProjectInformationIssues(project).length
    + (project.classification_review_needed ? 1 : 0)
    + (!project.projection_ready ? 1 : 0)
    + (['지연', '추진곤란'].includes(getWorkspaceProjectStatus(project)) ? 1 : 0);
}

export function getExecutionRateLabel(project: Pick<WorkspaceProject, 'year' | 'exec_text' | 'rate'>, currentYear: number) {
  if ((project.year ?? 0) > currentYear && amount(project.exec_text) === BigInt(0)) return '집행 전';
  return `${(project.rate ?? 0).toFixed(1)}%`;
}

function matchesExecutionRate(project: WorkspaceProject, filter: string, currentYear: number) {
  const rate = project.rate ?? 0;
  if (!filter) return true;
  if (filter === 'before') return getExecutionRateLabel(project, currentYear) === '집행 전';
  if (filter === '0-25') return rate >= 0 && rate < 25;
  if (filter === '25-50') return rate >= 25 && rate < 50;
  if (filter === '50-75') return rate >= 50 && rate < 75;
  if (filter === '75-100') return rate >= 75 && rate < 100;
  if (filter === '100+') return rate >= 100;
  return true;
}

export function filterWorkspaceProjects(
  projects: WorkspaceProject[],
  filters: WorkspaceProjectFilters,
  currentYear = new Date().getFullYear(),
) {
  const query = filters.query.trim().toLocaleLowerCase('ko-KR');
  return projects.filter((project) => {
    const issues = getProjectInformationIssues(project);
    const lifecycle = getWorkspaceProjectLifecycle(project);
    const status = getWorkspaceProjectStatus(project);
    if (query && ![project.project_code, project.project_name, formatProjectName(project)]
      .some((value) => value?.toLocaleLowerCase('ko-KR').includes(query))) return false;
    if (filters.year && String(project.year ?? '') !== filters.year) return false;
    if (filters.lifecycle && lifecycle !== filters.lifecycle) return false;
    if (filters.status === '지연·추진곤란' && !['지연', '추진곤란'].includes(status)) return false;
    if (filters.status && filters.status !== '지연·추진곤란' && status !== filters.status) return false;
    if (filters.largeCategoryId && project.large_category_id !== filters.largeCategoryId) return false;
    if (filters.middleCategoryId && project.middle_category_id !== filters.middleCategoryId) return false;
    if (filters.smallCategoryId && !project.small_category_ids.includes(filters.smallCategoryId)
        && project.primary_small_category_id !== filters.smallCategoryId) return false;
    if (filters.funding === 'connected' && !project.projection_ready) return false;
    if (filters.funding === 'unconnected' && project.projection_ready) return false;
    if (filters.completeness === 'missing' && issues.length === 0) return false;
    if (filters.completeness === 'complete' && issues.length > 0) return false;
    if (filters.completeness === 'classification' && !project.classification_review_needed) return false;
    if (filters.completeness === 'funding' && project.projection_ready) return false;
    return matchesExecutionRate(project, filters.executionRate, currentYear);
  });
}

export function sortWorkspaceProjects(projects: WorkspaceProject[], sort: WorkspaceProjectSort) {
  return [...projects].sort((left, right) => {
    const leftName = formatProjectName(left);
    const rightName = formatProjectName(right);
    if (sort === 'name') return leftName.localeCompare(rightName, 'ko-KR');
    if (sort === 'rate-low') return (left.rate ?? 0) - (right.rate ?? 0)
      || leftName.localeCompare(rightName, 'ko-KR');
    if (sort === 'allocation-high') return compareBigInt(amount(right.alloc_text), amount(left.alloc_text))
      || leftName.localeCompare(rightName, 'ko-KR');
    if (sort === 'attention') return getProjectAttentionCount(right) - getProjectAttentionCount(left)
      || leftName.localeCompare(rightName, 'ko-KR');
    if (sort === 'year') return (right.year ?? 0) - (left.year ?? 0)
      || leftName.localeCompare(rightName, 'ko-KR');
    return String(right.updated_at ?? '').localeCompare(String(left.updated_at ?? ''))
      || (right.year ?? 0) - (left.year ?? 0)
      || leftName.localeCompare(rightName, 'ko-KR');
  });
}

export function paginateWorkspaceItems<T>(items: T[], page: number, pageSize: number) {
  const safePageSize = pageSize === 50 ? 50 : 20;
  const pageCount = Math.max(1, Math.ceil(items.length / safePageSize));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const start = (safePage - 1) * safePageSize;
  return {
    items: items.slice(start, start + safePageSize),
    page: safePage,
    pageSize: safePageSize,
    pageCount,
    start: items.length === 0 ? 0 : start + 1,
    end: Math.min(start + safePageSize, items.length),
    total: items.length,
  };
}

export function isTerminalRequestStatus(status: string) {
  return TERMINAL_REQUEST_STATUSES.has(status);
}

export function requestStatusLabel(status: string) {
  const labels: Record<string, string> = {
    DRAFT: '임시저장',
    SUBMITTED: '처리대기',
    APPROVED: '반영대기',
    REJECTED: '반려·보완 필요',
    APPLIED: '적용완료',
    LINKED: '연결완료',
    COMPLETED: '처리완료',
    CANCELLED: '취소완료',
    DUPLICATE: '중복 요청 종료',
  };
  return labels[status] ?? formatSystemTerm(status, '상태 확인 필요');
}

function requestStatusPriority(status: string) {
  const priority: Record<string, number> = {
    REJECTED: 60,
    DRAFT: 50,
    SUBMITTED: 40,
    APPROVED: 30,
    APPLIED: 20,
    LINKED: 20,
    COMPLETED: 10,
    CANCELLED: 10,
    DUPLICATE: 10,
  };
  return priority[status] ?? 45;
}

function rowKindPriority(kind: WorkspaceRequestKind) {
  return kind === 'BUDGET_CHANGE' ? 3 : kind === 'NEW_PROJECT' ? 2 : 1;
}

function uniqueSteps(rows: WorkspaceRequestRow[]) {
  const byKey = new Map<string, WorkspaceRequestRow['steps'][number]>();
  for (const row of rows) {
    for (const step of row.steps) {
      const current = byKey.get(step.key);
      if (!current || (current.state !== 'done' && step.state === 'done')) byKey.set(step.key, step);
    }
  }
  return [...byKey.values()];
}

export function groupWorkspaceRequests(rows: WorkspaceRequestRow[]): WorkspaceRequestGroup[] {
  const groups = new Map<string, WorkspaceRequestRow[]>();
  for (const row of rows) {
    const key = row.correlation_id || `${row.kind}:${row.id}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return [...groups.values()].map((relatedRows) => {
    const root = [...relatedRows].sort((left, right) => rowKindPriority(right.kind) - rowKindPriority(left.kind))[0];
    const incomplete = relatedRows.filter((row) => !isTerminalRequestStatus(row.status));
    const representative = [...(incomplete.length ? incomplete : relatedRows)].sort(
      (left, right) => requestStatusPriority(right.status) - requestStatusPriority(left.status)
        || String(right.requested_at).localeCompare(String(left.requested_at)),
    )[0];
    const processedAt = relatedRows.map((row) => row.processed_at).filter((value): value is string => Boolean(value))
      .sort((left, right) => right.localeCompare(left))[0] ?? null;
    return {
      ...root,
      status: representative.status,
      stage: representative.stage,
      rejection_reason: formatStoredUserText(
        relatedRows.find((row) => row.rejection_reason)?.rejection_reason,
        '',
      ) || null,
      processed_at: processedAt,
      can_edit: relatedRows.some((row) => row.can_edit),
      steps: uniqueSteps(relatedRows),
      is_completed: incomplete.length === 0,
      raw_row_count: relatedRows.length,
      related_rows: relatedRows,
    };
  }).sort((left, right) => {
    const dateKey = left.is_completed ? left.processed_at ?? left.requested_at : left.requested_at;
    const rightDateKey = right.is_completed ? right.processed_at ?? right.requested_at : right.requested_at;
    return String(rightDateKey).localeCompare(String(dateKey));
  });
}

export function filterWorkspaceRequests(
  requests: WorkspaceRequestGroup[],
  input: { query?: string; status?: string; year?: string },
) {
  const query = input.query?.trim().toLocaleLowerCase('ko-KR') ?? '';
  return requests.filter((request) => {
    if (input.status && request.status !== input.status) return false;
    if (input.year && String(request.fiscal_year) !== input.year) return false;
    if (query && ![request.source_label, request.destination_label, request.stage, request.rejection_reason]
      .some((value) => value?.toLocaleLowerCase('ko-KR').includes(query))) return false;
    return true;
  });
}

export function buildProjectSummary(projects: WorkspaceProject[]) {
  return {
    total: projects.length,
    missing: projects.filter((project) => getProjectInformationIssues(project).length > 0).length,
    delayed: projects.filter((project) => ['지연', '추진곤란'].includes(getWorkspaceProjectStatus(project))).length,
    classification: projects.filter((project) => project.classification_review_needed).length,
    funding: projects.filter((project) => !project.projection_ready).length,
  };
}
