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
const ACTUAL_DUPLICATE_ID = '00000000-0000-4000-8000-000000000108';
const ACTUAL_APPLIED_ID = '00000000-0000-4000-8000-000000000109';
const ACTUAL_SOURCE_ID = '00000000-0000-4000-8000-000000000110';
const ACTUAL_DESTINATION_ID = '00000000-0000-4000-8000-000000000111';
const ACTUAL_AMOUNT = 10_000_000n;
const CONCURRENT_AMOUNT = 10_000_000n;
const REJECT_AMOUNT = 1_000_000n;

function fail(message) { throw new Error(message); }
function check(value, message) { if (!value) fail(message); }
function equal(actual, expected, message) {
  if (String(actual) !== String(expected)) fail(`${message} (expected=${expected}, actual=${actual})`);
}
function money(value) { return BigInt(value ?? 0); }
function arg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
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
function supabase(url, key) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
async function signIn(url, key, email, password, alias) {
  const client = supabase(url, key);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user || !data.session) fail(`${alias} TEST authentication failed.`);
  return { alias, client, userId: data.user.id };
}
async function rawRpc(account, name, args) { return account.client.rpc(name, args ?? {}); }
async function rpc(account, name, args, label = name) {
  const { data, error } = await rawRpc(account, name, args);
  if (error) fail(`${label}: ${error.code ?? 'RPC'} ${error.message}`);
  return data;
}
function one(data, label) {
  if (Array.isArray(data)) {
    check(data.length === 1, `${label} must return one row.`);
    return data[0];
  }
  check(data && typeof data === 'object', `${label} must return one row.`);
  return data;
}
function errorSummary(error) {
  return { code: error?.code ?? null, message: error?.message ?? null, details: error?.details ?? null };
}
function assertBusinessDuplicate(error, label) {
  check(error, `${label} unexpectedly succeeded.`);
  equal(error.code, '23505', `${label} SQLSTATE`);
  check(/이미 승인 요청|동일 예산조정/.test(error.message), `${label} business message`);
}
async function position(account, projectId, label) {
  const value = one(await rpc(account, 'get_financial_budget_change_project_position', {
    p_project_id: projectId,
  }, label), label);
  equal(money(value.original_allocation) + money(value.increase_amount) - money(value.decrease_amount),
    value.adjusted_allocation, `${label} adjusted formula`);
  equal(money(value.adjusted_allocation) - money(value.execution_amount), value.unexecuted_amount,
    `${label} unexecuted formula`);
  return value;
}
async function statistics(account, regionId, label) {
  return one(await rpc(account, 'get_financial_budget_change_statistics', {
    p_year: null, p_region_id: regionId,
  }, label), label);
}
async function filteredAnalytics(account, year, sido, sigungu, label) {
  return one(await rpc(account, 'get_financial_budget_change_statistics_filtered', {
    p_year: year, p_sido: sido, p_sigungu: sigungu,
  }, label), label);
}
async function regionTotals(pg, regionId) {
  return (await pg.query(`select
      count(*)::integer as project_count,
      coalesce(sum(coalesce(positions.ledger_adjusted_allocation, projects.alloc, 0)),0)::bigint::text as adjusted,
      coalesce(sum(coalesce(positions.ledger_execution_amount, projects.exec, 0)),0)::bigint::text as execution
    from public.projects
    left join public.financial_project_funding_positions as positions on positions.project_id=projects.id
    where projects.region_id=$1`, [regionId])).rows[0];
}
async function monetaryTotals(pg) {
  return (await pg.query(`select
      (select count(*)::integer from public.project_fund_transfers) as transfer_count,
      (select coalesce(sum(amount),0)::bigint::text from public.project_fund_transfers) as transfer_amount,
      (select count(*)::integer from public.financial_unallocated_fund_movements) as movement_count,
      (select coalesce(sum(amount),0)::bigint::text from public.financial_unallocated_fund_movements) as movement_amount,
      (select count(*)::integer from public.projects) as project_count,
      (select coalesce(sum(coalesce(alloc,0)),0)::bigint::text from public.projects) as project_alloc,
      (select coalesce(sum(coalesce(exec,0)),0)::bigint::text from public.projects) as project_exec`)).rows[0];
}
async function requestMaterialization(pg, requestId) {
  return (await pg.query(`select
      count(*)::integer as line_count,
      count(lines.materialized_transfer_id)::integer as transfer_count,
      count(lines.materialized_lot_id)::integer as lot_count,
      count(lines.pending_fund_id)::integer as pending_count,
      coalesce(sum(transfers.amount),0)::bigint::text as transfer_amount
    from public.financial_budget_change_request_lines as lines
    left join public.project_fund_transfers as transfers on transfers.id=lines.materialized_transfer_id
    where lines.request_id=$1`, [requestId])).rows[0];
}
async function actionableQueue(pg, admin, expectedId = null) {
  const dbCount = Number((await pg.query(`select count(*)::integer as value
    from public.financial_budget_change_requests
    where status in ('SUBMITTED','APPROVED')`)).rows[0].value);
  const rows = await rpc(admin, 'get_financial_budget_change_requests', {
    p_project_id: null, p_status: null, p_year: null, p_region_id: null,
  }, 'Admin actionable queue');
  const queue = rows.filter((row) => ['SUBMITTED', 'APPROVED', 'DUPLICATE'].includes(row.status));
  equal(queue.length, dbCount, 'DB pending request/Admin queue parity');
  if (expectedId) equal(queue.filter((row) => row.id === expectedId).length, 1, 'Admin target queue count');
  return { db_pending_request: dbCount, admin_queue: queue.length };
}
async function requestRow(pg, requestId) {
  return (await pg.query(`select id,status,total_amount::text,source_project_id,source_budget_year_id,
      source_adjustment_revision::text,draft_revision_id,adjustment_fingerprint,
      duplicate_of_request_id,reason,requested_by
    from public.financial_budget_change_requests where id=$1`, [requestId])).rows[0] ?? null;
}
async function exactSnapshots(pg, requestId) {
  return (await pg.query(`select project_role,project_id,amount::text,
      original_before::text,increase_before::text,decrease_before::text,adjusted_before::text,
      execution_before::text,unexecuted_before::text,
      original_after::text,increase_after::text,decrease_after::text,adjusted_after::text,
      execution_after::text,unexecuted_after::text
    from public.financial_budget_workflow_amount_snapshots
    where budget_request_id=$1 and capture_kind='EXACT_AT_APPLY'
    order by project_role,project_id`, [requestId])).rows;
}
function selectScenarioProjects(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.year)) grouped.set(row.year, []);
    grouped.get(row.year).push(row);
  }
  for (const [year, projects] of [...grouped.entries()].sort((a, b) => Number(b[0]) - Number(a[0]))) {
    const sourceA = projects.find((row) => money(row.available_amount) >= CONCURRENT_AMOUNT);
    if (!sourceA) continue;
    const destinationA = projects.find((row) => row.id !== sourceA.id);
    const sourceB = projects.find((row) => row.id !== sourceA.id && row.id !== destinationA?.id
      && money(row.available_amount) >= REJECT_AMOUNT);
    const destinationB = projects.find((row) => ![sourceA.id, destinationA?.id, sourceB?.id].includes(row.id));
    if (destinationA && sourceB && destinationB) return { year: Number(year), sourceA, destinationA, sourceB, destinationB };
  }
  fail('No safe same-year four-project TEST scenario is available.');
}
async function main() {
  check(process.argv.includes('--confirm-test-write'), 'UAT requires --confirm-test-write.');
  const env = { ...load(arg('--env-file')), ...load(arg('--credentials-file')) };
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  const supabaseUrl = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (String(env.TARGET_ENV).toUpperCase() !== 'TEST'
      || env.TEST_PROJECT_REF !== TEST_REF || env.PROD_PROJECT_REF !== PROD_REF
      || refFromUrl(supabaseUrl) !== TEST_REF || refFromDatabase(databaseUrl) !== TEST_REF
      || refFromDatabase(databaseUrl) === PROD_REF) fail('Fail-closed TEST target gate rejected configuration.');

  const localEmail = required(env, 'UAT_LOCAL_C_EMAIL');
  const localPassword = required(env, 'UAT_LOCAL_C_PASSWORD');
  const [localA, localB, adminA, adminB] = await Promise.all([
    signIn(supabaseUrl, anonKey, localEmail, localPassword, 'local_c tab_a'),
    signIn(supabaseUrl, anonKey, localEmail, localPassword, 'local_c tab_b'),
    signIn(supabaseUrl, anonKey, required(env, 'UAT_ADMIN_A_EMAIL'), required(env, 'UAT_ADMIN_A_PASSWORD'), 'admin_a'),
    signIn(supabaseUrl, anonKey, required(env, 'UAT_ADMIN_B_EMAIL'), required(env, 'UAT_ADMIN_B_PASSWORD'), 'admin_b'),
  ]);
  const pg = new Client({ connectionString: connectionString(databaseUrl), ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000, application_name: 'budget-adjustment-idempotency-uat' });
  await pg.connect();
  try {
    await pg.query("set statement_timeout = '120s'");
    const runtime = (await pg.query(`select environment_kind,mode,bound_project_ref,native_start_date::text
      from public.financial_ledger_runtime where singleton=true`)).rows[0];
    equal(runtime?.environment_kind, 'TEST', 'Runtime environment');
    equal(runtime?.mode, 'TEST', 'Runtime mode');
    equal(runtime?.bound_project_ref, TEST_REF, 'Runtime ref');
    const profile = (await pg.query(`select profiles.role,profiles.region_id,regions.sido,regions.sigungu
      from public.profiles join public.regions on regions.id=profiles.region_id where profiles.id=$1`,
    [localA.userId])).rows[0];
    equal(profile?.role, 'local_user', 'local_c role');
    const regionId = profile.region_id;

    const actualBefore = {
      source: await position(localA, ACTUAL_SOURCE_ID, 'Actual source before duplicate rejection'),
      destination: await position(localA, ACTUAL_DESTINATION_ID, 'Actual destination before duplicate rejection'),
      monetary: await monetaryTotals(pg),
      duplicate: await requestRow(pg, ACTUAL_DUPLICATE_ID),
      applied: await requestRow(pg, ACTUAL_APPLIED_ID),
      materialized: await requestMaterialization(pg, ACTUAL_APPLIED_ID),
    };
    check(['SUBMITTED', 'REJECTED'].includes(actualBefore.duplicate?.status),
      'Actual duplicate must be pending rejection or already rejected.');
    equal(actualBefore.duplicate?.duplicate_of_request_id, ACTUAL_APPLIED_ID, 'Actual duplicate canonical link');
    equal(actualBefore.applied?.status, 'APPLIED', 'Actual canonical status');
    const duplicateUi = (await rpc(adminA, 'get_financial_budget_change_requests', {
      p_project_id: null, p_status: null, p_year: 2025, p_region_id: regionId,
    }, 'Actual duplicate admin queue')).find((row) => row.id === ACTUAL_DUPLICATE_ID);
    equal(duplicateUi?.status, actualBefore.duplicate.status === 'SUBMITTED' ? 'DUPLICATE' : 'REJECTED',
      'Actual duplicate admin projection');
    const rejectedActual = actualBefore.duplicate.status === 'SUBMITTED'
      ? one(await rpc(adminA, 'financial_reject_budget_change_request', {
      p_request_id: ACTUAL_DUPLICATE_ID,
      p_reason: '실제 휴먼 UAT 중복 요청 · 정상 승인건 유지 후 미승인 중복 반려',
      }, 'Actual duplicate rejection'), 'Actual duplicate rejection')
      : { request_id: ACTUAL_DUPLICATE_ID, status: 'REJECTED' };
    equal(rejectedActual.status, 'REJECTED', 'Actual duplicate rejected status');
    const actualAfter = {
      source: await position(localA, ACTUAL_SOURCE_ID, 'Actual source after duplicate rejection'),
      destination: await position(localA, ACTUAL_DESTINATION_ID, 'Actual destination after duplicate rejection'),
      monetary: await monetaryTotals(pg),
      duplicate: await requestRow(pg, ACTUAL_DUPLICATE_ID),
      applied: await requestRow(pg, ACTUAL_APPLIED_ID),
      materialized: await requestMaterialization(pg, ACTUAL_APPLIED_ID),
    };
    equal(actualAfter.duplicate?.status, 'REJECTED', 'Actual duplicate final status');
    equal(actualAfter.applied?.status, 'APPLIED', 'Actual canonical remains applied');
    equal(actualAfter.source.decrease_amount, ACTUAL_AMOUNT, 'Actual source decrease exactly once');
    equal(actualAfter.destination.increase_amount, ACTUAL_AMOUNT, 'Actual destination increase exactly once');
    equal(actualAfter.materialized.transfer_count, 1, 'Actual canonical transfer count');
    equal(actualAfter.materialized.transfer_amount, ACTUAL_AMOUNT, 'Actual canonical transfer amount');
    equal(actualAfter.materialized.lot_count, 0, 'Actual canonical lot count');
    equal(money(actualAfter.source.decrease_amount) - money(actualAfter.destination.increase_amount), 0,
      'Actual source/destination GAP');
    for (const field of ['original_allocation','increase_amount','decrease_amount','adjusted_allocation',
      'execution_amount','unexecuted_amount','execution_rate']) {
      equal(actualAfter.source[field], actualBefore.source[field], `Actual source rejection no change ${field}`);
      equal(actualAfter.destination[field], actualBefore.destination[field], `Actual destination rejection no change ${field}`);
    }
    for (const field of Object.keys(actualBefore.monetary)) {
      equal(actualAfter.monetary[field], actualBefore.monetary[field], `Actual rejection no monetary change ${field}`);
    }

    const candidateRows = (await pg.query(`select projects.id,projects.project_code,projects.year,
        coalesce(nullif(btrim(projects.detail_project_name),''),nullif(btrim(projects.fund_project_name),''),
          nullif(btrim(projects.project_name),''),'사업명 확인 필요') as project_name,
        (positions.ledger_adjusted_allocation-positions.ledger_execution_amount)::bigint::text as available_amount
      from public.projects
      join public.financial_project_funding_positions as positions on positions.project_id=projects.id
      where projects.region_id=$1 and positions.projection_ready
        and positions.ledger_execution_amount<=positions.ledger_adjusted_allocation
        and projects.id<>all($2::uuid[])
        and not exists (select 1 from public.financial_budget_change_requests as active
          where active.source_project_id=projects.id and active.status in ('SUBMITTED','APPROVED'))
      order by projects.year desc,
        (positions.ledger_adjusted_allocation-positions.ledger_execution_amount) desc,projects.id`,
    [regionId, [ACTUAL_SOURCE_ID, ACTUAL_DESTINATION_ID]])).rows;
    const scenario = selectScenarioProjects(candidateRows);
    const effectiveDate = runtime.native_start_date;
    const beforeA = {
      source: await position(localA, scenario.sourceA.id, 'Concurrent source before'),
      destination: await position(localA, scenario.destinationA.id, 'Concurrent destination before'),
      region: await regionTotals(pg, regionId),
      stats: await statistics(adminA, regionId, 'Dashboard stats before concurrent request'),
      analytics: await filteredAnalytics(localA, scenario.year, profile.sido, profile.sigungu,
        'Analytics before concurrent request'),
      queue: await actionableQueue(pg, adminA),
    };
    check(money(beforeA.source.unexecuted_amount) >= CONCURRENT_AMOUNT, 'Concurrent source availability');
    const draftId = crypto.randomUUID();
    const createArgs = {
      p_source_project_id: scenario.sourceA.id,
      p_source_budget_year_id: null,
      p_destinations: [{ destination_type: 'EXISTING_PROJECT',
        destination_project_id: scenario.destinationA.id, amount: CONCURRENT_AMOUNT.toString(),
        note: 'CONCURRENT_DRAFT_UAT' }],
      p_effective_date: effectiveDate,
      p_reason: '동시 제출 UAT · 기존사업 재배분',
      p_idempotency_key: draftId,
      p_submit: true,
    };
    const concurrent = await Promise.all([
      rawRpc(localA, 'financial_test_uat_create_budget_change_request', createArgs),
      rawRpc(localB, 'financial_test_uat_create_budget_change_request', createArgs),
    ]);
    const successes = concurrent.filter((result) => !result.error);
    const blocked = concurrent.filter((result) => result.error);
    equal(successes.length, 1, 'Concurrent successful submit count');
    equal(blocked.length, 1, 'Concurrent blocked submit count');
    assertBusinessDuplicate(blocked[0].error, 'Concurrent second submit');
    const created = one(successes[0].data, 'Concurrent successful submit');
    equal(created.status, 'SUBMITTED', 'Concurrent request submitted status');
    const requestId = created.request_id;
    const createdRow = await requestRow(pg, requestId);
    equal(createdRow.draft_revision_id, draftId, 'Stored draft revision');
    const fingerprintCount = Number((await pg.query(`select count(*)::integer as value
      from public.financial_budget_change_requests where adjustment_fingerprint=$1`,
    [createdRow.adjustment_fingerprint])).rows[0].value);
    equal(fingerprintCount, 1, 'Economic fingerprint request count');
    equal((await requestMaterialization(pg, requestId)).transfer_count, 0, 'Pre-approval transfer count');
    equal((await requestMaterialization(pg, requestId)).lot_count, 0, 'Pre-approval lot count');
    const queueSubmitted = await actionableQueue(pg, adminA, requestId);
    equal(queueSubmitted.admin_queue, beforeA.queue.admin_queue + 1, 'Admin queue increment');

    const refreshClient = await signIn(supabaseUrl, anonKey, localEmail, localPassword, 'local_c refresh');
    const refreshRetry = await rawRpc(refreshClient, 'financial_test_uat_create_budget_change_request', createArgs);
    assertBusinessDuplicate(refreshRetry.error, 'Refresh same-draft submit');
    const otherTabRetry = await rawRpc(localB, 'financial_test_uat_create_budget_change_request', {
      ...createArgs,
      p_idempotency_key: crypto.randomUUID(),
      p_reason: '다른 탭 UAT · 표현만 다른 동일 예산조정',
      p_destinations: [{ ...createArgs.p_destinations[0], note: 'INCREASE_TARGET' }],
    });
    assertBusinessDuplicate(otherTabRetry.error, 'Two-tab economic duplicate');
    equal(Number((await pg.query(`select count(*)::integer as value
      from public.financial_budget_change_requests where adjustment_fingerprint=$1`,
    [createdRow.adjustment_fingerprint])).rows[0].value), 1, 'Refresh/two-tab request count');
    equal((await actionableQueue(pg, adminA, requestId)).admin_queue, queueSubmitted.admin_queue,
      'Refresh/two-tab queue unchanged');

    const directBypass = await rawRpc(localA, 'financial_create_budget_change_request', {
      p_source_budget_year_id: createdRow.source_budget_year_id,
      p_destinations: createArgs.p_destinations,
      p_effective_date: effectiveDate,
      p_reason: '직접 내부 RPC 우회 차단 UAT',
      p_idempotency_key: crypto.randomUUID(), p_submit: true,
    });
    check(directBypass.error, 'Authenticated direct internal create unexpectedly succeeded.');

    const approved = one(await rpc(adminA, 'financial_approve_budget_change_request_group', {
      p_request_id: requestId, p_new_project_codes: {},
    }, 'Concurrent request approve'), 'Concurrent request approve');
    equal(approved.status, 'APPROVED', 'Concurrent request approved status');
    const applied = one(await rpc(adminB, 'financial_apply_budget_change_request', {
      p_request_id: requestId,
    }, 'Concurrent request apply'), 'Concurrent request apply');
    equal(applied.status, 'APPLIED', 'Concurrent request applied status');
    equal(applied.gap_amount, 0, 'Concurrent request apply GAP');
    const afterApplyMaterial = await requestMaterialization(pg, requestId);
    equal(afterApplyMaterial.transfer_count, 1, 'Concurrent request transfer exactly once');
    equal(afterApplyMaterial.transfer_amount, CONCURRENT_AMOUNT, 'Concurrent request transfer amount');
    equal(afterApplyMaterial.lot_count, 0, 'Concurrent request movement/lot count');
    const afterA = {
      source: await position(localA, scenario.sourceA.id, 'Concurrent source after'),
      destination: await position(localA, scenario.destinationA.id, 'Concurrent destination after'),
      region: await regionTotals(pg, regionId),
      stats: await statistics(adminA, regionId, 'Dashboard stats after concurrent APPLY'),
      analytics: await filteredAnalytics(localA, scenario.year, profile.sido, profile.sigungu,
        'Analytics after concurrent APPLY'),
      snapshots: await exactSnapshots(pg, requestId),
    };
    equal(afterA.source.original_allocation, beforeA.source.original_allocation, 'Source original unchanged');
    equal(money(afterA.source.decrease_amount) - money(beforeA.source.decrease_amount), CONCURRENT_AMOUNT,
      'Source decrease once');
    equal(money(beforeA.source.adjusted_allocation) - money(afterA.source.adjusted_allocation), CONCURRENT_AMOUNT,
      'Source adjusted decrease');
    equal(afterA.source.execution_amount, beforeA.source.execution_amount, 'Source execution unchanged');
    equal(afterA.destination.original_allocation, beforeA.destination.original_allocation,
      'Destination original unchanged');
    equal(money(afterA.destination.increase_amount) - money(beforeA.destination.increase_amount), CONCURRENT_AMOUNT,
      'Destination increase once');
    equal(money(afterA.destination.adjusted_allocation) - money(beforeA.destination.adjusted_allocation),
      CONCURRENT_AMOUNT, 'Destination adjusted increase');
    equal(afterA.destination.execution_amount, beforeA.destination.execution_amount,
      'Destination execution unchanged');
    equal(afterA.region.adjusted, beforeA.region.adjusted, 'Region allocation conservation');
    equal(afterA.region.execution, beforeA.region.execution, 'Region execution conservation');
    equal(money(afterA.stats.transfer_amount) - money(beforeA.stats.transfer_amount), CONCURRENT_AMOUNT,
      'Dashboard transfer delta');
    equal(money(afterA.stats.transfer_count) - money(beforeA.stats.transfer_count), 1,
      'Dashboard transfer count delta');
    equal(afterA.stats.transaction_gap_amount, 0, 'Dashboard monetary GAP');
    equal(money(afterA.analytics.transfer_amount) - money(beforeA.analytics.transfer_amount), CONCURRENT_AMOUNT,
      'Analytics transfer delta');
    equal(afterA.analytics.transaction_gap_amount, 0, 'Analytics monetary GAP');
    equal(afterA.snapshots.length, 2, 'Exact source/destination snapshot count');

    const duplicateApplyBefore = await monetaryTotals(pg);
    const duplicateApply = one(await rpc(adminB, 'financial_apply_budget_change_request', {
      p_request_id: requestId,
    }, 'Duplicate APPLY'), 'Duplicate APPLY');
    equal(duplicateApply.status, 'APPLIED', 'Duplicate APPLY idempotent status');
    const duplicateApplyAfter = await monetaryTotals(pg);
    for (const field of Object.keys(duplicateApplyBefore)) {
      equal(duplicateApplyAfter[field], duplicateApplyBefore[field], `Duplicate APPLY no delta ${field}`);
    }
    const approveTerminal = await rawRpc(adminA, 'financial_approve_budget_change_request_group', {
      p_request_id: requestId, p_new_project_codes: {},
    });
    check(approveTerminal.error, 'APPLIED request re-approval unexpectedly succeeded.');
    const rejectTerminal = await rawRpc(adminA, 'financial_reject_budget_change_request', {
      p_request_id: requestId, p_reason: 'terminal 상태 반려 차단 UAT',
    });
    check(rejectTerminal.error, 'APPLIED request rejection unexpectedly succeeded.');

    const freshLocal = await signIn(supabaseUrl, anonKey, localEmail, localPassword, 'local_c fresh read');
    const freshPairs = await Promise.all([
      Promise.all([position(freshLocal, scenario.sourceA.id, 'Fresh local source'),
        position(adminA, scenario.sourceA.id, 'Fresh admin source')]),
      Promise.all([position(freshLocal, scenario.destinationA.id, 'Fresh local destination'),
        position(adminA, scenario.destinationA.id, 'Fresh admin destination')]),
    ]);
    for (const [localPosition, adminPosition] of freshPairs) {
      for (const field of ['original_allocation','increase_amount','decrease_amount','adjusted_allocation',
        'execution_amount','unexecuted_amount','execution_rate']) {
        equal(localPosition[field], adminPosition[field], `Fresh local/admin sync ${field}`);
      }
    }
    const histories = await Promise.all([
      rpc(freshLocal, 'get_financial_budget_change_requests', {
        p_project_id: scenario.sourceA.id, p_status: 'APPLIED', p_year: scenario.year, p_region_id: regionId,
      }, 'Source history'),
      rpc(freshLocal, 'get_financial_budget_change_requests', {
        p_project_id: scenario.destinationA.id, p_status: 'APPLIED', p_year: scenario.year, p_region_id: regionId,
      }, 'Destination history'),
    ]);
    check(histories.every((rows) => rows.some((row) => row.id === requestId)),
      'Source/destination history counterpart trace');

    const beforeReject = {
      source: await position(localA, scenario.sourceB.id, 'Reject source before'),
      destination: await position(localA, scenario.destinationB.id, 'Reject destination before'),
      monetary: await monetaryTotals(pg),
      region: await regionTotals(pg, regionId),
      stats: await statistics(adminA, regionId, 'Dashboard stats before rejection'),
      analytics: await filteredAnalytics(localA, scenario.year, profile.sido, profile.sigungu,
        'Analytics before rejection'),
    };
    check(money(beforeReject.source.unexecuted_amount) >= REJECT_AMOUNT, 'Reject source availability');
    const rejectedCreate = one(await rpc(localA, 'financial_test_uat_create_budget_change_request', {
      p_source_project_id: scenario.sourceB.id, p_source_budget_year_id: null,
      p_destinations: [{ destination_type: 'EXISTING_PROJECT', destination_project_id: scenario.destinationB.id,
        amount: REJECT_AMOUNT.toString(), note: 'REJECTION_UAT' }],
      p_effective_date: effectiveDate, p_reason: '관리자 반려 상태 모호성 회귀 사용자 검증',
      p_idempotency_key: crypto.randomUUID(), p_submit: true,
    }, 'Rejection scenario submit'), 'Rejection scenario submit');
    equal(rejectedCreate.status, 'SUBMITTED', 'Rejection scenario submitted');
    await actionableQueue(pg, adminA, rejectedCreate.request_id);
    const rejected = one(await rpc(adminA, 'financial_reject_budget_change_request', {
      p_request_id: rejectedCreate.request_id, p_reason: '반려 처리 함수 상태 모호성 수정 검증',
    }, 'Rejection scenario review'), 'Rejection scenario review');
    equal(rejected.status, 'REJECTED', 'Rejection scenario final status');
    const afterReject = {
      source: await position(localA, scenario.sourceB.id, 'Reject source after'),
      destination: await position(localA, scenario.destinationB.id, 'Reject destination after'),
      monetary: await monetaryTotals(pg),
      region: await regionTotals(pg, regionId),
      stats: await statistics(adminA, regionId, 'Dashboard stats after rejection'),
      analytics: await filteredAnalytics(localA, scenario.year, profile.sido, profile.sigungu,
        'Analytics after rejection'),
      materialized: await requestMaterialization(pg, rejectedCreate.request_id),
    };
    for (const field of ['original_allocation','increase_amount','decrease_amount','adjusted_allocation',
      'execution_amount','unexecuted_amount','execution_rate']) {
      equal(afterReject.source[field], beforeReject.source[field], `Rejected source unchanged ${field}`);
      equal(afterReject.destination[field], beforeReject.destination[field], `Rejected destination unchanged ${field}`);
    }
    for (const field of Object.keys(beforeReject.monetary)) {
      equal(afterReject.monetary[field], beforeReject.monetary[field], `Rejected no monetary delta ${field}`);
    }
    equal(afterReject.region.adjusted, beforeReject.region.adjusted, 'Rejected region amount unchanged');
    equal(afterReject.region.execution, beforeReject.region.execution, 'Rejected execution unchanged');
    equal(afterReject.stats.transfer_amount, beforeReject.stats.transfer_amount, 'Rejected Dashboard unchanged');
    equal(afterReject.analytics.transfer_amount, beforeReject.analytics.transfer_amount,
      'Rejected Analytics unchanged');
    equal(afterReject.materialized.transfer_count, 0, 'Rejected transfer count');
    equal(afterReject.materialized.lot_count, 0, 'Rejected lot/movement count');

    const crossRegionProject = (await pg.query(`select projects.id,projects.project_code
      from public.projects where projects.region_id<>$1 order by projects.id limit 1`, [regionId])).rows[0];
    check(crossRegionProject, 'Cross-region RLS fixture missing.');
    const crossRegionKey = crypto.randomUUID();
    const crossRegionAttempt = await rawRpc(localA, 'financial_test_uat_create_budget_change_request', {
      p_source_project_id: crossRegionProject.id, p_source_budget_year_id: null,
      p_destinations: [{ destination_type: 'EXISTING_PROJECT', destination_project_id: scenario.destinationB.id,
        amount: '1', note: 'RLS_UAT' }],
      p_effective_date: effectiveDate, p_reason: '타지역 write 차단 UAT',
      p_idempotency_key: crossRegionKey, p_submit: true,
    });
    check(crossRegionAttempt.error, 'Cross-region write unexpectedly succeeded.');
    equal(crossRegionAttempt.error.code, '42501', 'Cross-region write SQLSTATE');
    equal(Number((await pg.query(`select count(*)::integer as value
      from public.financial_budget_change_requests where idempotency_key=$1`, [crossRegionKey])).rows[0].value),
    0, 'Cross-region request rows');

    const duplicateAudit = (await pg.query(`select grouped.adjustment_fingerprint,
        grouped.source_project_id,projects.project_code,
        coalesce(nullif(btrim(projects.detail_project_name),''),nullif(btrim(projects.fund_project_name),''),
          nullif(btrim(projects.project_name),''),'사업명 확인 필요') as project_name,
        grouped.total_amount::text,grouped.request_count,grouped.statuses,
        grouped.duplicate_links,grouped.materialized_transfer_count,grouped.materialized_lot_count
      from (
        select requests.adjustment_fingerprint,requests.source_project_id,requests.total_amount,
          count(*)::integer as request_count,
          jsonb_agg(jsonb_build_object('id',requests.id,'status',requests.status,
            'duplicate_of',requests.duplicate_of_request_id) order by requests.requested_at) as statuses,
          count(requests.duplicate_of_request_id)::integer as duplicate_links,
          count(lines.materialized_transfer_id)::integer as materialized_transfer_count,
          count(lines.materialized_lot_id)::integer as materialized_lot_count
        from public.financial_budget_change_requests as requests
        left join public.financial_budget_change_request_lines as lines on lines.request_id=requests.id
        group by requests.adjustment_fingerprint,requests.source_project_id,requests.total_amount
        having count(distinct requests.id)>1
      ) as grouped
      join public.projects on projects.id=grouped.source_project_id
      order by grouped.request_count desc,grouped.adjustment_fingerprint`)).rows;
    const activeCanonicalDuplicates = Number((await pg.query(`select count(*)::integer as value from (
      select adjustment_fingerprint from public.financial_budget_change_requests
      where status in ('SUBMITTED','APPROVED','APPLIED') and duplicate_of_request_id is null
      group by adjustment_fingerprint having count(*)>1) as duplicates`)).rows[0].value);
    equal(activeCanonicalDuplicates, 0, 'Active canonical duplicate groups');
    const integrity = (await pg.query(`select
      (select count(*)::integer from (
        select requests.id from public.financial_budget_change_requests as requests
        left join public.financial_budget_change_request_lines as lines on lines.request_id=requests.id
        group by requests.id,requests.total_amount
        having requests.total_amount<>coalesce(sum(lines.amount),0)) as gaps) as request_gap_count,
      (select count(*)::integer from public.financial_funding_invariant_check
        where cohort_conservation_gap<>0 or decrease_resolution_gap<>0) as invariant_gap_count,
      (select count(*)::integer from public.financial_budget_change_requests
        where status in ('SUBMITTED','APPROVED') and duplicate_of_request_id is not null) as active_duplicate_count`)).rows[0];
    equal(integrity.request_gap_count, 0, 'Request monetary GAP count');
    equal(integrity.invariant_gap_count, 0, 'Funding invariant GAP count');
    equal(integrity.active_duplicate_count, 0, 'Active duplicate request count');
    const finalQueue = await actionableQueue(pg, adminA);

    process.stdout.write(`${JSON.stringify({
      status: 'PASS', target: 'TEST', project_ref: TEST_REF, production_touched: false,
      authenticated_accounts: ['local_c tab_a', 'local_c tab_b', 'local_c refresh', 'admin_a', 'admin_b'],
      actual_yanggu_duplicate: {
        reported_display_amount: '62450000', exact_database_amount: ACTUAL_AMOUNT.toString(),
        canonical_request_id: ACTUAL_APPLIED_ID, duplicate_request_id: ACTUAL_DUPLICATE_ID,
        before_status: actualBefore.duplicate.status, admin_projection_before: duplicateUi.status,
        final_status: actualAfter.duplicate.status, canonical_status: actualAfter.applied.status,
        source_before: actualBefore.source, source_after: actualAfter.source,
        destination_before: actualBefore.destination, destination_after: actualAfter.destination,
        transfer_count: actualAfter.materialized.transfer_count,
        transfer_amount: actualAfter.materialized.transfer_amount, movement_or_lot_count: 0,
        monetary_gap: '0', rejection_monetary_effect: '0',
      },
      concurrent_submit: {
        region: `${profile.sido} ${profile.sigungu}`, fiscal_year: scenario.year,
        source: scenario.sourceA, destination: scenario.destinationA,
        amount: CONCURRENT_AMOUNT.toString(), draft_revision_id: draftId,
        request_id: requestId, successes: successes.length, blocked: blocked.length,
        blocked_error: errorSummary(blocked[0].error), database_request_count: fingerprintCount,
        queue_before: beforeA.queue, queue_submitted: queueSubmitted,
        refresh_retry: errorSummary(refreshRetry.error), two_tab_retry: errorSummary(otherTabRetry.error),
        direct_internal_rpc_blocked: errorSummary(directBypass.error),
        source_before: beforeA.source, source_after: afterA.source,
        destination_before: beforeA.destination, destination_after: afterA.destination,
        exact_snapshots: afterA.snapshots, transfer_count: afterApplyMaterial.transfer_count,
        movement_or_lot_count: afterApplyMaterial.lot_count, monetary_gap: applied.gap_amount,
        duplicate_apply_monetary_delta: '0', terminal_reapprove_blocked: errorSummary(approveTerminal.error),
        terminal_reject_blocked: errorSummary(rejectTerminal.error),
        source_destination_history: 'PASS', fresh_local_admin_sync: 'PASS',
      },
      rejection: {
        request_id: rejectedCreate.request_id, source: scenario.sourceB, destination: scenario.destinationB,
        amount: REJECT_AMOUNT.toString(), status: rejected.status, sql_ambiguity: false,
        monetary_delta: '0', dashboard_delta: '0', analytics_delta: '0',
        transfer_count: afterReject.materialized.transfer_count,
        movement_or_lot_count: afterReject.materialized.lot_count,
      },
      dashboard: { before: beforeA.stats, after_apply: afterA.stats, after_reject: afterReject.stats },
      analytics: { before: beforeA.analytics, after_apply: afterA.analytics,
        after_reject: afterReject.analytics },
      rls: { cross_region_project_code: crossRegionProject.project_code,
        blocked: true, error: errorSummary(crossRegionAttempt.error), request_rows_created: 0 },
      duplicate_audit: { groups: duplicateAudit, active_canonical_duplicate_groups: activeCanonicalDuplicates },
      integrity, final_queue: finalQueue,
    }, null, 2)}\n`);
    await Promise.allSettled([
      refreshClient.client.auth.signOut(), freshLocal.client.auth.signOut(),
      localA.client.auth.signOut(), localB.client.auth.signOut(),
      adminA.client.auth.signOut(), adminB.client.auth.signOut(),
    ]);
  } finally {
    await pg.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`BUDGET ADJUSTMENT IDEMPOTENCY UAT FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
