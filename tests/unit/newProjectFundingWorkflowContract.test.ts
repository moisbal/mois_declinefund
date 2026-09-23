import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const migration = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260903000100_new_project_funding_source_workflow.sql',
), 'utf8');
const pendingPathMigration = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260903000200_new_project_pending_fund_path.sql',
), 'utf8');
const pendingSnapshotMigration = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260903000300_pending_fund_snapshot_trigger.sql',
), 'utf8');
const pendingBusinessYearMigration = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260903000400_pending_fund_business_year.sql',
), 'utf8');
const fundingAction = fs.readFileSync(path.join(root, 'app/my-projects/funding-actions.ts'), 'utf8');
const budgetAction = fs.readFileSync(path.join(root, 'app/my-projects/budget-change-actions.ts'), 'utf8');
const newProjectUi = fs.readFileSync(path.join(root, 'components/my-projects/NewProjectRequestPanel.tsx'), 'utf8');
const budgetUi = fs.readFileSync(path.join(root, 'components/my-projects/ProjectFundingManagementSection.tsx'), 'utf8');
const sharedFields = fs.readFileSync(path.join(root, 'components/my-projects/NewProjectRequestFields.tsx'), 'utf8');
const businessTypeOptions = fs.readFileSync(path.join(root, 'components/my-projects/ProjectBusinessTypeOptions.tsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8');
const reasonMigration = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260903000600_execution_status_reason.sql',
), 'utf8');

test('신규사업 재원 보정은 TEST ref에 고정되고 migration 자체는 업무 행·금액을 바꾸지 않는다', () => {
  assert.match(migration, /^begin;/m);
  assert.match(migration, /commit;\s*$/);
  assert.match(migration, /bound_project_ref <> 'reviewtestxxxxxxxxxx'/);
  assert.doesNotMatch(migration, /reviewprodxxxxxxxxxx/);
  assert.match(migration, /new_project_funding_workflow_snapshot/);
  assert.match(migration, /row\(v_before\.\*\) is distinct from row\(v_after\.\*\)/);
  assert.match(migration, /production/i);
});

test('선택지는 일반 잔액이 아니라 지역·대상연도·상태·잔액·미연결 조건을 만족한 예정재원이다', () => {
  const sourceRpc = pendingPathMigration.slice(
    pendingPathMigration.indexOf('create or replace function public.get_financial_new_project_funding_sources'),
    pendingPathMigration.indexOf('create or replace function public.financial_validate_budget_change_request'),
  );
  assert.match(sourceRpc, /pending\.status = 'WAITING'/);
  assert.match(sourceRpc, /balances\.remaining_amount > 0/);
  assert.match(sourceRpc, /pending\.planned_project_year = p_year/);
  assert.match(sourceRpc, /pending\.planned_project_year = pending\.fiscal_year \+ 1/);
  assert.match(sourceRpc, /v_role = 'admin' or pending\.region_id = v_actor_region_id/);
  assert.match(sourceRpc, /financial_pending_new_project_link_requests/);
  assert.match(sourceRpc, /claimed\.id is null/);
  assert.match(fundingAction, /newProjectFundingSources: 'get_financial_new_project_funding_sources'/);
  assert.match(newProjectUi, /result\.data\.newProjectFundingSources/);
  assert.doesNotMatch(newProjectUi, /result\.data\.lots\.filter/);
});

test('독립 신규사업은 재원 없이 초안 저장되지만 제출 직전에 적격 재원을 다시 검증한다', () => {
  assert.match(migration, /source_lot_id is null and status = 'DRAFT'/);
  assert.match(migration, /check \(requested_amount >= 0\)/);
  assert.match(migration, /financial_save_new_project_request_draft/);
  assert.match(migration, /승인요청 전에 연결할 대기재원을 선택해 주세요/);
  assert.match(migration, /v_pending\.planned_project_year <> v_request\.fiscal_year/);
  assert.match(migration, /v_pending\.amount <> v_request\.requested_amount/);
  assert.match(newProjectUi, /재원 없이 신규사업 초안을 임시저장할 수 있습니다/);
  assert.match(newProjectUi, /disabled=\{submitting !== null \|\| !sourceLotId \|\| submissionRequirements\.length > 0\}/);
  assert.match(newProjectUi, /allowZeroAmount=\{!selectedSource\}/);
});

