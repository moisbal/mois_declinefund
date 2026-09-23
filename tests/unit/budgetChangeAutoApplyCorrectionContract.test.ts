import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const migration = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260911000100_budget_change_auto_apply_and_destination_correction.sql',
), 'utf8');
const actions = fs.readFileSync(path.join(root, 'app/my-projects/budget-change-actions.ts'), 'utf8');
const localUi = fs.readFileSync(path.join(
  root,
  'components/my-projects/ProjectFundingManagementSection.tsx',
), 'utf8');
const adminUi = fs.readFileSync(path.join(root, 'components/admin/FundingManagementShell.tsx'), 'utf8');
const migrationRunner = fs.readFileSync(path.join(
  root,
  'scripts/run-budget-change-auto-apply-test-migration.cjs',
), 'utf8');
const uatRunner = fs.readFileSync(path.join(
  root,
  'scripts/run-budget-change-auto-apply-uat.cjs',
), 'utf8');
const classificationHotfix = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260914000100_budget_change_destination_correction_classification_hotfix.sql',
), 'utf8');
const classificationHotfixRunner = fs.readFileSync(path.join(
  root,
  'scripts/run-budget-change-correction-hotfix-test-migration.cjs',
), 'utf8');

test('automatic application is reversible through one audited singleton setting', () => {
  assert.match(migration, /create table public\.financial_workflow_settings/);
  assert.match(migration, /budget_change_auto_apply boolean not null default true/);
  assert.match(migration, /financial_set_budget_change_auto_apply/);
  assert.match(migration, /financial_require_admin\(\)/);
  assert.match(migration, /financial_workflow_setting_events/);
  assert.match(migration, /previous_value, next_value, reason, changed_by/);
});

