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
function client(url, key) {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}
async function signIn(url, key, email, password, label) {
  const instance = client(url, key);
  const { data, error } = await instance.auth.signInWithPassword({ email, password });
  if (error || !data.user) fail(`${label} TEST sign-in failed.`);
  return { label, id: data.user.id, client: instance };
}
async function rpc(account, name, args) {
  const { data, error } = await account.client.rpc(name, args ?? {});
  if (error) return { count: null, error: `${error.code ?? 'RPC'}:${error.message}` };
  return { count: Array.isArray(data) ? data.length : data == null ? 0 : 1, rows: data };
}
function compactRows(rows) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)));
}

async function main() {
  if (process.argv.length !== 4) {
    fail('Usage: node scripts/trace-admin-budget-workflow-test.cjs <explicit-test-env> <explicit-uat-credentials-env>');
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

  const [admin, localB] = await Promise.all([
    signIn(supabaseUrl, anonKey, required(env, 'UAT_ADMIN_A_EMAIL'), required(env, 'UAT_ADMIN_A_PASSWORD'), 'adminA'),
    signIn(supabaseUrl, anonKey, required(env, 'UAT_LOCAL_B_EMAIL'), required(env, 'UAT_LOCAL_B_PASSWORD'), 'localB'),
  ]);
  const pg = new Client({ connectionString: connectionString(databaseUrl), ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000, application_name: 'trace-admin-budget-workflow-test' });
  await pg.connect();
  try {
    await pg.query("set statement_timeout = '30s'");
    const runtime = (await pg.query(`select environment_kind, mode, bound_project_ref
      from public.financial_ledger_runtime where singleton`)).rows[0];
    if (runtime?.environment_kind !== 'TEST' || runtime?.bound_project_ref !== TEST_REF) fail('Ledger runtime is not approved TEST.');

    const profiles = (await pg.query(`select id, role, region_id from public.profiles where id = any($1::uuid[])`,
      [[admin.id, localB.id]])).rows;
    const localRegion = profiles.find((row) => row.id === localB.id)?.region_id;
    if (!localRegion) fail('localB region is missing.');

    const rawCounts = (await pg.query(`select
      (select count(*)::integer from public.financial_budget_change_requests) budget_requests,
      (select count(*)::integer from public.financial_pending_new_project_funds) pending_funds,
      (select count(*)::integer from public.financial_pending_new_project_link_requests) link_requests,
      (select count(*)::integer from public.financial_new_project_requests) new_project_requests,
      (select count(*)::integer from public.financial_funding_reallocation_requests) legacy_reallocation_requests,
      (select count(*)::integer from public.financial_budget_change_requests where region_id = $1) local_budget_requests,
      (select count(*)::integer from public.financial_pending_new_project_funds where region_id = $1) local_pending_funds,
      (select count(*)::integer from public.financial_pending_new_project_link_requests where region_id = $1) local_link_requests,
      (select count(*)::integer from public.financial_new_project_requests where region_id = $1) local_new_project_requests`,
      [localRegion])).rows[0];

    const [adminBudget, adminPending, adminLinks, adminNewProjects,
      localBudget, localPending, localLinks, localNewProjects] = await Promise.all([
      rpc(admin, 'get_financial_budget_change_requests', { p_project_id: null, p_status: null, p_year: null, p_region_id: null }),
      rpc(admin, 'get_financial_pending_new_project_funds', { p_status: null, p_year: null, p_region_id: null }),
      rpc(admin, 'get_financial_pending_new_project_link_requests', { p_status: null }),
      rpc(admin, 'get_financial_new_project_requests', { p_status: null }),
      rpc(localB, 'get_financial_budget_change_requests', { p_project_id: null, p_status: null, p_year: null, p_region_id: null }),
      rpc(localB, 'get_financial_pending_new_project_funds', { p_status: null, p_year: null, p_region_id: null }),
      rpc(localB, 'get_financial_pending_new_project_link_requests', { p_status: null }),
      rpc(localB, 'get_financial_new_project_requests', { p_status: null }),
    ]);

    const recent = (await pg.query(`select requests.id request_id, requests.status request_status,
      requests.fiscal_year source_year, source.project_code source_code,
      coalesce(nullif(btrim(source.detail_project_name),''), nullif(btrim(source.fund_project_name),''), source.project_name) source_name,
      requests.total_amount, requests.requested_at,
      lines.id line_id, lines.line_no, lines.destination_type, lines.amount line_amount,
      destination.year destination_year, destination.project_code destination_code,
      coalesce(nullif(btrim(destination.detail_project_name),''), nullif(btrim(destination.fund_project_name),''), destination.project_name) destination_name,
      lines.planned_project_year, lines.planned_project_name,
      pending.id pending_fund_id, pending.lot_id source_lot_id, pending.status pending_status,
      new_requests.id new_project_request_id, new_requests.status new_project_status,
      new_requests.project_name new_project_name, new_requests.materialized_project_id,
      links.id link_request_id, links.status link_status,
      linked.year linked_year, linked.project_code linked_code,
      coalesce(nullif(btrim(linked.detail_project_name),''), nullif(btrim(linked.fund_project_name),''), linked.project_name) linked_name
    from public.financial_budget_change_requests requests
    join public.projects source on source.id = requests.source_project_id
    join public.financial_budget_change_request_lines lines on lines.request_id = requests.id
    left join public.projects destination on destination.id = lines.destination_project_id
    left join public.financial_pending_new_project_funds pending on pending.source_line_id = lines.id
    left join public.financial_new_project_requests new_requests on new_requests.source_lot_id = pending.lot_id
    left join public.financial_pending_new_project_link_requests links on links.pending_fund_id = pending.id
    left join public.projects linked on linked.id = coalesce(links.destination_project_id, pending.linked_project_id, new_requests.materialized_project_id)
    where requests.region_id = $1 or requests.requested_at >= now() - interval '3 days'
    order by requests.requested_at desc, lines.line_no, new_requests.requested_at desc, links.requested_at desc
    limit 100`, [localRegion])).rows;

    const orphanSummary = (await pg.query(`select
      (select count(*)::integer from public.financial_pending_new_project_funds p
        left join public.financial_budget_change_requests r on r.id = p.source_request_id where r.id is null) pending_without_request,
      (select count(*)::integer from public.financial_pending_new_project_funds p
        left join public.financial_budget_change_request_lines l on l.id = p.source_line_id where l.id is null) pending_without_line,
      (select count(*)::integer from public.financial_new_project_requests n
        left join public.financial_pending_new_project_funds p on p.lot_id = n.source_lot_id where p.id is null) new_project_without_pending,
      (select count(*)::integer from public.financial_pending_new_project_link_requests l
        left join public.financial_pending_new_project_funds p on p.id = l.pending_fund_id where p.id is null) link_without_pending`)).rows[0];

    const apiCounts = {
      admin: { budget_requests: adminBudget.count, pending_funds: adminPending.count,
        link_requests: adminLinks.count, new_project_requests: adminNewProjects.count,
        errors: compactRows([adminBudget, adminPending, adminLinks, adminNewProjects].filter((item) => item.error)) },
      local_b: { budget_requests: localBudget.count, pending_funds: localPending.count,
        link_requests: localLinks.count, new_project_requests: localNewProjects.count,
        errors: compactRows([localBudget, localPending, localLinks, localNewProjects].filter((item) => item.error)) },
    };
    const countMatches = {
      admin_budget: rawCounts.budget_requests === apiCounts.admin.budget_requests,
      admin_pending: rawCounts.pending_funds === apiCounts.admin.pending_funds,
      admin_links: rawCounts.link_requests === apiCounts.admin.link_requests,
      admin_new_projects: rawCounts.new_project_requests === apiCounts.admin.new_project_requests,
      local_budget: rawCounts.local_budget_requests === apiCounts.local_b.budget_requests,
      local_pending: rawCounts.local_pending_funds === apiCounts.local_b.pending_funds,
      local_links: rawCounts.local_link_requests === apiCounts.local_b.link_requests,
      local_new_projects: rawCounts.local_new_project_requests === apiCounts.local_b.new_project_requests,
    };

    process.stdout.write(`${JSON.stringify({ status: 'PASS', target: 'TEST', production_touched: false,
      runtime, local_region_id: localRegion, raw_counts: rawCounts, authenticated_rpc_counts: apiCounts,
      raw_rpc_count_match: countMatches, orphan_summary: orphanSummary, recent_correlated_rows: compactRows(recent) }, null, 2)}\n`);
  } finally {
    await pg.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`TEST ADMIN BUDGET WORKFLOW TRACE FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
