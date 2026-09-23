import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const migrationPath = path.join(
  process.cwd(),
  'supabase',
  'migrations',
  '20260821000100_ledger_policy_delta.sql',
);
const migration = fs.readFileSync(migrationPath, 'utf8');

function section(from: string, to: string): string {
  const start = migration.indexOf(from);
  const end = migration.indexOf(to, start + from.length);
  assert.notEqual(start, -1, `missing section start: ${from}`);
  assert.notEqual(end, -1, `missing section end: ${to}`);
  return migration.slice(start, end);
}

test('delta is one fail-fast transaction and checks all existing zero-row tables/signatures', () => {
  assert.match(migration, /^begin;$/m);
  assert.equal((migration.match(/^begin;$/gm) ?? []).length, 1);
  assert.match(migration, /^commit;\s*$/m);
  assert.equal((migration.match(/^commit;$/gm) ?? []).length, 1);

  for (const table of [
    'project_budget_cohorts',
    'project_budget_years',
    'project_fund_transfers',
    'project_execution_records',
    'project_carryovers',
    'project_budget_adjustments',
    'financial_ledger_cutovers',
    'project_financial_baselines',
    'project_baseline_corrections',
    'project_metadata_history',
  ]) {
    assert.match(migration, new RegExp(`public\\.${table}`));
  }
  assert.match(migration, /to_regprocedure\('public\.create_carryover\(uuid,uuid,bigint,text,date,uuid\)'\)/);
  assert.match(migration, /to_regprocedure\('public\.create_project_budget_cohort\(uuid,integer,bigint,text,text,uuid\)'\)/);
  assert.match(migration, /to_regprocedure\('public\.financial_review_legacy_baseline\(uuid,text,text\)'\)/);
  assert.match(migration, /requires zero rows/i);
  assert.match(migration, /superseded runtime\/lineage hardening draft appears to have been applied/i);
});

