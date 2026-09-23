import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const migration = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260831000400_budget_adjustment_idempotency_state_machine_hotfix.sql',
), 'utf8');
const insertDefaultsMigration = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260831000500_budget_adjustment_insert_defaults_hotfix.sql',
), 'utf8');
const localUi = fs.readFileSync(path.join(
  root,
  'components/my-projects/ProjectFundingManagementSection.tsx',
), 'utf8');
const adminUi = fs.readFileSync(path.join(
  root,
  'components/admin/FundingManagementShell.tsx',
), 'utf8');
const actions = fs.readFileSync(path.join(
  root,
  'app/my-projects/budget-change-actions.ts',
), 'utf8');

test('idempotency migration is TEST-pinned and does not mutate monetary/project rows', () => {
  assert.match(migration, /^begin;/m);
  assert.match(migration, /commit;\s*$/);
  assert.match(migration, /bound_project_ref <> 'reviewtestxxxxxxxxxx'/);
  assert.doesNotMatch(migration, /reviewprodxxxxxxxxxx/);
  assert.doesNotMatch(migration, /insert into public\.(project_fund_transfers|financial_unallocated_fund_movements|projects)/i);
  assert.doesNotMatch(migration, /update public\.(project_fund_transfers|financial_unallocated_fund_movements|projects)/i);
  assert.doesNotMatch(migration, /delete from public\.|truncate /i);
  assert.match(migration, /row\(v_snapshot\.\*\) is distinct from row\(v_current\.\*\)/);
});

test('economic fingerprint includes source revision and canonical destinations but not UI reason', () => {
  const fingerprint = migration.slice(
    migration.indexOf('create or replace function public.financial_budget_change_adjustment_fingerprint'),
    migration.indexOf('create or replace function public.financial_budget_change_request_adjustment_fingerprint'),
  );
  assert.match(fingerprint, /source_project_id/);
  assert.match(fingerprint, /source_budget_year_id/);
  assert.match(fingerprint, /source_adjustment_revision/);
  assert.match(fingerprint, /total_amount/);
  assert.match(fingerprint, /effective_date/);
  assert.match(fingerprint, /financial_budget_change_canonical_destinations/);
  assert.doesNotMatch(fingerprint, /reason|INCREASE_TARGET/);
  assert.match(migration, /registered_project_reference/);
});

test('concurrent and repeated submissions are serialized and uniquely constrained', () => {
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(v_adjustment_fingerprint, 0\)\)/);
  assert.match(migration, /create unique index financial_budget_change_active_adjustment_uidx/);
  assert.match(migration, /status in \('SUBMITTED', 'APPROVED', 'APPLIED'\)/);
  assert.match(migration, /이미 승인 요청된 예산조정입니다/);
  assert.match(migration, /동일 예산조정이 이미 승인 요청되었거나 적용되었습니다/);
  assert.match(migration, /revoke all on function public\.financial_create_budget_change_request[\s\S]*from public, anon, authenticated/);
});

test('legacy internal insert receives provisional values without exposing the bypass', () => {
  assert.match(insertDefaultsMigration, /bound_project_ref <> 'reviewtestxxxxxxxxxx'/);
  assert.match(insertDefaultsMigration, /source_adjustment_revision set default 0/);
  assert.match(insertDefaultsMigration, /draft_revision_id set default gen_random_uuid\(\)/);
  assert.match(insertDefaultsMigration, /adjustment_fingerprint set default/);
  assert.match(insertDefaultsMigration, /has_function_privilege\('authenticated'/);
  assert.doesNotMatch(insertDefaultsMigration, /insert into public\.(financial_budget_change_requests|project_fund_transfers|financial_unallocated_fund_movements)/i);
});

test('legacy duplicates are linked without deletion and cannot transition to approval/apply', () => {
  assert.match(migration, /add column duplicate_of_request_id uuid/);
  assert.match(migration, /first_value\(requests\.id\) over/);
  assert.match(migration, /when 'APPLIED' then 1 when 'APPROVED' then 2 when 'SUBMITTED' then 3/);
  assert.match(migration, /new\.duplicate_of_request_id is not null and new\.status in \('APPROVED', 'APPLIED'\)/);
  assert.match(migration, /then 'DUPLICATE'::text else requests\.status end/);
  assert.doesNotMatch(migration, /delete from public\.financial_budget_change_requests/i);
});

test('state machine only allows draft-submit-approve-apply and submitted/approved rejection', () => {
  const guard = migration.slice(
    migration.indexOf('create or replace function public.financial_guard_budget_change_state_transition'),
    migration.indexOf('drop trigger if exists financial_budget_change_state_transition_guard'),
  );
  assert.match(guard, /old\.status = 'DRAFT' and new\.status = 'SUBMITTED'/);
  assert.match(guard, /old\.status = 'SUBMITTED' and new\.status in \('APPROVED', 'REJECTED'\)/);
  assert.match(guard, /old\.status = 'APPROVED' and new\.status in \('APPLIED', 'REJECTED'\)/);
  assert.match(guard, /허용되지 않은 예산조정 상태 변경/);
});

test('reject RPC qualifies status references and preserves zero monetary effect', () => {
  const reject = migration.slice(
    migration.indexOf('create or replace function public.financial_reject_budget_change_request'),
    migration.indexOf('-- Keep the existing return signature'),
  );
  assert.match(reject, /#variable_conflict use_column/);
  assert.match(reject, /requests\.status/);
  assert.match(reject, /new_requests\.status/);
  assert.match(reject, /v_request\.status/);
  assert.match(reject, /materialized_transfer_id is not null/);
  assert.match(reject, /materialized_lot_id is not null/);
  assert.match(reject, /'monetary_effect', 0/);
  assert.doesNotMatch(reject, /update public\.(project_fund_transfers|financial_unallocated_fund_movements|projects)/i);
});

test('local UI uses a synchronous lock and one draft revision id per form', () => {
  assert.match(localUi, /useRef/);
  assert.match(localUi, /submitLockRef\.current/);
  assert.match(localUi, /setDraftRevisionId\(crypto\.randomUUID\(\)\)/);
  assert.match(localUi, /idempotencyKey: draftRevisionId/);
  const submitBlock = localUi.slice(localUi.indexOf('async function submit()'), localUi.indexOf('async function linkPending'));
  assert.doesNotMatch(submitBlock, /idempotencyKey: crypto\.randomUUID\(\)/);
  assert.match(localUi, /disabled=\{submitting \|\| !submitEnabled\}/);
  assert.match(localUi, /aria-busy=\{submitting\}/);
  assert.match(localUi, /반영 중\.\.\./);
});

test('관리자 화면은 중복 이력을 보존하되 해당 업무의 승인 예외 큐를 노출하지 않는다', () => {
  assert.match(adminUi, /request\.status === 'DUPLICATE'/);
  assert.match(adminUi, /등록·연결 모니터링/);
  assert.match(adminUi, /확인요청/);
  assert.match(adminUi, /적용 거래 차액/);
  assert.doesNotMatch(adminUi, /반려만 가능합니다|자동반영 예외 예산조정|사업코드 확인·예산 반영|요청 반려|중복 요청 반려/);
  assert.doesNotMatch(adminUi, />group 승인<\/button>|>group 반려<\/button>|MONETARY GAP/);
  assert.match(actions, /formatUserFacingError\(error, '예산 조정 처리 중 오류가 발생했습니다\.'\)/);
});
