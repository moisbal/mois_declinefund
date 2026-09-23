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
const EXPECTED_PROJECT_CODES = [
  '2024-51-800-0003',
  '2024-51-800-0002',
  '2024-51-800-0007',
  '2025-51-800-UAT-0831-G2',
];

function fail(message) { throw new Error(message); }
function load(file) {
  const resolved = path.resolve(process.cwd(), file ?? '');
  if (!file || !fs.existsSync(resolved)) fail(`Missing explicit file: ${file ?? '(none)'}`);
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
function same(actual, expected, message) {
  if (String(actual) !== String(expected)) fail(`${message} (expected=${expected}, actual=${actual})`);
}

async function main() {
  const env = load(process.argv[2]);
  const credentials = load(process.argv[3]);
  const baseUrl = String(process.argv[4] ?? '').replace(/\/$/, '');
  const supabaseUrl = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  if (String(env.TARGET_ENV ?? '').toUpperCase() !== 'TEST'
      || env.TEST_PROJECT_REF !== TEST_REF || env.PROD_PROJECT_REF !== PROD_REF
      || refFromUrl(supabaseUrl) !== TEST_REF || refFromDatabase(databaseUrl) !== TEST_REF
      || refFromDatabase(databaseUrl) === PROD_REF || baseUrl !== TEST_ALIAS) {
    fail('Fail-closed TEST Preview gate rejected configuration.');
  }
  const client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: required(credentials, 'UAT_LOCAL_C_EMAIL'),
    password: required(credentials, 'UAT_LOCAL_C_PASSWORD'),
  });
  if (error || !data.session || !data.user) fail('TEST local_c authentication failed.');
  const { data: profile, error: profileError } = await client.from('profiles')
    .select('role,region_id').eq('id', data.user.id).single();
  if (profileError || profile?.role !== 'local_user' || !profile.region_id) fail('TEST local_c profile lookup failed.');
  const { data: expectedStatsRows, error: expectedStatsError } = await client
    .rpc('get_financial_budget_change_statistics', { p_year: null, p_region_id: profile.region_id });
  if (expectedStatsError || !expectedStatsRows?.[0]) fail('Direct TEST budget-change statistics lookup failed.');
  const expectedStatistics = expectedStatsRows[0];
  const { data: projectRows, error: projectError } = await client.from('projects')
    .select('id,project_code').in('project_code', EXPECTED_PROJECT_CODES);
  if (projectError || projectRows?.length !== EXPECTED_PROJECT_CODES.length) {
    fail('Direct TEST UAT project lookup failed.');
  }
  const expectedPositions = new Map();
  for (const project of projectRows) {
    const { data: positionRows, error: positionError } = await client
      .rpc('get_financial_budget_change_project_position', { p_project_id: project.id });
    if (positionError || !positionRows?.[0]) fail(`Direct position lookup failed: ${project.project_code}`);
    expectedPositions.set(project.project_code, positionRows[0]);
  }

  const params = new URLSearchParams({
    timeBasis: 'current', sido: '강원', sigungu: '양구군', groupBy: 'project', rateBasis: 'adjusted', rateBand: 'all',
  });
  const [response, summaryResponse] = await Promise.all([
    fetch(`${baseUrl}/api/analytics?${params}`, {
      headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: 'no-store',
    }),
    fetch(`${baseUrl}/api/projects/summary`, {
      headers: { Authorization: `Bearer ${data.session.access_token}` }, cache: 'no-store',
    }),
  ]);
  if (!response.ok) fail(`Preview analytics returned HTTP ${response.status}.`);
  if (!summaryResponse.ok) fail(`Preview project summary returned HTTP ${summaryResponse.status}.`);
  for (const [label, previewResponse] of [['analytics', response], ['project summary', summaryResponse]]) {
    const cacheControl = previewResponse.headers.get('cache-control') ?? '';
    if (!cacheControl.includes('no-store')) {
      fail(`Preview ${label} response is not no-store.`);
    }
  }
  const [body, summary] = await Promise.all([response.json(), summaryResponse.json()]);
  const statistics = body.budgetChangeStatistics;
  if (!statistics) fail('Preview response omitted budgetChangeStatistics.');
  for (const field of [
    'transfer_amount', 'transfer_count', 'new_project_allocated_amount',
    'pending_new_project_amount', 'applied_request_count', 'transaction_gap_amount',
  ]) same(statistics[field], expectedStatistics[field], `Preview ${field}`);
  same(statistics.transaction_gap_amount, '0', 'Preview transaction gap');
  if (!Array.isArray(body.rows) || body.rows.length === 0) fail('Preview project analytics rows are missing.');
  if (!body.funding || body.funding.source !== 'confirmed_financial_ledger') fail('Preview funding Ledger source is missing.');
  if (!body.kpis) fail('Preview analytics KPI is missing.');
  same(summary.projectCount, body.kpis.projectCount, 'Dashboard/Analytics project count');
  same(summary.allocSum, body.kpis.adjustedAllocation, 'Dashboard/Analytics adjusted allocation');
  same(summary.execSum, body.kpis.cumulativeExecution, 'Dashboard/Analytics execution');
  const verifiedProjects = [];
  for (const code of EXPECTED_PROJECT_CODES) {
    const row = body.rows.find((candidate) => candidate.projectCode === code);
    if (!row) fail(`UAT project is missing from Preview analytics: ${code}`);
    const expected = expectedPositions.get(code);
    same(row.originalAllocation, expected.original_allocation, `${code} original allocation`);
    same(row.adjustedAllocation, expected.adjusted_allocation, `${code} adjusted allocation`);
    same(row.cumulativeExecution, expected.execution_amount, `${code} execution`);
    same(row.unexecutedAmount, expected.unexecuted_amount, `${code} unexecuted amount`);
    verifiedProjects.push({ project_code: code, adjusted_allocation: row.adjustedAllocation,
      execution: row.cumulativeExecution, unexecuted_amount: row.unexecutedAmount });
  }
  const newProject = expectedPositions.get('2025-51-800-UAT-0831-G2');
  same(newProject.original_allocation, '0', 'Preview new-project original allocation');
  same(newProject.increase_amount, '2000000', 'Preview new-project increase amount');
  same(newProject.adjusted_allocation, '2000000', 'Preview new-project adjusted allocation');
  same(newProject.execution_amount, '0', 'Preview new-project execution');
  same(newProject.unexecuted_amount, '2000000', 'Preview new-project unexecuted amount');
  same(newProject.execution_rate, '0', 'Preview new-project execution rate');

  const admin = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: adminAuth, error: adminAuthError } = await admin.auth.signInWithPassword({
    email: required(credentials, 'UAT_ADMIN_A_EMAIL'),
    password: required(credentials, 'UAT_ADMIN_A_PASSWORD'),
  });
  if (adminAuthError || !adminAuth.user) fail('TEST admin_a authentication failed.');
  const [submitted, approved] = await Promise.all([
    admin.rpc('get_financial_budget_change_requests', {
      p_project_id: null, p_status: 'SUBMITTED', p_year: null, p_region_id: null,
    }),
    admin.rpc('get_financial_budget_change_requests', {
      p_project_id: null, p_status: 'APPROVED', p_year: null, p_region_id: null,
    }),
  ]);
  if (submitted.error || approved.error) fail('Direct TEST Admin queue lookup failed.');
  const actionableQueueCount = (submitted.data?.length ?? 0) + (approved.data?.length ?? 0);
  const pg = new Client({ connectionString: connectionString(databaseUrl), ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000, application_name: 'verify-budget-change-preview' });
  await pg.connect();
  const finalAudit = (await pg.query(`select
      (select count(*)::integer from public.financial_budget_change_requests
       where status in ('SUBMITTED','APPROVED')) actionable_requests,
      (select count(*)::integer from public.financial_budget_change_requests
       where status='SUBMITTED') submitted_requests,
      (select count(*)::integer from (
        select requests.id from public.financial_budget_change_requests requests
        join public.financial_budget_change_request_lines lines on lines.request_id=requests.id
        group by requests.id,requests.total_amount
        having requests.total_amount<>sum(lines.amount)) gaps) request_gaps,
      (select count(*)::integer from public.financial_funding_invariant_check
       where cohort_conservation_gap<>0 or decrease_resolution_gap<>0) invariant_gaps,
      (select count(*)::integer from public.financial_budget_workflow_amount_snapshots
       where adjusted_before<>original_before+increase_before-decrease_before
          or unexecuted_before<>adjusted_before-execution_before
          or adjusted_after<>original_after+increase_after-decrease_after
          or unexecuted_after<>adjusted_after-execution_after) snapshot_formula_errors,
      (select count(*)::integer
       from public.financial_budget_change_request_lines lines
       join public.financial_budget_change_requests requests on requests.id=lines.request_id
       where requests.status='APPLIED' and (
         (lines.destination_type='EXISTING_PROJECT' and lines.materialized_transfer_id is null)
         or (lines.destination_type='PENDING_NEW_PROJECT' and lines.materialized_lot_id is null))) partial_apply_lines`)).rows[0];
  await pg.end();
  same(actionableQueueCount, finalAudit.actionable_requests, 'DB actionable request/Admin queue');
  same(finalAudit.request_gaps, 0, 'Final request monetary gaps');
  same(finalAudit.invariant_gaps, 0, 'Final ledger invariant gaps');
  same(finalAudit.snapshot_formula_errors, 0, 'Final snapshot formula errors');
  same(finalAudit.partial_apply_lines, 0, 'Final partial APPLY lines');

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    target: 'TEST Preview alias',
    base_url: baseUrl,
    authenticated_role: 'local_user',
    region: '강원 양구군',
    password_reset: false,
    analytics_rows: body.rows.length,
    funding_source: body.funding.source,
    dashboard_analytics_synchronized: true,
    no_store: true,
    verified_projects: verifiedProjects,
    new_project: { project_code: '2025-51-800-UAT-0831-G2',
      original_allocation: String(newProject.original_allocation),
      increase_amount: String(newProject.increase_amount),
      adjusted_allocation: String(newProject.adjusted_allocation),
      execution: String(newProject.execution_amount),
      unexecuted_amount: String(newProject.unexecuted_amount),
      execution_rate: Number(newProject.execution_rate) },
    admin_actionable_queue: actionableQueueCount,
    db_actionable_requests: finalAudit.actionable_requests,
    db_submitted_requests: finalAudit.submitted_requests,
    integrity: finalAudit,
    budget_change_statistics: statistics,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`TEST PREVIEW VERIFICATION FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
