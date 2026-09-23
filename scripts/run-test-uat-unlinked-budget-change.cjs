#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dotenv = require('dotenv');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';
const SOURCE_CODE = '2025-51-800-0001';
const UAT_YEAR = 2025;
const TRANSFER_AMOUNT = 10_000_000n;

let activePg = null;

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }
function equal(actual, expected, message) {
  if (String(actual) !== String(expected)) fail(`${message} (expected=${expected}, actual=${actual})`);
}
function amount(value) { return BigInt(value ?? 0); }
function arg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function has(name) { return process.argv.includes(name); }
function load(file) {
  const resolved = path.resolve(process.cwd(), file ?? '');
  assert(file && fs.existsSync(resolved), `Missing explicit env file: ${file ?? '(none)'}`);
  return dotenv.parse(fs.readFileSync(resolved));
}
function required(env, name) {
  const value = String(env[name] ?? '').trim();
  assert(value, `${name} is required.`);
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
function client(url, anonKey) {
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
async function signIn(url, anonKey, email, password, alias) {
  const instance = client(url, anonKey);
  const { data, error } = await instance.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user) fail(`${alias} TEST authentication failed.`);
  return { alias, client: instance, userId: data.user.id };
}
async function rpc(instance, name, args, label = name) {
  const { data, error } = await instance.rpc(name, args ?? {});
  if (error) fail(`${label}: ${error.message}`);
  return data;
}
async function expectRpcError(instance, name, args, label) {
  const { error } = await instance.rpc(name, args ?? {});
  assert(error, `${label} unexpectedly succeeded.`);
  return error.code ?? 'RPC_ERROR';
}
async function position(instance, projectId, label) {
  const rows = await rpc(instance, 'get_financial_budget_change_project_position', {
    p_project_id: projectId,
  }, label);
  assert(Array.isArray(rows) && rows.length === 1, `${label} must return one row.`);
  const row = rows[0];
  equal(amount(row.original_allocation) + amount(row.increase_amount) - amount(row.decrease_amount),
    row.adjusted_allocation, `${label} 공식 배분액 산식`);
  equal(amount(row.adjusted_allocation) - amount(row.execution_amount),
    row.unexecuted_amount, `${label} 미집행액 산식`);
  assert(row.valid_execution === true, `${label} 집행액은 조정 후 배분액 이하여야 합니다.`);
  return row;
}
async function stats(instance, regionId) {
  const rows = await rpc(instance, 'get_financial_budget_change_statistics', {
    p_year: UAT_YEAR, p_region_id: regionId,
  }, '예산조정 통계');
  assert(rows.length === 1, '예산조정 통계는 한 행이어야 합니다.');
  return rows[0];
}
async function snapshot(pg, regionId) {
  const result = await pg.query(`select
    (select md5(string_agg(concat_ws('|', id::text, total_budget::text,
      original_alloc::text, increase_amount::text, decrease_amount::text,
      alloc::text, exec::text, rate::text), E'\\n' order by id)) from public.projects) as projects_money,
    (select coalesce(sum(case when positions.projection_ready
        then positions.ledger_adjusted_allocation else coalesce(projects.alloc, 0) end), 0)::bigint
      from public.projects
      left join public.financial_project_funding_positions as positions
        on positions.project_id = projects.id
      where projects.region_id = $1) as region_adjusted_allocation,
    (select coalesce(sum(case when positions.projection_ready
        then positions.ledger_execution_amount else coalesce(projects.exec, 0) end), 0)::bigint
      from public.projects
      left join public.financial_project_funding_positions as positions
        on positions.project_id = projects.id
      where projects.region_id = $1) as region_execution,
    (select count(*)::bigint from public.financial_test_uat_project_bootstraps) as bootstrap_count,
    (select count(*)::bigint from public.project_budget_years) as wallet_count,
    (select count(*)::bigint from public.project_budget_cohorts) as cohort_count,
    (select count(*)::bigint from public.project_fund_transfers) as transfer_count,
    (select coalesce(sum(amount),0)::bigint from public.project_fund_transfers) as transfer_amount,
    (select count(*)::bigint from public.financial_budget_change_requests) as request_count`, [regionId]);
  return result.rows[0];
}
async function createApproveApply({ local, adminA, adminB, sourceProjectId, destinationProjectId,
  effectiveDate, reason, note }) {
  const created = await rpc(local, 'financial_test_uat_create_budget_change_request', {
    p_source_project_id: sourceProjectId,
    p_source_budget_year_id: null,
    p_destinations: [{
      destination_type: 'EXISTING_PROJECT',
      destination_project_id: destinationProjectId,
      amount: String(TRANSFER_AMOUNT),
      note,
    }],
    p_effective_date: effectiveDate,
    p_reason: reason,
    p_idempotency_key: crypto.randomUUID(),
    p_submit: true,
  }, `${reason} 요청`);
  assert(created.length === 1, `${reason} 요청 결과가 없습니다.`);
  equal(created[0].status, 'SUBMITTED', `${reason} 제출 상태`);
  equal(created[0].gap_amount, 0, `${reason} 요청 GAP`);

  const selfApproval = await expectRpcError(local, 'financial_approve_budget_change_request', {
    p_request_id: created[0].request_id,
  }, `${reason} 요청자 자기승인 차단`);
  assert(selfApproval, `${reason} 자기승인 차단 코드가 필요합니다.`);
  const approved = await rpc(adminA, 'financial_approve_budget_change_request', {
    p_request_id: created[0].request_id,
  }, `${reason} 관리자 A 승인`);
  equal(approved[0]?.status, 'APPROVED', `${reason} 승인 상태`);
  const applied = await rpc(adminB, 'financial_apply_budget_change_request', {
    p_request_id: created[0].request_id,
  }, `${reason} 관리자 B 적용`);
  equal(applied[0]?.status, 'APPLIED', `${reason} 적용 상태`);
  equal(applied[0]?.gap_amount, 0, `${reason} 적용 GAP`);
  return String(created[0].request_id);
}

async function main() {
  assert(has('--confirm-test-write'), 'UAT requires --confirm-test-write.');
  const env = load(arg('--env-file'));
  const credentials = load(arg('--credentials-file'));
  const testRef = required(env, 'TEST_PROJECT_REF');
  const prodRef = required(env, 'PROD_PROJECT_REF');
  const supabaseUrl = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  assert(String(env.TARGET_ENV).toUpperCase() === 'TEST'
    && testRef === TEST_REF && prodRef === PROD_REF && testRef !== prodRef
    && refFromUrl(supabaseUrl) === TEST_REF
    && refFromDatabase(databaseUrl) === TEST_REF
    && refFromDatabase(databaseUrl) !== PROD_REF,
  'Fail-closed TEST target gate rejected configuration.');

  const pg = new Client({ connectionString: connectionString(databaseUrl), ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000, application_name: 'unlinked-budget-change-uat' });
  activePg = pg;
  await pg.connect();
  const [adminA, adminB, localC] = await Promise.all([
    signIn(supabaseUrl, anonKey, required(credentials, 'UAT_ADMIN_A_EMAIL'), required(credentials, 'UAT_ADMIN_A_PASSWORD'), 'admin_a'),
    signIn(supabaseUrl, anonKey, required(credentials, 'UAT_ADMIN_B_EMAIL'), required(credentials, 'UAT_ADMIN_B_PASSWORD'), 'admin_b'),
    signIn(supabaseUrl, anonKey, required(credentials, 'UAT_LOCAL_C_EMAIL'), required(credentials, 'UAT_LOCAL_C_PASSWORD'), 'local_c'),
  ]);
  const profiles = await pg.query(`select id, role, region_id from public.profiles where id = any($1::uuid[])`,
    [[adminA.userId, adminB.userId, localC.userId]]);
  const byId = new Map(profiles.rows.map((row) => [row.id, row]));
  assert(byId.get(adminA.userId)?.role === 'admin' && byId.get(adminB.userId)?.role === 'admin',
    'TEST 관리자 A/B 프로필이 필요합니다.');
  const localProfile = byId.get(localC.userId);
  assert(localProfile?.role === 'local_user' && localProfile.region_id, 'local_c 지역 프로필이 필요합니다.');
  const region = (await pg.query('select sido, sigungu from public.regions where id = $1', [localProfile.region_id])).rows[0];
  equal(`${region?.sido} ${region?.sigungu}`, '강원 양구군', 'local_c UAT 지역');

  const runtime = (await pg.query(`select environment_kind, mode, bound_project_ref,
      native_start_date::text as native_start_date
    from public.financial_ledger_runtime where singleton = true`)).rows[0];
  equal(runtime?.environment_kind, 'TEST', 'Ledger environment');
  equal(runtime?.mode, 'TEST', 'Ledger mode');
  equal(runtime?.bound_project_ref, TEST_REF, 'Ledger TEST ref');
  const effectiveDate = String(runtime.native_start_date);

  const sourceA = (await pg.query(`select projects.id, projects.project_code,
      coalesce(projects.detail_project_name, projects.fund_project_name, projects.project_name) as project_name,
      projects.original_alloc::bigint, projects.increase_amount::bigint, projects.decrease_amount::bigint,
      projects.alloc::bigint, projects.exec::bigint,
      count(wallets.id)::integer as wallet_count,
      count(attestations.project_id)::integer as attestation_count
    from public.projects
    left join public.project_budget_years as wallets on wallets.project_id = projects.id
    left join public.financial_project_baseline_attestations as attestations on attestations.project_id = projects.id
    where projects.region_id = $1 and projects.year = $2 and projects.project_code = $3
    group by projects.id`, [localProfile.region_id, UAT_YEAR, SOURCE_CODE])).rows[0];
  assert(sourceA, `${SOURCE_CODE} 실사업이 필요합니다.`);

  const fixtures = (await pg.query(`select projects.id, projects.project_code,
      coalesce(projects.detail_project_name, projects.fund_project_name, projects.project_name) as project_name,
      projects.original_alloc::bigint, projects.increase_amount::bigint, projects.decrease_amount::bigint,
      projects.alloc::bigint, projects.exec::bigint,
      count(wallets.id)::integer as wallet_count,
      count(attestations.project_id)::integer as attestation_count
    from public.projects
    left join public.project_budget_years as wallets on wallets.project_id = projects.id
    left join public.financial_project_baseline_attestations as attestations on attestations.project_id = projects.id
    where projects.region_id = $1 and projects.year = $2 and projects.id <> $3
      and coalesce(projects.exec,0) <= coalesce(projects.alloc,0)
    group by projects.id
    having count(wallets.id) = 0 and count(attestations.project_id) = 0
    order by (coalesce(projects.alloc,0) - coalesce(projects.exec,0)) desc,
      projects.project_code, projects.id`,
  [localProfile.region_id, UAT_YEAR, sourceA.id])).rows;
  equal(sourceA.alloc, 144_000_000n, '실사업 A 현재 배분액');
  equal(sourceA.exec, 124_800_000n, '실사업 A 현재 집행액');
  assert(amount(sourceA.alloc) - amount(sourceA.exec) >= TRANSFER_AMOUNT, '실사업 A 미집행액이 1천만원 이상이어야 합니다.');

  const sourceD = fixtures.find((row) => amount(row.alloc) - amount(row.exec) >= TRANSFER_AMOUNT);
  const destinationB = fixtures.find((row) => row.id !== sourceD?.id && amount(row.alloc) > 0n);
  const targetC = fixtures.find((row) => ![sourceD?.id, destinationB?.id].includes(row.id));
  assert(sourceD && destinationB && targetC, '서로 다른 미연결 TEST 사업 B/C/D가 필요합니다.');
  const fixtureIds = [sourceA.id, destinationB.id, sourceD.id, targetC.id];

  const existingBootstraps = await pg.query(`select count(*)::integer as count
    from public.financial_test_uat_project_bootstraps where project_id = any($1::uuid[])`, [fixtureIds]);
  const preexistingFixtureBootstrapCount = Number(existingBootstraps.rows[0]?.count ?? 0);
  assert(preexistingFixtureBootstrapCount <= 1,
    '재개 시에는 앞선 적용일 검증에서 생성된 A 기준재원 한 건만 허용됩니다.');
  const previousRequests = await rpc(localC.client, 'get_financial_budget_change_requests', {
    p_project_id: sourceA.id, p_status: null, p_year: UAT_YEAR, p_region_id: localProfile.region_id,
  }, '이전 실패 요청 확인');
  const invalidApproved = previousRequests.filter((row) => row.status === 'APPROVED'
    && row.reason === 'TEST 미연결 사업 A 감액 후 기존사업 B 배분'
    && row.effective_date < effectiveDate);
  for (const row of invalidApproved) {
    const rejected = await rpc(adminB.client, 'financial_reject_budget_change_request', {
      p_request_id: row.id,
      p_reason: 'TEST UAT 적용일 직렬화 오류로 인한 승인 취소',
    }, '잘못된 적용일 승인요청 반려');
    equal(rejected[0]?.status, 'REJECTED', '잘못된 적용일 요청 반려 상태');
  }
  const before = await snapshot(pg, localProfile.region_id);
  const statsBefore = await stats(adminA.client, localProfile.region_id);
  const sourceBefore = await position(localC.client, sourceA.id, '감액 시작 사업 A 사전 포지션');
  equal(sourceBefore.adjusted_allocation, 144_000_000n, 'A 사전 조정 후 배분액');
  equal(sourceBefore.execution_amount, 124_800_000n, 'A 사전 집행액');
  equal(sourceBefore.unexecuted_amount, 19_200_000n, 'A 사전 미집행액');
  const destinationBefore = await position(localC.client, destinationB.id, '기존사업 B 사전 포지션');
  const sourceDBefore = await position(localC.client, sourceD.id, '증액 출처 사업 D 사전 포지션');
  const targetBefore = await position(localC.client, targetC.id, '증액 대상 사업 C 사전 포지션');

  const decreaseRequest = await createApproveApply({
    local: localC.client, adminA: adminA.client, adminB: adminB.client,
    sourceProjectId: sourceA.id, destinationProjectId: destinationB.id, effectiveDate,
    reason: 'TEST 미연결 사업 A 감액 후 기존사업 B 배분', note: '감액 버튼 UAT',
  });
  const increaseRequest = await createApproveApply({
    local: localC.client, adminA: adminA.client, adminB: adminB.client,
    sourceProjectId: sourceD.id, destinationProjectId: targetC.id, effectiveDate,
    reason: 'TEST 미연결 사업 C 증액과 출처 사업 D 감액', note: 'INCREASE_TARGET',
  });

  const sourceAfter = await position(localC.client, sourceA.id, '감액 사업 A 적용 후');
  const destinationAfter = await position(localC.client, destinationB.id, '기존사업 B 적용 후');
  const sourceDAfter = await position(localC.client, sourceD.id, '증액 출처 사업 D 적용 후');
  const targetAfter = await position(localC.client, targetC.id, '증액 대상 사업 C 적용 후');
  equal(amount(sourceAfter.adjusted_allocation), amount(sourceBefore.adjusted_allocation) - TRANSFER_AMOUNT,
    'A 조정 후 배분액 감액');
  equal(sourceAfter.adjusted_allocation, 134_000_000n, 'A 최종 조정 후 배분액');
  equal(sourceAfter.execution_amount, sourceBefore.execution_amount, 'A 집행액 유지');
  equal(sourceAfter.unexecuted_amount, 9_200_000n, 'A 최종 미집행액');
  equal(amount(sourceAfter.decrease_amount), amount(sourceBefore.decrease_amount) + TRANSFER_AMOUNT, 'A 감액액 증가');
  equal(amount(destinationAfter.adjusted_allocation), amount(destinationBefore.adjusted_allocation) + TRANSFER_AMOUNT,
    'B 조정 후 배분액 증액');
  equal(amount(destinationAfter.increase_amount), amount(destinationBefore.increase_amount) + TRANSFER_AMOUNT, 'B 증액액 증가');
  equal(amount(sourceDAfter.adjusted_allocation), amount(sourceDBefore.adjusted_allocation) - TRANSFER_AMOUNT,
    'D 출처 감액');
  equal(amount(targetAfter.adjusted_allocation), amount(targetBefore.adjusted_allocation) + TRANSFER_AMOUNT,
    'C 대상 증액');
  equal(amount(targetAfter.increase_amount), amount(targetBefore.increase_amount) + TRANSFER_AMOUNT, 'C 증액액 증가');

  for (const account of [adminA, adminB]) {
    for (const expected of [sourceAfter, destinationAfter, sourceDAfter, targetAfter]) {
      const adminPosition = await position(account.client, expected.project_id, `${account.alias} 적용 포지션`);
      equal(adminPosition.adjusted_allocation, expected.adjusted_allocation, `${account.alias} 조정 후 배분액 동기화`);
      equal(adminPosition.execution_amount, expected.execution_amount, `${account.alias} 집행액 동기화`);
    }
  }
  const localRequests = await rpc(localC.client, 'get_financial_budget_change_requests', {
    p_project_id: null, p_status: 'APPLIED', p_year: UAT_YEAR, p_region_id: localProfile.region_id,
  }, 'local_c 적용 요청 목록');
  const adminRequests = await rpc(adminA.client, 'get_financial_budget_change_requests', {
    p_project_id: null, p_status: 'APPLIED', p_year: UAT_YEAR, p_region_id: localProfile.region_id,
  }, 'admin_a 적용 요청 목록');
  for (const requestId of [decreaseRequest, increaseRequest]) {
    assert(localRequests.some((row) => row.id === requestId), `local_c 요청 ${requestId} 조회`);
    assert(adminRequests.some((row) => row.id === requestId), `admin_a 요청 ${requestId} 조회`);
  }

  const bootstraps = await pg.query(`select project_id, bootstrap_kind, adjusted_allocation, execution_amount,
      budget_cohort_id, budget_year_id
    from public.financial_test_uat_project_bootstraps where project_id = any($1::uuid[])`, [fixtureIds]);
  equal(bootstraps.rowCount, 4, '실제 관여 사업 온디맨드 부트스트랩 건수');
  assert(bootstraps.rows.every((row) => row.bootstrap_kind === 'TEST_UAT_BOOTSTRAP'),
    '모든 기준재원은 TEST_UAT_BOOTSTRAP으로 표시되어야 합니다.');
  const requestGaps = await pg.query(`select requests.id,
      requests.total_amount - coalesce(sum(lines.amount),0)::bigint as gap
    from public.financial_budget_change_requests as requests
    left join public.financial_budget_change_request_lines as lines on lines.request_id = requests.id
    where requests.id = any($1::uuid[]) group by requests.id, requests.total_amount`,
  [[decreaseRequest, increaseRequest]]);
  assert(requestGaps.rows.length === 2 && requestGaps.rows.every((row) => amount(row.gap) === 0n),
    '두 요청의 출처 감액과 목적지 증액 GAP은 모두 0원이어야 합니다.');
  const invariants = await rpc(adminA.client, 'get_financial_funding_invariant_check', {
    p_budget_cohort_id: null,
  }, '전체 Ledger 불변식');
  assert(invariants.length > 0 && invariants.every((row) => amount(row.cohort_conservation_gap) === 0n
    && amount(row.decrease_resolution_gap) === 0n), 'Ledger 총량·감액해소 GAP은 모두 0이어야 합니다.');

  const after = await snapshot(pg, localProfile.region_id);
  const statsAfter = await stats(adminA.client, localProfile.region_id);
  equal(after.projects_money, before.projects_money, 'projects 물리 금액 fingerprint');
  equal(after.region_adjusted_allocation, before.region_adjusted_allocation, '강원 양구군 예산 총량');
  equal(after.region_execution, before.region_execution, '강원 양구군 집행 총량');
  equal(amount(after.bootstrap_count) - amount(before.bootstrap_count),
    4 - preexistingFixtureBootstrapCount, '온디맨드 부트스트랩 증가 건수');
  equal(amount(after.transfer_count) - amount(before.transfer_count), 2, '실제 이체 증가 건수');
  equal(amount(after.transfer_amount) - amount(before.transfer_amount), 2n * TRANSFER_AMOUNT, '실제 이체 증가액');
  equal(amount(after.request_count) - amount(before.request_count), 2, '예산조정 요청 증가 건수');
  equal(amount(statsAfter.transfer_amount) - amount(statsBefore.transfer_amount), 2n * TRANSFER_AMOUNT,
    '관리자 통계 이체 증가액');
  equal(amount(statsAfter.applied_request_count) - amount(statsBefore.applied_request_count), 2,
    '관리자 통계 적용 요청 증가 건수');
  equal(statsAfter.transaction_gap_amount, 0, '관리자 통계 거래 GAP');

  await pg.end();
  activePg = null;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    target: 'TEST',
    project_ref: TEST_REF,
    production_touched: false,
    region: '강원 양구군',
    bootstrap: { kind: 'TEST_UAT_BOOTSTRAP', on_demand_projects: 4,
      resumed_preexisting_fixture_count: preexistingFixtureBootstrapCount },
    decrease_button: {
      request_id: decreaseRequest,
      source: { code: sourceA.project_code, name: sourceA.project_name,
        before_adjusted: String(sourceBefore.adjusted_allocation), after_adjusted: String(sourceAfter.adjusted_allocation),
        execution: String(sourceAfter.execution_amount), unexecuted: String(sourceAfter.unexecuted_amount) },
      destination: { code: destinationB.project_code, name: destinationB.project_name,
        increase_delta: String(TRANSFER_AMOUNT) },
    },
    increase_button: {
      request_id: increaseRequest,
      source: { code: sourceD.project_code, name: sourceD.project_name, decrease_delta: String(TRANSFER_AMOUNT) },
      destination: { code: targetC.project_code, name: targetC.project_name, increase_delta: String(TRANSFER_AMOUNT) },
    },
    workflow: { local_submit: true, admin_a_approve: true, admin_b_apply: true,
      applied_requests: 2, transfers: 2, transfer_amount: String(2n * TRANSFER_AMOUNT), gap_amount: '0' },
    synchronization: { local_read: true, admin_a_read: true, admin_b_read: true },
    integrity: { projects_money_unchanged: true, region_budget_total_unchanged: true,
      region_execution_unchanged: true, ledger_invariant_gaps_zero: true },
  }, null, 2)}\n`);
}

main().catch(async (error) => {
  process.stderr.write(`${error.message}\n`);
  if (activePg) await activePg.end().catch(() => undefined);
  process.exitCode = 1;
});
