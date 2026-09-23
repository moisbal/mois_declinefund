import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const migration = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260914000200_direct_new_project_and_post_checks.sql',
), 'utf8');
const hotfix = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260914000300_direct_new_project_existing_validation_hotfix.sql',
), 'utf8');
const groupedTraceHotfix = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260914000400_direct_grouped_destination_trace_hotfix.sql',
), 'utf8');
const fundingActions = fs.readFileSync(path.join(root, 'app/my-projects/funding-actions.ts'), 'utf8');
const budgetActions = fs.readFileSync(path.join(root, 'app/my-projects/budget-change-actions.ts'), 'utf8');
const adminUi = fs.readFileSync(path.join(root, 'components/admin/FundingManagementShell.tsx'), 'utf8');
const confirmationActions = fs.readFileSync(path.join(root, 'app/confirmations/actions.ts'), 'utf8');
const confirmationUi = fs.readFileSync(path.join(root, 'components/confirmations/ConfirmationCenterShell.tsx'), 'utf8');
const header = fs.readFileSync(path.join(root, 'components/common/Header.tsx'), 'utf8');
const lifecycle = fs.readFileSync(path.join(root, 'components/my-projects/ProjectLifecycleOptions.tsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8');

test('신규사업과 신규·기존사업 예산연결은 검증 뒤 같은 트랜잭션에서 직접 완료된다', () => {
  assert.match(migration, /create or replace function public\.financial_submit_new_project_request_v2/);
  assert.match(migration, /perform 1 from public\.financial_submit_new_project_request\(v_request\.id\)/);
  assert.match(migration, /financial_complete_new_project_request\(v_request\.id\)/);
  assert.match(migration, /create or replace function public\.financial_submit_budget_change_request/);
  assert.match(migration, /from public\.financial_apply_budget_change_request\(v_request\.id\)/);
  assert.match(migration, /create or replace function public\.financial_request_pending_new_project_link/);
  assert.match(migration, /from public\.financial_apply_pending_new_project_link\(v_request\.id\)/);
  assert.match(migration, /unique \(entity_type, entity_id\)/);
  assert.match(migration, /on conflict \(entity_type, entity_id\) do nothing/);
  assert.match(migration, /'approval_required', false/);
  assert.match(hotfix, /기존 신규사업 제출 검증 규칙과 직접 처리 검증 규칙/);
});

test('임시저장은 확정 행이나 원장 거래를 만들지 않고 제출 시에만 직접처리된다', () => {
  const submit = migration.slice(
    migration.indexOf('create or replace function public.financial_submit_new_project_request_v2'),
    migration.indexOf('-- Budget changes that contain'),
  );
  assert.match(submit, /v_request\.status <> 'DRAFT'/);
  assert.match(submit, /financial_submit_new_project_request/);
  assert.match(submit, /financial_complete_new_project_request/);
  assert.doesNotMatch(fundingActions, /reviewNewProjectRequestAction/);
  assert.doesNotMatch(budgetActions, /reviewBudgetChangeRequestAction|reviewPendingNewProjectLinkAction/);
});

test('해당 업무의 레거시 승인·반려·적용 RPC는 호출 권한이 제거된다', () => {
  for (const signature of [
    'financial_apply_new_project_request(uuid)',
    'financial_apply_new_project_request_v2(uuid)',
    'financial_approve_new_project_request(uuid,text)',
    'financial_reject_new_project_request(uuid,text)',
    'financial_review_pending_new_project_link(uuid,text,text)',
    'financial_apply_pending_new_project_link(uuid)',
    'financial_approve_budget_change_request_group(uuid,jsonb)',
    'financial_reject_budget_change_request(uuid,text)',
    'financial_apply_budget_change_request_dispatch(uuid)',
  ]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${signature.replace(/[()]/g, '\\$&')}`));
  }
  assert.match(migration, /from public, anon, authenticated, service_role/);
  assert.doesNotMatch(adminUi, /reviewNewProjectRequestAction|reviewBudgetChangeRequestAction|reviewPendingNewProjectLinkAction/);
});

test('확인요청은 요청·회신·완료·재확인 이력과 영속 알림을 금액 영향 없이 저장한다', () => {
  assert.match(migration, /create table public\.financial_post_check_requests/);
  assert.match(migration, /status in \('REQUESTED', 'REPLIED', 'COMPLETED'\)/);
  assert.match(migration, /parent_request_id uuid references public\.financial_post_check_requests/);
  assert.match(migration, /create table public\.system_notifications/);
  assert.match(migration, /read_at timestamptz/);
  assert.match(migration, /on delete restrict/);
  assert.match(migration, /create or replace function public\.financial_create_post_check_request/);
  assert.match(migration, /create or replace function public\.financial_reply_post_check_request/);
  assert.match(migration, /create or replace function public\.financial_complete_post_check_request/);
  assert.match(migration, /create or replace function public\.financial_mark_notification_read/);
  assert.match(migration, /'monetary_effect', 0/);
  assert.match(confirmationActions, /financial_create_post_check_request/);
  assert.match(confirmationActions, /financial_reply_post_check_request/);
  assert.match(confirmationActions, /financial_complete_post_check_request/);
  assert.match(confirmationActions, /financial_mark_notification_read/);
});

test('확인요청 조회·회신·알림은 관리자와 해당 지자체 권한으로 서버에서 분리된다', () => {
  assert.match(migration, /checks\.region_id = v_actor_region_id/);
  assert.match(migration, /v_request\.region_id <> v_actor_region_id/);
  assert.match(migration, /notifications\.recipient_user_id = v_actor_id/);
  assert.match(migration, /profiles\.region_id = v_region_id/);
  assert.match(migration, /profiles\.role = 'local_user'/);
  assert.match(migration, /revoke all on table public\.financial_post_check_requests from public, anon, authenticated/);
  assert.match(migration, /revoke all on table public\.system_notifications from public, anon, authenticated/);
});

test('관리자와 지자체 화면은 확인요청·조회함·회신함을 구분하고 읽음과 완료를 분리한다', () => {
  assert.match(adminUi, /확인요청 보내기/);
  assert.match(adminUi, /회신기한 <i>선택<\/i>/);
  assert.match(adminUi, /확인요청 상태/);
  assert.match(confirmationUi, /조회함/);
  assert.match(confirmationUi, /회신함/);
  assert.match(confirmationUi, /회신완료/);
  assert.match(confirmationUi, /확인완료/);
  assert.match(confirmationUi, /재확인 요청 보내기/);
  assert.match(confirmationUi, /markNotificationReadAction/);
  assert.match(header, /getPostCheckCenterAction/);
  assert.match(header, /\/confirmations/);
});

test('신규·계속사업 공통 선택 UI는 글자 단위가 아닌 박스 단위로 줄바꿈한다', () => {
  assert.match(lifecycle, /role="radiogroup"/);
  assert.match(lifecycle, /<label className=/);
  assert.match(lifecycle, /<span>신규사업<\/span>/);
  assert.match(lifecycle, /<span>계속사업<\/span>/);
  assert.match(css, /\.project-lifecycle-options \{[\s\S]*display: flex;[\s\S]*flex-flow: row wrap/);
  assert.match(css, /\.project-lifecycle-options label \{[\s\S]*display: inline-flex;[\s\S]*min-width: min\(168px, 100%\)/);
  assert.match(css, /white-space: nowrap/);
  assert.match(css, /writing-mode: horizontal-tb/);
  assert.match(css, /\.project-lifecycle-options label:focus-within/);
});

test('추가형 migration은 업무·거래·확인이력을 삭제하지 않고 설치 중 금액 불변을 검증한다', () => {
  assert.match(migration, /^begin;/m);
  assert.match(migration, /direct_workflow_install_snapshot/);
  assert.match(migration, /row\(v_before\.\*\) is distinct from row\(v_after\.\*\)/);
  assert.doesNotMatch(migration, /\btruncate\b|delete\s+from\s+public\.(projects|project_fund_transfers|financial_post_check_requests|system_notifications)/i);
  assert.match(migration, /commit;\s*$/);
});

test('직접 처리된 신규사업 목적지 추적행은 직접·자동 모드로 기록되고 과거 승인 모드는 보존된다', () => {
  assert.match(groupedTraceHotfix, /v_direct := new\.approved_by is null or new\.approved_by = new\.requested_by/);
  assert.match(groupedTraceHotfix, /approval_mode, processing_mode/);
  assert.match(groupedTraceHotfix, /case when v_direct then 'AUTO' else 'MANUAL' end/);
  assert.match(groupedTraceHotfix, /case when v_direct then 'DIRECT' else 'LEGACY_APPROVAL' end/);
  assert.match(groupedTraceHotfix, /direct_grouped_trace_install_snapshot/);
  assert.match(groupedTraceHotfix, /row\(v_before\.\*\) is distinct from row\(v_after\.\*\)/);
  assert.doesNotMatch(groupedTraceHotfix, /\btruncate\b|delete\s+from\s+public\./i);
  assert.match(groupedTraceHotfix, /commit;\s*$/);
});
