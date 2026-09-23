import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const migration = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260907000100_multi_destination_budget_change.sql',
), 'utf8');
const directWorkflowMigration = fs.readFileSync(path.join(
  root,
  'supabase/migrations/20260914000200_direct_new_project_and_post_checks.sql',
), 'utf8');
const localUi = fs.readFileSync(path.join(
  root,
  'components/my-projects/ProjectFundingManagementSection.tsx',
), 'utf8');
const newProjectUi = fs.readFileSync(path.join(
  root,
  'components/my-projects/NewProjectRequestPanel.tsx',
), 'utf8');
const adminUi = fs.readFileSync(path.join(
  root,
  'components/admin/FundingManagementShell.tsx',
), 'utf8');
const fundingAction = fs.readFileSync(path.join(root, 'app/my-projects/funding-actions.ts'), 'utf8');
const sharedNewProjectFields = fs.readFileSync(path.join(
  root,
  'components/my-projects/NewProjectRequestFields.tsx',
), 'utf8');

test('migration is fail-closed to TEST and preserves existing monetary rows while installing functions', () => {
  assert.match(migration, /^begin;/m);
  assert.match(migration, /commit;\s*$/);
  assert.match(migration, /bound_project_ref <> 'reviewtestxxxxxxxxxx'/);
  assert.match(migration, /multi_destination_budget_change_snapshot/);
  assert.match(migration, /row\(v_before\.\*\) is distinct from row\(v_after\.\*\)/);
});

test('funding-first destination keeps its generated draft and mixed destinations are not rejected', () => {
  const save = migration.slice(
    migration.indexOf('create or replace function public.financial_test_uat_save_budget_change_request_complete'),
    migration.indexOf('create or replace function public.financial_submit_budget_change_request'),
  );
  assert.match(save, /set unlinked_funding_only = true/);
  assert.doesNotMatch(save, /v_has_unlinked and v_has_other/);
  assert.doesNotMatch(save, /delete from public\.financial_new_project_requests/);
});

test('group submission keeps reserved drafts in DRAFT and directly materializes only immediate projects', () => {
  assert.match(migration, /and not lines\.unlinked_funding_only/);
  assert.match(directWorkflowMigration, /and not lines\.unlinked_funding_only/);
  assert.match(directWorkflowMigration, /financial_next_project_code/);
  assert.match(adminUi, /신규사업 초안/);
  assert.doesNotMatch(adminUi, /requiresOfficialProjectCode|reviewNewProjectRequestAction/);
});

test('one atomic APPLY supports existing transfers, pending funds and later automatic materialization', () => {
  const apply = migration.slice(
    migration.indexOf('create or replace function public.financial_apply_budget_change_request'),
    migration.indexOf('create or replace function public.financial_apply_budget_change_to_pending_funds'),
  );
  assert.match(apply, /insert into public\.project_fund_transfers/);
  assert.match(apply, /insert into public\.financial_pending_new_project_funds/);
  assert.match(apply, /source_lot_id = v_lot_id/);
  assert.match(apply, /source_budget_change_request_id = null/);
  assert.match(apply, /v_classification_after - v_classification_before <> v_request\.total_amount/);
  assert.match(migration, /financial_apply_pending_new_project_link/);
  assert.match(fundingAction, /financial_submit_new_project_request_v2/);
});

test('local UI preserves destination arrays, exposes both modes and explains disabled add buttons', () => {
  assert.match(localUi, /replaceBudgetDestination\(current, line\.key, replacement\)/);
  assert.doesNotMatch(localUi, /fundingOnly\s*\?\s*\[replacement\]/);
  assert.match(localUi, /기존에 신청·생성한 신규사업 연결/);
  assert.match(localUi, /예정재원 먼저 확보\(사업은 나중에 작성\)/);
  assert.match(localUi, /addDestinationDisabledReason/);
  assert.match(localUi, /감액 요청액 전액을 배분했습니다/);
});

test('deferred edit route reuses the same request id and all connected amounts use won format', () => {
  assert.match(localUi, /params\.set\('requestId', pending\.new_project_request_id\)/);
  assert.match(newProjectUi, /params\.get\('requestId'\)/);
  assert.match(newProjectUi, /setRequestId\(linkedRequest\.id\)/);
  assert.doesNotMatch(newProjectUi, /formatWonAsManwonWithUnit|만원/);
  assert.match(sharedNewProjectFields, /화면 표시 \$\{formatWonWithUnit\(value\.requestedAmount\)\}/);
  assert.doesNotMatch(sharedNewProjectFields, /formatWonAsManwonWithUnit|만원/);
});
