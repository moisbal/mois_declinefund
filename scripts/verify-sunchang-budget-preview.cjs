#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';
const TEST_ALIAS = 'https://declinefund-test.vercel.app';
const CODES = [
  '2026-52-770-0001', '2026-52-770-0002', '2026-52-770-0006',
  '2027-52-770-UAT-0831-B', '2026-52-770-0005', '2026-52-770-0007',
  '2027-52-770-UAT-0831-C',
];

function fail(message) { throw new Error(message); }
function same(actual, expected, message) {
  if (String(actual) !== String(expected)) fail(`${message} (expected=${expected}, actual=${actual})`);
}
function load(file) {
  const resolved = path.resolve(process.cwd(), file ?? '');
  if (!file || !fs.existsSync(resolved)) fail(`Missing explicit file: ${file ?? '(none)'}`);
  return dotenv.parse(fs.readFileSync(resolved));
}
function required(env, key) {
  const value = String(env[key] ?? '').trim();
  if (!value) fail(`${key} is required.`);
  return value;
}
function ref(value, database = false) {
  try {
    const url = new URL(value);
    return database
      ? url.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i)?.[1]
        ?? decodeURIComponent(url.username).match(/^postgres\.([a-z0-9-]+)$/i)?.[1] ?? null
      : url.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i)?.[1] ?? null;
  } catch { return null; }
}
function connectionString(value) {
  const url = new URL(value);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('uselibpqcompat');
  return url.toString();
}

