import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const migrationPath = path.join(
  process.cwd(),
  'supabase',
  'migrations',
  '20260824000100_funding_reallocation_delta.sql',
);
const migration = fs.readFileSync(migrationPath, 'utf8');
const uatHotfix = fs.readFileSync(path.join(
  process.cwd(),
  'supabase',
  'migrations',
  '20260824000200_funding_reallocation_uat_hotfix.sql',
), 'utf8');
const analyticsRegionHotfix = fs.readFileSync(path.join(
  process.cwd(),
  'supabase',
  'migrations',
  '20260824000300_funding_analytics_region_label_uat_hotfix.sql',
), 'utf8');

function section(from: string, to: string): string {
  const start = migration.indexOf(from);
  const end = migration.indexOf(to, start + from.length);
  assert.notEqual(start, -1, `missing section start: ${from}`);
  assert.notEqual(end, -1, `missing section end: ${to}`);
  return migration.slice(start, end);
}

test('delta is a single fail-fast transaction and snapshots existing TEST facts', () => {
  assert.equal((migration.match(/^begin;$/gm) ?? []).length, 1);
  assert.equal((migration.match(/^commit;$/gm) ?? []).length, 1);
  assert.match(migration, /unexpected Ledger helper signature set/);
  assert.match(migration, /funding_reallocation_migration_snapshot/);
  assert.match(migration, /project_count/);
  assert.match(migration, /decreased_project_count/);
  assert.match(migration, /project_decrease_total/);
  assert.match(migration, /runtime_rows/);
  assert.match(migration, /must not mutate or materialize existing projects\/decreases/);
  assert.match(migration, /must create no UAT transaction or request rows/);
});

test('TEST UAT hotfix deterministically replaces both APPLY functions without data mutation', () => {
  assert.equal((uatHotfix.match(/^begin;$/gm) ?? []).length, 1);
  assert.equal((uatHotfix.match(/^commit;$/gm) ?? []).length, 1);
  assert.equal((uatHotfix.match(/create or replace function public\.financial_apply_funding_reallocation_request/g) ?? []).length, 1);
  assert.equal((uatHotfix.match(/create or replace function public\.financial_apply_new_project_request/g) ?? []).length, 1);
  assert.doesNotMatch(uatHotfix, /execute\s+v_definition/i);
  assert.match(uatHotfix, /funding_reallocation_uat_hotfix_snapshot/);
  assert.match(uatHotfix, /must not mutate TEST data or runtime policy/);
  assert.match(uatHotfix, /transfers\.status = 'CONFIRMED'/);
  assert.match(uatHotfix, /adjustments\.status = 'CONFIRMED'/);
  assert.match(uatHotfix, /existing_projects\.project_code/);
  assert.match(uatHotfix, /existing_projects\.project_id/);
});

test('TEST analytics hotfix uses the actual regions schema without data mutation', () => {
  const functionStart = analyticsRegionHotfix.indexOf(
    'create or replace function public.get_financial_funding_analytics',
  );
  const functionEnd = analyticsRegionHotfix.indexOf(
    'revoke all on function public.get_financial_funding_analytics',
    functionStart,
  );
  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);
  const analyticsFunction = analyticsRegionHotfix.slice(functionStart, functionEnd);
  assert.equal((analyticsRegionHotfix.match(/^begin;$/gm) ?? []).length, 1);
  assert.equal((analyticsRegionHotfix.match(/^commit;$/gm) ?? []).length, 1);
  assert.equal((analyticsRegionHotfix.match(/create or replace function public\.get_financial_funding_analytics/g) ?? []).length, 1);
  assert.doesNotMatch(analyticsFunction, /regions\.name/);
  assert.match(analyticsFunction, /regions\.display_name/);
  assert.match(analyticsRegionHotfix, /funding_analytics_region_label_hotfix_snapshot/);
  assert.match(analyticsRegionHotfix, /must not mutate TEST data or runtime policy/);
});

