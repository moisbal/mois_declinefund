#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';
const EXPECTED_PROJECT_COUNT = 3_905;
const TABLES = [
  'financial_budget_change_requests',
  'financial_budget_change_request_lines',
  'financial_pending_new_project_funds',
  'financial_pending_new_project_link_requests',
  'financial_test_uat_project_bootstraps',
];
const ROUTINES = [
  'financial_create_budget_change_request',
  'financial_test_uat_create_budget_change_request',
  'financial_test_uat_bootstrap_project',
  'financial_submit_budget_change_request',
  'financial_approve_budget_change_request',
  'financial_reject_budget_change_request',
  'financial_apply_budget_change_request',
  'financial_request_pending_new_project_link',
  'financial_review_pending_new_project_link',
  'financial_apply_pending_new_project_link',
  'get_financial_budget_change_candidates',
  'get_financial_budget_change_next_year_candidates',
  'get_financial_budget_change_requests',
  'get_financial_pending_new_project_funds',
  'get_financial_pending_new_project_link_requests',
  'get_financial_budget_change_project_position',
  'get_financial_budget_change_statistics',
  'get_financial_budget_change_statistics_filtered',
];

function fail(message) { throw new Error(message); }
function refFromUrl(value) {
  try { return new URL(value).hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i)?.[1] ?? null; } catch { return null; }
}
function refFromDatabase(value) {
  try {
    const url = new URL(value);
    return url.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i)?.[1]
      ?? decodeURIComponent(url.username).match(/^postgres\.([a-z0-9-]+)$/i)?.[1] ?? null;
  } catch { return null; }
}
function connectionString(value) {
  const url = new URL(value);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('uselibpqcompat');
  return url.toString();
}
function masked(value) { return `${value.slice(0, 3)}***${value.slice(-3)}`; }
function check(condition, message) { if (!condition) fail(message); }
function same(actual, expected, message) {
  if (String(actual) !== String(expected)) fail(`${message} (expected=${expected}, actual=${actual})`);
}