async function main() {
  const env = load(process.argv[2]);
  const credentials = load(process.argv[3]);
  const baseUrl = String(process.argv[4] ?? '').replace(/\/$/, '');
  const url = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  if (env.TARGET_ENV !== 'TEST' || env.TEST_PROJECT_REF !== TEST_REF || env.PROD_PROJECT_REF !== PROD_REF
      || ref(url) !== TEST_REF || ref(databaseUrl, true) !== TEST_REF || ref(databaseUrl, true) === PROD_REF
      || baseUrl !== TEST_ALIAS) fail('Fail-closed TEST Preview gate rejected configuration.');
  const anonKey = required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const local = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: auth, error: authError } = await local.auth.signInWithPassword({
    email: required(credentials, 'UAT_LOCAL_A_EMAIL'), password: required(credentials, 'UAT_LOCAL_A_PASSWORD'),
  });
  if (authError || !auth.user || !auth.session) fail('TEST local_a authentication failed.');
  const { data: profile, error: profileError } = await local.from('profiles')
    .select('role,region_id').eq('id', auth.user.id).single();
  if (profileError || profile?.role !== 'local_user' || !profile.region_id) fail('TEST local_a profile failed.');
  const { data: directProjects, error: projectsError } = await local.from('projects')
    .select('id,project_code').in('project_code', CODES);
  if (projectsError || directProjects?.length !== CODES.length) fail('Direct TEST Sunchang projects are incomplete.');
  const positions = new Map();
  for (const project of directProjects) {
    const { data, error } = await local.rpc('get_financial_budget_change_project_position', {
      p_project_id: project.id,
    });
    if (error || !data?.[0]) fail(`Direct position failed: ${project.project_code}`);
    positions.set(project.project_code, data[0]);
  }
  const { data: expectedStats, error: statsError } = await local.rpc('get_financial_budget_change_statistics', {
    p_year: null, p_region_id: profile.region_id,
  });
  if (statsError || !expectedStats?.[0]) fail('Direct Sunchang statistics failed.');
  const params = new URLSearchParams({
    timeBasis: 'current', sido: '전북', sigungu: '순창군', groupBy: 'project',
    rateBasis: 'adjusted', rateBand: 'all',
  });
  const headers = { Authorization: `Bearer ${auth.session.access_token}`, 'Cache-Control': 'no-cache' };
  const [analyticsResponse, summaryResponse] = await Promise.all([
    fetch(`${baseUrl}/api/analytics?${params}`, { headers, cache: 'no-store' }),
    fetch(`${baseUrl}/api/projects/summary`, { headers, cache: 'no-store' }),
  ]);
  if (!analyticsResponse.ok || !summaryResponse.ok) {
    fail(`Preview API failed (analytics=${analyticsResponse.status}, summary=${summaryResponse.status}).`);
  }
  for (const response of [analyticsResponse, summaryResponse]) {
    if (!(response.headers.get('cache-control') ?? '').includes('no-store')) fail('Preview API is not no-store.');
  }
  const [analytics, summary] = await Promise.all([analyticsResponse.json(), summaryResponse.json()]);
  same(summary.projectCount, analytics.kpis.projectCount, 'Sunchang Dashboard/Analytics project count');
  same(summary.allocSum, analytics.kpis.adjustedAllocation, 'Sunchang Dashboard/Analytics allocation');
  same(summary.execSum, analytics.kpis.cumulativeExecution, 'Sunchang Dashboard/Analytics execution');
  for (const field of ['transfer_amount', 'transfer_count', 'new_project_allocated_amount',
    'new_project_allocated_count', 'pending_new_project_amount', 'pending_new_project_count',
    'applied_request_count', 'transaction_gap_amount']) {
    same(analytics.budgetChangeStatistics?.[field], expectedStats[0][field], `Sunchang ${field}`);
  }
  same(analytics.budgetChangeStatistics.transaction_gap_amount, 0, 'Sunchang analytics GAP');
  const verified = [];
  for (const code of CODES) {
    const row = analytics.rows.find((item) => item.projectCode === code);
    if (!row) fail(`Sunchang Preview Analytics omitted ${code}.`);
    const direct = positions.get(code);
    same(row.originalAllocation, direct.original_allocation, `${code} original`);
    same(row.adjustedAllocation, direct.adjusted_allocation, `${code} adjusted`);
    same(row.cumulativeExecution, direct.execution_amount, `${code} execution`);
    same(row.unexecutedAmount, direct.unexecuted_amount, `${code} unexecuted`);
    verified.push({ code, adjusted_allocation: row.adjustedAllocation,
      execution: row.cumulativeExecution, unexecuted_amount: row.unexecutedAmount });
  }
  for (const code of ['2027-52-770-UAT-0831-B', '2027-52-770-UAT-0831-C']) {
    const value = positions.get(code);
    const adjusted = BigInt(value.original_allocation) + BigInt(value.increase_amount)
      - BigInt(value.decrease_amount);
    same(value.adjusted_allocation, adjusted, `${code} official allocation formula`);
    same(value.unexecuted_amount, adjusted - BigInt(value.execution_amount),
      `${code} unexecuted formula`);
  }

  const admin = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: adminAuth, error: adminAuthError } = await admin.auth.signInWithPassword({
    email: required(credentials, 'UAT_ADMIN_A_EMAIL'), password: required(credentials, 'UAT_ADMIN_A_PASSWORD'),
  });
  if (adminAuthError || !adminAuth.user) fail('TEST admin_a authentication failed.');
  const { data: pending, error: pendingError } = await admin.rpc('get_financial_budget_change_requests', {
    p_project_id: null, p_status: 'SUBMITTED', p_year: null, p_region_id: null,
  });
  if (pendingError) fail('TEST Admin pending queue failed.');
  const pg = new Client({ connectionString: connectionString(databaseUrl), ssl: { rejectUnauthorized: false },
    application_name: 'verify-sunchang-budget-preview' });
  await pg.connect();
  const integrity = (await pg.query(`select
      (select count(*)::integer from public.financial_budget_change_requests where status='SUBMITTED') pending,
      (select count(*)::integer from (
        select requests.id from public.financial_budget_change_requests requests
        join public.financial_budget_change_request_lines lines on lines.request_id=requests.id
        group by requests.id,requests.total_amount having requests.total_amount<>sum(lines.amount)) gaps) request_gaps,
      (select count(*)::integer from public.financial_funding_invariant_check
        where cohort_conservation_gap<>0 or decrease_resolution_gap<>0) invariant_gaps,
      (select count(*)::integer from public.financial_budget_change_request_lines lines
        join public.financial_budget_change_requests requests on requests.id=lines.request_id
        where requests.status='APPLIED' and (
          (lines.destination_type='EXISTING_PROJECT' and lines.materialized_transfer_id is null)
          or (lines.destination_type='PENDING_NEW_PROJECT' and lines.materialized_lot_id is null))) partial_apply_lines`)).rows[0];
  await pg.end();
  same(pending.length, integrity.pending, 'Preview Admin queue/DB pending');
  same(integrity.request_gaps, 0, 'Preview request GAP');
  same(integrity.invariant_gaps, 0, 'Preview invariant GAP');
  same(integrity.partial_apply_lines, 0, 'Preview partial APPLY');
  process.stdout.write(`${JSON.stringify({
    status: 'PASS', target: 'TEST Preview alias', base_url: baseUrl, region: '전북 순창군',
    project_count: summary.projectCount, adjusted_allocation: summary.allocSum,
    execution: summary.execSum, dashboard_analytics_synchronized: true,
    analytics_rows: analytics.rows.length, verified_projects: verified,
    budget_change_statistics: analytics.budgetChangeStatistics,
    queue: { db_pending_request: integrity.pending, admin_queue: pending.length },
    integrity, production_touched: false,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`SUNCHANG TEST PREVIEW VERIFICATION FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
