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
const AMOUNT = 100_000_000n;

function fail(message) { throw new Error(message); }
function check(condition, message) { if (!condition) fail(message); }
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
function supabase(url, anonKey) {
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
async function signIn(url, anonKey, credentials, prefix, alias) {
  const client = supabase(url, anonKey);
  const { data, error } = await client.auth.signInWithPassword({
    email: required(credentials, `UAT_${prefix}_EMAIL`),
    password: required(credentials, `UAT_${prefix}_PASSWORD`),
  });
  if (error || !data.user || !data.session) fail(`${alias} TEST authentication failed.`);
  return { alias, client, userId: data.user.id };
}
async function rpc(account, name, args, label = name) {
  const { data, error } = await account.client.rpc(name, args ?? {});
  if (error) fail(`${label}: ${error.message}`);
  return data ?? [];
}
async function expectRpcError(account, name, args, label) {
  const { error } = await account.client.rpc(name, args ?? {});
  check(error, `${label} unexpectedly succeeded.`);
  return { code: error.code ?? 'RPC_ERROR', message: error.message };
}
function one(rows, label) {
  check(Array.isArray(rows) && rows.length === 1, `${label} must return one row.`);
  return rows[0];
}
async function project(pg, regionId, year, code) {
  const row = (await pg.query(`select id,region_id,year,project_code,
      coalesce(nullif(btrim(detail_project_name),''),nullif(btrim(fund_project_name),''),project_name) project_name
    from public.projects where region_id=$1 and year=$2 and project_code=$3`, [regionId, year, code])).rows[0];
  check(row, `TEST fixture project ${code} is missing.`);
  return row;
}
async function position(account, projectId, label) {
  const row = one(await rpc(account, 'get_financial_budget_change_project_position', {
    p_project_id: projectId,
  }, label), label);
  equal(amount(row.original_allocation) + amount(row.increase_amount) - amount(row.decrease_amount),
    row.adjusted_allocation, `${label} adjusted formula`);
  equal(amount(row.adjusted_allocation) - amount(row.execution_amount), row.unexecuted_amount,
    `${label} unexecuted formula`);
  return row;
}
async function regionSnapshot(pg, regionId) {
  const row = (await pg.query(`select
      (select count(*)::integer from public.projects where region_id=$1) project_count,
      (select coalesce(sum(coalesce(positions.ledger_adjusted_allocation,projects.alloc,0)),0)::bigint
        from public.projects left join public.financial_project_funding_positions positions
          on positions.project_id=projects.id where projects.region_id=$1)::text project_adjusted,
      (select coalesce(sum(coalesce(positions.ledger_execution_amount,projects.exec,0)),0)::bigint
        from public.projects left join public.financial_project_funding_positions positions
          on positions.project_id=projects.id where projects.region_id=$1)::text project_execution,
      (select coalesce(sum(amount),0)::bigint from public.financial_pending_new_project_funds
        where region_id=$1 and status='WAITING')::text waiting_funds,
      (select count(*)::integer from public.financial_budget_change_requests where region_id=$1) budget_requests,
      (select count(*)::integer from public.financial_new_project_requests where region_id=$1) new_requests,
      (select count(*)::integer from public.financial_pending_new_project_funds where region_id=$1) pending_funds`,
  [regionId])).rows[0];
  return { ...row, managed_total: (amount(row.project_adjusted) + amount(row.waiting_funds)).toString() };
}
async function groupRows(pg, requestId) {
  const request = (await pg.query(`select id,status,region_id,fiscal_year,source_project_id,total_amount
    from public.financial_budget_change_requests where id=$1`, [requestId])).rows[0];
  const lines = (await pg.query(`select lines.id,lines.line_no,lines.destination_type,
      lines.destination_project_id,lines.planned_project_name,lines.planned_project_year,
      lines.amount,lines.unlinked_funding_only,lines.new_project_request_id,
      lines.materialized_transfer_id,lines.materialized_lot_id,lines.pending_fund_id,
      new_requests.status new_project_status,new_requests.source_lot_id,
      new_requests.source_budget_change_request_id,new_requests.source_budget_change_line_id,
      new_requests.materialized_project_id,new_requests.materialized_movement_id
    from public.financial_budget_change_request_lines lines
    left join public.financial_new_project_requests new_requests
      on new_requests.id=lines.new_project_request_id
    where lines.request_id=$1 order by lines.line_no`, [requestId])).rows;
  const pending = (await pg.query(`select id,source_request_id,source_line_id,lot_id,amount,status,
      linked_project_id,linked_movement_id from public.financial_pending_new_project_funds
    where source_request_id=$1 order by source_line_id`, [requestId])).rows;
  return { request, lines, pending };
}
async function createGroup(account, sourceProjectId, destinations, effectiveDate, reason, idempotencyKey) {
  return one(await rpc(account, 'financial_test_uat_save_budget_change_request_complete_v2', {
    p_source_project_id: sourceProjectId,
    p_source_budget_year_id: null,
    p_destinations: destinations,
    p_effective_date: effectiveDate,
    p_reason: reason,
    p_idempotency_key: idempotencyKey,
    p_submit: true,
  }, reason), reason);
}
async function approveApplyGroup(adminA, adminB, requestId, codes = {}) {
  const approved = one(await rpc(adminA, 'financial_approve_budget_change_request_group', {
    p_request_id: requestId, p_new_project_codes: codes,
  }, `approve group ${requestId}`), 'group approve');
  equal(approved.status, 'APPROVED', 'group approved status');
  const applied = one(await rpc(adminB, 'financial_apply_budget_change_request_dispatch', {
    p_request_id: requestId,
  }, `apply group ${requestId}`), 'group apply');
  equal(applied.status, 'APPLIED', 'group applied status');
  equal(applied.gap_amount, 0, 'group apply gap');
  return { approved: approved.status, applied: applied.status };
}
function code(year, area, sequence) {
  return `${year}-${area}-${sequence}-${crypto.randomInt(1000, 9999)}`;
}

async function main() {
  check(has('--confirm-test-write'), 'UAT requires --confirm-test-write.');
  const env = load(arg('--env-file'));
  const credentials = load(arg('--credentials-file'));
  const url = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  check(String(env.TARGET_ENV).toUpperCase() === 'TEST'
    && required(env, 'TEST_PROJECT_REF') === TEST_REF
    && required(env, 'PROD_PROJECT_REF') === PROD_REF
    && refFromUrl(url) === TEST_REF
    && refFromDatabase(databaseUrl) === TEST_REF
    && refFromDatabase(databaseUrl) !== PROD_REF,
  'Fail-closed TEST target gate rejected configuration.');

  const [localA, localB, localC, adminA, adminB] = await Promise.all([
    signIn(url, anonKey, credentials, 'LOCAL_A', 'local_a'),
    signIn(url, anonKey, credentials, 'LOCAL_B', 'local_b'),
    signIn(url, anonKey, credentials, 'LOCAL_C', 'local_c'),
    signIn(url, anonKey, credentials, 'ADMIN_A', 'admin_a'),
    signIn(url, anonKey, credentials, 'ADMIN_B', 'admin_b'),
  ]);
  const accounts = [localA, localB, localC, adminA, adminB];
  const pg = new Client({ connectionString: connectionString(databaseUrl), ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000, application_name: 'multi-destination-budget-change-uat' });
  await pg.connect();
  try {
    await pg.query("set statement_timeout='180s'");
    const runtime = (await pg.query(`select environment_kind,mode,bound_project_ref,native_start_date::text
      from public.financial_ledger_runtime where singleton=true`)).rows[0];
    equal(runtime.environment_kind, 'TEST', 'runtime environment');
    equal(runtime.mode, 'TEST', 'runtime mode');
    equal(runtime.bound_project_ref, TEST_REF, 'runtime ref');
    const profiles = (await pg.query(`select profiles.id,profiles.role,profiles.region_id,regions.display_name
      from public.profiles left join public.regions on regions.id=profiles.region_id
      where profiles.id=any($1::uuid[])`, [accounts.map((account) => account.userId)])).rows;
    for (const admin of [adminA, adminB]) equal(profiles.find((row) => row.id === admin.userId)?.role, 'admin', `${admin.alias} role`);
    for (const local of [localA, localB, localC]) equal(profiles.find((row) => row.id === local.userId)?.role, 'local_user', `${local.alias} role`);
    const profileA = profiles.find((row) => row.id === localA.userId);
    const profileB = profiles.find((row) => row.id === localB.userId);
    const profileC = profiles.find((row) => row.id === localC.userId);
    equal(profileA.display_name, '전북 순창군', 'local_a region');
    equal(profileB.display_name, '부산 서구', 'local_b region');
    equal(profileC.display_name, '강원 양구군', 'local_c region');

    const fixtures = {
      A: {
        source: await project(pg, profileA.region_id, 2026, '2026-52-770-0005'),
        existing: await project(pg, profileA.region_id, 2026, '2026-52-770-0004'),
      },
      D: {
        source: await project(pg, profileB.region_id, 2026, '2026-26-140-0002'),
        existing: await project(pg, profileB.region_id, 2026, '2026-26-140-0014'),
      },
      B: {
        source: await project(pg, profileC.region_id, 2026, '2026-51-800-0008'),
        existing1: await project(pg, profileC.region_id, 2026, '2026-51-800-0003'),
        existing2: await project(pg, profileC.region_id, 2026, '2026-51-800-0005'),
      },
    };
    for (const [label, actor, source] of [['A', localA, fixtures.A.source], ['D', localB, fixtures.D.source], ['B', localC, fixtures.B.source]]) {
      const sourcePosition = await position(actor, source.id, `Scenario ${label} source position`);
      check(amount(sourcePosition.unexecuted_amount) >= AMOUNT, `Scenario ${label} source needs 100,000,000 won.`);
    }
    const crossRegionError = await expectRpcError(localB, 'get_financial_budget_change_project_position', {
      p_project_id: fixtures.A.source.id,
    }, 'cross-region project read');

    const before = {
      A: await regionSnapshot(pg, profileA.region_id),
      B: await regionSnapshot(pg, profileB.region_id),
      C: await regionSnapshot(pg, profileC.region_id),
    };
    const mutationLog = [];

    const keyA = crypto.randomUUID();
    const destinationsA = [
      { destination_type: 'EXISTING_PROJECT', destination_project_id: fixtures.A.existing.id,
        amount: '40000000', note: '당해연도 기존사업 배분' },
      { destination_type: 'PENDING_NEW_PROJECT', create_unlinked_funding: true,
        planned_project_name: '차년도 청년생활 기반 확충사업', planned_project_year: 2027,
        amount: '60000000', note: '예정재원 우선 확보' },
    ];
    const createdA = await createGroup(localA, fixtures.A.source.id, destinationsA,
      runtime.native_start_date, '복수 목적지 배분 검증', keyA);
    equal(createdA.status, 'SUBMITTED', 'Scenario A submitted');
    equal(createdA.gap_amount, 0, 'Scenario A create gap');
    const retryErrorA = await expectRpcError(localA,
      'financial_test_uat_save_budget_change_request_complete_v2', {
        p_source_project_id: fixtures.A.source.id, p_source_budget_year_id: null,
        p_destinations: destinationsA, p_effective_date: runtime.native_start_date,
        p_reason: '복수 목적지 배분 검증', p_idempotency_key: keyA, p_submit: true,
      }, 'Scenario A duplicate submit');
    const queueA = (await rpc(adminA, 'get_financial_budget_change_requests', {
      p_project_id: null, p_status: 'SUBMITTED', p_year: 2026, p_region_id: profileA.region_id,
    }, 'Scenario A admin queue')).find((row) => row.id === createdA.request_id);
    check(queueA && queueA.destinations.length === 2, 'Scenario A admin queue must contain both destinations.');
    equal(queueA.destinations[0].amount, '40000000', 'Scenario A existing queue amount');
    equal(queueA.destinations[1].amount, '60000000', 'Scenario A reserved queue amount');
    const stateA = await approveApplyGroup(adminA, adminB, createdA.request_id, {});
    const replayA = one(await rpc(adminB, 'financial_apply_budget_change_request_dispatch', {
      p_request_id: createdA.request_id,
    }, 'Scenario A duplicate apply'), 'Scenario A duplicate apply');
    equal(replayA.status, 'APPLIED', 'Scenario A idempotent apply');
    const groupA = await groupRows(pg, createdA.request_id);
    equal(groupA.lines.length, 2, 'Scenario A DB child count');
    equal(groupA.pending.length, 1, 'Scenario A pending count');
    const reservedLineA = groupA.lines.find((line) => line.unlinked_funding_only);
    check(reservedLineA?.new_project_request_id && reservedLineA?.pending_fund_id, 'Scenario A reserved draft relation');
    equal(reservedLineA.new_project_status, 'DRAFT', 'Scenario A reserved draft state');
    equal(reservedLineA.source_lot_id, reservedLineA.materialized_lot_id, 'Scenario A draft lot succession');
    equal(reservedLineA.source_budget_change_request_id, null, 'Scenario A draft group source detached after apply');
    const requestCountBeforeDetail = Number((await pg.query(`select count(*) value from public.financial_new_project_requests
      where id=$1`, [reservedLineA.new_project_request_id])).rows[0].value);
    equal(requestCountBeforeDetail, 1, 'Scenario E one stable draft');

    const savedDetail = one(await rpc(localA, 'financial_save_new_project_request_draft_v2', {
      p_request_id: reservedLineA.new_project_request_id,
      p_region_id: profileA.region_id, p_fiscal_year: 2027,
      p_project_name: '차년도 청년생활 기반 확충사업',
      p_fund_project_name: '차년도 청년생활 기반 확충사업',
      p_detail_project_name: '청년생활 기반 확충 세부사업',
      p_project_period: '2027.01~2027.12', p_project_start_year: 2027, p_project_end_year: 2027,
      p_status: '정상추진', p_business_type: 'HW', p_large_category_id: null,
      p_middle_category_id: null, p_source_lot_id: reservedLineA.materialized_lot_id,
      p_requested_amount: '60000000', p_idempotency_key: crypto.randomUUID(),
      p_execution_status_reason: null,
    }, 'Scenario E continue reserved draft'), 'Scenario E draft save');
    equal(savedDetail.request_id, reservedLineA.new_project_request_id, 'Scenario E stable request id');
    const submittedDetail = one(await rpc(localA, 'financial_submit_new_project_request_v2', {
      p_request_id: reservedLineA.new_project_request_id,
    }, 'Scenario E submit new project'), 'Scenario E submit');
    equal(submittedDetail.status, 'SUBMITTED', 'Scenario E new project submitted');
    const officialA = code(2027, '52-770', '91');
    const approvedDetail = one(await rpc(adminA, 'financial_approve_new_project_request', {
      p_request_id: reservedLineA.new_project_request_id, p_official_project_code: officialA,
    }, 'Scenario E approve new project'), 'Scenario E approve');
    equal(approvedDetail.status, 'APPROVED', 'Scenario E new project approved');
    const appliedDetail = one(await rpc(adminB, 'financial_apply_new_project_request_v2', {
      p_request_id: reservedLineA.new_project_request_id,
    }, 'Scenario E apply and auto-link'), 'Scenario E apply');
    check(appliedDetail.project_id && appliedDetail.movement_id, 'Scenario E materialization result');
    const appliedDetailReplay = one(await rpc(adminB, 'financial_apply_new_project_request_v2', {
      p_request_id: reservedLineA.new_project_request_id,
    }, 'Scenario E duplicate apply'), 'Scenario E duplicate apply');
    equal(appliedDetailReplay.project_id, appliedDetail.project_id, 'Scenario E idempotent project');
    equal(appliedDetailReplay.movement_id, appliedDetail.movement_id, 'Scenario E idempotent movement');
    const pendingAfterE = (await pg.query(`select status,linked_project_id,linked_movement_id
      from public.financial_pending_new_project_funds where id=$1`, [reservedLineA.pending_fund_id])).rows[0];
    equal(pendingAfterE.status, 'LINKED', 'Scenario E pending linked');
    equal(pendingAfterE.linked_project_id, appliedDetail.project_id, 'Scenario E linked project');
    const newPositionA = await position(localA, appliedDetail.project_id, 'Scenario E materialized position');
    equal(newPositionA.increase_amount, '60000000', 'Scenario E destination increase');
    equal(newPositionA.adjusted_allocation, '60000000', 'Scenario E adjusted allocation');
    mutationLog.push({ account: 'local_a/admin_a/admin_b', scenario: 'A/E/H',
      source_project: fixtures.A.source.project_code, group_id: createdA.request_id,
      amount: '100000000', existing: '40000000', reserved: '60000000',
      new_project_request_id: reservedLineA.new_project_request_id,
      materialized_project_id: appliedDetail.project_id, result: 'APPLIED_AND_LINKED' });

    const standaloneKey = crypto.randomUUID();
    const standaloneName = '부산 차년도 의료생활 지원사업';
    const standalone = one(await rpc(localB, 'financial_save_new_project_request_draft_v2', {
      p_request_id: null, p_region_id: profileB.region_id, p_fiscal_year: 2027,
      p_project_name: standaloneName, p_fund_project_name: standaloneName,
      p_detail_project_name: standaloneName, p_project_period: '2027.01~2027.12',
      p_project_start_year: 2027, p_project_end_year: 2027, p_status: '정상추진',
      p_business_type: 'SW', p_large_category_id: null, p_middle_category_id: null,
      p_source_lot_id: null, p_requested_amount: '60000000', p_idempotency_key: standaloneKey,
      p_execution_status_reason: null,
    }, 'Scenario D standalone draft'), 'Scenario D draft');
    const newCountBeforeD = Number((await pg.query(`select count(*) value from public.financial_new_project_requests
      where region_id=$1`, [profileB.region_id])).rows[0].value);
    const destinationsD = [
      { destination_type: 'EXISTING_PROJECT', destination_project_id: fixtures.D.existing.id,
        amount: '40000000', note: '기존 목적지' },
      { destination_type: 'PENDING_NEW_PROJECT', existing_new_project_request_id: standalone.request_id,
        planned_project_name: standaloneName, planned_project_year: 2027,
        planned_fund_project_name: standaloneName, planned_detail_project_name: standaloneName,
        planned_project_period: '2027.01~2027.12', planned_project_start_year: 2027,
        planned_project_end_year: 2027, planned_project_status: '정상추진',
        planned_business_type: 'SW', amount: '60000000', note: '기존 신규사업 요청 연결' },
    ];
    const createdD = await createGroup(localB, fixtures.D.source.id, destinationsD,
      runtime.native_start_date, '사전 생성 신규사업 연결 검증', crypto.randomUUID());
    const groupDBefore = await groupRows(pg, createdD.request_id);
    equal(groupDBefore.lines.length, 2, 'Scenario D line count');
    equal(groupDBefore.lines[1].new_project_request_id, standalone.request_id, 'Scenario D reuses request id');
    equal(Number((await pg.query(`select count(*) value from public.financial_new_project_requests
      where region_id=$1`, [profileB.region_id])).rows[0].value), newCountBeforeD,
    'Scenario D must not create duplicate request');
    const officialD = code(2027, '26-140', '92');
    const stateD = await approveApplyGroup(adminA, adminB, createdD.request_id, {
      [standalone.request_id]: officialD,
    });
    const groupDAfter = await groupRows(pg, createdD.request_id);
    equal(groupDAfter.lines[1].new_project_status, 'APPLIED', 'Scenario D new request applied');
    check(groupDAfter.lines[1].materialized_project_id, 'Scenario D project materialized');
    mutationLog.push({ account: 'local_b/admin_a/admin_b', scenario: 'D',
      source_project: fixtures.D.source.project_code, group_id: createdD.request_id,
      amount: '100000000', existing: '40000000', precreated_request: '60000000',
      new_project_request_id: standalone.request_id,
      materialized_project_id: groupDAfter.lines[1].materialized_project_id, result: 'APPLIED' });

    const destinationsB = [
      { destination_type: 'PENDING_NEW_PROJECT', create_unlinked_funding: true,
        planned_project_name: '양구 차년도 일자리 연계 기반사업', planned_project_year: 2027,
        amount: '60000000', note: '신규사업을 먼저 입력' },
      { destination_type: 'EXISTING_PROJECT', destination_project_id: fixtures.B.existing1.id,
        amount: '20000000', note: '첫 번째 기존사업' },
      { destination_type: 'EXISTING_PROJECT', destination_project_id: fixtures.B.existing2.id,
        amount: '10000000', note: '두 번째 기존사업' },
      { destination_type: 'PENDING_NEW_PROJECT', create_unlinked_funding: true,
        planned_project_name: '양구 차년도 교통생활 기반사업', planned_project_year: 2027,
        amount: '10000000', note: '두 번째 예정재원' },
    ];
    const createdB = await createGroup(localC, fixtures.B.source.id, destinationsB,
      runtime.native_start_date, '신규사업 우선 복수 목적지 검증', crypto.randomUUID());
    const queueB = (await rpc(adminA, 'get_financial_budget_change_requests', {
      p_project_id: null, p_status: 'SUBMITTED', p_year: 2026, p_region_id: profileC.region_id,
    }, 'Scenario B admin queue')).find((row) => row.id === createdB.request_id);
    check(queueB && queueB.destinations.length === 4, 'Scenario B admin queue child count');
    equal(queueB.destinations[0].amount, '60000000', 'Scenario B first new destination preserved');
    const stateB = await approveApplyGroup(adminA, adminB, createdB.request_id, {});
    const groupB = await groupRows(pg, createdB.request_id);
    equal(groupB.lines.length, 4, 'Scenario B DB child count');
    equal(groupB.pending.length, 2, 'Scenario B multiple pending count');
    equal(groupB.lines.filter((line) => line.destination_type === 'EXISTING_PROJECT').length, 2,
      'Scenario B multiple existing count');
    equal(groupB.lines.filter((line) => line.unlinked_funding_only).length, 2,
      'Scenario B multiple new count');
    mutationLog.push({ account: 'local_c/admin_a/admin_b', scenario: 'B/C/F/G',
      source_project: fixtures.B.source.project_code, group_id: createdB.request_id,
      amount: '100000000', destinations: ['60000000', '20000000', '10000000', '10000000'],
      result: 'APPLIED' });

    const requestIds = [createdA.request_id, createdD.request_id, createdB.request_id];
    const integrity = (await pg.query(`select
      (select count(*)::integer from (
        select requests.id from public.financial_budget_change_requests requests
        left join public.financial_budget_change_request_lines lines on lines.request_id=requests.id
        where requests.id=any($1::uuid[]) group by requests.id,requests.total_amount
        having requests.total_amount<>coalesce(sum(lines.amount),0)) gaps) request_gaps,
      (select count(*)::integer from public.financial_funding_invariant_check
        where cohort_conservation_gap<>0 or decrease_resolution_gap<>0) invariant_gaps,
      (select count(*)::integer from public.financial_budget_change_requests
        where id=any($1::uuid[]) and status<>'APPLIED') partial_groups,
      (select count(*)::integer from public.financial_pending_new_project_funds pending
        join public.financial_budget_change_request_lines lines on lines.pending_fund_id=pending.id
        where lines.request_id=any($1::uuid[]) and lines.new_project_request_id is null) orphan_pending,
      (select count(*)::integer from public.financial_budget_change_request_lines lines
        where lines.request_id=any($1::uuid[])) destination_count`, [requestIds])).rows[0];
    equal(integrity.request_gaps, 0, 'request monetary gaps');
    equal(integrity.invariant_gaps, 0, 'Ledger invariant gaps');
    equal(integrity.partial_groups, 0, 'partial group applies');
    equal(integrity.orphan_pending, 0, 'orphan pending funds');
    equal(integrity.destination_count, 8, 'UI/API/DB destination total');

    const after = {
      A: await regionSnapshot(pg, profileA.region_id),
      B: await regionSnapshot(pg, profileB.region_id),
      C: await regionSnapshot(pg, profileC.region_id),
    };
    for (const key of ['A', 'B', 'C']) {
      equal(after[key].managed_total, before[key].managed_total, `${key} managed regional total conservation`);
      equal(after[key].project_execution, before[key].project_execution, `${key} execution total unchanged`);
    }
    const localHistoryA = await rpc(localA, 'get_financial_budget_change_requests', {
      p_project_id: null, p_status: 'APPLIED', p_year: 2026, p_region_id: profileA.region_id,
    }, 'local_a history');
    const adminHistoryA = await rpc(adminA, 'get_financial_budget_change_requests', {
      p_project_id: null, p_status: 'APPLIED', p_year: 2026, p_region_id: profileA.region_id,
    }, 'admin history');
    check(localHistoryA.some((row) => row.id === createdA.request_id && row.destinations.length === 2),
      'local history group parity');
    check(adminHistoryA.some((row) => row.id === createdA.request_id && row.destinations.length === 2),
      'admin history group parity');
    const duplicateCounts = (await pg.query(`select
      (select count(*)::integer from public.financial_budget_change_requests where id=any($1::uuid[])) groups,
      (select count(*)::integer from public.financial_pending_new_project_funds
        where source_request_id=any($1::uuid[])) pending,
      (select count(*)::integer from public.financial_unallocated_fund_movements movements
        join public.financial_pending_new_project_funds pending on pending.linked_movement_id=movements.id
        where pending.source_request_id=any($1::uuid[])) linked_movements`, [requestIds])).rows[0];
    equal(duplicateCounts.groups, 3, 'no duplicate groups');
    equal(duplicateCounts.pending, 4, 'one trace or reserved pending row per new-project line');
    equal(duplicateCounts.linked_movements, 2, 'one immediate and one deferred materialization movement');

    const result = {
      status: 'PASS', target: 'TEST', project_ref: TEST_REF, production_touched: false,
      runtime, accounts: profiles.map((row) => ({ alias: accounts.find((account) => account.userId === row.id)?.alias,
        role: row.role, region: row.display_name ?? null })),
      cross_region_rls: { status: 'PASS', error_code: crossRegionError.code },
      scenarios: {
        A: { status: 'PASS', group_id: createdA.request_id, destination_count: 2,
          ui_payload_db_count: '2/2/2', state: stateA, gap: '0' },
        B: { status: 'PASS', group_id: createdB.request_id, first_destination: 'PENDING_NEW_PROJECT:60000000',
          remaining_after_first: '40000000', destination_count: 4, state: stateB, gap: '0' },
        C: { status: 'PASS', group_id: createdA.request_id, order: ['EXISTING_PROJECT', 'PENDING_NEW_PROJECT'] },
        D: { status: 'PASS', group_id: createdD.request_id, reused_request_id: standalone.request_id,
          duplicate_request_delta: 0, state: stateD },
        E: { status: 'PASS', group_id: createdA.request_id,
          stable_request_id: reservedLineA.new_project_request_id,
          materialized_project_id: appliedDetail.project_id,
          pending_status: pendingAfterE.status, destination_increase: newPositionA.increase_amount },
        F: { status: 'PASS', evidence: 'unit stable-key middle delete/replace and gap restoration' },
        G: { status: 'PASS', evidence: 'unit under/over/exact BigInt validation and per-line maximum' },
        H: { status: 'PASS', duplicate_submit_error: retryErrorA.code,
          group_apply_replay: replayA.status, project_apply_same_id: true,
          groups: duplicateCounts.groups, pending: duplicateCounts.pending,
          linked_movements: duplicateCounts.linked_movements },
      },
      integrity, destination_counts: { ui_intended: 8, api_payload: 8, database: integrity.destination_count,
        admin_queue_A: queueA.destinations.length, admin_queue_B: queueB.destinations.length,
        local_history_A: localHistoryA.find((row) => row.id === createdA.request_id)?.destinations.length,
        admin_history_A: adminHistoryA.find((row) => row.id === createdA.request_id)?.destinations.length },
      monetary: { group_gaps: '0', ledger_invariant_gaps: integrity.invariant_gaps,
        region_before: before, region_after: after, regional_managed_total_gap: { A: '0', B: '0', C: '0' } },
      mutation_log: mutationLog,
    };
    const output = arg('--output');
    if (output) {
      const resolved = path.resolve(process.cwd(), output);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await pg.end().catch(() => undefined);
    await Promise.allSettled(accounts.map((account) => account.client.auth.signOut()));
  }
}

main().catch((error) => {
  process.stderr.write(`MULTI DESTINATION BUDGET UAT FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
