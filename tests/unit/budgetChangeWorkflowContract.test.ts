import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260826000600_budget_change_workflow_delta.sql'), 'utf8');
const localUi = fs.readFileSync(path.join(root, 'components/my-projects/ProjectFundingManagementSection.tsx'), 'utf8');
const sharedNewProjectFields = fs.readFileSync(path.join(root, 'components/my-projects/NewProjectRequestFields.tsx'), 'utf8');
const newProjectUi = fs.readFileSync(path.join(root, 'components/my-projects/NewProjectRequestPanel.tsx'), 'utf8');
const editShell = fs.readFileSync(path.join(root, 'components/my-projects/MyProjectEditShell.tsx'), 'utf8');
const adminUi = fs.readFileSync(path.join(root, 'components/admin/FundingManagementShell.tsx'), 'utf8');
const action = fs.readFileSync(path.join(root, 'app/my-projects/budget-change-actions.ts'), 'utf8');
const positionHotfix = fs.readFileSync(path.join(root, 'supabase/migrations/20260826000700_budget_change_position_hotfix.sql'), 'utf8');
const candidateHotfix = fs.readFileSync(path.join(root, 'supabase/migrations/20260826000800_budget_change_candidate_hotfix.sql'), 'utf8');
const applyHotfix = fs.readFileSync(path.join(root, 'supabase/migrations/20260826000900_budget_change_apply_hotfix.sql'), 'utf8');
const conservationHotfix = fs.readFileSync(path.join(root, 'supabase/migrations/20260827000100_budget_change_conservation_rules_hotfix.sql'), 'utf8');
const yearSearchDelta = fs.readFileSync(path.join(root, 'supabase/migrations/20260827000200_budget_change_year_search_and_increase_source.sql'), 'utf8');
const testUatBootstrap = fs.readFileSync(path.join(root, 'supabase/migrations/20260827000300_test_uat_on_demand_budget_bootstrap.sql'), 'utf8');
const adminWorkflowHotfix = fs.readFileSync(path.join(root, 'supabase/migrations/20260827000500_admin_budget_workflow_uat_hotfix.sql'), 'utf8');
const maxDecreaseGuard = fs.readFileSync(path.join(root, 'supabase/migrations/20260827000600_budget_change_max_decrease_and_same_year_guard.sql'), 'utf8');
const projectChangeAdminUi = fs.readFileSync(path.join(root, 'components/admin/ProjectChangeManagementShell.tsx'), 'utf8');
const projectReviewAdminUi = fs.readFileSync(path.join(root, 'components/admin/ProjectReviewDetailPanel.tsx'), 'utf8');
const presentationLabels = fs.readFileSync(path.join(root, 'lib/presentationLabels.ts'), 'utf8');
const myProjectsUi = fs.readFileSync(path.join(root, 'components/my-projects/MyProjectsShell.tsx'), 'utf8');
const projectTableUi = fs.readFileSync(path.join(root, 'components/dashboard/ProjectTable.tsx'), 'utf8');
const analyticsUi = fs.readFileSync(path.join(root, 'components/analytics/AnalyticsShell.tsx'), 'utf8');
const yangguUat = fs.readFileSync(path.join(root, 'scripts/run-yanggu-budget-change-e2e-uat.cjs'), 'utf8');
const sunchangUat = fs.readFileSync(path.join(root, 'scripts/run-sunchang-mixed-budget-adjustment-uat.cjs'), 'utf8');
const preUserUat = fs.readFileSync(path.join(root, 'scripts/run-pre-user-uat.cjs'), 'utf8');
const adminBudgetWorkflowUat = fs.readFileSync(path.join(root, 'scripts/run-admin-budget-workflow-uat.cjs'), 'utf8');
const budgetWorkflowUat = fs.readFileSync(path.join(root, 'scripts/run-budget-change-workflow-uat.cjs'), 'utf8');
const budgetDraftUat = fs.readFileSync(path.join(root, 'scripts/run-budget-adjustment-draft-upsert-uat.cjs'), 'utf8');
const adminFundingAudit = fs.readFileSync(path.join(root, 'scripts/audit-admin-funding-approval-test.cjs'), 'utf8');
const genericAdjustmentEngine = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260829000100_generic_budget_adjustment_engine.sql'),
  'utf8',
);
const genericAdjustmentTraceHotfix = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260831000100_generic_budget_adjustment_trace_hotfix.sql'),
  'utf8',
);
const genericAdjustmentAmbiguityHotfix = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260831000200_generic_budget_adjustment_ambiguity_hotfix.sql'),
  'utf8',
);
const genericAdjustmentCanonicalDecreaseHotfix = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260831000300_generic_budget_adjustment_canonical_decrease_hotfix.sql'),
  'utf8',
);
const budgetAdjustmentDraftUpsert = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260831000600_budget_adjustment_draft_upsert.sql'),
  'utf8',
);

