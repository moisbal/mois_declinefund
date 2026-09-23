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
const RUN_TAG = 'yanggu-generic-budget-adjustment-20260831-v2';
const INVALID_SOURCE_CODE = '2024-51-800-0001';
const SCENARIO_A_SOURCE_CODE = '2024-51-800-0003';
const SCENARIO_A_DESTINATION_CODE = '2024-51-800-0002';
const SCENARIO_B_SOURCE_CODE = '2024-51-800-0007';
const INVALID_AMOUNT = 80_000_000n;
const SCENARIO_A_AMOUNT = 1_000_000n;
const SCENARIO_B_AMOUNT = 2_000_000n;
const NEW_PROJECT_YEAR = 2025;
const NEW_PROJECT_NAME = '양구 관광활성화 신규사업';
const NEW_PROJECT_CODE = arg('--official-new-project-code');

function fail(message) { throw new Error(message); }
function check(value, message) { if (!value) fail(message); }
function equal(actual, expected, message) {
  if (String(actual) !== String(expected)) fail(`${message} (expected=${expected}, actual=${actual})`);
}
function amount(value) { return BigInt(value ?? 0); }
function arg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function has(name) { return process.argv.includes(name); }
function load(file) {
  const resolved = path.resolve(process.cwd(), file ?? '');
  check(file && fs.existsSync(resolved), `Missing explicit env file: ${file ?? '(none)'}`);
  return dotenv.parse(fs.readFileSync(resolved));
}
function required(env, name) {
  const value = String(env[name] ?? '').trim();
  check(value, `${name} is required.`);
  return value;
}
function refFromUrl(value) {
  try { return new URL(value).hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i)?.[1] ?? null; }
  catch { return null; }
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
function stableUuid(label) {
  const chars = crypto.createHash('sha256').update(`${RUN_TAG}:${label}`).digest('hex').slice(0, 32).split('');
  chars[12] = '4';
  chars[16] = ['8', '9', 'a', 'b'][Number.parseInt(chars[16], 16) % 4];
  const value = chars.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
function client(url, key) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
async function signIn(url, key, email, password, alias) {
  const instance = client(url, key);
  const { data, error } = await instance.auth.signInWithPassword({ email, password });
  if (error || !data.user || !data.session) fail(`${alias} TEST authentication failed.`);
  return { alias, client: instance, userId: data.user.id };
}
async function rpc(account, name, args, label = name) {
  const { data, error } = await account.client.rpc(name, args ?? {});
  if (error) fail(`${label}: ${error.code ?? 'RPC'} ${error.message}`);
  return data ?? [];
}
async function expectRpcError(account, name, args, label) {
  const { error } = await account.client.rpc(name, args ?? {});
  if (!error) fail(`${label} unexpectedly succeeded.`);
  return error;
}
function first(rows, label) {
  check(Array.isArray(rows) && rows.length === 1, `${label} must return one row.`);
  return rows[0];
}
function roundedRate(execution, adjusted) {
  if (amount(adjusted) <= 0n) return 0;
  return Number((Number(execution) * 100 / Number(adjusted)).toFixed(2));
}
async function position(account, projectId, label) {
  const row = first(await rpc(account, 'get_financial_budget_change_project_position', {
    p_project_id: projectId,
  }, label), label);
  equal(amount(row.original_allocation) + amount(row.increase_amount) - amount(row.decrease_amount),
    row.adjusted_allocation, `${label} allocation formula`);
  equal(amount(row.adjusted_allocation) - amount(row.execution_amount),
    row.unexecuted_amount, `${label} unexecuted formula`);
  equal(Number(row.execution_rate), roundedRate(row.execution_amount, row.adjusted_allocation),
    `${label} execution rate`);
  return row;
}
function snapshotPosition(row, suffix) {
  const adjusted = amount(row[`adjusted_${suffix}`]);
  const execution = amount(row[`execution_${suffix}`]);
  return {
    project_id: row.project_id,
    original_allocation: String(row[`original_${suffix}`]),
    increase_amount: String(row[`increase_${suffix}`]),
    decrease_amount: String(row[`decrease_${suffix}`]),
    adjusted_allocation: String(row[`adjusted_${suffix}`]),
    execution_amount: String(row[`execution_${suffix}`]),
    unexecuted_amount: String(row[`unexecuted_${suffix}`]),
    execution_rate: adjusted > 0n ? Number((Number(execution) * 100 / Number(adjusted)).toFixed(2)) : 0,
    valid_execution: execution <= adjusted,
  };
}
async function exactSnapshot(pg, requestId, projectId, role) {
  return (await pg.query(`select project_id,project_role,
      original_before::text,increase_before::text,decrease_before::text,adjusted_before::text,
      execution_before::text,unexecuted_before::text,
      original_after::text,increase_after::text,decrease_after::text,adjusted_after::text,
      execution_after::text,unexecuted_after::text
    from public.financial_budget_workflow_amount_snapshots
    where budget_request_id=$1 and project_id=$2 and project_role=$3 and capture_kind='EXACT_AT_APPLY'
    order by captured_at desc limit 1`, [requestId, projectId, role])).rows[0] ?? null;
}
async function projectByCode(pg, regionId, code) {
  const row = (await pg.query(`select id, project_code,
      coalesce(nullif(btrim(detail_project_name), ''), nullif(btrim(fund_project_name), ''),
        nullif(btrim(project_name), ''), '사업명 확인 필요') as project_name,
      year, coalesce(alloc,0)::bigint::text raw_adjusted,
      coalesce(exec,0)::bigint::text raw_execution
    from public.projects where region_id=$1 and project_code=$2`, [regionId, code])).rows;
  return first(row, code);
}
async function regionSnapshot(pg, regionId) {
  return (await pg.query(`select
      (select count(*)::integer from public.projects where region_id=$1) project_count,
      (select coalesce(sum(coalesce(positions.ledger_adjusted_allocation, projects.alloc, 0)),0)::bigint::text
        from public.projects left join public.financial_project_funding_positions positions
          on positions.project_id=projects.id where projects.region_id=$1) official_adjusted,
      (select coalesce(sum(coalesce(positions.ledger_execution_amount, projects.exec, 0)),0)::bigint::text
        from public.projects left join public.financial_project_funding_positions positions
          on positions.project_id=projects.id where projects.region_id=$1) official_execution,
      (select coalesce(sum(amount),0)::bigint::text from public.financial_pending_new_project_funds
        where region_id=$1 and status='WAITING') waiting_amount,
      (select count(*)::integer from public.financial_budget_change_requests where region_id=$1) budget_request_count,
      (select count(*)::integer from public.financial_new_project_requests where region_id=$1) new_project_request_count,
      (select count(*)::integer from public.financial_pending_new_project_link_requests where region_id=$1) link_request_count`,
    [regionId])).rows[0];
}
async function adminQueueCounts(pg, admin) {
  const raw = (await pg.query(`select
    (select count(*)::integer from public.financial_budget_change_requests) budget_requests,
    (select count(*)::integer from public.financial_pending_new_project_funds) pending_funds,
    (select count(*)::integer from public.financial_new_project_requests) new_project_requests,
    (select count(*)::integer from public.financial_pending_new_project_link_requests) link_requests`)).rows[0];
  const [budget, pending, projects, links] = await Promise.all([
    rpc(admin, 'get_financial_budget_change_requests', {
      p_project_id: null, p_status: null, p_year: null, p_region_id: null,
    }, 'admin all budget queue'),
    rpc(admin, 'get_financial_pending_new_project_funds', {
      p_status: null, p_year: null, p_region_id: null,
    }, 'admin all pending-fund queue'),
    rpc(admin, 'get_financial_new_project_requests', { p_status: null }, 'admin all new-project queue'),
    rpc(admin, 'get_financial_pending_new_project_link_requests', { p_status: null }, 'admin all link queue'),
  ]);
  equal(budget.length, raw.budget_requests, 'Admin budget raw/RPC count');
  equal(pending.length, raw.pending_funds, 'Admin pending raw/RPC count');
  equal(projects.length, raw.new_project_requests, 'Admin new-project raw/RPC count');
  equal(links.length, raw.link_requests, 'Admin link raw/RPC count');
  return { raw, rpc: { budget_requests: budget.length, pending_funds: pending.length,
    new_project_requests: projects.length, link_requests: links.length } };
}
async function submittedBudgetQueueParity(pg, admin, expectedRequestId) {
  const dbCount = Number((await pg.query(`select count(*)::integer as value
    from public.financial_budget_change_requests where status='SUBMITTED'`)).rows[0].value);
  const rows = await rpc(admin, 'get_financial_budget_change_requests', {
    p_project_id: null, p_status: 'SUBMITTED', p_year: null, p_region_id: null,
  }, 'admin submitted budget queue parity');
  equal(rows.length, dbCount, 'DB pending request/Admin queue');
  check(rows.some((row) => row.id === expectedRequestId), 'Admin submitted queue omitted the UAT request.');
  return { db_pending_request: dbCount, admin_queue: rows.length };
}
async function authenticatedProjectCount(account, regionId) {
  const { count, error } = await account.client.from('projects')
    .select('id', { count: 'exact', head: true }).eq('region_id', regionId);
  if (error) fail(`${account.alias} project count: ${error.code ?? 'SELECT'} ${error.message}`);
  return Number(count ?? 0);
}
async function createBudget(pg, local, sourceProjectId, destinations, key, reason, effectiveDate) {
  const existing = (await pg.query(`select id as request_id,status,0::bigint::text as gap_amount
    from public.financial_budget_change_requests where idempotency_key=$1`, [stableUuid(key)])).rows[0];
  if (existing) return existing;
  const row = first(await rpc(local, 'financial_test_uat_create_budget_change_request', {
    p_source_project_id: sourceProjectId,
    p_source_budget_year_id: null,
    p_destinations: destinations,
    p_effective_date: effectiveDate,
    p_reason: reason,
    p_idempotency_key: stableUuid(key),
    p_submit: true,
  }, reason), reason);
  check(['SUBMITTED', 'APPROVED', 'APPLIED'].includes(row.status), `${reason} request status`);
  equal(row.gap_amount, 0, `${reason} gap`);
  return row;
}
async function approveApplyBudget(requestId, adminA, adminB, regionId, expected) {
  const allRows = await rpc(adminA, 'get_financial_budget_change_requests', {
    p_project_id: null, p_status: null, p_year: 2024, p_region_id: regionId,
  }, 'admin budget queue');
  let request = allRows.find((row) => row.id === requestId);
  check(request, 'Admin budget queue omitted the request.');
  equal(request.source_project_code, expected.sourceCode, 'Admin queue source code');
  equal(request.total_amount, expected.amount, 'Admin queue decrease amount');
  const destination = request.destinations?.find((row) => expected.destinationCode
    ? row.destination_project_code === expected.destinationCode
    : row.destination_type === 'PENDING_NEW_PROJECT');
  check(destination, 'Admin queue destination is missing.');
  equal(destination.amount, expected.amount, 'Admin queue increase amount');
  let queueParity = null;
  if (request.status === 'SUBMITTED') {
    queueParity = await submittedBudgetQueueParity(expected.pg, adminA, requestId);
    const submittedRows = await rpc(adminA, 'get_financial_budget_change_requests', {
      p_project_id: null, p_status: 'SUBMITTED', p_year: 2024, p_region_id: regionId,
    }, 'admin submitted budget queue');
    check(submittedRows.some((row) => row.id === requestId), 'Submitted request is missing from Admin queue.');
    const approved = first(await rpc(adminA, 'financial_approve_budget_change_request_group', {
      p_request_id: requestId,
      p_new_project_codes: expected.newProjectRequestId
        ? { [expected.newProjectRequestId]: expected.newProjectCode }
        : {},
    }, 'admin grouped budget approve'), 'admin grouped budget approve');
    equal(approved.status, 'APPROVED', 'Budget approved status');
    request = { ...request, status: approved.status };
  }
  if (request.status === 'APPROVED') {
    const applied = first(await rpc(adminB, 'financial_apply_budget_change_request', {
      p_request_id: requestId,
    }, 'admin budget apply'), 'admin budget apply');
    equal(applied.status, 'APPLIED', 'Budget applied status');
    equal(applied.gap_amount, 0, 'Budget applied gap');
    request = { ...request, status: applied.status };
  }
  equal(request.status, 'APPLIED', 'Budget final status');
  await rpc(adminB, 'financial_apply_budget_change_request', { p_request_id: requestId }, 'duplicate budget apply');
  return { submitted: 'SUBMITTED', approved: 'APPROVED', applied: 'APPLIED', queue_parity: queueParity };
}

async function main() {
  check(has('--confirm-test-write'), 'UAT requires --confirm-test-write.');
  check(NEW_PROJECT_CODE?.trim(), 'An explicit --official-new-project-code is required.');
  check(!/(?:^|[-_\s])(?:UAT|AUTO|GENERIC)(?=$|[-_\s])/i.test(NEW_PROJECT_CODE),
    'The official project code must not contain a TEST run identifier.');
  const env = { ...load(arg('--env-file')), ...load(arg('--credentials-file')) };
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  const supabaseUrl = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (String(env.TARGET_ENV).toUpperCase() !== 'TEST'
      || env.TEST_PROJECT_REF !== TEST_REF || env.PROD_PROJECT_REF !== PROD_REF
      || refFromUrl(supabaseUrl) !== TEST_REF || refFromDatabase(databaseUrl) !== TEST_REF
      || refFromDatabase(databaseUrl) === PROD_REF) fail('Fail-closed TEST target gate rejected configuration.');

  const [localC, adminA, adminB] = await Promise.all([
    signIn(supabaseUrl, anonKey, required(env, 'UAT_LOCAL_C_EMAIL'), required(env, 'UAT_LOCAL_C_PASSWORD'), 'local_c'),
    signIn(supabaseUrl, anonKey, required(env, 'UAT_ADMIN_A_EMAIL'), required(env, 'UAT_ADMIN_A_PASSWORD'), 'admin_a'),
    signIn(supabaseUrl, anonKey, required(env, 'UAT_ADMIN_B_EMAIL'), required(env, 'UAT_ADMIN_B_PASSWORD'), 'admin_b'),
  ]);
  const pg = new Client({ connectionString: connectionString(databaseUrl), ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000, application_name: 'yanggu-budget-change-e2e-uat' });
  await pg.connect();
  try {
    await pg.query("set statement_timeout = '90s'");
    const runtime = (await pg.query(`select environment_kind,mode,bound_project_ref,
      native_start_date::text as native_start_date from public.financial_ledger_runtime where singleton=true`)).rows[0];
    equal(runtime?.environment_kind, 'TEST', 'Ledger environment');
    equal(runtime?.mode, 'TEST', 'Ledger mode');
    equal(runtime?.bound_project_ref, TEST_REF, 'Ledger TEST ref');
    const effectiveDate = runtime.native_start_date;
    const localProfile = (await pg.query(`select profiles.role,profiles.region_id,regions.sido,regions.sigungu
      from public.profiles join public.regions on regions.id=profiles.region_id where profiles.id=$1`,
    [localC.userId])).rows[0];
    equal(localProfile?.role, 'local_user', 'local_c role');
    equal(`${localProfile.sido} ${localProfile.sigungu}`, '강원 양구군', 'local_c region');
    const regionId = localProfile.region_id;

    const [invalidSource, sourceA, destinationA, sourceB] = await Promise.all([
      projectByCode(pg, regionId, INVALID_SOURCE_CODE),
      projectByCode(pg, regionId, SCENARIO_A_SOURCE_CODE),
      projectByCode(pg, regionId, SCENARIO_A_DESTINATION_CODE),
      projectByCode(pg, regionId, SCENARIO_B_SOURCE_CODE),
    ]);
    for (const row of [invalidSource, sourceA, destinationA, sourceB]) equal(row.year, 2024, `${row.project_code} fiscal year`);

    const invalidPositionBefore = await position(localC, invalidSource.id, 'Invalid source before');
    const invalidMaximum = amount(invalidPositionBefore.unexecuted_amount);
    check(invalidMaximum < INVALID_AMOUNT, 'Invalid scenario must exceed current unexecuted amount.');
    const invalidBefore = (await pg.query(`select
      (select count(*)::integer from public.financial_budget_change_requests where idempotency_key=$1) request_count,
      (select count(*)::integer from public.financial_test_uat_project_bootstraps where project_id=$2) bootstrap_count`,
    [stableUuid('invalid-80m'), invalidSource.id])).rows[0];
    const invalidError = await expectRpcError(localC, 'financial_test_uat_create_budget_change_request', {
      p_source_project_id: invalidSource.id,
      p_source_budget_year_id: null,
      p_destinations: [{ destination_type: 'EXISTING_PROJECT', destination_project_id: destinationA.id,
        amount: INVALID_AMOUNT.toString(), note: 'UAT invalid maximum decrease' }],
      p_effective_date: effectiveDate,
      p_reason: 'UAT invalid 80m decrease',
      p_idempotency_key: stableUuid('invalid-80m'),
      p_submit: true,
    }, 'Invalid 80m decrease');
    equal(invalidError.code, '23514', 'Invalid decrease SQLSTATE');
    const formattedMaximum = invalidMaximum.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    check(invalidError.message.includes(`최대 감액 가능액은 ${formattedMaximum}원입니다.`)
      || invalidError.message === '감액액이 현재 미집행액을 초과합니다.',
    `Invalid decrease business message (actual=${invalidError.message})`);
    const invalidAfter = (await pg.query(`select
      (select count(*)::integer from public.financial_budget_change_requests where idempotency_key=$1) request_count,
      (select count(*)::integer from public.financial_test_uat_project_bootstraps where project_id=$2) bootstrap_count`,
    [stableUuid('invalid-80m'), invalidSource.id])).rows[0];
    equal(invalidAfter.request_count, invalidBefore.request_count, 'Invalid request row count');
    equal(invalidAfter.bootstrap_count, invalidBefore.bootstrap_count, 'Invalid bootstrap row count');

    const candidates = await rpc(localC, 'get_financial_budget_change_candidates', {
      p_anchor_project_id: sourceA.id, p_search: null, p_year: null, p_require_available: false,
    }, 'same-year candidate search');
    check(candidates.length > 0 && candidates.every((row) => Number(row.fiscal_year) === 2024),
      'Existing destination candidates must all be same-year.');
    check(candidates.some((row) => row.project_id === destinationA.id), 'Scenario A destination candidate is missing.');
    const pastYearError = await expectRpcError(localC, 'get_financial_budget_change_candidates', {
      p_anchor_project_id: sourceA.id, p_search: null, p_year: 2023, p_require_available: false,
    }, 'past-year candidate search');
    equal(pastYearError.code, '23514', 'Past-year candidate SQLSTATE');

    const baseline = await regionSnapshot(pg, regionId);
    const conservedBaseline = amount(baseline.official_adjusted) + amount(baseline.waiting_amount);
    let sourceABefore = await position(localC, sourceA.id, 'Scenario A source before');
    let destinationABefore = await position(localC, destinationA.id, 'Scenario A destination before');
    check(amount(sourceABefore.unexecuted_amount) >= SCENARIO_A_AMOUNT, 'Scenario A source has insufficient raw unexecuted amount.');
    const scenarioARequest = await createBudget(pg, localC, sourceA.id, [{
      destination_type: 'EXISTING_PROJECT', destination_project_id: destinationA.id,
      amount: SCENARIO_A_AMOUNT.toString(), note: 'UAT Scenario A same-year existing project',
    }], 'scenario-a-budget', 'UAT 양구 Scenario A · 2024 기존사업', effectiveDate);
    const scenarioAStates = await approveApplyBudget(scenarioARequest.request_id, adminA, adminB, regionId, {
      sourceCode: sourceA.project_code, destinationCode: destinationA.project_code,
      amount: SCENARIO_A_AMOUNT.toString(), pg,
    });
    let sourceAAfter = await position(localC, sourceA.id, 'Scenario A source after');
    let destinationAAfter = await position(localC, destinationA.id, 'Scenario A destination after');
    if (scenarioARequest.status === 'APPLIED') {
      const [sourceSnapshot, destinationSnapshot] = await Promise.all([
        exactSnapshot(pg, scenarioARequest.request_id, sourceA.id, 'SOURCE'),
        exactSnapshot(pg, scenarioARequest.request_id, destinationA.id, 'DESTINATION'),
      ]);
      check(sourceSnapshot && destinationSnapshot, 'Scenario A exact snapshots are missing.');
      sourceABefore = snapshotPosition(sourceSnapshot, 'before');
      sourceAAfter = snapshotPosition(sourceSnapshot, 'after');
      destinationABefore = snapshotPosition(destinationSnapshot, 'before');
      destinationAAfter = snapshotPosition(destinationSnapshot, 'after');
    }
    equal(sourceAAfter.original_allocation, sourceABefore.original_allocation, 'Scenario A source original unchanged');
    equal(amount(sourceAAfter.decrease_amount) - amount(sourceABefore.decrease_amount), SCENARIO_A_AMOUNT,
      'Scenario A source decrease delta');
    equal(amount(sourceABefore.adjusted_allocation) - amount(sourceAAfter.adjusted_allocation), SCENARIO_A_AMOUNT,
      'Scenario A source adjusted delta');
    equal(sourceAAfter.execution_amount, sourceABefore.execution_amount, 'Scenario A source execution unchanged');
    equal(destinationAAfter.original_allocation, destinationABefore.original_allocation, 'Scenario A destination original unchanged');
    equal(amount(destinationAAfter.increase_amount) - amount(destinationABefore.increase_amount), SCENARIO_A_AMOUNT,
      'Scenario A destination increase delta');
    equal(amount(destinationAAfter.adjusted_allocation) - amount(destinationABefore.adjusted_allocation), SCENARIO_A_AMOUNT,
      'Scenario A destination adjusted delta');
    equal(destinationAAfter.execution_amount, destinationABefore.execution_amount, 'Scenario A destination execution unchanged');
    const afterScenarioA = await regionSnapshot(pg, regionId);
    equal(afterScenarioA.project_count, baseline.project_count, 'Scenario A project count');
    equal(amount(afterScenarioA.official_adjusted) + amount(afterScenarioA.waiting_amount),
      conservedBaseline, 'Scenario A region total conservation');

    let sourceBBefore = await position(localC, sourceB.id, 'Scenario B source before');
    check(amount(sourceBBefore.unexecuted_amount) >= SCENARIO_B_AMOUNT, 'Scenario B source has insufficient raw unexecuted amount.');
    const projectCountsBeforeB = {
      official: Number(afterScenarioA.project_count),
      local: await authenticatedProjectCount(localC, regionId),
      admin: await authenticatedProjectCount(adminA, regionId),
    };
    const scenarioBRequest = await createBudget(pg, localC, sourceB.id, [{
      destination_type: 'PENDING_NEW_PROJECT', planned_project_name: NEW_PROJECT_NAME,
      planned_project_year: NEW_PROJECT_YEAR, amount: SCENARIO_B_AMOUNT.toString(),
      note: '양구 차년도 신규사업 목적지',
    }], 'scenario-b-budget', '양구 차년도 신규사업 예정재원 배분', effectiveDate);
    const scenarioBAlreadyApplied = scenarioBRequest.status === 'APPLIED';
    const scenarioBQueued = (await rpc(adminA, 'get_financial_budget_change_requests', {
      p_project_id: null, p_status: null, p_year: 2024, p_region_id: regionId,
    }, 'Scenario B grouped admin queue')).find((row) => row.id === scenarioBRequest.request_id);
    check(scenarioBQueued, 'Admin budget queue omitted Scenario B before approval.');
    const queuedDestination = scenarioBQueued.destinations?.find(
      (row) => row.destination_type === 'PENDING_NEW_PROJECT',
    );
    check(queuedDestination?.new_project_request_id, 'Scenario B linked new-project request is missing from Admin queue.');
    equal(queuedDestination.new_project_request_status, scenarioBAlreadyApplied ? 'APPLIED' : 'SUBMITTED',
      'Scenario B linked new-project request status');
    const newProjectRequestId = queuedDestination.new_project_request_id;
    let newProjectRequest = (await rpc(adminA, 'get_financial_new_project_requests', { p_status: null },
      'admin grouped new-project queue')).find((row) => row.id === newProjectRequestId);
    check(newProjectRequest, 'Admin new-project queue omitted the grouped Scenario B request.');
    const intermediate = await regionSnapshot(pg, regionId);
    const projectCountsBeforeApply = {
      official: Number(intermediate.project_count),
      local: await authenticatedProjectCount(localC, regionId),
      admin: await authenticatedProjectCount(adminA, regionId),
    };
    equal(projectCountsBeforeApply.official, projectCountsBeforeB.official, 'Scenario B official count before APPLY');
    equal(projectCountsBeforeApply.local, projectCountsBeforeB.local, 'Scenario B local count before APPLY');
    equal(projectCountsBeforeApply.admin, projectCountsBeforeB.admin, 'Scenario B admin count before APPLY');
    const scenarioBStates = await approveApplyBudget(scenarioBRequest.request_id, adminA, adminB, regionId, {
      sourceCode: sourceB.project_code, destinationCode: null, amount: SCENARIO_B_AMOUNT.toString(), pg,
      newProjectRequestId, newProjectCode: NEW_PROJECT_CODE,
    });
    let sourceBAfter = await position(localC, sourceB.id, 'Scenario B source after');
    const sourceSnapshot = await exactSnapshot(pg, scenarioBRequest.request_id, sourceB.id, 'SOURCE');
    check(sourceSnapshot, 'Scenario B exact source snapshot is missing.');
    sourceBBefore = snapshotPosition(sourceSnapshot, 'before');
    sourceBAfter = snapshotPosition(sourceSnapshot, 'after');
    equal(amount(sourceBAfter.decrease_amount) - amount(sourceBBefore.decrease_amount), SCENARIO_B_AMOUNT,
      'Scenario B source decrease delta');
    equal(amount(sourceBBefore.adjusted_allocation) - amount(sourceBAfter.adjusted_allocation), SCENARIO_B_AMOUNT,
      'Scenario B source adjusted delta');
    equal(sourceBAfter.execution_amount, sourceBBefore.execution_amount, 'Scenario B source execution unchanged');
    equal(amount(intermediate.official_adjusted) + amount(intermediate.waiting_amount), conservedBaseline,
      'Scenario B pre-APPLY official + waiting total conservation');
    equal(intermediate.project_count, baseline.project_count, 'Scenario B pre-registration official project count');

    newProjectRequest = (await rpc(adminA, 'get_financial_new_project_requests', { p_status: null },
      'admin applied grouped new-project queue')).find((row) => row.id === newProjectRequestId);
    equal(newProjectRequest?.status, 'APPLIED', 'Scenario B grouped new-project final status');
    check(newProjectRequest.materialized_project_id, 'Scenario B materialized project is missing.');
    equal(newProjectRequest.official_project_code, NEW_PROJECT_CODE, 'Scenario B official project code');
    const pendingRows = await rpc(localC, 'get_financial_pending_new_project_funds', {
      p_status: null, p_year: NEW_PROJECT_YEAR, p_region_id: regionId,
    }, 'Scenario B completed pending queue');
    const pending = pendingRows.find((row) => row.source_request_id === scenarioBRequest.request_id);
    check(pending, 'Scenario B completed pending-fund trace is missing.');
    equal(pending.status, 'LINKED', 'Scenario B pending-fund trace status');
    const lotId = (await pg.query(`select lot_id from public.financial_pending_new_project_funds where id=$1`,
    [pending.id])).rows[0]?.lot_id;
    check(lotId, 'Scenario B pending lot is missing.');
    const correlation = (await pg.query(`select lines.id as line_id, lines.new_project_request_id,
        lines.pending_fund_id, lines.materialized_lot_id, requests.materialized_project_id,
        requests.materialized_movement_id, pending.status as pending_status,
        links.id as link_request_id, links.status as link_status,
        links.materialized_movement_id as link_movement_id
      from public.financial_budget_change_request_lines lines
      join public.financial_new_project_requests requests on requests.id=lines.new_project_request_id
      join public.financial_pending_new_project_funds pending on pending.id=lines.pending_fund_id
      join public.financial_pending_new_project_link_requests links on links.pending_fund_id=pending.id
      where lines.request_id=$1`, [scenarioBRequest.request_id])).rows[0];
    equal(correlation?.new_project_request_id, newProjectRequest.id, 'Scenario B workflow new-project correlation');
    equal(correlation?.pending_fund_id, pending.id, 'Scenario B workflow pending-fund correlation');
    equal(correlation?.materialized_lot_id, lotId, 'Scenario B workflow lot correlation');
    equal(correlation?.materialized_project_id, newProjectRequest.materialized_project_id,
      'Scenario B workflow project correlation');
    equal(correlation?.materialized_movement_id, correlation?.link_movement_id,
      'Scenario B workflow movement correlation');
    equal(correlation?.pending_status, 'LINKED', 'Scenario B workflow pending status');
    equal(correlation?.link_status, 'APPLIED', 'Scenario B workflow link status');
    const link = (await rpc(adminA, 'get_financial_pending_new_project_link_requests', { p_status: null },
      'admin link queue')).find((row) => row.pending_fund_id === pending.id);
    check(link, 'Admin pending-link queue omitted Scenario B.');
    equal(link?.status, 'APPLIED', 'Scenario B link final status');

    const newProjectPosition = await position(localC, newProjectRequest.materialized_project_id,
      'Scenario B new project final');
    equal(newProjectPosition.original_allocation, 0, 'Scenario B new project original allocation');
    equal(newProjectPosition.increase_amount, SCENARIO_B_AMOUNT, 'Scenario B new project increase');
    equal(newProjectPosition.decrease_amount, 0, 'Scenario B new project decrease');
    equal(newProjectPosition.adjusted_allocation, SCENARIO_B_AMOUNT, 'Scenario B new project adjusted allocation');
    equal(newProjectPosition.execution_amount, 0, 'Scenario B new project execution');
    equal(newProjectPosition.unexecuted_amount, SCENARIO_B_AMOUNT, 'Scenario B new project unexecuted');
    equal(newProjectPosition.execution_rate, 0, 'Scenario B new project execution rate');

    const finalRegion = await regionSnapshot(pg, regionId);
    const projectCountsAfterApply = {
      official: Number(finalRegion.project_count),
      local: await authenticatedProjectCount(localC, regionId),
      admin: await authenticatedProjectCount(adminA, regionId),
    };
    equal(finalRegion.project_count, Number(baseline.project_count) + (scenarioBAlreadyApplied ? 0 : 1),
      'Final official project count');
    equal(projectCountsAfterApply.local, projectCountsBeforeB.local + (scenarioBAlreadyApplied ? 0 : 1),
      'Scenario B local project count after APPLY');
    equal(projectCountsAfterApply.admin, projectCountsBeforeB.admin + (scenarioBAlreadyApplied ? 0 : 1),
      'Scenario B admin project count after APPLY');
    equal(finalRegion.official_adjusted, conservedBaseline, 'Final official allocation conservation');
    equal(finalRegion.official_execution, baseline.official_execution, 'Final execution conservation');
    equal(finalRegion.waiting_amount, 0, 'Final waiting amount');

    const historyChecks = await Promise.all([
      rpc(localC, 'get_financial_budget_change_requests', {
        p_project_id: sourceA.id, p_status: 'APPLIED', p_year: 2024, p_region_id: regionId,
      }, 'Scenario A source history'),
      rpc(localC, 'get_financial_budget_change_requests', {
        p_project_id: destinationA.id, p_status: 'APPLIED', p_year: 2024, p_region_id: regionId,
      }, 'Scenario A destination history'),
    ]);
    check(historyChecks.every((rows) => rows.some((row) => row.id === scenarioARequest.request_id)),
      'Scenario A source/destination history tag relation is missing.');
    for (const rows of historyChecks) {
      const history = rows.find((row) => row.id === scenarioARequest.request_id);
      equal(history.source_project_code, sourceA.project_code, 'Scenario A history source counterpart');
      equal(history.total_amount, SCENARIO_A_AMOUNT, 'Scenario A history transfer amount');
      const historyDestination = history.destinations?.find(
        (row) => row.destination_project_code === destinationA.project_code,
      );
      check(historyDestination, 'Scenario A history destination counterpart is missing.');
      equal(historyDestination.amount, SCENARIO_A_AMOUNT, 'Scenario A history destination amount');
    }
    const scenarioBHistory = await Promise.all([
      rpc(localC, 'get_financial_budget_change_requests', {
        p_project_id: sourceB.id, p_status: 'APPLIED', p_year: 2024, p_region_id: regionId,
      }, 'Scenario B source history'),
      rpc(localC, 'get_financial_budget_change_requests', {
        p_project_id: newProjectRequest.materialized_project_id, p_status: 'APPLIED', p_year: 2024,
        p_region_id: regionId,
      }, 'Scenario B destination history'),
    ]);
    check(scenarioBHistory.every((rows) => rows.some((row) => row.id === scenarioBRequest.request_id)),
      'Scenario B source/new-project history correlation is missing.');

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
    equal(integrity.group_gaps, 0, 'Request monetary gap');
    equal(integrity.invariant_gaps, 0, 'Ledger invariant gap');
    check(Number(integrity.exact_snapshots) >= 4, 'Exact amount snapshots are incomplete.');
    equal(integrity.snapshot_formula_errors, 0, 'Amount snapshot formula errors');
    const queueCounts = await adminQueueCounts(pg, adminA);

    await Promise.allSettled([localC.client.auth.signOut(), adminA.client.auth.signOut(), adminB.client.auth.signOut()]);
    const [freshLocal, freshAdmin] = await Promise.all([
      signIn(supabaseUrl, anonKey, required(env, 'UAT_LOCAL_C_EMAIL'), required(env, 'UAT_LOCAL_C_PASSWORD'), 'local_c fresh'),
      signIn(supabaseUrl, anonKey, required(env, 'UAT_ADMIN_A_EMAIL'), required(env, 'UAT_ADMIN_A_PASSWORD'), 'admin_a fresh'),
    ]);
    const comparedProjects = [
      [sourceA.id, 'Scenario A source'],
      [destinationA.id, 'Scenario A destination'],
      [sourceB.id, 'Scenario B source'],
      [newProjectRequest.materialized_project_id, 'Scenario B new project'],
    ];
    const freshPairs = await Promise.all(comparedProjects.map(async ([projectId, label]) => {
      const [localPosition, adminPosition] = await Promise.all([
        position(freshLocal, projectId, `Fresh local ${label}`),
        position(freshAdmin, projectId, `Fresh admin ${label}`),
      ]);
      for (const field of [
        'original_allocation', 'increase_amount', 'decrease_amount', 'adjusted_allocation',
        'execution_amount', 'unexecuted_amount', 'execution_rate',
      ]) equal(localPosition[field], adminPosition[field], `Fresh local/admin ${label} ${field}`);
      return { project_id: projectId, label, local: localPosition, admin: adminPosition };
    }));
    equal(freshPairs[0].local.adjusted_allocation, sourceAAfter.adjusted_allocation, 'Fresh source A');
    equal(freshPairs[1].local.adjusted_allocation, destinationAAfter.adjusted_allocation, 'Fresh destination A');
    equal(freshPairs[2].local.adjusted_allocation, sourceBAfter.adjusted_allocation, 'Fresh source B');
    equal(freshPairs[3].local.adjusted_allocation, newProjectPosition.adjusted_allocation, 'Fresh new project');

    process.stdout.write(`${JSON.stringify({
      status: 'PASS', target: 'TEST', project_ref: TEST_REF, production_touched: false,
      region: '강원 양구군',
      invalid_scenario: {
        source: `${invalidSource.project_code} ${invalidSource.project_name}`,
        adjusted_allocation: invalidPositionBefore.adjusted_allocation,
        execution: invalidPositionBefore.execution_amount,
        maximum_decrease: invalidMaximum.toString(), attempted_decrease: INVALID_AMOUNT.toString(),
        blocked_sqlstate: invalidError.code, message: invalidError.message,
        request_rows_created: Number(invalidAfter.request_count) - Number(invalidBefore.request_count),
        bootstrap_rows_created: Number(invalidAfter.bootstrap_count) - Number(invalidBefore.bootstrap_count),
      },
      scenario_a: {
        request_id: scenarioARequest.request_id, amount: SCENARIO_A_AMOUNT.toString(),
        source: { code: sourceA.project_code, name: sourceA.project_name, before: sourceABefore, after: sourceAAfter },
        destination: { code: destinationA.project_code, name: destinationA.project_name,
          before: destinationABefore, after: destinationAAfter },
        state_machine: scenarioAStates, project_count_before: baseline.project_count,
        project_count_after: afterScenarioA.project_count,
        monetary_gap: (amount(afterScenarioA.official_adjusted) + amount(afterScenarioA.waiting_amount)
          - conservedBaseline).toString(),
        source_destination_history: 'PASS',
      },
      scenario_b: {
        request_id: scenarioBRequest.request_id, pending_fund_id: pending.id,
        new_project_request_id: newProjectRequest.id, link_request_id: link.id,
        amount: SCENARIO_B_AMOUNT.toString(), source: { code: sourceB.project_code, name: sourceB.project_name,
          before: sourceBBefore, after: sourceBAfter },
        new_project: { id: newProjectRequest.materialized_project_id, code: NEW_PROJECT_CODE,
          name: NEW_PROJECT_NAME, position: newProjectPosition },
        state_machine: { budget: scenarioBStates, new_project: 'SUBMITTED→APPROVED→APPLIED',
          pending_fund_trace: 'LINKED', link_trace: 'APPLIED' },
        workflow_correlation: correlation,
        project_count_before: baseline.project_count, project_count_before_registration: intermediate.project_count,
        project_count_after: finalRegion.project_count,
        project_counts: { before_request: projectCountsBeforeB, before_apply: projectCountsBeforeApply,
          after_apply: projectCountsAfterApply },
        intermediate_official_plus_waiting_gap:
          (amount(intermediate.official_adjusted) + amount(intermediate.waiting_amount) - conservedBaseline).toString(),
        final_monetary_gap: (amount(finalRegion.official_adjusted) - conservedBaseline).toString(),
      },
      candidate_policy: { same_region: true, same_year: 2024, count: candidates.length, past_year_blocked: true },
      fresh_read: { local: 'PASS', admin: 'PASS', identical_project_count: freshPairs.length },
      integrity, queue_counts: queueCounts,
      region_before: baseline, region_final: finalRegion,
    }, null, 2)}\n`);
    await Promise.allSettled([freshLocal.client.auth.signOut(), freshAdmin.client.auth.signOut()]);
  } finally {
    await pg.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`YANGGU BUDGET E2E UAT FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
