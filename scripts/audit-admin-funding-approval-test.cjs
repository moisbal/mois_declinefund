#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';

function fail(message) { throw new Error(message); }
function load(file) {
  const resolved = path.resolve(process.cwd(), file ?? '');
  if (!file || !fs.existsSync(resolved)) fail(`Missing explicit env file: ${file ?? '(none)'}`);
  return dotenv.parse(fs.readFileSync(resolved));
}
function required(env, name) {
  const value = String(env[name] ?? '').trim();
  if (!value) fail(`${name} is required.`);
  return value;
}
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
async function rpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) fail(`${name}: ${error.code ?? 'RPC'} ${error.message}`);
  return Array.isArray(data) ? data : data == null ? [] : [data];
}

async function main() {
  if (process.argv.length !== 4) {
    fail('Usage: node scripts/audit-admin-funding-approval-test.cjs <explicit-test-env> <explicit-uat-credentials-env>');
  }
  const env = { ...load(process.argv[2]), ...load(process.argv[3]) };
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  const supabaseUrl = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (String(env.TARGET_ENV).toUpperCase() !== 'TEST'
      || env.TEST_PROJECT_REF !== TEST_REF || env.PROD_PROJECT_REF !== PROD_REF
      || refFromUrl(supabaseUrl) !== TEST_REF || refFromDatabase(databaseUrl) !== TEST_REF
      || refFromDatabase(databaseUrl) === PROD_REF) {
    fail('Fail-closed TEST target gate rejected configuration.');
  }

  const admin = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: auth, error: authError } = await admin.auth.signInWithPassword({
    email: required(env, 'UAT_ADMIN_A_EMAIL'),
    password: required(env, 'UAT_ADMIN_A_PASSWORD'),
  });
  if (authError || !auth.user) fail('TEST admin authentication failed.');

  const pg = new Client({
    connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
    application_name: 'audit-admin-funding-approval-test',
  });
  await pg.connect();
  try {
    await pg.query('begin read only');
    await pg.query("set local statement_timeout = '45s'");
    const runtime = (await pg.query(`select environment_kind, mode, bound_project_ref
      from public.financial_ledger_runtime where singleton`)).rows[0];
    if (runtime?.environment_kind !== 'TEST' || runtime?.bound_project_ref !== TEST_REF) {
      fail('Ledger runtime is not the approved TEST target.');
    }

    const [budgetRows, newProjectRows, linkRows, pendingRows] = await Promise.all([
      rpc(admin, 'get_financial_budget_change_requests', {
        p_project_id: null, p_status: null, p_year: null, p_region_id: null,
      }),
      rpc(admin, 'get_financial_new_project_requests', { p_status: null }),
      rpc(admin, 'get_financial_pending_new_project_link_requests', { p_status: null }),
      rpc(admin, 'get_financial_pending_new_project_funds', {
        p_status: null, p_year: null, p_region_id: null,
      }),
    ]);

    const rawBudgetStatus = new Map((await pg.query(`select id::text, status
      from public.financial_budget_change_requests`)).rows.map((row) => [row.id, row.status]));
    const uiCounts = {
      budget_actionable: budgetRows.filter((row) => {
        if (row.status === 'SUBMITTED' || row.status === 'APPROVED') return true;
        return row.status === 'DUPLICATE'
          && ['SUBMITTED', 'APPROVED'].includes(rawBudgetStatus.get(row.id));
      }).length,
      new_project_actionable: newProjectRows.filter((row) => !row.source_budget_change_request_id
        && ['SUBMITTED', 'APPROVED'].includes(row.status)).length,
      funding_link_actionable: linkRows.filter((row) => ['SUBMITTED', 'APPROVED'].includes(row.status)).length,
      pending_stock: pendingRows.filter((row) => row.status === 'WAITING').length,
    };

    const dbCounts = (await pg.query(`select
      (select count(*)::integer from public.financial_budget_change_requests
        where status in ('SUBMITTED','APPROVED')) budget_actionable,
      (select count(*)::integer from public.financial_new_project_requests
        where source_budget_change_request_id is null and status in ('SUBMITTED','APPROVED')) new_project_actionable,
      (select count(*)::integer from public.financial_pending_new_project_link_requests
        where status in ('SUBMITTED','APPROVED')) funding_link_actionable,
      (select count(*)::integer from public.financial_pending_new_project_funds
        where status='WAITING') pending_stock,
      (select count(*)::integer from public.financial_budget_change_requests
        where status in ('APPLIED','REJECTED')) budget_terminal,
      (select count(*)::integer from public.financial_new_project_requests
        where status in ('APPLIED','REJECTED')) new_project_terminal,
      (select count(*)::integer from public.financial_pending_new_project_link_requests
        where status in ('APPLIED','REJECTED')) funding_link_terminal`)).rows[0];

    const contradictions = (await pg.query(`select
      (select count(*)::integer
       from public.financial_budget_change_requests requests
       join public.financial_new_project_requests children
         on children.source_budget_change_request_id=requests.id
       where requests.status<>children.status) grouped_status_mismatch,
      (select count(*)::integer
       from public.financial_new_project_requests requests
       where requests.status='REJECTED'
         and (requests.materialized_project_id is not null or requests.materialized_movement_id is not null)) rejected_project_materialized,
      (select count(*)::integer
       from public.financial_pending_new_project_link_requests links
       join public.financial_pending_new_project_funds pending on pending.id=links.pending_fund_id
       where links.status='APPLIED'
         and (pending.status<>'LINKED' or pending.linked_project_id<>links.destination_project_id)) applied_link_not_linked,
      (select count(*)::integer
       from public.financial_new_project_requests requests
       join public.financial_pending_new_project_funds pending on pending.lot_id=requests.source_lot_id
       join public.financial_pending_new_project_link_requests links
         on links.pending_fund_id=pending.id and links.idempotency_key=requests.id
       where requests.status='REJECTED' and links.status='APPLIED') rejected_project_with_applied_link,
      (select count(*)::integer
       from public.financial_pending_new_project_funds pending
       left join public.financial_budget_change_requests requests on requests.id=pending.source_request_id
       left join public.financial_budget_change_request_lines lines on lines.id=pending.source_line_id
       where requests.id is null or lines.id is null) orphan_pending_fund,
      (select count(*)::integer
       from public.financial_pending_new_project_link_requests links
       left join public.financial_pending_new_project_funds pending on pending.id=links.pending_fund_id
       where pending.id is null) orphan_link_request,
      (select count(*)::integer
       from public.financial_new_project_requests requests
       left join public.financial_budget_change_requests parents
         on parents.id=requests.source_budget_change_request_id
       left join public.financial_budget_change_request_lines lines
         on lines.id=requests.source_budget_change_line_id
       where requests.source_budget_change_request_id is not null
         and (parents.id is null or lines.id is null)) orphan_grouped_new_project,
      (select count(*)::integer
       from public.financial_pending_new_project_funds pending
       join public.financial_new_project_requests requests on requests.source_lot_id=pending.lot_id
       where pending.status='WAITING' and requests.materialized_project_id is not null
         and not exists (select 1 from public.financial_pending_new_project_link_requests links
           where links.pending_fund_id=pending.id and links.status in ('SUBMITTED','APPROVED'))) materialized_without_open_link`)).rows[0];

    const monetary = (await pg.query(`select
      (select count(*)::integer from (
        select requests.id
        from public.financial_budget_change_requests requests
        left join public.financial_budget_change_request_lines lines on lines.request_id=requests.id
        group by requests.id,requests.total_amount
        having requests.total_amount<>coalesce(sum(lines.amount),0)) gaps) request_group_gaps,
      (select count(*)::integer from public.financial_funding_invariant_check
        where cohort_conservation_gap<>0 or decrease_resolution_gap<>0) ledger_invariant_gaps,
      (select coalesce(sum(requests.total_amount-coalesce(lines.total_amount,0)),0)::text
       from public.financial_budget_change_requests requests
       left join lateral (select sum(amount)::bigint total_amount
         from public.financial_budget_change_request_lines
         where request_id=requests.id) lines on true
       where requests.status='APPLIED') applied_transaction_gap`)).rows[0];

    const identifierAudit = (await pg.query(`select
      (select count(*)::integer from public.projects
        where coalesce(project_name,'') ~* '(^|[-_[:space:]])(UAT|AUTO-UAT|AUTO-BUDGET-UAT|GENERIC-BUDGET-UAT)([-_[:space:]]|$)'
          or coalesce(project_code,'') ~* '(^|[-_[:space:]])(UAT|AUTO-UAT|AUTO-BUDGET-UAT|GENERIC-BUDGET-UAT)([-_[:space:]]|$)') projects_with_internal_identifier,
      (select count(*)::integer from public.financial_new_project_requests
        where coalesce(project_name,'') ~* '(^|[-_[:space:]])(UAT|AUTO-UAT|AUTO-BUDGET-UAT|GENERIC-BUDGET-UAT)([-_[:space:]]|$)'
          or coalesce(official_project_code,'') ~* '(^|[-_[:space:]])(UAT|AUTO-UAT|AUTO-BUDGET-UAT|GENERIC-BUDGET-UAT)([-_[:space:]]|$)') requests_with_internal_identifier`)).rows[0];

    const samples = (await pg.query(`select year fiscal_year, project_name, project_code
      from public.projects
      where coalesce(project_name,'') ~* '(^|[-_[:space:]])(UAT|AUTO-UAT|AUTO-BUDGET-UAT|GENERIC-BUDGET-UAT)([-_[:space:]]|$)'
         or coalesce(project_code,'') ~* '(^|[-_[:space:]])(UAT|AUTO-UAT|AUTO-BUDGET-UAT|GENERIC-BUDGET-UAT)([-_[:space:]]|$)'
      order by year desc, project_name limit 10`)).rows;
    await pg.query('commit');

    const countMatch = Object.fromEntries(Object.keys(uiCounts)
      .map((key) => [key, Number(dbCounts[key]) === uiCounts[key]]));
    const hardContradictions = Object.fromEntries(Object.entries(contradictions)
      .filter(([key]) => key !== 'materialized_without_open_link'));
    const pass = Object.values(countMatch).every(Boolean)
      && Object.values(hardContradictions).every((value) => Number(value) === 0)
      && Number(monetary.request_group_gaps) === 0
      && Number(monetary.ledger_invariant_gaps) === 0
      && BigInt(monetary.applied_transaction_gap) === 0n;
    if (!pass) fail(`Admin funding audit failed: ${JSON.stringify({ countMatch, contradictions, monetary })}`);

    process.stdout.write(`${JSON.stringify({
      status: 'PASS', target: 'TEST', production_touched: false, runtime,
      queue_completeness: { database: dbCounts, ui_derived: uiCounts, matches: countMatch },
      state_consistency: contradictions,
      monetary_integrity: monetary,
      internal_identifier_audit: { ...identifierAudit, samples },
    }, null, 2)}\n`);
  } finally {
    await pg.query('rollback').catch(() => undefined);
    await pg.end().catch(() => undefined);
    await admin.auth.signOut().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`ADMIN FUNDING APPROVAL TEST AUDIT FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