test('ordinary requests auto approve and apply atomically while project-code registration remains human reviewed', () => {
  const submit = migration.slice(
    migration.indexOf('create or replace function public.financial_submit_budget_change_request'),
    migration.indexOf('create or replace function public.financial_approve_budget_change_request_group'),
  );
  assert.match(submit, /v_requires_project_registration/);
  assert.match(submit, /and not lines\.unlinked_funding_only/);
  assert.match(submit, /approval_mode = 'AUTO'/);
  assert.match(submit, /financial_apply_budget_change_request\(v_request\.id\)/);
  assert.match(submit, /set_config\(\s*'app\.financial_budget_change_auto_request_id'/);
  assert.match(migration, /BUDGET_REALLOCATION_AUTO_APPROVED/);
  assert.match(migration, /if coalesce\(v_auto_apply, false\) and not v_requires_project_registration/);
});

test('pending-fund linking follows the same auto-apply policy', () => {
  assert.match(migration, /app\.financial_pending_link_auto_request_id/);
  assert.match(migration, /financial_apply_pending_new_project_link\(v_request\.id\)/);
  assert.match(migration, /alter table public\.financial_pending_new_project_link_requests[\s\S]*approval_mode/);
});

test('destination corrections preserve immutable ledger history with reversal plus replacement', () => {
  const correction = migration.slice(
    migration.indexOf('create table public.financial_budget_change_destination_corrections'),
    migration.indexOf('create or replace function public.get_financial_budget_change_destination_states'),
  );
  assert.match(correction, /financial_budget_change_corrections_immutable/);
  assert.match(correction, /financial_require_available_amount/);
  assert.match(correction, /'CONFIRMED', 'REVERSAL'/);
  assert.match(correction, /'CONFIRMED', 'NORMAL'/);
  assert.match(correction, /'UNALLOCATED_MOVEMENT'/);
  assert.match(correction, /original_materialization_id/);
  assert.match(correction, /reversal_materialization_id/);
  assert.match(correction, /replacement_materialization_id/);
  assert.match(migration, /financial_reclassify_budget_change_destination_transfer/);
  assert.match(migration, /financial_project_decrease_classification_reversals/);
  assert.match(migration, /CLASSIFICATION_REVERSAL/);
  assert.match(migration, /REPLACEMENT_CLASSIFICATION/);
  assert.match(correction, /idempotency_key uuid not null unique/);
  assert.doesNotMatch(correction, /delete from public\.(project_fund_transfers|financial_unallocated_fund_movements)/);
  assert.doesNotMatch(correction, /update public\.(project_fund_transfers|financial_unallocated_fund_movements)/);
  assert.doesNotMatch(correction, /select lines, requests into/);
  assert.match(correction, /select lines\.\* into v_line[\s\S]*select requests\.\* into v_request/);
});

test('지자체 UI는 목적지 보정과 승인 없는 직접처리 안내를 함께 제공한다', () => {
  assert.match(actions, /get_financial_budget_change_destination_states/);
  assert.match(actions, /financial_correct_budget_change_destination/);
  assert.match(localUi, /correctBudgetChangeDestinationAction/);
  assert.match(localUi, /목적지 변경/);
  assert.match(localUi, /기존 이관 취소 후 새 목적지로 변경/);
  assert.match(localUi, /승인 없는 직접 처리 적용 중/);
  assert.match(adminUi, /등록·연결 모니터링/);
  assert.doesNotMatch(adminUi, /자동반영 예외 관리|사업코드 확인·예산 반영/);
});

test('install migration proves that no existing monetary rows change', () => {
  assert.match(migration, /^begin;/m);
  assert.match(migration, /budget_change_auto_apply_install_snapshot/);
  assert.match(migration, /row\(v_before\.\*\) is distinct from row\(v_after\.\*\)/);
  assert.match(migration, /commit;\s*$/);
});

test('TEST migration runner validates in a rollback-only transaction before apply', () => {
  assert.match(migrationRunner, /TARGET_ENV/);
  assert.match(migrationRunner, /TEST_PROJECT_REF/);
  assert.match(migrationRunner, /PROD_PROJECT_REF/);
  assert.match(migrationRunner, /--action/);
  assert.match(migrationRunner, /--confirm-test-write/);
  assert.match(migrationRunner, /transaction: 'ROLLED_BACK'/);
  assert.match(migrationRunner, /rollback_proof: true/);
  assert.match(migrationRunner, /business_rows_unchanged: true/);
  assert.doesNotMatch(migrationRunner, /service_role|SUPABASE_SERVICE_ROLE_KEY/);
});

test('TEST UAT proves automatic apply, append-only correction and regional isolation', () => {
  assert.match(uatRunner, /--confirm-test-write/);
  assert.match(uatRunner, /TARGET_ENV/);
  assert.match(uatRunner, /TEST_PROJECT_REF/);
  assert.match(uatRunner, /PROD_PROJECT_REF/);
  assert.match(uatRunner, /financial_test_uat_save_budget_change_request_complete_v2/);
  assert.match(uatRunner, /financial_correct_budget_change_destination/);
  assert.match(uatRunner, /BUDGET_REALLOCATION_AUTO_APPROVED/);
  assert.match(uatRunner, /BUDGET_REALLOCATION_DESTINATION_CORRECTED/);
  assert.match(uatRunner, /budget_conservation_gap: '0'/);
  assert.match(uatRunner, /field_name='financial_budget_change_requests'/);
  assert.match(uatRunner, /new_value::jsonb ->> 'record_id'/);
  assert.doesNotMatch(uatRunner, /service_role|SUPABASE_SERVICE_ROLE_KEY/);
});

test('classification hotfix links reversal and replacement classifications without data backfill', () => {
  assert.match(classificationHotfix, /^begin;/m);
  assert.match(classificationHotfix, /financial_project_decrease_classification_reversals/);
  assert.match(classificationHotfix, /CLASSIFICATION_REVERSAL/);
  assert.match(classificationHotfix, /REPLACEMENT_CLASSIFICATION/);
  assert.match(classificationHotfix, /financial_reclassify_budget_change_destination_transfer/);
  assert.match(classificationHotfix, /row\(v_before\.\*\) is distinct from row\(v_after\.\*\)/);
  assert.match(classificationHotfix, /commit;\s*$/);
  assert.match(classificationHotfixRunner, /--confirm-test-write/);
  assert.match(classificationHotfixRunner, /transaction: 'ROLLED_BACK'/);
  assert.match(classificationHotfixRunner, /rollback_proof: true/);
});