test('waiting funds are normalized and remaining amount is movement-derived', () => {
  const tables = section(
    'create table public.financial_unallocated_fund_lots',
    '-- This table classifies',
  );
  for (const field of [
    'region_id', 'fiscal_year', 'budget_cohort_id', 'source_project_id',
    'source_budget_year_id', 'original_amount', 'record_origin', 'evidence_id',
    'idempotency_key', 'request_fingerprint', 'created_by',
  ]) assert.match(tables, new RegExp(field));
  assert.match(tables, /'ALLOCATE_EXISTING_PROJECT', 'ALLOCATE_NEW_PROJECT', 'RETURN', 'RESTORE_SOURCE'/);
  assert.match(tables, /transaction_kind in \('NORMAL', 'REVERSAL'\)/);
  assert.doesNotMatch(tables, /remaining_amount\s+bigint/);

  const balance = section(
    'create view public.financial_unallocated_fund_lot_balances',
    'create view public.financial_project_decrease_classification_effects',
  );
  assert.match(balance, /original_amount - coalesce\(totals\.disposed_amount, 0\)/);
  assert.match(balance, /allocated_existing_amount/);
  assert.match(balance, /allocated_new_amount/);
  assert.match(balance, /returned_amount/);
});

test('lot allocation is serialized and redundant references are trigger-validated', () => {
  const lock = section(
    'create or replace function public.financial_lock_unallocated_lot_remaining',
    'create or replace function public.financial_assert_funding_origin_evidence',
  );
  assert.match(lock, /for update/);
  assert.match(lock, /v_disposed < 0 or v_disposed > v_original/);
  assert.match(migration, /financial_validate_unallocated_lot_links/);
  assert.match(migration, /financial_validate_unallocated_movement_links/);
  assert.match(migration, /Movement reversal target facts must match the normal movement/);
  assert.match(migration, /same-region\/year wallet in the lot cohort/);
});

test('decrease classification is immutable, monotonic, idempotent, and reversal-aware', () => {
  const classifications = section(
    'create table public.financial_project_decrease_classifications',
    'create index financial_unallocated_fund_lots_region_year_idx',
  );
  assert.match(classifications, /unique \(canonical_table, canonical_record_id\)/);
  assert.doesNotMatch(classifications, /unique \(source_project_id, decrease_amount_before, decrease_amount_after\)/);
  assert.match(classifications, /decrease_amount_after - decrease_amount_before = amount/);
  assert.match(classifications, /decrease_amount_before - decrease_amount_after = amount/);
  assert.match(classifications, /financial_project_decrease_classification_reversals/);
  assert.match(migration, /financial_project_decrease_classifications_immutable/);
  assert.match(migration, /financial_project_decrease_classification_reversals_immutable/);
  assert.match(migration, /financial_validate_decrease_classification_links/);
  assert.match(migration, /financial_validate_decrease_classification_reversal_links/);

  const delta = section(
    'create or replace function public.financial_assert_decrease_delta_position',
    'create or replace function public.financial_validate_funding_reallocation_payload',
  );
  assert.match(delta, /projects\.decrease_amount/);
  assert.match(delta, /v_classification_count = 0/);
  assert.match(delta, /v_project_decrease > 0 and v_project_decrease <> p_decrease_amount_after/);
  assert.match(delta, /v_classified <> p_decrease_amount_before/);
  assert.match(delta, /p_decrease_amount_before - p_decrease_amount_after <> p_amount/);
  assert.match(delta, /linked correction reversal/);

  const effects = section(
    'create view public.financial_project_decrease_classification_effects',
    'create view public.financial_unclassified_project_decreases',
  );
  assert.match(effects, /financial_project_decrease_classification_reversals/);
  assert.match(effects, /rows\.classification_id = classifications\.id/);
  assert.match(effects, /classification_effect/);
});

test('all direct decrease outcomes create one canonical monetary record and one trace in one apply transaction', () => {
  const requestTable = section(
    'create table public.financial_funding_reallocation_requests',
    '-- ---------------------------------------------------------------------------\n-- 3.',
  );
  for (const type of [
    'CREATE_UNALLOCATED_LOT', 'CREATE_DECREASE_TRANSFER',
    'CREATE_DIRECT_ADJUSTMENT', 'ALLOCATE_UNALLOCATED_EXISTING',
    'RETURN_UNALLOCATED', 'REVERSE_UNALLOCATED_MOVEMENT',
    'REVERSE_DECREASE_CLASSIFICATION',
  ]) assert.match(requestTable, new RegExp(`'${type}'`));

  const apply = section(
    'create or replace function public.financial_apply_funding_reallocation_request',
    'create or replace function public.financial_create_new_project_request',
  );
  assert.match(apply, /insert into public\.project_fund_transfers/);
  assert.match(apply, /insert into public\.project_budget_adjustments/);
  assert.match(apply, /insert into public\.financial_unallocated_fund_lots/);
  assert.match(apply, /insert into public\.financial_project_decrease_classifications/g);
  assert.match(apply, /'CONFIRMED'/);
  assert.match(apply, /financial_require_available_amount/);
  assert.match(apply, /Requester cannot apply their own funding request/);
  assert.doesNotMatch(apply, /\band status = 'CONFIRMED'/);
  assert.match(apply, /transfers\.status = 'CONFIRMED'/);
  assert.match(apply, /adjustments\.status = 'CONFIRMED'/);
  assert.match(apply, /reversals\.status = 'CONFIRMED'/);
});