async function main() {
  const envArgument = process.argv[2];
  if (!envArgument || process.argv.length !== 3) {
    fail('Usage: node scripts/audit-budget-change-workflow-test.cjs <explicit-test-env-file>');
  }
  const envPath = path.resolve(process.cwd(), envArgument);
  if (!fs.existsSync(envPath)) fail('Explicit TEST env file does not exist.');
  const env = dotenv.parse(fs.readFileSync(envPath));
  const testRef = String(env.TEST_PROJECT_REF ?? '').trim();
  const prodRef = String(env.PROD_PROJECT_REF ?? '').trim();
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '').trim();
  if (String(env.TARGET_ENV ?? '').toUpperCase() !== 'TEST'
      || testRef !== TEST_REF || prodRef !== PROD_REF || testRef === prodRef
      || refFromUrl(env.NEXT_PUBLIC_SUPABASE_URL ?? '') !== TEST_REF
      || refFromDatabase(databaseUrl) !== TEST_REF
      || refFromDatabase(databaseUrl) === PROD_REF) {
    fail('Fail-closed target gate rejected configuration.');
  }

  const client = new Client({ connectionString: connectionString(databaseUrl), ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000, application_name: 'budget-change-final-test-audit' });
  await client.connect();
  try {
    await client.query("set statement_timeout = '30s'");
    const runtime = (await client.query(`select environment_kind, mode, bound_project_ref,
      baseline_as_of::text, native_start_date::text from public.financial_ledger_runtime where singleton = true`)).rows[0];
    check(runtime, 'Ledger runtime row is missing.');
    same(runtime.environment_kind, 'TEST', 'Ledger environment');
    same(runtime.mode, 'TEST', 'Ledger mode');
    same(runtime.bound_project_ref, TEST_REF, 'Ledger bound ref');
    same(runtime.baseline_as_of, '2026-08-31', 'Ledger baseline date');
    same(runtime.native_start_date, '2026-09-01', 'Ledger native start date');

    const projects = (await client.query(`select count(*)::integer as count,
      md5(string_agg(concat_ws('|', id::text, total_budget::text, original_alloc::text,
        increase_amount::text, decrease_amount::text, alloc::text, exec::text, rate::text), E'\\n' order by id)) as money_fingerprint,
      count(*) filter (where project_code = '2025-26-140-9001')::integer as linked_project_code_count
      from public.projects`)).rows[0];
    same(projects.count, EXPECTED_PROJECT_COUNT, 'TEST project count');
    same(projects.linked_project_code_count, 1, 'Linked official project code count');

    const workflow = (await client.query(`select
      (select count(*)::integer from public.financial_budget_change_requests) as requests,
      (select count(*)::integer from public.financial_budget_change_requests where status = 'APPLIED') as applied_requests,
      (select count(*)::integer from public.financial_budget_change_requests where status = 'REJECTED') as rejected_requests,
      (select count(*)::integer from public.financial_budget_change_request_lines) as lines,
      (select count(*)::integer from public.financial_budget_change_request_lines
        where destination_type = 'EXISTING_PROJECT' and materialized_transfer_id is not null) as transfer_lines,
      (select coalesce(sum(amount),0)::text from public.financial_budget_change_request_lines
        where destination_type = 'EXISTING_PROJECT' and materialized_transfer_id is not null) as transfer_amount,
      (select count(*)::integer from public.financial_budget_change_request_lines
        where destination_type = 'PENDING_NEW_PROJECT' and materialized_lot_id is not null and pending_fund_id is not null) as pending_lines,
      (select count(*)::integer from public.financial_pending_new_project_funds) as pending_funds,
      (select count(*)::integer from public.financial_pending_new_project_funds where status = 'LINKED') as linked_funds,
      (select coalesce(sum(amount),0)::text from public.financial_pending_new_project_funds where status = 'LINKED') as linked_amount,
      (select count(*)::integer from public.financial_pending_new_project_funds where status = 'WAITING') as waiting_funds,
      (select coalesce(sum(amount),0)::text from public.financial_pending_new_project_funds where status = 'WAITING') as waiting_amount,
      (select count(*)::integer from public.financial_pending_new_project_link_requests where status = 'APPLIED') as applied_links,
      (select count(*)::integer from public.financial_budget_change_requests
        where requested_by = approved_by or requested_by = applied_by) as maker_checker_violations,
      (select count(*)::integer from (
        select requests.id
        from public.financial_budget_change_requests requests
        left join public.financial_budget_change_request_lines lines on lines.request_id = requests.id
        group by requests.id, requests.total_amount
        having requests.total_amount <> coalesce(sum(lines.amount),0)
      ) gaps) as nonzero_request_gaps`)).rows[0];
    same(workflow.requests, 8, 'Workflow request count');
    same(workflow.applied_requests, 7, 'Applied request count');
    same(workflow.rejected_requests, 1, 'Rejected request count');
    same(workflow.lines, 11, 'Workflow line count');
    same(workflow.transfer_lines, 8, 'Materialized transfer line count');
    same(workflow.transfer_amount, '56000000', 'Materialized transfer amount');
    same(workflow.pending_lines, 2, 'Materialized pending line count');
    same(workflow.pending_funds, 2, 'Pending fund count');
    same(workflow.linked_funds, 1, 'Linked pending fund count');
    same(workflow.linked_amount, '4000000', 'Linked pending fund amount');
    same(workflow.waiting_funds, 1, 'Waiting pending fund count');
    same(workflow.waiting_amount, '5000000', 'Waiting pending fund amount');
    same(workflow.applied_links, 1, 'Applied pending link count');
    same(workflow.maker_checker_violations, 0, 'Maker-checker violation count');
    same(workflow.nonzero_request_gaps, 0, 'Nonzero request gap count');

    const bootstrap = (await client.query(`select count(*)::integer as count,
      count(*) filter (where bootstrap_kind = 'TEST_UAT_BOOTSTRAP')::integer as marked_count,
      count(*) filter (where project_id in (select id from public.projects where project_code in (
        '2025-51-800-0001', '2025-51-800-0012', '2025-51-800-0007', '2025-51-800-0008'
      )))::integer as uat_project_count,
      count(*) filter (where exists (select 1 from public.financial_project_funding_positions as positions
        where positions.project_id = financial_test_uat_project_bootstraps.project_id
          and positions.projection_ready))::integer as projection_ready_count
      from public.financial_test_uat_project_bootstraps`)).rows[0];
    same(bootstrap.count, 4, 'TEST UAT bootstrap count');
    same(bootstrap.marked_count, 4, 'TEST UAT bootstrap marker count');
    same(bootstrap.uat_project_count, 4, 'Actual unlinked UAT project count');
    same(bootstrap.projection_ready_count, 4, 'Bootstrapped projection-ready count');

    const linkedMovement = (await client.query(`select count(*)::integer as count,
      coalesce(sum(movements.amount),0)::text as amount
      from public.financial_pending_new_project_funds pending
      join public.financial_unallocated_fund_movements movements
        on movements.id = pending.linked_movement_id
      where pending.status = 'LINKED'
        and movements.movement_type = 'ALLOCATE_EXISTING_PROJECT'`)).rows[0];
    same(linkedMovement.count, 1, 'Linked movement count');
    same(linkedMovement.amount, '4000000', 'Linked movement amount');

    const invariants = (await client.query(`select count(*)::integer as cohort_count,
      count(*) filter (where cohort_conservation_gap <> 0 or decrease_resolution_gap <> 0)::integer as nonzero_gap_count,
      coalesce(max(abs(cohort_conservation_gap)),0)::text as max_conservation_gap,
      coalesce(max(abs(decrease_resolution_gap)),0)::text as max_decrease_gap
      from public.financial_funding_invariant_check`)).rows[0];
    same(invariants.nonzero_gap_count, 0, 'Ledger invariant nonzero gap count');

    const unclassified = (await client.query(`select count(*)::integer as count,
      coalesce(sum(unclassified_amount),0)::text as amount
      from public.financial_unclassified_project_decreases`)).rows[0];
    same(unclassified.count, 4, 'Pre-existing unclassified decrease count');
    same(unclassified.amount, '187703000', 'Pre-existing unclassified decrease amount');

    const legacy = (await client.query(`select
      (select concat(count(*)::text, ':', coalesce(sum(amount),0)::text) from public.project_carryovers) as carryovers,
      (select concat(count(*)::text, ':', coalesce(sum(amount),0)::text)
        from public.project_fund_transfers where transaction_kind = 'RETURN') as return_transfers,
      (select concat(count(*)::text, ':', coalesce(sum(amount),0)::text)
        from public.financial_unallocated_fund_movements where movement_type = 'RETURN') as return_movements`)).rows[0];

    const security = (await client.query(`select
      (select count(*)::integer from pg_catalog.pg_class tables
        join pg_catalog.pg_namespace schemas on schemas.oid = tables.relnamespace
        where schemas.nspname = 'public' and tables.relname = any($1::text[])
          and tables.relrowsecurity and tables.relforcerowsecurity) as forced_rls_tables,
      (select count(*)::integer from information_schema.role_table_grants
        where table_schema = 'public' and table_name = any($1::text[])
          and grantee in ('anon','authenticated')
          and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')) as forbidden_table_grants,
      (select count(distinct routine_name)::integer from information_schema.routine_privileges
        where routine_schema = 'public' and routine_name = any($2::text[])
          and grantee = 'authenticated' and privilege_type = 'EXECUTE') as authenticated_rpcs,
      (select count(*)::integer from information_schema.routine_privileges
        where routine_schema = 'public' and routine_name = any($2::text[])
          and grantee = 'anon' and privilege_type = 'EXECUTE') as anonymous_rpc_grants`, [TABLES, ROUTINES])).rows[0];
    same(security.forced_rls_tables, TABLES.length, 'Forced RLS table count');
    same(security.forbidden_table_grants, 0, 'Forbidden table grant count');
    same(security.authenticated_rpcs, ROUTINES.length, 'Authenticated RPC count');
    same(security.anonymous_rpc_grants, 0, 'Anonymous RPC grant count');

    const definitions = (await client.query(`select
      pg_get_functiondef('public.get_financial_budget_change_project_position(uuid)'::regprocedure) as position,
      pg_get_functiondef('public.get_financial_budget_change_candidates(uuid,text,integer,boolean)'::regprocedure) as candidates,
      pg_get_functiondef('public.get_financial_budget_change_next_year_candidates(uuid,text)'::regprocedure) as next_year_candidates,
      pg_get_functiondef('public.financial_apply_budget_change_request(uuid)'::regprocedure) as apply,
      pg_get_functiondef('public.financial_reject_budget_change_request(uuid,text)'::regprocedure) as reject,
      pg_get_functiondef('public.financial_test_uat_create_budget_change_request(uuid,uuid,jsonb,date,text,uuid,boolean)'::regprocedure) as bootstrap_create`)).rows[0];
    check(definitions.position.includes('bootstrap_decrease') && definitions.position.includes('gross_decrease'),
      'TEST bootstrap-aware Ledger position definition is missing.');
    check(definitions.candidates.toLowerCase().includes('projects.year <= v_anchor_year')
        && definitions.candidates.toLowerCase().includes('order by 2 desc, 4, 3'),
      'Current/past-year candidate conservation definition is missing.');
    check(definitions.next_year_candidates.toLowerCase().includes('projects.year = v_anchor_year + 1')
        && definitions.next_year_candidates.toLowerCase().includes('order by 4, 3'),
      'Next-year candidate conservation definition is missing.');
    check(definitions.apply.includes('request_lines.request_id = v_request.id')
        && definitions.apply.includes('financial_test_uat_bootstrap_project'),
      'TEST bootstrap-aware APPLY definition is missing.');
    check(definitions.reject.includes("status not in ('SUBMITTED', 'APPROVED')"),
      'Approved-request rejection definition is missing.');
    check(definitions.bootstrap_create.includes('financial_test_uat_bootstrap_project'),
      'On-demand request wrapper definition is missing.');

    process.stdout.write(`${JSON.stringify({
      status: 'PASS',
      target: 'TEST',
      project_ref: masked(TEST_REF),
      production_touched: false,
      runtime,
      projects,
      workflow,
      bootstrap,
      linked_movement: linkedMovement,
      invariants,
      pre_existing_unclassified_decreases: unclassified,
      legacy_history: legacy,
      security,
      hotfix_definitions: { position: true, current_and_past_year_candidates: true,
        next_year_candidates: true, apply: true, approved_rejection: true, on_demand_bootstrap: true },
    }, null, 2)}\n`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`FINAL TEST BUDGET-CHANGE AUDIT FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