test('delta는 승인된 TEST ref에 고정된 단일 transaction이고 기존 monetary row를 backfill하지 않는다', () => {
  assert.match(migration, /^begin;/m);
  assert.match(migration, /commit;\s*$/);
  assert.match(migration, /bound_project_ref <> 'reviewtestxxxxxxxxxx'/);
  assert.doesNotMatch(migration, /reviewprodxxxxxxxxxx/);
  assert.doesNotMatch(migration, /update public\.projects|delete from public\.|truncate /i);
  assert.doesNotMatch(migration, /drop table public\.(project_carryovers|financial_unallocated_fund_lots)/i);
});

test('한 요청이 복수 목적지와 maker-checker 상태를 보존한다', () => {
  assert.match(migration, /create table public\.financial_budget_change_requests/);
  assert.match(migration, /create table public\.financial_budget_change_request_lines/);
  assert.match(migration, /line_no integer not null check \(line_no between 1 and 20\)/);
  assert.match(migration, /destination_type in \('EXISTING_PROJECT', 'PENDING_NEW_PROJECT'\)/);
  assert.match(migration, /status in \('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'APPLIED'\)/);
  assert.match(migration, /approved_by <> requested_by/);
  assert.match(migration, /감액액과 목적지 배분 합계의 차액은 0원이어야 합니다/);
});

test('APPLY는 source 감액과 기존사업 증액 또는 예정재원을 같은 함수 transaction에서 물질화한다', () => {
  const apply = migration.slice(
    migration.indexOf('create or replace function public.financial_apply_budget_change_request'),
    migration.indexOf('create or replace function public.financial_request_pending_new_project_link'),
  );
  assert.match(apply, /financial_require_available_amount/);
  assert.match(apply, /insert into public\.project_fund_transfers/);
  assert.match(apply, /insert into public\.financial_unallocated_fund_lots/);
  assert.match(apply, /insert into public\.financial_project_decrease_classifications/g);
  assert.match(apply, /insert into public\.financial_pending_new_project_funds/);
  assert.match(apply, /v_classification_after - v_classification_before <> v_request\.total_amount/);
  assert.match(apply, /'BUDGET_REALLOCATION_APPLIED'/);
  assert.doesNotMatch(apply, /'RETURN'|'MYEONGSI'|'SAGO'/);
});

test('지역 제한과 사업명·사업코드 부분검색을 DB에서 재검증한다', () => {
  assert.match(migration, /v_existing_region <> v_region_id or v_existing_year > v_fiscal_year/);
  assert.match(migration, /projects\.region_id = v_anchor_region/);
  assert.match(migration, /projects\.year <= v_anchor_year/);
  assert.match(migration, /ilike '%' \|\| btrim\(p_search\) \|\| '%'/);
  assert.match(migration, /role = 'admin' or region_id = financial_budget_change_requests\.region_id/);
});

test('신규사업 예정재원은 lot과 1:1이고 연결 시 stock 감소와 destination inflow를 중복 없이 만든다', () => {
  assert.match(migration, /create table public\.financial_pending_new_project_funds/);
  assert.match(migration, /lot_id uuid not null unique/);
  assert.match(migration, /source_line_id uuid not null unique/);
  const link = migration.slice(
    migration.indexOf('create or replace function public.financial_apply_pending_new_project_link'),
    migration.indexOf('create or replace function public.get_financial_budget_change_candidates'),
  );
  assert.match(link, /financial_lock_unallocated_lot_remaining/);
  assert.match(link, /'ALLOCATE_EXISTING_PROJECT', 'NORMAL'/);
  assert.match(link, /set status = 'LINKED'/);
  assert.match(link, /linked_movement_id = v_movement_id/);
  assert.match(link, /return query select v_request\.id, v_request\.status, 0::bigint/);
});

test('새 UI는 예산 영역에서 조정하고 RETURN·이월 생성 action을 노출하지 않는다', () => {
  assert.match(editShell, /const budgetSectionNumber = 4/);
  assert.match(editShell, /<ProjectBudgetSection[\s\S]*<ProjectFundingManagementSection[\s\S]*<\/ProjectBudgetSection>/);
  assert.match(editShell, /ProjectFinancialLedgerSection[\s\S]*embedded/);
  assert.match(editShell, /ProjectChangeHistoryPanel[\s\S]*sectionNumber=\{6\}/);
  assert.match(localUi, /감액액 입력 및 배분/);
  assert.match(localUi, /증액액 입력 및 출처 선택/);
  assert.match(localUi, /증액 재원 출처 선택/);
  assert.match(localUi, /<span>출처 사업<\/span>/);
  assert.match(localUi, /note: 'INCREASE_TARGET'/);
  assert.match(localUi, /기존사업 목적지 추가/);
  assert.match(localUi, /차년도 신규사업 추가/);
  assert.match(localUi, /이 사업에 연결/);
  assert.doesNotMatch(localUi, /returnUnallocatedFundAction|createCarryoverReviewRequestAction|createUnallocatedLotRequestAction/);
  assert.match(localUi, /과거 재원변동 이력/);
  assert.match(adminUi, /필수 검증 후 승인 없이 완료/);
});

test('감액 화면은 복수·혼합 목적지와 미배분 사유를 설명하고 신규사업 공용 form을 재사용한다', () => {
  assert.match(localUi, /기존사업 목적지 추가/);
  assert.match(localUi, /차년도 신규사업 추가/);
  assert.match(localUi, /신규사업 생성/);
  assert.match(localUi, /신규사업 임시저장 및 목적지 연결/);
  assert.match(localUi, /newProjectDraftCompleted/);
  assert.match(localUi, /목적지 배분 합계/);
  assert.match(localUi, /아직 배분할 금액/);
  assert.match(localUi, /추가 배분해야 반영할 수 있습니다/);
  assert.match(localUi, /감액 요청액 전액을 배분했습니다/);
  assert.doesNotMatch(localUi, /미등록 신규사업 직접 입력/);
  assert.match(localUi, /<NewProjectRequestFields/);
  assert.match(newProjectUi, /<NewProjectRequestFields/);
  assert.match(sharedNewProjectFields, /validateNewProjectRequestDraft/);
  assert.match(sharedNewProjectFields, /사업연도/);
  assert.match(sharedNewProjectFields, /사업기간/);
  assert.match(sharedNewProjectFields, /사업유형/);
});

test('최신 TEST delta는 당해·과거연도 검색과 출처 지정 증액을 지역·원자성 규칙 안에서 허용한다', () => {
  assert.match(yearSearchDelta, /^begin;/m);
  assert.match(yearSearchDelta, /commit;\s*$/);
  assert.match(yearSearchDelta, /bound_project_ref <> 'reviewtestxxxxxxxxxx'/);
  assert.match(yearSearchDelta, /projects\.year <= v_anchor_year/);
  assert.match(yearSearchDelta, /p_year is null or projects\.year = p_year/);
  assert.match(yearSearchDelta, /INCREASE_TARGET/);
  assert.match(yearSearchDelta, /v_destination_region <> v_region_id/);
  assert.match(yearSearchDelta, /v_sum <> v_request\.total_amount/);
  assert.doesNotMatch(yearSearchDelta, /update public\.projects|delete from|truncate /i);
});

test('원장 기준잔액이 없는 TEST 사업도 raw 금액을 유지한 채 예산조정을 시작한다', () => {
  assert.match(localUi, /fundingPosition\?\.projection_ready && projectWallets\.length > 0/);
  assert.match(localUi, /runtime\?\.mode === 'TEST' && position\?\.valid_execution === true/);
  assert.match(localUi, /기준재원 자동 연결 준비/);
  assert.match(localUi, /이 거래에 필요한 기준재원만 내부적으로 자동 연결/);
  assert.match(localUi, /value=\{candidate\.project_id\}/);
  assert.doesNotMatch(localUi, /visibleCandidates\.filter\(\(candidate\) => candidate\.source_budget_year_id\)/);
  assert.match(localUi, /disabled=\{!pendingLinkEnabled \|\| linkingId !== null\}/);
  assert.match(editShell, /setLedgerManaged\(position\.projection_ready\)/);
  assert.match(editShell, /if \(!position\.projection_ready\) return/);
});

test('TEST UAT 부트스트랩은 사용 시점에만 기준재원을 만들고 Production에서 닫힌다', () => {
  assert.match(testUatBootstrap, /^begin;/m);
  assert.match(testUatBootstrap, /commit;\s*$/);
  assert.match(testUatBootstrap, /bound_project_ref <> 'reviewtestxxxxxxxxxx'/);
  assert.doesNotMatch(testUatBootstrap, /reviewprodxxxxxxxxxx/);
  assert.match(testUatBootstrap, /create table public\.financial_test_uat_project_bootstraps/);
  assert.match(testUatBootstrap, /create or replace function public\.financial_test_uat_bootstrap_project/);
  assert.match(testUatBootstrap, /'TEST_UAT_BOOTSTRAP'/);
  assert.match(testUatBootstrap, /perform public\.financial_test_uat_bootstrap_project\(v_line\.destination_project_id\)/);
  assert.match(testUatBootstrap, /financial_test_uat_create_budget_change_request/);
  assert.doesNotMatch(testUatBootstrap, /update public\.projects|delete from public\.|truncate /i);
  assert.match(action, /financial_test_uat_save_budget_change_request/);
  assert.match(action, /p_source_project_id: input\.sourceProjectId/);
  assert.match(action, /p_source_budget_year_id: input\.sourceBudgetYearId \?\? null/);
});

test('server action은 service role 없이 사용자 JWT와 TEST target gate를 사용한다', () => {
  assert.match(action, /Authorization: `Bearer \$\{accessToken\}`/);
  assert.match(action, /assertLedgerTestTarget\(\)/);
  assert.doesNotMatch(action, /SERVICE_ROLE|supabaseAdmin/);
});

test('모든 신규 table은 region RLS·RPC-only write이고 anonymous 실행권한이 없다', () => {
  for (const table of [
    'financial_budget_change_requests',
    'financial_budget_change_request_lines',
    'financial_pending_new_project_funds',
    'financial_pending_new_project_link_requests',
  ]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(migration, new RegExp(`alter table public\\.${table} force row level security`));
  }
  assert.match(migration, /revoke all on table[\s\S]+from public, anon, authenticated/);
  assert.doesNotMatch(migration, /grant (insert|update|delete|all) on table[\s\S]+to authenticated/i);
  assert.match(migration, /revoke all on function public\.financial_apply_budget_change_request\(uuid\) from public, anon/);
});

test('후속 position hotfix는 기존 migration을 덮어쓰지 않고 gross 증감액과 공식 산식을 복원한다', () => {
  assert.match(positionHotfix, /bound_project_ref <> 'reviewtestxxxxxxxxxx'/);
  assert.match(positionHotfix, /classified_decrease/);
  assert.match(positionHotfix, /greatest\(position\.classified_decrease, position\.imported_decrease/);
  assert.match(positionHotfix, /gross\.adjusted_amount - gross\.original_amount \+ gross\.gross_decrease/);
  assert.match(positionHotfix, /gross\.adjusted_amount - gross\.execution_amount/);
  assert.doesNotMatch(positionHotfix, /update public\.projects|delete from|truncate /i);
});

test('후속 candidate hotfix는 출력열 이름 충돌 없이 연도·이름·코드 순으로 정렬한다', () => {
  assert.match(candidateHotfix, /bound_project_ref <> 'reviewtestxxxxxxxxxx'/);
  assert.match(candidateHotfix, /order by 2 desc, 4, 3/i);
  assert.match(candidateHotfix, /projects\.year <= v_anchor_year/);
  assert.match(candidateHotfix, /projects\.project_code, ''\) ilike/);
  assert.doesNotMatch(candidateHotfix, /update public\.projects|delete from|truncate /i);
});

test('후속 APPLY hotfix는 반환열 request_id와 요청선 열을 별칭으로 분리한다', () => {
  assert.match(applyHotfix, /bound_project_ref <> 'reviewtestxxxxxxxxxx'/);
  assert.match(applyHotfix, /request_lines\.request_id = v_request\.id/);
  assert.match(applyHotfix, /for update of request_lines/);
  assert.match(applyHotfix, /v_classification_after - v_classification_before <> v_request\.total_amount/);
  assert.doesNotMatch(applyHotfix, /update public\.projects|delete from|truncate /i);
});

test('총량보존 hotfix는 당초 배분액·연도 규칙·신규사업 직접 연결을 강제한다', () => {
  assert.match(conservationHotfix, /^begin;/m);
  assert.match(conservationHotfix, /commit;\s*$/);
  assert.match(conservationHotfix, /projects\.alloc, 0\) \+ coalesce\(projects\.decrease_amount, 0\)[\s\S]*- coalesce\(projects\.increase_amount, 0\)/);
  assert.match(conservationHotfix, /v_year <> v_request\.fiscal_year/);
  assert.match(conservationHotfix, /planned_project_year <> v_request\.fiscal_year \+ 1/);
  assert.match(conservationHotfix, /projects\.year = v_anchor_year/);
  assert.match(conservationHotfix, /financial_validate_budget_change_line_year/);
  assert.match(conservationHotfix, /financial_link_pending_fund_from_new_project/);
  assert.match(conservationHotfix, /pending\.amount = new\.amount/);
  assert.doesNotMatch(conservationHotfix, /update public\.projects|delete from|truncate /i);
});

test('관리자 UAT hotfix는 차년도 신규사업 등록과 재원 연결 승인을 분리한다', () => {
  assert.match(adminWorkflowHotfix, /^begin;/m);
  assert.match(adminWorkflowHotfix, /commit;\s*$/);
  assert.match(adminWorkflowHotfix, /bound_project_ref <> 'reviewtestxxxxxxxxxx'/);
  assert.doesNotMatch(adminWorkflowHotfix, /reviewprodxxxxxxxxxx/);
  assert.match(adminWorkflowHotfix, /v_pending\.planned_project_year <> p_fiscal_year/);
  assert.match(adminWorkflowHotfix, /v_pending\.planned_project_year <> v_request\.fiscal_year/);
  assert.match(adminWorkflowHotfix, /insert into public\.financial_pending_new_project_link_requests/);
  assert.match(adminWorkflowHotfix, /materialized_project_id = v_project_id, materialized_movement_id = null/);
  assert.match(adminWorkflowHotfix, /'financial_amount_effect', 0/);
  assert.doesNotMatch(adminWorkflowHotfix, /update public\.projects\s+set|delete from public\.|truncate /i);
});

test('최대 감액 guard는 TEST에서 부트스트랩 전에 원 단위 미집행액을 검사하고 기존사업을 동일연도로 제한한다', () => {
  assert.match(maxDecreaseGuard, /^begin;/m);
  assert.match(maxDecreaseGuard, /commit;\s*$/);
  assert.match(maxDecreaseGuard, /bound_project_ref <> 'reviewtestxxxxxxxxxx'/);
  assert.doesNotMatch(maxDecreaseGuard, /reviewprodxxxxxxxxxx/);
  assert.match(maxDecreaseGuard, /get_financial_budget_change_project_position\(p_source_project_id\)/);
  assert.match(maxDecreaseGuard, /현재 미집행액을 초과하여 감액할 수 없습니다\. 최대 감액 가능액은 %s원입니다/);
  assert.match(maxDecreaseGuard, /financial_test_uat_bootstrap_project\(p_source_project_id\)/);
  assert.ok(maxDecreaseGuard.indexOf('get_financial_budget_change_project_position(p_source_project_id)')
    < maxDecreaseGuard.indexOf('financial_test_uat_bootstrap_project(p_source_project_id)'));
  assert.match(maxDecreaseGuard, /v_destination_year <> v_fiscal_year/);
  assert.match(maxDecreaseGuard, /projects\.year = v_anchor_year/);
  assert.doesNotMatch(maxDecreaseGuard, /update public\.projects|delete from public\.|truncate /i);
  assert.match(localUi, /현재 미집행액: \{formatWonWithUnit\(position\?\.unexecuted_amount \?\? '0'\)\}/);
  assert.doesNotMatch(localUi, /현재 미집행액: \{formatWonAsManwonWithUnit/);
  assert.doesNotMatch(localUi, /<span>\{format(?:WonAsManwonWithUnit|WonWithUnit)\(position\?\.unexecuted_amount/);
  assert.match(localUi, /출처: \{currentProjectYear\}년/);
  assert.match(localUi, /최대 감액 가능액은 현재 미집행액과 동일합니다/);
  assert.match(localUi, /maximumDecreaseError/);
  assert.match(action, /get_financial_budget_change_project_position/);
  assert.match(action, /validateBudgetChangeMaximumDecrease/);
});

test('예산 이벤트 금액 이력은 원 단위 불변 스냅샷과 공식 산식을 보존한다', () => {
  assert.match(adminWorkflowHotfix, /create table public\.financial_budget_workflow_amount_snapshots/);
  assert.match(adminWorkflowHotfix, /capture_kind in \('EXACT_AT_APPLY', 'DERIVED_CURRENT'\)/);
  assert.match(adminWorkflowHotfix, /adjusted_before = original_before \+ increase_before - decrease_before/);
  assert.match(adminWorkflowHotfix, /unexecuted_after = adjusted_after - execution_after/);
  assert.match(adminWorkflowHotfix, /financial_capture_budget_change_amount_snapshots/);
  assert.match(adminWorkflowHotfix, /financial_capture_pending_link_amount_snapshot/);
  assert.match(adminWorkflowHotfix, /force row level security/);
  assert.match(adminWorkflowHotfix, /grant select on table public\.financial_budget_workflow_amount_snapshots to authenticated/);
  assert.match(adminWorkflowHotfix, /revoke all on function public\.get_financial_budget_workflow_amount_snapshots\(uuid\) from public, anon/);
  assert.match(yangguUat, /select project_id,project_role,/);
  assert.match(yangguUat, /and project_role=\$3 and capture_kind='EXACT_AT_APPLY'/);
  assert.doesNotMatch(yangguUat, /select project_id,role,/);
});

test('관리자 화면은 승인 큐 없이 초안·미연결 재원·직접처리 모니터링을 분리한다', () => {
  assert.match(action, /get_financial_new_project_requests/);
  assert.match(action, /get_financial_budget_workflow_amount_snapshots/);
  assert.match(action, /pendingByLot/);
  assert.match(action, /workflow_group_id/);
  assert.match(action, /financial_budget_change_requests'[\s\S]*approved_by,approved_at,rejected_by,rejected_at,applied_by,applied_at/);
  assert.match(action, /financial_pending_new_project_link_requests'[\s\S]*approved_by,approved_at,rejected_by,rejected_at,applied_by,applied_at/);
  assert.match(adminUi, /등록·연결 모니터링<span>\{historyItems\.length\}<\/span>/);
  assert.match(adminUi, /신규사업 초안<span>\{newProjectDrafts\.length\}<\/span>/);
  assert.match(adminUi, /예정재원 현황<span>\{pendingStatus\.length\}<\/span>/);
  assert.match(adminUi, /확인요청 센터/);
  assert.doesNotMatch(adminUi, /예산조정 승인대기|신규사업 승인대기|예정재원 연결 승인대기/);
  assert.doesNotMatch(adminUi, /reviewNewProjectRequestAction|reviewBudgetChangeRequestAction|reviewPendingNewProjectLinkAction/);
  assert.match(adminUi, /BudgetGroupDetails/);
  assert.match(adminUi, /ReviewOutcome/);
  assert.match(adminUi, /filteredHistory/);
  assert.match(adminUi, /관리자 승인 없는 직접 처리/);
  assert.match(adminUi, /읽기 전용/);
  assert.doesNotMatch(adminUi, /신규사업 요청<span>\{data\.newProjectRequests\.length\}<\/span>/);
  assert.doesNotMatch(adminUi, /예산 조정 요청<span>\{data\.requests\.length\}<\/span>/);
});

test('관리자 모니터링은 직접처리 결과에 사후 확인요청만 제공한다', () => {
  assert.match(adminUi, /data\.requests[\s\S]*request\.status !== 'DRAFT'/);
  assert.match(adminUi, /data\.pending\.filter\(\(pending\) => pending\.status === 'WAITING'\)/);
  assert.match(adminUi, /confirmationControl/);
  assert.match(adminUi, /확인요청 보내기/);
  assert.match(adminUi, /회신기한 <i>선택<\/i>/);
  assert.match(adminUi, /확인요청 내용 <b>필수<\/b>/);
  assert.doesNotMatch(adminUi, /reviewBudgetChangeRequestAction|reviewNewProjectRequestAction|reviewPendingNewProjectLinkAction/);
});

test('처리 이력은 요구된 업무 필터와 과거 검토·현재 직접처리 이력을 함께 제공한다', () => {
  for (const label of ['시작일', '종료일', '시도·시군구', '사업연도', '유형', '처리상태', '출처사업', '목적사업', '신규사업 여부', '최소금액', '최대금액', '확인요청 상태']) {
    assert.match(adminUi, new RegExp(label));
  }
  assert.match(adminUi, /<dt>검토 의견<\/dt>/);
  assert.match(adminUi, /<dt>검토자<\/dt>/);
  assert.match(adminUi, /<dt>검토일<\/dt>/);
  assert.match(adminUi, /<dt>적용자<\/dt>/);
  assert.match(adminUi, /<dt>적용일<\/dt>/);
  assert.match(adminUi, /조정 사유: \{formatStoredUserText\(request\.reason, '사유 미입력'\)\}/);
});

test('관리자 승인 감사는 TEST에 fail-closed되고 UI 큐·상태 모순·금액 불변식을 함께 검증한다', () => {
  assert.match(adminFundingAudit, /TARGET_ENV/);
  assert.match(adminFundingAudit, /TEST_PROJECT_REF/);
  assert.match(adminFundingAudit, /PROD_PROJECT_REF/);
  assert.match(adminFundingAudit, /begin read only/);
  assert.match(adminFundingAudit, /budget_actionable/);
  assert.match(adminFundingAudit, /new_project_actionable/);
  assert.match(adminFundingAudit, /funding_link_actionable/);
  assert.match(adminFundingAudit, /grouped_status_mismatch/);
  assert.match(adminFundingAudit, /rejected_project_with_applied_link/);
  assert.match(adminFundingAudit, /orphan_pending_fund/);
  assert.match(adminFundingAudit, /request_group_gaps/);
  assert.match(adminFundingAudit, /ledger_invariant_gaps/);
  assert.match(adminFundingAudit, /applied_transaction_gap/);
  assert.doesNotMatch(adminFundingAudit, /insert into|update public\.|delete from|truncate /i);
});

test('지자체 배분·관리자 승인·검수 화면은 재정 금액을 원 단위로 일관되게 표시한다', () => {
  assert.match(projectChangeAdminUi, /예산 조정 전·후 금액/);
  assert.match(projectChangeAdminUi, /당초 배분액/);
  assert.match(projectChangeAdminUi, /증액액/);
  assert.match(projectChangeAdminUi, /감액액/);
  assert.match(projectChangeAdminUi, /조정 후 배분액/);
  assert.match(projectChangeAdminUi, /집행액/);
  assert.match(projectChangeAdminUi, /미집행액/);
  for (const ui of [localUi, adminUi, projectChangeAdminUi, projectReviewAdminUi]) {
    assert.match(ui, /formatWonWithUnit/);
    assert.doesNotMatch(ui, /formatWonAsManwonWithUnit|만원/);
  }
  assert.match(localUi, /value=\{formatIntegerString\(value\)\}/);
  assert.match(localUi, /화면 표시 \{formatWonWithUnit\(value\)\}/);
  assert.doesNotMatch(localUi, /화면 표시 \{formatWonAsManwonWithUnit/);
  assert.match(projectChangeAdminUi, /거래금액\(원\)/);
  assert.match(projectChangeAdminUi, /title=\{`\$\{formatIntegerString\(value\)\}원`\}/);
  assert.match(projectChangeAdminUi, /재정금액 영향 없음/);
});

test('감액 입력·저장·Ledger 계산 경로는 표시 단위와 무관하게 정수 원 값을 그대로 전달한다', () => {
  assert.match(localUi, /onChange=\{\(event\) => onChange\(normalizeLedgerAmount\(event\.target\.value\)\)\}/);
  assert.match(localUi, /totalAmount,\s*destinations,/);
  assert.match(action, /p_destinations: input\.destinations/);
  assert.match(migration, /total_amount bigint/);
  assert.match(migration, /amount bigint/);
  for (const source of [localUi, action, migration, genericAdjustmentEngine, budgetAdjustmentDraftUpsert]) {
    assert.doesNotMatch(source, /WON_PER_MANWON|\/\s*10_?000|\*\s*10_?000/);
  }
});

test('범용 예산조정 엔진은 group 신규사업 생성·재원 이동·금액 스냅샷을 한 transaction에서 끝낸다', () => {
  assert.match(genericAdjustmentEngine, /^begin;/m);
  assert.match(genericAdjustmentEngine, /commit;\s*$/);
  const apply = genericAdjustmentEngine.slice(
    genericAdjustmentEngine.indexOf('create or replace function public.financial_apply_budget_change_request'),
    genericAdjustmentEngine.indexOf('create or replace function public.get_financial_budget_change_requests'),
  );
  assert.match(apply, /insert into public\.project_fund_transfers/);
  assert.match(apply, /insert into public\.financial_unallocated_fund_lots/);
  assert.match(apply, /insert into public\.financial_unallocated_fund_movements/);
  assert.match(apply, /insert into public\.projects/);
  assert.match(apply, /materialized_project_id = v_destination_project_id/);
  assert.match(apply, /materialized_movement_id = v_movement_id/);
  assert.match(apply, /v_classification_after - v_classification_before <> v_request\.total_amount/);
  assert.match(apply, /atomic_group_apply/);
  assert.match(genericAdjustmentEngine, /financial_capture_budget_change_amount_snapshots/);
});

test('범용 관리자 큐와 통계는 grouped 신규사업과 등록된 차년도 목적지를 노출한다', () => {
  assert.match(genericAdjustmentEngine, /'new_project_request_id', new_requests\.id/);
  assert.match(genericAdjustmentEngine, /'new_project_request_status', new_requests\.status/);
  assert.match(genericAdjustmentEngine, /'materialized_project_id', materialized\.id/);
  assert.match(genericAdjustmentEngine, /REGISTERED_NEXT_YEAR_PROJECT:/);
  assert.match(genericAdjustmentEngine, /lines\.destination_type = 'PENDING_NEW_PROJECT'/);
  assert.match(genericAdjustmentEngine, /movements\.lot_id = lines\.materialized_lot_id/);
  assert.match(genericAdjustmentEngine, /revoke all on function public\.financial_apply_budget_change_request\(uuid\)/);
  assert.match(genericAdjustmentEngine, /grant execute on function public\.financial_approve_budget_change_request_group\(uuid,jsonb\)/);
});

test('grouped 차년도 목적지는 완료된 예정재원·연결 trace를 원자 transaction에 남긴다', () => {
  assert.match(genericAdjustmentTraceHotfix, /^begin;/m);
  assert.match(genericAdjustmentTraceHotfix, /commit;\s*$/);
  assert.match(genericAdjustmentTraceHotfix, /create trigger financial_trace_grouped_budget_destination/);
  assert.match(genericAdjustmentTraceHotfix, /insert into public\.financial_pending_new_project_funds/);
  assert.match(genericAdjustmentTraceHotfix, /insert into public\.financial_pending_new_project_link_requests/);
  assert.match(genericAdjustmentTraceHotfix, /'LINKED'/);
  assert.match(genericAdjustmentTraceHotfix, /'APPLIED'/);
  assert.match(genericAdjustmentTraceHotfix, /set pending_fund_id = v_pending_id/);
  assert.match(genericAdjustmentTraceHotfix, /revoke all on function public\.financial_trace_grouped_budget_destination\(\)/);
});

test('범용 함수 ambiguity hotfix는 RETURNS TABLE 출력명과 요청선 열을 명시적으로 분리한다', () => {
  assert.match(genericAdjustmentAmbiguityHotfix, /^begin;/m);
  assert.match(genericAdjustmentAmbiguityHotfix, /commit;\s*$/);
  assert.match(genericAdjustmentAmbiguityHotfix, /bound_project_ref <> 'reviewtestxxxxxxxxxx'/);
  assert.match(genericAdjustmentAmbiguityHotfix, /financial_budget_change_request_lines\.request_id = v_request\.id/);
  assert.match(genericAdjustmentAmbiguityHotfix, /financial_budget_change_request_lines\.new_project_request_id is not null/);
  assert.doesNotMatch(genericAdjustmentAmbiguityHotfix, /update public\.projects|delete from public\.|truncate /i);
});

test('canonical decrease hotfix는 과거 감액을 보존해 후속 유입을 증액으로 표시하고 monetary 총량은 바꾸지 않는다', () => {
  assert.match(genericAdjustmentCanonicalDecreaseHotfix, /^begin;/m);
  assert.match(genericAdjustmentCanonicalDecreaseHotfix, /commit;\s*$/);
  assert.match(genericAdjustmentCanonicalDecreaseHotfix, /bound_project_ref<>'reviewtestxxxxxxxxxx'/);
  assert.match(genericAdjustmentCanonicalDecreaseHotfix, /financial_project_decrease_classification_effects/);
  assert.match(genericAdjustmentCanonicalDecreaseHotfix, /effects\.effect_count>0 then 0/);
  assert.match(genericAdjustmentCanonicalDecreaseHotfix, /greatest\(public\.financial_budget_change_visible_decrease\(base\.project_id\)/);
  assert.match(genericAdjustmentCanonicalDecreaseHotfix, /ledger_original_allocation\+ledger_increase_amount-ledger_decrease_amount/);
  assert.match(genericAdjustmentCanonicalDecreaseHotfix, /cohort_conservation_gap<>0 or decrease_resolution_gap<>0/);
  assert.doesNotMatch(genericAdjustmentCanonicalDecreaseHotfix,
    /insert into public\.(project_fund_transfers|financial_unallocated_fund_movements)|update public\.projects|delete from public\.|truncate /i);
});

test('신규사업 작성 완료는 부모·목적지·신규사업 요청을 DB DRAFT로 저장하고 함께 제출한다', () => {
  assert.match(budgetAdjustmentDraftUpsert, /^begin;/m);
  assert.match(budgetAdjustmentDraftUpsert, /commit;\s*$/);
  assert.match(budgetAdjustmentDraftUpsert, /bound_project_ref <> 'reviewtestxxxxxxxxxx'/);
  assert.match(budgetAdjustmentDraftUpsert, /financial_test_uat_save_budget_change_request/);
  assert.match(budgetAdjustmentDraftUpsert, /source_budget_change_request_id/);
  assert.match(budgetAdjustmentDraftUpsert, /source_budget_change_line_id/);
  assert.match(budgetAdjustmentDraftUpsert, /new_requests[\s\S]*status='SUBMITTED'/);
  assert.match(budgetAdjustmentDraftUpsert, /financial_validate_budget_change_request/);
  assert.match(action, /saveBudgetChangeDraftAction/);
  assert.match(action, /p_submit: false/);
  assert.match(localUi, /신규사업 임시저장을 현재 예산조정 목적지에 연결했습니다/);
});

test('관리자·지자체·대시보드·분석 화면은 공통 사업 표시 규칙으로 시험 식별자와 코드를 숨긴다', () => {
  assert.match(presentationLabels, /sanitizeProjectNameForDisplay/);
  assert.match(presentationLabels, /isInternalTestIdentifier/);
  assert.match(presentationLabels, /return getProjectPresentation\(project\)\.name/);
  for (const ui of [adminUi, projectChangeAdminUi, localUi, newProjectUi, editShell, myProjectsUi, projectTableUi, analyticsUi]) {
    assert.match(ui, /formatProject(?:Option|Reference)|getProjectPresentation|analyticsProjectName|getMyProjectDisplayName/);
  }
  assert.doesNotMatch(localUi, /DRAFT 저장|SUBMITTED 제출|TEST_UAT_BOOTSTRAP으로/);
  assert.doesNotMatch(newProjectUi, /DRAFT 저장|SUBMITTED 제출/);
  assert.doesNotMatch(adminUi, /MONETARY GAP|RUN ID/);
  assert.match(editShell, /preservesPresentationOnlyName/);
  assert.match(editShell, /detailProjectName: currentRawDetailName/);
  assert.match(action, /formatUserFacingError/);
});

test('TEST 자동화는 RUN ID를 업무용 사업명·공식 사업코드로 재사용하지 않는다', () => {
  assert.match(yangguUat, /양구 관광활성화 신규사업/);
  assert.match(yangguUat, /--official-new-project-code/);
  assert.doesNotMatch(yangguUat, /GENERIC-BUDGET-UAT 2025 양구 신규사업|2025-51-800-UAT-0831-G2/);
  assert.match(sunchangUat, /순창 청년활력 지원사업/);
  assert.match(sunchangUat, /--case-b-official-code/);
  assert.match(sunchangUat, /--case-c-official-code/);
  assert.doesNotMatch(sunchangUat, /UAT 순창 2027 신규사업 B|2027-52-770-UAT-0831-[BC]/);
  assert.match(preUserUat, /--golden-official-code/);
  assert.match(preUserUat, /--one-won-official-code/);
  assert.match(preUserUat, /--nine-nine-nine-nine-official-code/);
  assert.doesNotMatch(preUserUat, /draftName: `\$\{runId\}|finalName: `\$\{runId\}|officialCode: `\$\{codeBase\}/);
  for (const script of [adminBudgetWorkflowUat, budgetWorkflowUat, budgetDraftUat]) {
    assert.doesNotMatch(script, /(?:planned_project_name|p_project_name|p_fund_project_name|p_detail_project_name):\s*['"`]\s*UAT/i);
    assert.doesNotMatch(script, /(?:officialCode|p_official_project_code)\s*=?:?\s*['"`][^'"`]*UAT/i);
  }
});