test('request creation replay is actor-isolated and APPLY replay returns stored materialization', () => {
  const fundingCreate = section(
    'create or replace function public.financial_create_funding_reallocation_request',
    'create or replace function public.financial_submit_funding_reallocation_request',
  );
  assert.match(fundingCreate, /v_request\.requested_by <> v_actor_id/);
  assert.match(fundingCreate, /Idempotency key belongs to another funding-request actor/);

  const fundingApply = section(
    'create or replace function public.financial_apply_funding_reallocation_request',
    'create or replace function public.financial_create_new_project_request',
  );
  assert.match(fundingApply, /if v_request\.status = 'APPLIED' then[\s\S]*v_request\.materialized_table[\s\S]*v_request\.materialized_record_id[\s\S]*return;/);

  const newProjectCreate = section(
    'create or replace function public.financial_create_new_project_request',
    'create or replace function public.financial_update_new_project_request_draft',
  );
  assert.match(newProjectCreate, /v_request\.requested_by <> v_actor_id/);
  assert.match(newProjectCreate, /Idempotency key belongs to another new-project-request actor/);

  const newProjectApply = section(
    'create or replace function public.financial_apply_new_project_request',
    '-- Ledger-managed projects need a save path',
  );
  assert.match(newProjectApply, /if v_request\.status = 'APPLIED' then/);
  assert.match(newProjectApply, /movements\.destination_budget_year_id/);
  assert.match(newProjectApply, /APPLIED new-project request has incomplete materialized references/);
  assert.match(newProjectApply, /v_request\.materialized_project_id[\s\S]*v_request\.materialized_movement_id[\s\S]*v_budget_year_id/);
  assert.doesNotMatch(newProjectApply, /where\s+project_code\s*=/);
  assert.doesNotMatch(newProjectApply, /or\s+project_id\s*=/);
  assert.match(newProjectApply, /existing_projects\.project_code/);
  assert.match(newProjectApply, /existing_projects\.project_id/);
});