test('fingerprint uses the catalog-confirmed pgcrypto schema with no unqualified digest call', () => {
  const fingerprint = section(
    'create or replace function public.financial_request_fingerprint',
    'create or replace function public.financial_assert_same_fingerprint',
  );
  assert.match(fingerprint, /set search_path = public, pg_temp/);
  assert.match(fingerprint, /extensions\.digest\(/);
  assert.doesNotMatch(migration, /(^|[^A-Za-z0-9_.])digest\s*\(/m);
});

test('runtime is fail-closed, project-ref bound, and still UNBOUND/DISABLED after migration', () => {
  assert.match(migration, /bound_project_ref text/);
  assert.match(migration, /environment_kind text not null default 'UNBOUND'/);
  assert.match(migration, /mode text not null default 'DISABLED'/);
  assert.match(migration, /mode in \('DISABLED', 'RECONCILIATION', 'TEST'\)/);
  assert.match(migration, /constraint financial_ledger_runtime_mode_value_check\s+check/);
  assert.match(migration, /constraint financial_ledger_runtime_mode_environment_check check/);
  assert.doesNotMatch(migration, /constraint financial_ledger_runtime_mode_check\b/);
  assert.match(migration, /baseline_as_of date not null default date '2026-08-31'/);
  assert.match(migration, /native_start_date date not null default date '2026-09-01'/);
  assert.match(migration, /financial_bind_test_ledger_environment/);
  assert.match(migration, /auth\.role\(\) is distinct from 'service_role'/);
  assert.match(migration, /where singleton = true and environment_kind = 'UNBOUND' and mode = 'DISABLED'/);
  assert.doesNotMatch(migration, /values \(true,\s*'TEST'/i);
});

test('origin policy separates SYSTEM_NATIVE dates from evidence-backed Legacy dates', () => {
  assert.match(migration, /record_origin = 'SYSTEM_NATIVE'.*2026-09-01/s);
  assert.match(migration, /record_origin = 'LEGACY_EXCEL'.*2022-01-01.*2026-08-31/s);
  assert.match(migration, /verification_status = 'VERIFIED'/);
  assert.match(migration, /financial_require_ledger_write\(/);
  assert.doesNotMatch(migration, /project_\w+_native_start_check/);
});

test('evidence is purpose-scoped, DRAFT-editable, and terminally immutable', () => {
  const evidence = section('-- 2. Purpose-scoped source evidence', '-- 3. Normalized');
  for (const token of [
    'region_id',
    'evidence_scope',
    'source_type',
    'source_system',
    'source_file_name',
    'source_file_sha256',
    'source_sheet_name',
    'source_row_reference',
    'external_reference',
    'evidence_note',
    'source_as_of_date',
    'import_batch_id',
    'created_by',
    'submitted_by',
    'verified_by',
    'rejected_by',
  ]) {
    assert.match(evidence, new RegExp(token));
  }
  assert.match(evidence, /source_file_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(evidence, /verified_by <> created_by/);
  assert.match(evidence, /old\.verification_status = 'DRAFT' and new\.verification_status = 'DRAFT'/);
  assert.match(migration, /financial_update_ledger_evidence_draft/);
  assert.match(evidence, /Terminal Ledger evidence is immutable/);
});

test('lineage is normalized with member evidence, DRAFT editing, final-person VERIFY, and never fuzzy', () => {
  const lineage = section('-- 3. Normalized, evidence-backed funding lineage', '-- 4. Origin');
  assert.match(lineage, /financial_project_lineages/);
  assert.match(lineage, /financial_project_lineage_members/);
  assert.match(lineage, /unique \(lineage_id, fiscal_year\)/);
  assert.match(lineage, /financial_project_lineage_members[\s\S]*evidence_id uuid not null/);
  assert.doesNotMatch(
    section('create table public.financial_project_lineages', 'create table public.financial_project_lineage_members'),
    /evidence_id/,
  );
  assert.match(lineage, /status in \('DRAFT', 'SUBMITTED', 'VERIFIED', 'REJECTED'\)/);
  assert.match(migration, /p_member_evidence_ids uuid\[\]/);
  assert.match(migration, /financial_update_project_lineage_draft/);
  assert.match(migration, /VERIFIED same-region PROJECT_LINEAGE evidence for every member/);
  assert.doesNotMatch(lineage, /project_code|project_name|similarity|levenshtein|trigram/i);

  const carryoverGuard = section(
    'create or replace function public.financial_assert_carryover_same_verified_lineage',
    'create or replace function public.financial_validate_carryover_verified_lineage',
  );
  assert.match(carryoverGuard, /lineages\.status = 'VERIFIED'/);
  assert.match(carryoverGuard, /same VERIFIED lineage, region, and immediately following fiscal year/);
});

test('Legacy reconstruction has the required workflow, event shapes, origin facts, and materializers', () => {
  assert.match(migration, /create table public\.legacy_ledger_reconstruction_entries/);
  assert.match(migration, /'ALLOCATION', 'EXECUTION', 'CARRYOVER', 'TRANSFER', 'ADJUSTMENT'/);
  assert.match(migration, /status in \('DRAFT', 'SUBMITTED', 'VERIFIED', 'REJECTED', 'APPLIED'\)/);
  assert.match(migration, /origin_fiscal_year integer/);
  assert.match(migration, /legacy_prior_carryover_count smallint/);
  assert.match(migration, /carryover_sequence smallint/);
  assert.match(migration, /carryover_type text/);
  assert.match(migration, /financial_submit_legacy_reconstruction/);
  assert.match(migration, /financial_verify_legacy_reconstruction/);
  assert.match(migration, /financial_apply_legacy_reconstruction/);
  assert.match(migration, /Apply the referenced Legacy ALLOCATION before this event/);
  assert.match(migration, /financial_assert_same_fingerprint/);
  assert.match(migration, /materialized_record_id/);
  assert.match(migration, /origin_fiscal_year = fiscal_year and legacy_prior_carryover_count = 0/);
  assert.match(migration, /p_origin_fiscal_year is distinct from p_fiscal_year/);
  assert.match(migration, /p_legacy_prior_carryover_count is distinct from 0/);
});

test('maker-checker covers all non-execution confirmations and direct legacy RPCs are revoked', () => {
  assert.match(migration, /request_type in \(\s*'CARRYOVER', 'BUDGET_ADJUSTMENT', 'EXECUTION_REVERSAL'/s);
  assert.match(migration, /approved_by <> requested_by/);
  assert.match(migration, /applied_by <> requested_by/);
  assert.match(migration, /v_transfer\.created_by = v_actor_id/);
  assert.match(migration, /v_cutover\.created_by = v_actor_id/);
  assert.match(migration, /v_lineage\.created_by = v_actor_id/);
  assert.match(migration, /v_entry\.created_by = v_actor_id/);
  assert.match(migration, /revoke all on function public\.create_carryover\(uuid, uuid, bigint, text, date, uuid\).*authenticated/i);
  assert.match(migration, /confirm_execution[\s\S]*v_actor_id, v_actor_id/);
});

test('Baseline uses explicit classifications, has correction RPCs, and auto-reconcile is read-only', () => {
  for (const state of [
    'NEEDS_REVIEW',
    'RECONCILED',
    'HISTORICAL',
    'EXCLUDED',
    'ACTIVE_AT_CUTOVER',
  ]) {
    assert.match(migration, new RegExp(`'${state}'`));
  }
  assert.match(migration, /Every project must be explicitly HISTORICAL, EXCLUDED, or ACTIVE_AT_CUTOVER/);
  assert.match(migration, /financial_request_baseline_correction/);
  assert.match(migration, /financial_submit_baseline_correction/);
  assert.match(migration, /financial_approve_baseline_correction/);
  assert.match(migration, /financial_reject_baseline_correction/);
  assert.match(migration, /financial_apply_baseline_correction/);

  const autoReconcile = section(
    'create or replace function public.financial_verify_reconciled_legacy_baselines',
    'create or replace function public.financial_confirm_ledger_cutover',
  );
  assert.doesNotMatch(autoReconcile, /update public\.project_financial_baselines/i);
  assert.match(autoReconcile, /language plpgsql\s+stable/i);
});

test('Cutover links only existing APPLIED Legacy wallets and synthesizes no cohort, wallet, or execution', () => {
  const cutover = section(
    'create or replace function public.financial_confirm_ledger_cutover',
    '-- Keep migration-19 metadata history behavior',
  );
  assert.match(cutover, /financial_resolve_applied_legacy_baseline_wallet/);
  assert.match(cutover, /legacy_funding_entry_id/);
  assert.match(cutover, /set ledger_budget_year_id = case[\s\S]*verification_status = 'ACTIVE_AT_CUTOVER'[\s\S]*v_budget_year_id/);
  assert.doesNotMatch(cutover, /insert into public\.project_budget_cohorts/i);
  assert.doesNotMatch(cutover, /insert into public\.project_budget_years/i);
  assert.doesNotMatch(cutover, /insert into public\.project_execution_records/i);

  const resolver = section(
    'create or replace function public.financial_resolve_applied_legacy_baseline_wallet',
    'create function public.financial_review_legacy_baseline',
  );
  assert.match(resolver, /event_type = 'ALLOCATION'/);
  assert.match(resolver, /status = 'APPLIED'/);
  assert.match(resolver, /complete APPLIED carryover path/);
  assert.match(resolver, /wallet materialized by APPLIED Legacy reconstruction/);
});

test('HISTORICAL requires APPLIED Legacy funding/path and zero active cohort balance', () => {
  const resolver = section(
    'create or replace function public.financial_resolve_applied_legacy_baseline_wallet',
    'create function public.financial_review_legacy_baseline',
  );
  const review = section(
    'create function public.financial_review_legacy_baseline',
    '-- Compatibility name retained',
  );
  const cutover = section(
    'create or replace function public.financial_confirm_ledger_cutover',
    '-- Keep migration-19 metadata history behavior',
  );

  assert.match(migration, /verification_status = 'HISTORICAL'[\s\S]{0,300}legacy_funding_entry_id is not null/);
  assert.match(resolver, /event_type = 'ALLOCATION'[\s\S]*status = 'APPLIED'[\s\S]*region_id = v_project_region_id/);
  assert.match(resolver, /fiscal_year = origin_fiscal_year[\s\S]*legacy_prior_carryover_count = 0/);
  assert.match(resolver, /with recursive applied_path[\s\S]*carryovers\.status = 'APPLIED'/);
  assert.match(resolver, /p_classification = 'HISTORICAL'[\s\S]*v_cohort_accounting_balance <> 0/);
  assert.match(review, /p_classification in \('HISTORICAL', 'ACTIVE_AT_CUTOVER'\)[\s\S]*p_legacy_funding_entry_id is null/);
  assert.match(cutover, /verification_status in \('HISTORICAL', 'ACTIVE_AT_CUTOVER'\)[\s\S]*legacy_funding_entry_id is null/);
  assert.match(migration, /verification_status = 'EXCLUDED'[\s\S]{0,350}legacy_funding_entry_id is null/);
});

test('ACTIVE_AT_CUTOVER requires a current APPLIED wallet with positive accounting balance', () => {
  const resolver = section(
    'create or replace function public.financial_resolve_applied_legacy_baseline_wallet',
    'create function public.financial_review_legacy_baseline',
  );
  assert.match(resolver, /financial_get_budget_year_balance\(v_budget_year_id\)/);
  assert.match(resolver, /v_available_balance is null or v_available_balance <= 0/);
  assert.match(resolver, /accounting_balance > 0; zero balance is HISTORICAL/);
  assert.match(resolver, /p_classification = 'HISTORICAL'[\s\S]*return v_budget_year_id;[\s\S]*ACTIVE_AT_CUTOVER requires/);
});

test('non-ALLOCATION Legacy events store no duplicate origin facts and fingerprints normalize them', () => {
  const eventTable = section(
    'create table public.legacy_ledger_reconstruction_entries',
    'create index legacy_ledger_reconstruction_region_status_idx',
  );
  for (const eventType of ['EXECUTION', 'CARRYOVER', 'TRANSFER', 'ADJUSTMENT']) {
    assert.match(
      eventTable,
      new RegExp(`event_type = '${eventType}'[\\s\\S]{0,260}origin_fiscal_year is null and legacy_prior_carryover_count is null`),
    );
  }

  const validation = section(
    'create or replace function public.financial_validate_legacy_reconstruction_values',
    'create or replace function public.financial_create_legacy_reconstruction_entry',
  );
  assert.match(validation, /p_origin_fiscal_year is not null or p_legacy_prior_carryover_count is not null/);
  assert.match(validation, /derive origin from funding_entry_id/);
  assert.ok((migration.match(/case when p_event_type = 'ALLOCATION' then jsonb_build_object\(/g) ?? []).length >= 2);

  const verify = section(
    'create or replace function public.financial_verify_legacy_reconstruction',
    'create or replace function public.financial_reject_legacy_reconstruction',
  );
  const apply = section(
    'create or replace function public.financial_apply_legacy_reconstruction',
    '-- 10. Vetted SYSTEM_NATIVE',
  );
  assert.match(verify, /v_entry\.origin_fiscal_year is not null or v_entry\.legacy_prior_carryover_count is not null/);
  assert.match(apply, /v_entry\.origin_fiscal_year is not null or v_entry\.legacy_prior_carryover_count is not null/);
});

test('Legacy carryover sequence is derived from the funding ALLOCATION origin in every lifecycle stage', () => {
  const validation = section(
    'create or replace function public.financial_validate_legacy_reconstruction_values',
    'create or replace function public.financial_create_legacy_reconstruction_entry',
  );
  const verify = section(
    'create or replace function public.financial_verify_legacy_reconstruction',
    'create or replace function public.financial_reject_legacy_reconstruction',
  );
  const apply = section(
    'create or replace function public.financial_apply_legacy_reconstruction',
    '-- 10. Vetted SYSTEM_NATIVE',
  );
  assert.match(validation, /p_destination_fiscal_year - v_funding\.origin_fiscal_year/);
  assert.match(verify, /v_entry\.destination_fiscal_year - v_funding\.origin_fiscal_year/);
  assert.match(apply, /v_entry\.destination_fiscal_year - v_funding\.origin_fiscal_year/);
});

test('change-request payloads fail fast at CREATE and are fully revalidated at APPLY', () => {
  const validator = section(
    'create or replace function public.financial_validate_change_request_payload',
    'create or replace function public.financial_change_request_region',
  );
  for (const requestType of [
    'CARRYOVER',
    'BUDGET_ADJUSTMENT',
    'EXECUTION_REVERSAL',
    'CARRYOVER_REVERSAL',
    'TRANSFER_REVERSAL',
    'ADJUSTMENT_REVERSAL',
  ]) {
    assert.match(validator, new RegExp(`'${requestType}'`));
  }
  assert.match(validator, /p_payload \?& array\['amount', 'effective_date'\]/);
  assert.match(validator, /jsonb_typeof\(p_payload -> 'amount'\) <> 'number'/);
  assert.match(validator, /source_budget_year_id', 'destination_project_id'/);
  assert.match(validator, /v_destination_year <> v_source\.fiscal_year \+ 1/);
  assert.match(validator, /financial_assert_carryover_same_verified_lineage/);
  assert.match(validator, /budget_year_id', 'adjustment_type'/);
  assert.match(validator, /original_record_id/);
  assert.match(validator, /status = 'CONFIRMED'.*transaction_kind = 'NORMAL'/);
  assert.match(validator, /invalid_text_representation or invalid_datetime_format/);
  assert.match(validator, /errcode = '22023'[\s\S]*malformed UUID, date, or bigint/);

  const create = section(
    'create or replace function public.financial_create_ledger_change_request',
    'create or replace function public.financial_submit_ledger_change_request',
  );
  assert.match(create, /v_region_id := public\.financial_validate_change_request_payload\(p_request_type, p_payload\)/);
  assert.ok(create.indexOf('financial_validate_change_request_payload') < create.indexOf('insert into public.financial_ledger_change_requests'));

  const apply = section(
    'create or replace function public.financial_apply_ledger_change_request',
    '-- 12. Baseline classification',
  );
  assert.match(apply, /financial_validate_change_request_payload\([\s\S]*v_request\.request_type, v_request\.payload/);
  assert.match(apply, /financial_assert_carryover_same_verified_lineage/);
  assert.match(apply, /financial_require_available_amount/);
  assert.match(apply, /Only confirmed normal execution may be reversed/);
  assert.match(apply, /v_amount > v_execution\.amount - v_reversed_amount/);
});

test('evidence date policy allows future lineage evidence but caps Legacy and Baseline evidence', () => {
  const evidence = section('-- 2. Purpose-scoped source evidence', '-- 3. Normalized');
  assert.match(evidence, /evidence_scope in \('LEGACY_RECONSTRUCTION', 'BASELINE'\)[\s\S]*2026-08-31/);
  assert.match(evidence, /evidence_scope = 'PROJECT_LINEAGE' and source_as_of_date >= date '2022-01-01'/);
  assert.doesNotMatch(evidence, /evidence_scope = 'PROJECT_LINEAGE'[^;]*2026-08-31/);
  assert.match(migration, /evidence_scope = 'LEGACY_RECONSTRUCTION'/);
});

test('Legacy carryover selected lineage must equal the actual VERIFIED source/destination lineage', () => {
  const validation = section(
    'create or replace function public.financial_validate_legacy_reconstruction_values',
    'create or replace function public.financial_create_legacy_reconstruction_entry',
  );
  assert.match(validation, /v_verified_lineage_id := public\.financial_assert_carryover_same_verified_lineage/);
  assert.match(validation, /p_lineage_id is distinct from v_verified_lineage_id/);

  const verify = section(
    'create or replace function public.financial_verify_legacy_reconstruction',
    'create or replace function public.financial_reject_legacy_reconstruction',
  );
  assert.match(verify, /v_entry\.lineage_id is distinct from v_verified_lineage_id/);

  const apply = section(
    'create or replace function public.financial_apply_legacy_reconstruction',
    '-- 10. Vetted SYSTEM_NATIVE',
  );
  assert.match(apply, /v_entry\.lineage_id is distinct from v_verified_lineage_id/);
});

test('runtime modes block DISABLED materialization, separate reconciliation, and reserve Native writes for TEST', () => {
  const guard = section(
    'create or replace function public.financial_require_ledger_write',
    'create or replace function public.financial_enforce_ledger_origin',
  );
  assert.match(guard, /v_runtime\.mode = 'DISABLED'[\s\S]*blocks every monetary Ledger materialization/);
  assert.match(guard, /p_record_origin = 'LEGACY_EXCEL'[\s\S]*mode not in \('RECONCILIATION', 'TEST'\)/);
  assert.match(guard, /p_record_origin = 'SYSTEM_NATIVE'[\s\S]*v_runtime\.mode <> 'TEST'/);
  assert.match(guard, /LEGACY_RECONSTRUCTION'[\s\S]*verification_status = 'VERIFIED'/);
});

test('cohort rate uses one cohort denominator and confirmed Ledger executions, never projects.exec', () => {
  const cohortSection = section('-- 13. Cohort accounting view', '-- 14. RLS');
  assert.match(cohortSection, /cohorts\.initial_allocation/);
  assert.match(cohortSection, /executions\.status = 'CONFIRMED'/);
  assert.match(cohortSection, /transaction_kind = 'REVERSAL'/);
  assert.match(cohortSection, /verified_cumulative_execution/);
  assert.match(cohortSection, /remaining_balance/);
  assert.match(cohortSection, /'UNRECONCILED'/);
  assert.doesNotMatch(cohortSection, /projects\.exec|projects\.alloc/);
});

test('authenticated has SELECT-only table access and no TRUNCATE/REFERENCES/TRIGGER', () => {
  assert.match(migration, /revoke all on table[\s\S]*from public, anon, authenticated;/);
  assert.match(migration, /revoke insert, update, delete, truncate, references, trigger on table[\s\S]*from anon, authenticated;/);
  assert.match(migration, /grant select on table[\s\S]*to authenticated;/);
  assert.doesNotMatch(migration, /grant\s+(insert|update|delete|truncate|references|trigger).*to authenticated/i);
});

test('delta performs no projects data mutation and creates no rows outside explicit future RPC bodies', () => {
  assert.doesNotMatch(migration, /update public\.projects\b/i);
  assert.doesNotMatch(migration, /delete from public\.(projects|regions|profiles)\b/i);
  assert.match(migration, /must not auto-create transactions, Baselines, reconstruction, or lineages/);
});
