import assert from 'node:assert/strict';
import test from 'node:test';
import { formatIntegerString } from '../../lib/amountFormat.ts';
import {
  buildProjectSummary,
  buildWorkspaceSearchParams,
  EMPTY_PROJECT_FILTERS,
  filterWorkspaceProjects,
  getExecutionRateLabel,
  getProjectInformationIssues,
  groupWorkspaceRequests,
  paginateWorkspaceItems,
  parseWorkspaceSearchParams,
  type WorkspaceProject,
  type WorkspaceRequestRow,
} from '../../lib/myProjectsWorkspace.ts';

function project(overrides: Partial<WorkspaceProject> = {}): WorkspaceProject {
  return {
    id: 'project-a',
    project_code: '2026-A',
    year: 2026,
    project_name: '청년 정착지원 기반사업',
    project_period: '2026.01~2026.12',
    project_start_year: 2026,
    project_end_year: 2026,
    status: '정상추진',
    execution_status_reason: null,
    business_type: 'HW',
    large_category_id: 'large-a',
    large_category_name: '생활인구',
    middle_category_id: 'middle-a',
    middle_category_name: '청년지원',
    primary_small_category_id: 'small-a',
    small_category_ids: ['small-a'],
    small_category_names: ['정착지원'],
    original_alloc_text: '133495175',
    increase_amount_text: '0',
    decrease_amount_text: '0',
    alloc_text: '133495175',
    exec_text: '0',
    rate: 0,
    projection_ready: true,
    classification_review_needed: false,
    updated_at: '2026-09-07T03:00:00.000Z',
    ...overrides,
  };
}

function request(overrides: Partial<WorkspaceRequestRow> = {}): WorkspaceRequestRow {
  return {
    id: 'request-a',
    correlation_id: null,
    kind: 'BUDGET_CHANGE',
    requested_at: '2026-09-07T01:00:00.000Z',
    processed_at: null,
    fiscal_year: 2026,
    source_label: '2026 · A사업',
    destination_label: '2027 · B사업',
    amount: '10000000',
    status: 'SUBMITTED',
    stage: '관리자 승인대기',
    rejection_reason: null,
    detail_href: '/my-projects/project-a/edit',
    can_edit: false,
    steps: [{ key: 'request-a:requested', label: '기존 사업 감액 요청', occurred_at: '2026-09-07T01:00:00.000Z', state: 'done' }],
    ...overrides,
  };
}

test('정보 완결성과 집행상태를 서로 다른 축으로 판정한다', () => {
  const incomplete = project({ project_period: null, project_start_year: null, primary_small_category_id: null, small_category_ids: [] });
  assert.equal(incomplete.status, '정상추진');
  assert.deepEqual(getProjectInformationIssues(incomplete), ['사업기간', '신규/계속 구분', '소분류']);
});

test('미래연도 0원 집행은 지연이 아니라 집행 전으로 표시한다', () => {
  assert.equal(getExecutionRateLabel(project({ year: 2028, exec_text: '0', rate: 0 }), 2026), '집행 전');
  assert.equal(getExecutionRateLabel(project({ year: 2025, exec_text: '0', rate: 0 }), 2026), '0.0%');
});

test('요약 count와 정보 미입력·지연 필터 결과가 일치한다', () => {
  const projects = [
    project(),
    project({ id: 'project-b', project_period: null }),
    project({ id: 'project-c', status: '지연' }),
    project({ id: 'project-d', status: '추진곤란' }),
  ];
  const summary = buildProjectSummary(projects);
  const missing = filterWorkspaceProjects(projects, { ...EMPTY_PROJECT_FILTERS, completeness: 'missing' }, 2026);
  const delayed = filterWorkspaceProjects(projects, { ...EMPTY_PROJECT_FILTERS, status: '지연·추진곤란' }, 2026);
  assert.equal(summary.missing, missing.length);
  assert.equal(summary.delayed, delayed.length);
  assert.deepEqual(delayed.map((item) => item.id), ['project-c', 'project-d']);
});

test('페이지네이션은 전체 count를 유지하고 20건만 반환한다', () => {
  const rows = Array.from({ length: 88 }, (_, index) => index + 1);
  const first = paginateWorkspaceItems(rows, 1, 20);
  const last = paginateWorkspaceItems(rows, 5, 20);
  assert.deepEqual({ total: first.total, start: first.start, end: first.end, count: first.items.length }, { total: 88, start: 1, end: 20, count: 20 });
  assert.deepEqual({ page: last.page, start: last.start, end: last.end, count: last.items.length }, { page: 5, start: 81, end: 88, count: 8 });
});

test('탭·필터·페이지 상태를 URL query parameter로 복원한다', () => {
  const params = buildWorkspaceSearchParams({
    tab: 'active',
    filters: { ...EMPTY_PROJECT_FILTERS, query: '청년', year: '2026', completeness: 'missing' },
    sort: 'attention',
    page: 3,
    pageSize: 50,
    requestQuery: '신규',
    requestStatus: 'pending',
    requestYear: '2027',
    newProject: true,
  });
  const restored = parseWorkspaceSearchParams(params);
  assert.equal(restored.tab, 'active');
  assert.equal(restored.filters.query, '청년');
  assert.equal(restored.filters.completeness, 'missing');
  assert.equal(restored.sort, 'attention');
  assert.equal(restored.page, 3);
  assert.equal(restored.pageSize, 50);
  assert.equal(restored.newProject, true);
});

test('동일 사업명·금액이어도 관계 식별자가 없으면 요청을 병합하지 않는다', () => {
  const rows = [request({ id: 'a' }), request({ id: 'b' })];
  const groups = groupWorkspaceRequests(rows);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((group) => group.raw_row_count === 1));
});

test('명시적인 correlation id가 있는 기술적 행만 하나의 업무사건으로 묶는다', () => {
  const rows = [
    request({ id: 'budget-a', correlation_id: 'workflow-a', status: 'APPLIED', processed_at: '2026-09-07T02:00:00.000Z' }),
    request({ id: 'new-a', correlation_id: 'workflow-a', kind: 'NEW_PROJECT', status: 'SUBMITTED', stage: '신규사업 승인대기' }),
    request({ id: 'same-values-no-link', correlation_id: null }),
  ];
  const groups = groupWorkspaceRequests(rows);
  const linked = groups.find((group) => group.id === 'budget-a');
  assert.equal(groups.length, 2);
  assert.equal(linked?.raw_row_count, 2);
  assert.equal(linked?.is_completed, false);
  assert.equal(linked?.stage, '신규사업 승인대기');
});

test('세부 금액은 반올림 없이 정확한 원 단위 문자열로 표시할 수 있다', () => {
  assert.equal(`${formatIntegerString('133495175')}원`, '133,495,175원');
  assert.equal(`${formatIntegerString('10000000')}원`, '10,000,000원');
  assert.equal(`${formatIntegerString('0')}원`, '0원');
});
