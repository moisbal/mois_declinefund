#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';
const RUN_TAG = 'admin-budget-workflow-uat-20260827';
const EFFECTIVE_DATE = '2026-09-01';
const TEN_MILLION = 10_000_000n;
const EIGHT_MILLION = 8_000_000n;

function fail(message) { throw new Error(message); }
function check(value, message) { if (!value) fail(message); }
function equal(actual, expected, message) {
  if (String(actual) !== String(expected)) fail(`${message} (expected=${expected}, actual=${actual})`);
}
function load(file) {
  const resolved = path.resolve(process.cwd(), file ?? '');
  if (!file || !fs.existsSync(resolved)) fail(`Missing explicit env file: ${file ?? '(none)'}`);
  return dotenv.parse(fs.readFileSync(resolved));
}
function required(env, name) { const value = String(env[name] ?? '').trim(); if (!value) fail(`${name} is required.`); return value; }
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
  const url = new URL(value); url.searchParams.delete('sslmode'); url.searchParams.delete('uselibpqcompat'); return url.toString();
}
function stableUuid(label) {
  const chars = crypto.createHash('sha256').update(`${RUN_TAG}:${label}`).digest('hex').slice(0, 32).split('');
  chars[12] = '4'; chars[16] = ['8', '9', 'a', 'b'][Number.parseInt(chars[16], 16) % 4];
  const value = chars.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
function newClient(url, key) {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}
async function signIn(url, key, email, password, label) {
  const instance = newClient(url, key);
  const { data, error } = await instance.auth.signInWithPassword({ email, password });
  if (error || !data.user || !data.session) fail(`${label} TEST sign-in failed.`);
  return { label, id: data.user.id, client: instance };
}
async function rpc(account, name, args, label = name) {
  const { data, error } = await account.client.rpc(name, args ?? {});
  if (error) fail(`${label}: ${error.code ?? 'RPC'} ${error.message}`);
  return data;
}
function first(rows, label) { check(Array.isArray(rows) && rows.length === 1, `${label} must return one row.`); return rows[0]; }
async function position(account, projectId, label) {
  const row = first(await rpc(account, 'get_financial_budget_change_project_position', { p_project_id: projectId }, label), label);
  equal(BigInt(row.original_allocation) + BigInt(row.increase_amount) - BigInt(row.decrease_amount), row.adjusted_allocation, `${label} allocation formula`);
  equal(BigInt(row.adjusted_allocation) - BigInt(row.execution_amount), row.unexecuted_amount, `${label} unexecuted formula`);
  return row;
}
async function approveApplyBudget(requestId, adminA, adminB) {
  const all = await rpc(adminA, 'get_financial_budget_change_requests', {
    p_project_id: null, p_status: null, p_year: null, p_region_id: null,
  });
  let row = all.find((item) => item.id === requestId);
  check(row, 'Admin budget queue omitted the submitted request.');
  if (row.status === 'SUBMITTED') await rpc(adminA, 'financial_approve_budget_change_request', { p_request_id: requestId }, 'budget approve');
  const approved = (await rpc(adminA, 'get_financial_budget_change_requests', {
    p_project_id: null, p_status: null, p_year: null, p_region_id: null,
  })).find((item) => item.id === requestId);
  if (approved?.status === 'APPROVED') await rpc(adminB, 'financial_apply_budget_change_request', { p_request_id: requestId }, 'budget apply');
  const applied = (await rpc(adminA, 'get_financial_budget_change_requests', {
    p_project_id: null, p_status: null, p_year: null, p_region_id: null,
  })).find((item) => item.id === requestId);
  equal(applied?.status, 'APPLIED', 'Budget request final status');
  await rpc(adminB, 'financial_apply_budget_change_request', { p_request_id: requestId }, 'budget duplicate apply');
  return applied;
}
async function createBudget(local, sourceProjectId, destinations, amount, key, reason) {
  const row = first(await rpc(local, 'financial_test_uat_create_budget_change_request', {
    p_source_project_id: sourceProjectId, p_source_budget_year_id: null,
    p_destinations: destinations, p_effective_date: EFFECTIVE_DATE,
    p_reason: reason, p_idempotency_key: stableUuid(key), p_submit: true,
  }, reason), reason);
  equal(row.gap_amount, '0', `${reason} gap`);
  return row;
}
async function queueCounts(pg, admin, regionId) {
  const raw = (await pg.query(`select
    (select count(*)::integer from public.financial_budget_change_requests) budget_requests,
    (select count(*)::integer from public.financial_pending_new_project_funds) pending_funds,
    (select count(*)::integer from public.financial_new_project_requests) new_project_requests,
    (select count(*)::integer from public.financial_pending_new_project_link_requests) link_requests,
    (select count(*)::integer from public.financial_budget_change_requests where region_id=$1) local_budget_requests,
    (select count(*)::integer from public.financial_pending_new_project_funds where region_id=$1) local_pending_funds,
    (select count(*)::integer from public.financial_new_project_requests where region_id=$1) local_new_project_requests,
    (select count(*)::integer from public.financial_pending_new_project_link_requests where region_id=$1) local_link_requests`, [regionId])).rows[0];
  const [budget, pending, projects, links] = await Promise.all([
    rpc(admin, 'get_financial_budget_change_requests', { p_project_id: null, p_status: null, p_year: null, p_region_id: null }),
    rpc(admin, 'get_financial_pending_new_project_funds', { p_status: null, p_year: null, p_region_id: null }),
    rpc(admin, 'get_financial_new_project_requests', { p_status: null }),
    rpc(admin, 'get_financial_pending_new_project_link_requests', { p_status: null }),
  ]);
  equal(budget.length, raw.budget_requests, 'Admin budget raw/RPC count');
  equal(pending.length, raw.pending_funds, 'Admin pending raw/RPC count');
  equal(projects.length, raw.new_project_requests, 'Admin new-project raw/RPC count');
  equal(links.length, raw.link_requests, 'Admin link raw/RPC count');
  return { raw, admin_rpc: { budget_requests: budget.length, pending_funds: pending.length,
    new_project_requests: projects.length, link_requests: links.length } };
}

async function main() {
  if (process.argv.length !== 4) fail('Usage: node scripts/run-admin-budget-workflow-uat.cjs <test-env> <uat-credentials-env>');
  const env = { ...load(process.argv[2]), ...load(process.argv[3]) };
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  const url = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const anon = required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (String(env.TARGET_ENV).toUpperCase() !== 'TEST' || env.TEST_PROJECT_REF !== TEST_REF
      || env.PROD_PROJECT_REF !== PROD_REF || refFromUrl(url) !== TEST_REF
      || refFromDatabase(databaseUrl) !== TEST_REF || refFromDatabase(databaseUrl) === PROD_REF) {
    fail('Fail-closed TEST target gate rejected configuration.');
  }
  const [adminA, adminB, localB] = await Promise.all([
    signIn(url, anon, required(env, 'UAT_ADMIN_A_EMAIL'), required(env, 'UAT_ADMIN_A_PASSWORD'), 'adminA'),
    signIn(url, anon, required(env, 'UAT_ADMIN_B_EMAIL'), required(env, 'UAT_ADMIN_B_PASSWORD'), 'adminB'),
    signIn(url, anon, required(env, 'UAT_LOCAL_B_EMAIL'), required(env, 'UAT_LOCAL_B_PASSWORD'), 'localB'),
  ]);
  const pg = new Client({ connectionString: connectionString(databaseUrl), ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000, application_name: 'admin-budget-workflow-uat' });
  await pg.connect();
  try {
    await pg.query("set statement_timeout = '60s'");
    const localProfile = (await pg.query(`select role,region_id from public.profiles where id=$1`, [localB.id])).rows[0];
    equal(localProfile?.role, 'local_user', 'localB role');
    const regionId = localProfile.region_id;
    const fixtures = (await pg.query(`select id, project_code,
      coalesce(nullif(btrim(detail_project_name),''), nullif(btrim(fund_project_name),''), project_name) project_name,
      coalesce(alloc,0)::bigint alloc, coalesce(exec,0)::bigint exec
      from public.projects
      where region_id=$1 and year=2024 and coalesce(alloc,0)-coalesce(exec,0) >= $2
        and project_code is not null
      order by (coalesce(alloc,0)-coalesce(exec,0)) desc, project_code
      limit 6`, [regionId, TEN_MILLION.toString()])).rows;
    check(fixtures.length >= 3, 'localB needs three 2024 projects with sufficient unexecuted allocation.');
    const [sourceA, destinationB, sourceC] = fixtures;
    const regionBefore = (await pg.query(`select
      coalesce(sum(coalesce(positions.ledger_adjusted_allocation, projects.alloc, 0)),0)::bigint
        + (select coalesce(sum(amount),0)::bigint from public.financial_pending_new_project_funds
           where region_id=$1 and status='WAITING') total
      from public.projects
      left join public.financial_project_funding_positions positions on positions.project_id=projects.id
      where projects.region_id=$1`, [regionId])).rows[0].total;

    const scenarioARequest = await createBudget(localB, sourceA.id, [{
      destination_type: 'EXISTING_PROJECT', destination_project_id: destinationB.id,
      amount: TEN_MILLION.toString(), note: 'UAT Scenario A existing destination',
    }], TEN_MILLION, 'scenario-a-budget', 'UAT Scenario A · 2024 existing project');
    await approveApplyBudget(scenarioARequest.request_id, adminA, adminB);
    const [sourceAPosition, destinationBPosition] = await Promise.all([
      position(localB, sourceA.id, 'Scenario A source'), position(localB, destinationB.id, 'Scenario A destination'),
    ]);

    const scenarioBRequest = await createBudget(localB, sourceC.id, [{
      destination_type: 'PENDING_NEW_PROJECT', planned_project_name: '지역 미래산업 연계 검증사업',
      planned_project_year: 2025, amount: EIGHT_MILLION.toString(), note: 'UAT Scenario B next-year new project',
    }], EIGHT_MILLION, 'scenario-b-budget', 'UAT Scenario B · 2025 new project');
    await approveApplyBudget(scenarioBRequest.request_id, adminA, adminB);
    const pending = first(await rpc(localB, 'get_financial_pending_new_project_funds', {
      p_status: null, p_year: 2025, p_region_id: regionId,
    }).then((rows) => rows.filter((row) => row.source_request_id === scenarioBRequest.request_id)), 'Scenario B pending fund');
    const lot = (await pg.query(`select lot_id from public.financial_pending_new_project_funds where id=$1`, [pending.id])).rows[0];
    check(lot?.lot_id, 'Scenario B pending lot link is missing.');

    let newProject = (await rpc(localB, 'get_financial_new_project_requests', { p_status: null }))
      .find((row) => row.source_lot_id === lot.lot_id);
    if (!newProject) {
      const draft = first(await rpc(localB, 'financial_create_new_project_request', {
        p_region_id: regionId, p_fiscal_year: 2025,
        p_project_name: '지역 미래산업 연계 검증사업', p_fund_project_name: '지역 미래산업 연계 검증사업',
        p_detail_project_name: '지역 미래산업 연계 검증사업', p_project_period: '2025.01~2025.12',
        p_project_start_year: 2025, p_project_end_year: 2025, p_status: '정상추진',
        p_business_type: 'HW', p_large_category_id: null, p_middle_category_id: null,
        p_source_lot_id: lot.lot_id, p_requested_amount: EIGHT_MILLION.toString(),
        p_idempotency_key: stableUuid('scenario-b-new-project'), p_submit: false,
      }, 'Scenario B new project draft'), 'Scenario B new project draft');
      await rpc(localB, 'financial_submit_new_project_request', { p_request_id: draft.request_id }, 'Scenario B new project submit');
      newProject = (await rpc(adminA, 'get_financial_new_project_requests', { p_status: null }))
        .find((row) => row.id === draft.request_id);
    }
    check(newProject, 'Admin new-project queue omitted Scenario B.');
    const officialCode = '2025-26-140-9827';
    if (newProject.status === 'SUBMITTED') {
      await rpc(adminA, 'financial_approve_new_project_request', {
        p_request_id: newProject.id, p_official_project_code: officialCode,
      }, 'Scenario B new-project approve');
    }
    newProject = (await rpc(adminA, 'get_financial_new_project_requests', { p_status: null }))
      .find((row) => row.id === newProject.id);
    if (newProject.status === 'APPROVED') {
      await rpc(adminB, 'financial_apply_new_project_request', { p_request_id: newProject.id }, 'Scenario B project registration apply');
    }
    newProject = (await rpc(adminA, 'get_financial_new_project_requests', { p_status: null }))
      .find((row) => row.id === newProject.id);
    equal(newProject.status, 'APPLIED', 'Scenario B project registration status');
    check(newProject.materialized_project_id, 'Scenario B materialized project is missing.');
    check(!newProject.materialized_movement_id, 'Scenario B must not allocate before link approval.');
    await rpc(adminB, 'financial_apply_new_project_request', { p_request_id: newProject.id }, 'Scenario B duplicate registration apply');

    let link = (await rpc(adminA, 'get_financial_pending_new_project_link_requests', { p_status: null }))
      .find((row) => row.pending_fund_id === pending.id);
    check(link, 'Admin link queue omitted the generated Scenario B link request.');
    if (link.status === 'SUBMITTED') {
      await rpc(adminA, 'financial_review_pending_new_project_link', {
        p_request_id: link.id, p_decision: 'APPROVE', p_reason: null,
      }, 'Scenario B link approve');
      link = (await rpc(adminA, 'get_financial_pending_new_project_link_requests', { p_status: null }))
        .find((row) => row.id === link.id);
    }
    if (link.status === 'APPROVED') {
      await rpc(adminB, 'financial_apply_pending_new_project_link', { p_request_id: link.id }, 'Scenario B link apply');
    }
    await rpc(adminB, 'financial_apply_pending_new_project_link', { p_request_id: link.id }, 'Scenario B duplicate link apply');
    link = (await rpc(adminA, 'get_financial_pending_new_project_link_requests', { p_status: null }))
      .find((row) => row.id === link.id);
    equal(link.status, 'APPLIED', 'Scenario B link final status');
    const newProjectPosition = await position(localB, newProject.materialized_project_id, 'Scenario B new project');
    equal(newProjectPosition.original_allocation, '0', 'Scenario B new project original allocation');
    equal(newProjectPosition.increase_amount, EIGHT_MILLION, 'Scenario B new project increase');
    equal(newProjectPosition.adjusted_allocation, EIGHT_MILLION, 'Scenario B new project adjusted allocation');

    const regionAfter = (await pg.query(`select
      coalesce(sum(coalesce(positions.ledger_adjusted_allocation, projects.alloc, 0)),0)::bigint
        + (select coalesce(sum(amount),0)::bigint from public.financial_pending_new_project_funds
           where region_id=$1 and status='WAITING') total
      from public.projects
      left join public.financial_project_funding_positions positions on positions.project_id=projects.id
      where projects.region_id=$1`, [regionId])).rows[0].total;
    equal(regionAfter, regionBefore, 'Region allocation + waiting-fund conservation');
    const integrity = (await pg.query(`select
      (select count(*)::integer from (
        select requests.id from public.financial_budget_change_requests requests
        join public.financial_budget_change_request_lines lines on lines.request_id=requests.id
        where requests.id=any($1::uuid[]) group by requests.id,requests.total_amount
        having requests.total_amount<>sum(lines.amount)) gaps) group_gaps,
      (select count(*)::integer from public.financial_funding_invariant_check
        where cohort_conservation_gap<>0 or decrease_resolution_gap<>0) invariant_gaps,
      (select count(*)::integer from public.financial_budget_workflow_amount_snapshots
        where budget_request_id=any($1::uuid[]) and capture_kind='EXACT_AT_APPLY') exact_snapshots,
      (select count(*)::integer from public.financial_budget_workflow_amount_snapshots
        where budget_request_id=any($1::uuid[])
          and (adjusted_before<>original_before+increase_before-decrease_before
            or unexecuted_before<>adjusted_before-execution_before
            or adjusted_after<>original_after+increase_after-decrease_after
            or unexecuted_after<>adjusted_after-execution_after)) snapshot_formula_errors`,
      [[scenarioARequest.request_id, scenarioBRequest.request_id]])).rows[0];
    equal(integrity.group_gaps, 0, 'Scenario request group gaps');
    equal(integrity.invariant_gaps, 0, 'Ledger invariant gaps');
    check(Number(integrity.exact_snapshots) >= 4, 'Scenario exact amount snapshots are incomplete.');
    equal(integrity.snapshot_formula_errors, 0, 'Scenario amount snapshot formulas');
    const counts = await queueCounts(pg, adminA, regionId);

    await Promise.all([localB.client.auth.signOut(), adminA.client.auth.signOut(), adminB.client.auth.signOut()]);
    const [reloginLocal, reloginAdmin] = await Promise.all([
      signIn(url, anon, required(env, 'UAT_LOCAL_B_EMAIL'), required(env, 'UAT_LOCAL_B_PASSWORD'), 'localB-relogin'),
      signIn(url, anon, required(env, 'UAT_ADMIN_A_EMAIL'), required(env, 'UAT_ADMIN_A_PASSWORD'), 'adminA-relogin'),
    ]);
    const persistedBudget = (await rpc(reloginLocal, 'get_financial_budget_change_requests', {
      p_project_id: null, p_status: null, p_year: null, p_region_id: null,
    })).filter((row) => [scenarioARequest.request_id, scenarioBRequest.request_id].includes(row.id));
    const persistedLinks = (await rpc(reloginAdmin, 'get_financial_pending_new_project_link_requests', { p_status: null }))
      .filter((row) => row.id === link.id);
    equal(persistedBudget.length, 2, 'Scenario C persisted budget requests after relogin');
    equal(persistedLinks.length, 1, 'Scenario C persisted link request after relogin');

    process.stdout.write(`${JSON.stringify({ status: 'PASS', target: 'TEST', production_touched: false,
      cutover_touched: false,
      scenario_a: { source: `${sourceA.project_code} ${sourceA.project_name}`, destination: `${destinationB.project_code} ${destinationB.project_name}`,
        amount: TEN_MILLION.toString(), request_id: scenarioARequest.request_id,
        source_after: sourceAPosition, destination_after: destinationBPosition, queue: 'PASS', duplicate_apply: 'PASS' },
      scenario_b: { source: `${sourceC.project_code} ${sourceC.project_name}`, planned_year: 2025,
        amount: EIGHT_MILLION.toString(), request_id: scenarioBRequest.request_id, pending_fund_id: pending.id,
        new_project_request_id: newProject.id, materialized_project_id: newProject.materialized_project_id,
        link_request_id: link.id, destination_after: newProjectPosition,
        admin_budget_queue: 'PASS', admin_pending_queue: 'PASS', admin_new_project_queue: 'PASS',
        admin_link_queue: 'PASS', duplicate_apply: 'PASS' },
      scenario_c: { refresh_relogin_persistence: 'PASS', budget_rows: persistedBudget.length, link_rows: persistedLinks.length },
      integrity, region_total_before: String(regionBefore), region_total_after: String(regionAfter), queue_counts: counts }, null, 2)}\n`);
  } finally {
    await pg.end().catch(() => undefined);
  }
}

main().catch((error) => { process.stderr.write(`ADMIN BUDGET WORKFLOW UAT FAILED: ${error.message}\n`); process.exitCode = 1; });