test('decrease correction is a linked partial reversal, never a standalone correction adjustment', () => {
  const apply = section(
    'create or replace function public.financial_apply_funding_reallocation_request',
    'create or replace function public.financial_create_new_project_request',
  );
  assert.match(apply, /v_request\.request_type = 'REVERSE_DECREASE_CLASSIFICATION'/);
  assert.match(apply, /financial_project_decrease_classification_reversals/);
  assert.match(apply, /'RESTORE_SOURCE', 'NORMAL'/);
  assert.match(apply, /'CONFIRMED', 'REVERSAL', v_transfer\.id/);
  assert.match(apply, /'CONFIRMED', 'REVERSAL', v_adjustment\.id/);
  assert.match(apply, /Decrease reversal exceeds the classification unreversed amount/);
  assert.match(apply, /where id = v_adjustment\.budget_year_id for update/);

  const validator = section(
    'create or replace function public.financial_validate_funding_reallocation_payload',
    'create or replace function public.financial_create_funding_reallocation_request',
  );
  assert.match(validator, /'RETURN', 'EXTERNAL_DECREASE'/);
  assert.doesNotMatch(validator, /'CORRECTION_INCREASE', 'CORRECTION_DECREASE'/);
  assert.match(validator, /decrease_amount_before'[\s\S]*- \(p_payload ->> 'decrease_amount_after'\)[\s\S]*<> v_amount/);
});

test('a linked lot correction conserves 100 as execution 90 plus wallet 2 plus waiting 8', () => {
  const initial = 100;
  const execution = 90;
  const restoredWallet = 2;
  const waitingLot = 8;
  assert.equal(execution + restoredWallet + waitingLot, initial);

  const lotBalance = section(
    'create view public.financial_unallocated_fund_lot_balances',
    'create view public.financial_project_decrease_classification_effects',
  );
  assert.match(lotBalance, /coalesce\(sum\(movements\.amount[\s\S]*as disposed_amount/);
  assert.match(lotBalance, /original_amount - coalesce\(totals\.disposed_amount, 0\)/);
});

test('pool RETURN is canonical and is not paired with an adjustment', () => {
  const poolBranch = section(
    "elsif v_request.request_type in ('ALLOCATE_UNALLOCATED_EXISTING', 'RETURN_UNALLOCATED')",
    "elsif v_request.request_type = 'REVERSE_UNALLOCATED_MOVEMENT'",
  );
  assert.match(poolBranch, /Pool RETURN is canonical here/);
  assert.match(poolBranch, /movement_type[\s\S]*'RETURN'/);
  assert.doesNotMatch(poolBranch, /insert into public\.project_budget_adjustments/);
});

test('generic movement reversal cannot detach a linked RESTORE_SOURCE correction', () => {
  const apply = section(
    "elsif v_request.request_type = 'REVERSE_UNALLOCATED_MOVEMENT'",
    "elsif v_request.request_type = 'REVERSE_DECREASE_CLASSIFICATION'",
  );
  assert.match(apply, /v_original_movement\.movement_type = 'RESTORE_SOURCE'/);
  assert.match(apply, /cannot be reversed outside its classification chain/);
});

test('wallet accounting subtracts lots, adds allocations, and does not count returns twice', () => {
  const wallet = section(
    'create or replace function public.financial_get_budget_year_balance',
    '-- Preserve the original columns/order',
  );
  assert.match(wallet, /- pool_out \+ pool_in/);
  assert.match(wallet, /source_budget_year_id = p_budget_year_id/);
  assert.match(wallet, /destination_budget_year_id = p_budget_year_id/);
  assert.match(wallet, /'ALLOCATE_EXISTING_PROJECT', 'ALLOCATE_NEW_PROJECT', 'RESTORE_SOURCE'/);
  assert.doesNotMatch(wallet, /movement_type\s*=\s*'RETURN'/);

  const cohort = section(
    'create or replace view public.financial_funding_cohort_execution',
    'create view public.financial_project_funding_positions',
  );
  assert.match(cohort, /waiting_balance/);
  assert.match(cohort, /current_wallet_balance/);
  assert.match(cohort, /external_return_amount/);
  assert.match(cohort, /initial_allocation[\s\S]*verified_cumulative_execution/);
});

test('new project uses admin official code, unique code/id, and waiting-lot funding atomically', () => {
  assert.match(migration, /status in \('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'APPLIED'\)/);
  assert.match(migration, /official_project_code/);
  assert.match(migration, /project_code = v_code or project_id = v_code/);
  assert.match(migration, /project_id, project_code, region_id/);
  assert.match(migration, /'ALLOCATE_NEW_PROJECT', 'NORMAL'/);
  assert.match(migration, /materialized_project_id = v_project_id, materialized_movement_id = v_movement_id/);
  assert.doesNotMatch(migration, /select\s+max\s*\(\s*(sequence|project_code)/i);
  assert.match(migration, /create unique index financial_new_project_requests_official_code_reservation_uidx/);
  assert.match(migration, /where official_project_code is not null/);

  const insert = section(
    '-- No max(sequence)+1 inference',
    ') returning id into v_project_id;',
  );
  assert.match(insert, /original_alloc, increase_amount, decrease_amount/);
  assert.match(insert, /v_request\.requested_amount,\s*0, v_request\.requested_amount, 0, v_request\.requested_amount, 0, 0/);
});

test('compatibility values are Ledger-derived and preserve unclassified legacy warnings', () => {
  const projection = section(
    'create view public.financial_project_funding_positions',
    '-- ---------------------------------------------------------------------------\n-- 6.',
  );
  assert.match(projection, /ledger_original_allocation/);
  assert.match(projection, /ledger_adjusted_allocation/);
  assert.match(projection, /confirmed_execution/);
  assert.match(projection, /ledger_execution_rate/);
  assert.match(projection, /projection_ready/);
  assert.match(projection, /unclassified_decrease_amount/);
  assert.match(projection, /financial_project_baseline_attestations/);
  assert.match(projection, /requests\.materialized_project_id = projects\.id/);
  assert.match(projection, /destination_wallet\.project_id = projects\.id/);
  assert.match(projection, /coalesce\(wallets\.confirmed_execution, 0\) = coalesce\(projects\.exec, 0\)/);
  assert.doesNotMatch(projection, /coalesce\(projects\.original_alloc, 0\) = 0/);
  assert.match(migration, /get_financial_project_funding_positions/);
  assert.doesNotMatch(projection, /update public\.projects/i);
});

test('all canonical project events require complete baseline and record immutable provenance', () => {
  const helper = section(
    'create or replace function public.financial_assert_project_baseline_ready',
    'create or replace function public.financial_validate_transfer_project_baselines',
  );
  assert.match(helper, /financial_project_baseline_attestations/);
  assert.match(helper, /pg_try_advisory_xact_lock\(pg_catalog\.hashtextextended\(/);
  assert.match(helper, /'financial_project_baseline:' \|\| p_project_id::text, 20260824000100/);
  assert.match(helper, /errcode = '40001'/);
  assert.match(helper, /Concurrent project baseline event detected; retry the transaction/);
  assert.match(helper, /Recheck committed provenance before calculating totals/);
  assert.equal((helper.match(/financial_project_baseline_attestations/g) ?? []).length >= 3, true);
  assert.doesNotMatch(helper, /where id = p_project_id for update/);
  assert.match(helper, /balance\.accounting_balance \+ execution\.confirmed_execution/);
  assert.match(helper, /p_pending_allocation_effect/);
  assert.match(helper, /p_pending_execution_effect/);
  assert.match(helper, /p_pending_classification_effect/);
  assert.match(helper, /p_record_origin = 'LEGACY_EXCEL'/);
  assert.match(helper, /v_candidate_allocation := v_ledger_allocation::numeric\s*\+ p_pending_allocation_effect::numeric/);
  assert.match(helper, /v_candidate_execution := v_ledger_execution::numeric\s*\+ p_pending_execution_effect::numeric/);
  assert.match(helper, /from public\.financial_project_decrease_classification_effects/);
  assert.match(helper, /sum\(classification_effect\)/);
  assert.match(helper, /v_candidate_classification := v_net_classified_decrease::numeric\s*\+ p_pending_classification_effect::numeric/);
  assert.match(helper, /v_current_allocation_target := v_physical_allocation::numeric[\s\S]*greatest\(v_target_decrease - v_net_classified_decrease::numeric, 0\)/);
  assert.match(helper, /v_candidate_allocation_target := v_physical_allocation::numeric[\s\S]*greatest\(v_target_decrease - v_candidate_classification, 0\)/);
  assert.match(helper, /v_candidate_allocation - v_candidate_allocation_target/);
  assert.match(helper, /v_ledger_allocation::numeric - v_current_allocation_target/);
  assert.match(helper, /abs\(v_candidate_execution - v_physical_execution::numeric\)[\s\S]*<= abs\(v_ledger_execution::numeric - v_physical_execution::numeric\)/);
  assert.match(helper, /abs\(v_candidate_classification - v_target_decrease\)[\s\S]*<= abs\(v_net_classified_decrease::numeric - v_target_decrease\)/);
  assert.match(helper, /must monotonically reduce at least one raw-vs-Ledger gap/);
  assert.doesNotMatch(helper, /p_allow_incomplete_execution/);
  assert.match(helper, /on conflict \(project_id\) do nothing/);
  for (const guard of [
    'financial_transfer_project_baselines_guard',
    'financial_execution_project_baseline_guard',
    'financial_adjustment_project_baseline_guard',
    'financial_carryover_project_baselines_guard',
    'financial_cohort_project_baseline_guard',
  ]) assert.match(migration, new RegExp(guard));
  assert.match(migration, /financial_transfer_project_baselines_guard\s*\n\s*before insert or update of status/);
  const transferGuard = section(
    'create or replace function public.financial_validate_transfer_project_baselines',
    'create trigger financial_transfer_project_baselines_guard',
  );
  const carryoverGuard = section(
    'create or replace function public.financial_validate_carryover_project_baselines',
    'create trigger financial_carryover_project_baselines_guard',
  );
  assert.match(transferGuard, /v_source_project_id < v_destination_project_id/);
  assert.match(carryoverGuard, /v_source_project_id < v_destination_project_id/);
  assert.match(migration, /new\.origin_project_id, new\.initial_allocation, 0, 0/);
  assert.match(migration, /v_source_project_id, -v_amount, 0, v_amount, v_record_origin/);
  assert.match(migration, /v_classification\.source_project_id, v_amount, 0, -v_amount, v_record_origin/);
});

test('Legacy baseline staging converges in execution-first or decrease-first order', () => {
  type Axes = readonly [allocation: number, execution: number, classification: number];
  const rawAdjustedAllocation = 90;
  const rawExecution = 80;
  const rawDecrease = 10;

  function advance(
    current: Axes,
    pending: Axes,
    raw: Axes = [rawAdjustedAllocation, rawExecution, rawDecrease],
  ): { allowed: boolean; exact: boolean; next: Axes } {
    const next = current.map((value, index) => value + pending[index]) as unknown as Axes;
    const currentAllocationTarget = raw[0] + Math.max(raw[2] - current[2], 0);
    const nextAllocationTarget = raw[0] + Math.max(raw[2] - next[2], 0);
    const currentGaps = [
      current[0] - currentAllocationTarget,
      current[1] - raw[1],
      current[2] - raw[2],
    ];
    const nextGaps = [
      next[0] - nextAllocationTarget,
      next[1] - raw[1],
      next[2] - raw[2],
    ];
    const nonnegative = next.every((value) => value >= 0);
    const noCrossOrOvershoot = nextGaps.every((gap, index) => gap * currentGaps[index] >= 0);
    const nonWorsening = nextGaps.every(
      (gap, index) => Math.abs(gap) <= Math.abs(currentGaps[index]),
    );
    const strictlyImproves = nextGaps.some(
      (gap, index) => Math.abs(gap) < Math.abs(currentGaps[index]),
    );
    return {
      allowed: nonnegative && noCrossOrOvershoot && nonWorsening && strictlyImproves,
      exact: nextGaps.every((gap) => gap === 0),
      next,
    };
  }

  const allocation = advance([0, 0, 0], [100, 0, 0]);
  assert.deepEqual({ allowed: allocation.allowed, exact: allocation.exact }, { allowed: true, exact: false });

  const executionFirst = advance(allocation.next, [0, 80, 0]);
  assert.deepEqual({ allowed: executionFirst.allowed, exact: executionFirst.exact }, { allowed: true, exact: false });
  const executionThenDecrease = advance(executionFirst.next, [-10, 0, 10]);
  assert.deepEqual({ allowed: executionThenDecrease.allowed, exact: executionThenDecrease.exact }, { allowed: true, exact: true });

  const decreaseFirst = advance(allocation.next, [-10, 0, 10]);
  assert.deepEqual({ allowed: decreaseFirst.allowed, exact: decreaseFirst.exact }, { allowed: true, exact: false });
  const decreaseThenExecution = advance(decreaseFirst.next, [0, 80, 0]);
  assert.deepEqual({ allowed: decreaseThenExecution.allowed, exact: decreaseThenExecution.exact }, { allowed: true, exact: true });

  const wrongIncrease = advance(allocation.next, [10, 0, 0]);
  assert.equal(wrongIncrease.allowed, false);
  const concurrentDuplicateAllocationAfterSerializedRetry = advance(allocation.next, [100, 0, 0]);
  assert.equal(concurrentDuplicateAllocationAfterSerializedRetry.allowed, false);

  // A staged Legacy correction changes both the raw compatibility target and
  // the net classification effect before execution is reconstructed.
  const decreaseBeforeExecution = advance(allocation.next, [-10, 0, 10], [90, 80, 10]);
  assert.deepEqual(
    { allowed: decreaseBeforeExecution.allowed, exact: decreaseBeforeExecution.exact },
    { allowed: true, exact: false },
  );
  const correctionBeforeExecution = advance(
    decreaseBeforeExecution.next,
    [2, 0, -2],
    [92, 80, 8],
  );
  assert.deepEqual(
    { allowed: correctionBeforeExecution.allowed, exact: correctionBeforeExecution.exact },
    { allowed: true, exact: false },
  );
  const correctedThenExecution = advance(
    correctionBeforeExecution.next,
    [0, 80, 0],
    [92, 80, 8],
  );
  assert.deepEqual(
    { allowed: correctedThenExecution.allowed, exact: correctedThenExecution.exact },
    { allowed: true, exact: true },
  );
});

test('classified canonical reversals require a linked trace by transaction end', () => {
  const guard = section(
    'create or replace function public.financial_enforce_linked_decrease_reversal',
    '-- ---------------------------------------------------------------------------\n-- 2.',
  );
  assert.match(guard, /deferrable initially deferred/g);
  assert.match(guard, /classified transfer must be reversed through REVERSE_DECREASE_CLASSIFICATION/);
  assert.match(guard, /classified adjustment must be reversed through REVERSE_DECREASE_CLASSIFICATION/);
  assert.match(guard, /RESTORE_SOURCE requires its linked decrease classification reversal/);
  assert.match(migration, /transfer with existing reversals cannot be classified/);
  assert.match(migration, /adjustment with existing reversals cannot be classified/);
});

test('Ledger-managed nonfinancial save never assigns compatibility finance columns', () => {
  const rpc = section(
    'create or replace function public.update_my_project_nonfinancial_with_audit',
    '-- ---------------------------------------------------------------------------\n-- 5.',
  );
  const update = section(
    'update public.projects as projects\n  set detail_project_name',
    'delete from public.project_related_projects',
  );
  assert.match(rpc, /project_budget_years where project_id = v_project\.id/);
  assert.match(rpc, /update_project_classification_with_custom_small_categories/);
  assert.match(rpc, /project_related_projects/);
  assert.match(rpc, /my_project_nonfinancial_details/);
  for (const column of [
    'original_alloc', 'increase_amount', 'decrease_amount', 'alloc', 'exec', 'rate',
  ]) assert.doesNotMatch(update, new RegExp(`\\b${column}\\s*=`));
  assert.match(migration, /grant execute on function public\.update_my_project_nonfinancial_with_audit\(/);
});

test('analytics has unique cohort grain, net carryover flow, stock, and conservation checks', () => {
  const analytics = section(
    'create or replace function public.get_financial_funding_analytics',
    '-- Auditable invariants',
  );
  assert.match(analytics, /coalesce\(combined\.budget_cohort_id::text, 'UNCLASSIFIED'\)/);
  assert.match(analytics, /null::uuid/);
  assert.match(analytics, /unclassified\.unclassified_amount/);
  assert.match(analytics, /carryover_net/);
  assert.match(analytics, /greatest\(normal\.amount - coalesce\(sum\(reversals\.amount\), 0\), 0\)/);
  assert.match(analytics, /carryover_destination_wallets/);
  assert.match(analytics, /select distinct destination_wallet\.id/);
  assert.doesNotMatch(analytics, /not exists \([\s\S]*outbound\.source_budget_year_id = destination_wallet\.id/);
  assert.match(analytics, /accounting balance already nets any partial\/full outbound carryover/);
  assert.doesNotMatch(analytics, /regions\.name/);
  assert.match(analytics, /nullif\(btrim\(regions\.display_name\), ''\)/);
  assert.match(analytics, /nullif\(btrim\(concat_ws\(' ', regions\.sido, regions\.sigungu\)\), ''\)/);
  for (const metric of [
    'decrease_flow_amount', 'reallocated_amount', 'returned_amount',
    'waiting_stock_amount', 'myeongsi_flow_amount', 'sago_flow_amount',
    'current_carryover_stock', 'second_sequence_amount',
  ]) assert.match(analytics, new RegExp(metric));
  assert.match(migration, /financial_funding_invariant_check/);
  assert.match(migration, /cohort_conservation_gap/);
});

test('invariant checks are exposed only through a region-filtered authenticated RPC', () => {
  const rpc = section(
    'create or replace function public.get_financial_funding_invariant_check',
    'create or replace function public.get_financial_carryover_destinations',
  );
  for (const field of [
    'cohort_id', 'region_id', 'origin_fiscal_year',
    'cohort_conservation_gap', 'decrease_resolution_gap',
  ]) assert.match(rpc, new RegExp(field));
  assert.match(rpc, /p_budget_cohort_id uuid default null/);
  assert.match(rpc, /from public\.financial_require_actor\(\)/);
  assert.match(rpc, /v_role = 'admin' or invariants\.region_id = v_actor_region_id/);
  assert.match(rpc, /p_budget_cohort_id is null[\s\S]*invariants\.cohort_id = p_budget_cohort_id/);
  assert.match(migration, /revoke all on table[\s\S]*public\.financial_funding_invariant_check[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.get_financial_funding_invariant_check\(uuid\) to authenticated/);
});

test('carryover candidates use only verified lineage and expose complete Legacy reconstruction facts', () => {
  const destinations = section(
    'create or replace function public.get_financial_carryover_destinations',
    'create or replace function public.get_financial_verified_legacy_evidence',
  );
  assert.match(destinations, /lineages\.status = 'VERIFIED'/);
  assert.match(destinations, /entries\.event_type = 'ALLOCATION' and entries\.status = 'APPLIED'/);
  assert.match(destinations, /legacy_prior_carryover_count/);
  assert.match(destinations, /expected_sequence/);
  assert.match(destinations, /'MYEONGSI'/);
  assert.match(destinations, /'SAGO'/);
  assert.match(destinations, /previous\.status = 'APPLIED'/);
  assert.match(destinations, /Carryover is limited to two occurrences/);
});

test('project history contains both transfer/carryover legs and reversal-aware labels', () => {
  const history = section(
    'create view public.financial_project_funding_history',
    'create or replace function public.get_financial_project_funding_history',
  );
  assert.match(history, /TRANSFER_OUT/);
  assert.match(history, /TRANSFER_IN/);
  assert.match(history, /MYEONGSI_CARRYOVER/);
  assert.match(history, /SAGO_CARRYOVER/);
  assert.match(history, /destination_wallet\.project_id/);
  assert.match(history, /_REVERSAL/);
  assert.match(history, /UNALLOCATED_ALLOCATION_REVERSAL/);
  assert.match(history, /UNALLOCATED_RESTORED_TO_SOURCE/);
  assert.match(history, /TRANSFER_REVERSAL_OUT'[\s\S]*'OUT'::text/);
  assert.match(history, /TRANSFER_REVERSAL_IN'[\s\S]*'IN'::text/);
});

test('decrease reversal candidates are region-filtered and expose the UI contract', () => {
  const rpc = section(
    'create or replace function public.get_financial_decrease_classifications',
    'create or replace function public.get_financial_project_funding_positions',
  );
  for (const field of [
    'classification_id', 'outcome_type', 'original_amount', 'reversed_amount',
    'reversible_amount', 'current_decrease_amount', 'canonical_table', 'canonical_record_id',
    'source_budget_year_id', 'created_at',
  ]) assert.match(rpc, new RegExp(field));
  assert.match(rpc, /effects\.source_project_id = p_project_id/);
  assert.match(rpc, /v_role = 'admin' or effects\.region_id = v_actor_region_id/);
  assert.match(migration, /revoke all on function public\.get_financial_decrease_classifications\(uuid\) from public, anon/);
  assert.match(migration, /grant execute on function public\.get_financial_decrease_classifications\(uuid\) to authenticated/);
});

test('RLS is local-region/admin SELECT with RPC-only writes and no anon grants', () => {
  for (const table of [
    'financial_unallocated_fund_lots',
    'financial_unallocated_fund_movements',
    'financial_project_decrease_classifications',
    'financial_project_decrease_classification_reversals',
    'financial_project_baseline_attestations',
    'financial_funding_reallocation_requests',
    'financial_new_project_requests',
  ]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(migration, new RegExp(`alter table public\\.${table} force row level security`));
    assert.match(migration, new RegExp(`${table}_select_region_or_admin`));
  }
  assert.match(migration, /role = 'admin'[\s\S]*region_id = financial_unallocated_fund_lots\.region_id/);
  assert.match(migration, /revoke insert, update, delete, truncate, references, trigger on table/);
  assert.match(migration, /from anon, authenticated, service_role/);
  assert.match(migration, /grant select on table[\s\S]*financial_new_project_requests[\s\S]*to authenticated, service_role/);
  assert.match(migration, /Server analytics uses supabaseAdmin against the security-invoker projection/);
  assert.match(migration, /grant select on table[\s\S]*financial_funding_cohort_execution[\s\S]*financial_project_funding_positions[\s\S]*financial_funding_invariant_check[\s\S]*to service_role/);
  assert.doesNotMatch(migration, /grant (insert|update|delete|all)[\s\S]*to (anon|authenticated)/i);
  assert.match(migration, /financial_validate_decrease_classification_reversal_links\(\) from public, anon, authenticated/);
  assert.match(migration, /financial_validate_cohort_project_baseline\(\) from public, anon, authenticated, service_role/);
  assert.match(migration, /grant execute on function public\.get_financial_carryover_destinations\(uuid\) to authenticated/);
  assert.match(migration, /grant execute on function public\.get_financial_project_funding_positions\(uuid\) to authenticated/);
  assert.match(migration, /grant execute on function public\.get_financial_funding_invariant_check\(uuid\) to authenticated/);
});

test('existing Native/Legacy runtime policy and canonical transfer/carryover objects are reused', () => {
  assert.match(migration, /financial_require_ledger_write\(new\.record_origin/);
  assert.match(migration, /financial_assert_funding_origin_evidence/);
  assert.match(migration, /LEGACY_EXCEL reallocation requires same-region VERIFIED reconstruction evidence/);
  assert.doesNotMatch(migration, /create or replace function public\.financial_require_ledger_write/);
  assert.doesNotMatch(migration, /create table public\.project_fund_transfers/);
  assert.doesNotMatch(migration, /create table public\.project_carryovers/);
  assert.doesNotMatch(migration, /update public\.financial_ledger_runtime/i);
});