test('예산조정은 새 신규사업과 기존 독립 초안을 같은 group에 원자적으로 연결한다', () => {
  assert.match(migration, /get_financial_attachable_new_project_drafts/);
  assert.match(migration, /requested_by = v_actor_id/);
  assert.match(migration, /requests\.fiscal_year = v_source_year \+ 1/);
  assert.match(migration, /existing_new_project_request_id/);
  assert.match(migration, /linked_from_standalone = true/);
  assert.match(migration, /financial_validate_budget_change_request\(v_parent\.id\)/);
  assert.match(migration, /financial_submit_budget_change_request\(v_parent\.id\)/);
  assert.match(budgetAction, /financial_test_uat_save_budget_change_request_complete_v2/g);
  assert.match(budgetUi, /기존에 작성한 신규사업 초안/);
  assert.match(budgetUi, /existing_new_project_request_id/);
  assert.match(budgetUi, /연결 예정 예산/);
});

test('예정예산만 먼저 확보하면 공식 사업 없이 N+1 대기재원을 만들고 적용을 분기한다', () => {
  assert.match(pendingPathMigration, /unlinked_funding_only boolean not null default false/);
  assert.match(pendingPathMigration, /create_unlinked_funding/);
  assert.match(pendingPathMigration, /financial_pending_new_project_funds/);
  assert.match(pendingPathMigration, /v_line\.planned_project_year/);
  assert.match(pendingPathMigration, /financial_apply_budget_change_request_dispatch/);
  assert.match(pendingPathMigration, /v_classification_after - v_classification_before <> v_request\.total_amount/);
  assert.match(pendingSnapshotMigration, /and not lines\.unlinked_funding_only/);
  assert.match(pendingBusinessYearMigration, /new\.fiscal_year := v_request_year/);
  assert.match(pendingBusinessYearMigration, /new\.planned_project_year <> v_request_year \+ 1/);
  assert.match(budgetUi, /예정재원 먼저 확보\(사업은 나중에 작성\)/);
  assert.match(budgetUi, /예정재원과 최소정보 신규사업 초안을 함께 확보합니다/);
  assert.match(budgetUi, /임시저장 후 필수정보를 채워 완료하면 사업 등록과 예산연결이 승인 없이 함께 처리됩니다/);
});

test('업무 화면은 공통 사업유형 이름과 업무용 재원 설명만 표시한다', () => {
  assert.match(sharedFields, /ProjectBusinessTypeOptions/);
  assert.match(businessTypeOptions, /BUSINESS_TYPE_LABELS\[businessType\]/);
  assert.doesNotMatch(sharedFields, /시설조성\(HW\)|프로그램\(SW\)/);
  assert.match(newProjectUi, /연결할 예산/);
  assert.match(newProjectUi, /source_fiscal_year/);
  assert.match(newProjectUi, /formatProjectOption/);
  assert.match(newProjectUi, /예산조정 자동 연결/);
  assert.doesNotMatch(newProjectUi, />DRAFT<|>SUBMITTED<|RUN ID/);
  assert.doesNotMatch(budgetUi, />DRAFT<|>SUBMITTED<|RUN ID/);
});

test('신규사업 요청의 사업유형 선택지는 좁은 입력 영역에서도 겹치지 않는다', () => {
  assert.match(css, /\.new-project-request-panel > \.funding-workflow-grid\s*\{[\s\S]*?grid-template-columns: minmax\(0, 2fr\) minmax\(280px, 1fr\);[\s\S]*?\}/);
  assert.match(css, /\.my-project-business-type-options\s*\{[\s\S]*?repeat\(auto-fit, minmax\(min\(100%, 180px\), 1fr\)\)[\s\S]*?\}/);
  assert.match(css, /\.my-project-business-type-options label\s*\{[\s\S]*?min-width: 0;[\s\S]*?\}/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.new-project-request-panel > \.funding-workflow-grid\s*\{\s*grid-template-columns: 1fr;/);
});

test('신규사업 등록과 예산조정 내 신규사업 초안이 집행상태 사유를 함께 저장한다', () => {
  assert.match(sharedFields, /ProjectExecutionStatusFields/);
  assert.match(fundingAction, /financial_save_new_project_request_draft_v2/);
  assert.match(fundingAction, /p_execution_status_reason/);
  assert.match(budgetUi, /planned_execution_status_reason/);
  assert.match(budgetAction, /get_financial_attachable_new_project_drafts_v2/);
  assert.match(reasonMigration, /execution_status_reason/);
});
