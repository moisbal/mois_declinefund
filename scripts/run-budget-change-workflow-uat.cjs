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
const EFFECTIVE_DATE = '2026-09-01';
const RUN_TAG = 'budget-change-final-20260826';
const WON = 1_000_000n;
const CODE = Object.freeze({
  sourceA: '2025-26-140-0007',
  donor: '2025-26-140-0008',
  destinationB: '2025-26-140-0002',
  destinationC: '2025-26-140-0003',
  pastDestination: '2024-26-140-0003',
  linkedNewProject: '2025-26-140-9001',
});

let activePg = null;

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }
function equal(actual, expected, message) {
  if (String(actual) !== String(expected)) fail(`${message} (expected=${expected}, actual=${actual})`);
}
function amount(value) { return BigInt(value ?? 0); }
function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
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
function refFromDatabaseUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i)?.[1]
      ?? decodeURIComponent(url.username).match(/^postgres\.([a-z0-9-]+)$/i)?.[1] ?? null;
  } catch { return null; }
}
function databaseConnectionString(value) {
  const url = new URL(value);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('uselibpqcompat');
  return url.toString();
}
function stableUuid(label) {
  const hex = crypto.createHash('sha256').update(`${RUN_TAG}:${label}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
function supabaseClient(url, key) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
async function signIn(url, anonKey, email, password, alias) {
  const instance = supabaseClient(url, anonKey);
  const { data, error } = await instance.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user) fail(`${alias} TEST authentication failed.`);
  return { alias, client: instance, userId: data.user.id };
}
async function profile(account, service) {
  const { data, error } = await service.from('profiles').select('role,region_id').eq('id', account.userId).single();
  if (error || !data) fail(`${account.alias} profile lookup failed.`);
  account.profile = data;
  return account;
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
async function projectByCode(service, projectCode) {
  const { data, error } = await service.from('projects')
    .select('id,region_id,year,project_code,detail_project_name,fund_project_name,project_name')
    .eq('project_code', projectCode).limit(2);
  if (error || !data || data.length !== 1) fail(`TEST fixture project is not unique: ${projectCode}`);
  return data[0];
}
async function position(instance, projectId, label) {
  const rows = await rpc(instance, 'get_financial_budget_change_project_position', {
    p_project_id: projectId,
  }, label);
  assert(Array.isArray(rows) && rows.length === 1, `${label} must return one row.`);
  const row = rows[0];
  equal(amount(row.original_allocation) + amount(row.increase_amount) - amount(row.decrease_amount), row.adjusted_allocation,
    `${label} official allocation formula`);
  equal(amount(row.adjusted_allocation) - amount(row.execution_amount), row.unexecuted_amount,
    `${label} unexecuted formula`);
  return row;
}
async function candidate(instance, anchorProjectId, projectCode, requireAvailable = false) {
  const rows = await rpc(instance, 'get_financial_budget_change_candidates', {
    p_anchor_project_id: anchorProjectId,
    p_search: projectCode,
    p_year: Number(projectCode.slice(0, 4)),
    p_require_available: requireAvailable,
  }, `후보 검색 ${projectCode}`);
  const exact = rows.filter((row) => row.project_code === projectCode);
  assert(exact.length === 1, `후보 검색에서 ${projectCode}를 정확히 한 건 찾아야 합니다.`);
  if (requireAvailable) assert(amount(exact[0].available_amount) > 0n && exact[0].source_budget_year_id,
    `${projectCode}에는 사용 가능한 출처 재원이 있어야 합니다.`);
  return exact[0];
}
async function databaseSnapshot(pg, regionId) {
  const result = await pg.query(`select
    (select md5(string_agg(concat_ws('|', id::text, total_budget::text,
      original_alloc::text, increase_amount::text, decrease_amount::text,
      alloc::text, exec::text, rate::text), E'\\n' order by id)) from public.projects) as projects_money,
    (select concat(count(*)::text, ':', coalesce(sum(amount),0)::text)
      from public.project_carryovers) as carryovers,
    (select concat(count(*)::text, ':', coalesce(sum(amount),0)::text)
      from public.project_fund_transfers where transaction_kind = 'RETURN') as return_transfers,
    (select concat(count(*)::text, ':', coalesce(sum(amount),0)::text)
      from public.financial_unallocated_fund_movements where movement_type = 'RETURN') as return_movements,
    (select count(*)::bigint from public.project_fund_transfers) as transfer_count,
    (select count(*)::bigint from public.financial_unallocated_fund_lots) as lot_count,
    (select count(*)::bigint from public.financial_unallocated_fund_movements) as movement_count,
    (select coalesce(sum(f.ledger_adjusted_allocation),0)::bigint
      from public.financial_project_funding_positions f
      join public.projects p on p.id = f.project_id
      where p.region_id = $1 and f.projection_ready)
      + (select coalesce(sum(amount),0)::bigint
        from public.financial_pending_new_project_funds
        where region_id = $1 and status = 'WAITING') as region_projects_plus_pending,
    (select count(*)::bigint from public.financial_budget_change_requests) as request_count,
    (select count(*)::bigint from public.financial_pending_new_project_funds) as pending_count,
    (select count(*)::bigint from public.financial_pending_new_project_link_requests) as link_request_count`, [regionId]);
  return result.rows[0];
}
async function workflowStats(instance, regionId) {
  const rows = await rpc(instance, 'get_financial_budget_change_statistics', {
    p_year: 2025,
    p_region_id: regionId,
  }, '예산조정 통계');
  assert(rows.length === 1, '예산조정 통계는 한 행이어야 합니다.');
  return rows[0];
}
async function createApproveApply({ local, adminA, adminB, sourceWalletId, destinations, key, reason }) {
  const created = await rpc(local, 'financial_create_budget_change_request', {
    p_source_budget_year_id: sourceWalletId,
    p_destinations: destinations,
    p_effective_date: EFFECTIVE_DATE,
    p_reason: reason,
    p_idempotency_key: stableUuid(key),
    p_submit: true,
  }, `${reason} 요청`);
  assert(created.length === 1, `${reason} 요청 결과가 없습니다.`);
  const requestId = created[0].request_id;
  equal(created[0].gap_amount, 0, `${reason} 요청 차액`);
  if (created[0].status === 'SUBMITTED') {
    const localApprovalError = await expectRpcError(local, 'financial_approve_budget_change_request', {
      p_request_id: requestId,
    }, `${reason} 요청자의 자기 승인 차단`);
    assert(localApprovalError, `${reason} 자기 승인 차단 오류 코드가 필요합니다.`);
    const approved = await rpc(adminA, 'financial_approve_budget_change_request', {
      p_request_id: requestId,
    }, `${reason} 관리자 승인`);
    equal(approved[0]?.status, 'APPROVED', `${reason} 승인 상태`);
  }
  const applied = await rpc(adminB, 'financial_apply_budget_change_request', {
    p_request_id: requestId,
  }, `${reason} 원자적 적용`);
  equal(applied[0]?.status, 'APPLIED', `${reason} 적용 상태`);
  equal(applied[0]?.gap_amount, 0, `${reason} 적용 차액`);
  return requestId;
}

async function main() {
  assert(has('--confirm-test-write'), 'UAT requires --confirm-test-write.');
  const env = load(arg('--env-file'));
  const credentials = load(arg('--credentials-file'));
  const testRef = required(env, 'TEST_PROJECT_REF');
  const prodRef = required(env, 'PROD_PROJECT_REF');
  const supabaseUrl = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const serviceKey = required(env, 'TEST_SUPABASE_SERVICE_ROLE_KEY');
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  assert(String(env.TARGET_ENV).toUpperCase() === 'TEST'
    && testRef === TEST_REF && prodRef === PROD_REF && testRef !== prodRef
    && refFromUrl(supabaseUrl) === TEST_REF
    && refFromDatabaseUrl(databaseUrl) === TEST_REF
    && refFromDatabaseUrl(databaseUrl) !== PROD_REF,
  'Fail-closed TEST target gate rejected configuration.');

  const service = supabaseClient(supabaseUrl, serviceKey);
  const anonymous = supabaseClient(supabaseUrl, anonKey);
  const pg = new Client({
    connectionString: databaseConnectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    application_name: 'budget-change-workflow-uat',
  });
  activePg = pg;
  await pg.connect();

  const [adminA, adminB, localB, localA, localC] = await Promise.all([
    signIn(supabaseUrl, anonKey, required(credentials, 'UAT_ADMIN_A_EMAIL'), required(credentials, 'UAT_ADMIN_A_PASSWORD'), 'admin_a'),
    signIn(supabaseUrl, anonKey, required(credentials, 'UAT_ADMIN_B_EMAIL'), required(credentials, 'UAT_ADMIN_B_PASSWORD'), 'admin_b'),
    signIn(supabaseUrl, anonKey, required(credentials, 'UAT_LOCAL_B_EMAIL'), required(credentials, 'UAT_LOCAL_B_PASSWORD'), 'local_b'),
    signIn(supabaseUrl, anonKey, required(credentials, 'UAT_LOCAL_A_EMAIL'), required(credentials, 'UAT_LOCAL_A_PASSWORD'), 'local_a'),
    signIn(supabaseUrl, anonKey, required(credentials, 'UAT_LOCAL_C_EMAIL'), required(credentials, 'UAT_LOCAL_C_PASSWORD'), 'local_c'),
  ]).then((accounts) => Promise.all(accounts.map((account) => profile(account, service))));
  assert(adminA.profile.role === 'admin' && adminB.profile.role === 'admin', '두 TEST 관리자 계정이 필요합니다.');
  assert(localB.profile.role === 'local_user' && localB.profile.region_id, 'local_b 지역 프로필이 필요합니다.');
  for (const crossLocal of [localA, localC]) {
    assert(crossLocal.profile.role === 'local_user' && crossLocal.profile.region_id
      && crossLocal.profile.region_id !== localB.profile.region_id, '타지역 local 프로필이 필요합니다.');
  }

  const projects = {};
  for (const [name, code] of Object.entries(CODE)) projects[name] = await projectByCode(service, code);
  for (const project of Object.values(projects)) {
    assert(project.region_id === localB.profile.region_id, `${project.project_code}는 부산 서구 UAT 사업이어야 합니다.`);
  }
  const { data: region, error: regionError } = await service.from('regions')
    .select('sido,sigungu').eq('id', localB.profile.region_id).single();
  if (regionError || !region) fail('local_b 지역명을 조회할 수 없습니다.');
  equal(`${region.sido} ${region.sigungu}`, '부산 서구', 'local_b UAT 지역');

  const preflightKeys = ['restore-a-1', 'scenario-a', 'increase-b', 'restore-a-2', 'multi-destination']
    .map(stableUuid);
  const { count: existingRunCount, error: existingRunError } = await service
    .from('financial_budget_change_requests').select('id', { count: 'exact', head: true })
    .in('idempotency_key', preflightKeys);
  if (existingRunError) fail(`UAT preflight request lookup failed: ${existingRunError.message}`);
  assert((existingRunCount ?? 0) <= 1, 'UAT 재개 전에는 최초 복원 요청만 존재할 수 있습니다.');

  const runtimeBefore = await pg.query('select environment_kind, mode, bound_project_ref from public.financial_ledger_runtime where singleton = true');
  equal(runtimeBefore.rows[0]?.environment_kind, 'TEST', 'Ledger environment');
  equal(runtimeBefore.rows[0]?.bound_project_ref, TEST_REF, 'Ledger TEST ref');
  assert(['RECONCILIATION', 'TEST'].includes(runtimeBefore.rows[0]?.mode), 'Ledger mode is not eligible for TEST UAT.');
  if (runtimeBefore.rows[0].mode !== 'TEST') {
    await rpc(adminA.client, 'financial_set_ledger_mode', {
      p_mode: 'TEST',
      p_reason: 'TEST 예산·집행 및 사업변경 통합 UAT 수행',
    }, 'TEST Ledger 모드 전환');
  }

  const before = await databaseSnapshot(pg, localB.profile.region_id);
  const statsBefore = await workflowStats(adminA.client, localB.profile.region_id);
  equal(before.request_count, existingRunCount ?? 0, '신규 예산조정 요청 사전 건수');
  equal(before.pending_count, 0, '신규 예정재원 사전 건수');

  const initialA = await position(localB.client, projects.sourceA.id, '시나리오 A 최초 포지션');
  equal(initialA.original_allocation, 100n * WON, 'A 원배정액');
  equal(initialA.adjusted_allocation, 90n * WON, 'A 최초 조정배정액');
  equal(initialA.execution_amount, 90n * WON, 'A 최초 집행액');
  equal(initialA.unexecuted_amount, 0, 'A 최초 미집행액');

  const pastByCode = await candidate(localB.client, projects.sourceA.id, CODE.pastDestination, false);
  equal(pastByCode.fiscal_year, 2024, '과거연도 후보 검색');
  assert(String(pastByCode.project_name ?? '').length > 0, '후보 검색은 사업명을 반환해야 합니다.');
  const nameToken = String(pastByCode.project_name).slice(0, 4);
  const nameRows = await rpc(localB.client, 'get_financial_budget_change_candidates', {
    p_anchor_project_id: projects.sourceA.id,
    p_search: nameToken,
    p_year: 2024,
    p_require_available: false,
  }, '과거연도 사업명 부분검색');
  assert(nameRows.some((row) => row.project_code === CODE.pastDestination), '사업명 부분검색 결과가 누락되었습니다.');

  let crossProject = null;
  let crossRegionId = null;
  let crossLocal = null;
  for (const crossLocal of [localA, localC]) {
    const row = (await pg.query(`select p.id
    from public.projects p where p.region_id = $1 order by p.year desc, p.id limit 1`,
    [crossLocal.profile.region_id])).rows[0];
    if (row) {
      crossProject = row;
      crossRegionId = crossLocal.profile.region_id;
      break;
    }
  }
  assert(crossProject, '타지역 권한차단 fixture가 필요합니다.');
  const crossCandidateError = await expectRpcError(localB.client, 'get_financial_budget_change_candidates', {
    p_anchor_project_id: crossProject.id,
    p_search: null,
    p_year: null,
    p_require_available: false,
  }, '타지역 후보 조회 차단');
  const emptyDestinationError = await expectRpcError(localB.client, 'financial_create_budget_change_request', {
    p_source_budget_year_id: (await candidate(localB.client, projects.sourceA.id, CODE.donor, true)).source_budget_year_id,
    p_destinations: [],
    p_effective_date: EFFECTIVE_DATE,
    p_reason: '목적지 필수 검증',
    p_idempotency_key: stableUuid('empty-destination-denied'),
    p_submit: true,
  }, '목적지 없는 감액 차단');
  const anonymousError = await expectRpcError(anonymous, 'get_financial_budget_change_statistics', {
    p_year: 2025, p_region_id: localB.profile.region_id,
  }, '비인증 통계 조회 차단');

  let donor = await candidate(localB.client, projects.sourceA.id, CODE.donor, true);
  await createApproveApply({
    local: localB.client, adminA: adminA.client, adminB: adminB.client,
    sourceWalletId: donor.source_budget_year_id,
    destinations: [{ destination_type: 'EXISTING_PROJECT', destination_project_id: projects.sourceA.id, amount: String(10n * WON), note: 'A 기준금액 복원' }],
    key: 'restore-a-1', reason: '시나리오 A 기준금액 복원',
  });
  const restoredA = await position(localB.client, projects.sourceA.id, 'A 기준금액 복원 후');
  equal(restoredA.adjusted_allocation, 100n * WON, 'A 복원 조정배정액');
  equal(restoredA.unexecuted_amount, 10n * WON, 'A 복원 미집행액');

  const sourceAFirst = await candidate(localB.client, projects.destinationB.id, CODE.sourceA, true);
  const scenarioARequest = await createApproveApply({
    local: localB.client, adminA: adminA.client, adminB: adminB.client,
    sourceWalletId: sourceAFirst.source_budget_year_id,
    destinations: [
      { destination_type: 'EXISTING_PROJECT', destination_project_id: projects.destinationB.id, amount: String(6n * WON), note: 'B 기존사업 배분' },
      { destination_type: 'PENDING_NEW_PROJECT', planned_project_name: '지역 청년활력 지원사업', planned_project_year: 2025, amount: String(4n * WON), note: 'C 신규사업 예정' },
    ],
    key: 'scenario-a', reason: 'A 1천만원 감액 후 B 6백만원·신규 C 4백만원 배분',
  });
  const afterScenarioA = await position(localB.client, projects.sourceA.id, '시나리오 A 적용 후');
  equal(afterScenarioA.original_allocation, 100n * WON, 'A 적용 후 원배정액');
  equal(afterScenarioA.adjusted_allocation, 90n * WON, 'A 적용 후 조정배정액');
  equal(afterScenarioA.execution_amount, 90n * WON, 'A 적용 후 집행액');
  equal(afterScenarioA.unexecuted_amount, 0, 'A 적용 후 미집행액');
  assert(afterScenarioA.valid_execution, 'A 적용 후 집행액은 조정배정액 이하여야 합니다.');

  const pendingRows = await rpc(localB.client, 'get_financial_pending_new_project_funds', {
    p_status: 'WAITING', p_year: 2025, p_region_id: localB.profile.region_id,
  }, '신규사업 예정재원 조회');
  const pendingC = pendingRows.find((row) => row.source_request_id === scenarioARequest);
  assert(pendingC, '시나리오 A의 신규사업 예정재원이 생성되어야 합니다.');
  equal(pendingC.amount, 4n * WON, '신규사업 예정재원 C 금액');

  crossLocal = [localA, localC].find((account) => account.profile.region_id === crossRegionId);
  assert(crossLocal, '타지역 쓰기 권한차단 계정이 필요합니다.');
  const crossWriteError = await expectRpcError(crossLocal.client, 'financial_request_pending_new_project_link', {
    p_pending_fund_id: pendingC.id,
    p_destination_project_id: projects.linkedNewProject.id,
    p_idempotency_key: stableUuid('cross-region-denied'),
  }, '타지역 예정재원 연결 생성 차단');

  const linkCreated = await rpc(localB.client, 'financial_request_pending_new_project_link', {
    p_pending_fund_id: pendingC.id,
    p_destination_project_id: projects.linkedNewProject.id,
    p_idempotency_key: stableUuid('link-pending-c'),
  }, '신규사업 C 실제 사업 연결 요청');
  equal(linkCreated[0]?.status, 'SUBMITTED', '신규사업 C 연결 제출 상태');
  const linkApproved = await rpc(adminA.client, 'financial_review_pending_new_project_link', {
    p_request_id: linkCreated[0].request_id, p_decision: 'APPROVE', p_reason: null,
  }, '신규사업 C 연결 승인');
  equal(linkApproved[0]?.status, 'APPROVED', '신규사업 C 연결 승인 상태');
  const newProjectBefore = await position(localB.client, projects.linkedNewProject.id, '신규사업 연결 전');
  const linkApplied = await rpc(adminB.client, 'financial_apply_pending_new_project_link', {
    p_request_id: linkCreated[0].request_id,
  }, '신규사업 C 연결 원자적 적용');
  equal(linkApplied[0]?.status, 'APPLIED', '신규사업 C 연결 적용 상태');
  equal(linkApplied[0]?.pending_amount, 0, '신규사업 C 연결 후 예정재원');
  const newProjectAfter = await position(localB.client, projects.linkedNewProject.id, '신규사업 연결 후');
  equal(amount(newProjectAfter.adjusted_allocation) - amount(newProjectBefore.adjusted_allocation), 4n * WON,
    '신규사업 C 연결 증액');
  const linkedRows = await rpc(localB.client, 'get_financial_pending_new_project_funds', {
    p_status: 'LINKED', p_year: 2025, p_region_id: localB.profile.region_id,
  }, '연결 완료 예정재원 조회');
  const linkedC = linkedRows.find((row) => row.id === pendingC.id);
  assert(linkedC && linkedC.linked_project_code === CODE.linkedNewProject, '예정재원이 실제 사업명·사업코드로 연결되어야 합니다.');

  const bBeforeIncrease = await position(localB.client, projects.destinationB.id, 'B 추가 증액 전');
  donor = await candidate(localB.client, projects.sourceA.id, CODE.donor, true);
  await createApproveApply({
    local: localB.client, adminA: adminA.client, adminB: adminB.client,
    sourceWalletId: donor.source_budget_year_id,
    destinations: [{ destination_type: 'EXISTING_PROJECT', destination_project_id: projects.destinationB.id, amount: String(5n * WON), note: '출처 지정 증액' }],
    key: 'increase-b', reason: 'B 5백만원 증액과 출처 사업 동시 감액',
  });
  const bAfterIncrease = await position(localB.client, projects.destinationB.id, 'B 추가 증액 후');
  equal(amount(bAfterIncrease.adjusted_allocation) - amount(bBeforeIncrease.adjusted_allocation), 5n * WON,
    'B 출처 지정 증액');

  donor = await candidate(localB.client, projects.sourceA.id, CODE.donor, true);
  await createApproveApply({
    local: localB.client, adminA: adminA.client, adminB: adminB.client,
    sourceWalletId: donor.source_budget_year_id,
    destinations: [{ destination_type: 'EXISTING_PROJECT', destination_project_id: projects.sourceA.id, amount: String(10n * WON), note: '복수 목적지 전 기준금액 복원' }],
    key: 'restore-a-2', reason: '복수 목적지 시나리오 기준금액 복원',
  });
  const sourceASecond = await candidate(localB.client, projects.destinationB.id, CODE.sourceA, true);
  const bBeforeMulti = await position(localB.client, projects.destinationB.id, '복수 목적지 B 적용 전');
  const cBeforeMulti = await position(localB.client, projects.destinationC.id, '복수 목적지 C 적용 전');
  const multiRequest = await createApproveApply({
    local: localB.client, adminA: adminA.client, adminB: adminB.client,
    sourceWalletId: sourceASecond.source_budget_year_id,
    destinations: [
      { destination_type: 'EXISTING_PROJECT', destination_project_id: projects.destinationB.id, amount: String(3n * WON), note: '복수 목적지 B' },
      { destination_type: 'EXISTING_PROJECT', destination_project_id: projects.destinationC.id, amount: String(2n * WON), note: '복수 목적지 C' },
      { destination_type: 'PENDING_NEW_PROJECT', planned_project_name: '지역 생활기반 확충사업', planned_project_year: 2025, amount: String(5n * WON), note: '복수 목적지 신규 D' },
    ],
    key: 'multi-destination', reason: 'A 1천만원을 B 3백만원·C 2백만원·신규 D 5백만원으로 배분',
  });
  const finalA = await position(localB.client, projects.sourceA.id, '복수 목적지 적용 후 A');
  const bAfterMulti = await position(localB.client, projects.destinationB.id, '복수 목적지 적용 후 B');
  const cAfterMulti = await position(localB.client, projects.destinationC.id, '복수 목적지 적용 후 C');
  equal(finalA.adjusted_allocation, 90n * WON, '복수 목적지 적용 후 A 조정배정액');
  equal(finalA.execution_amount, 90n * WON, '복수 목적지 적용 후 A 집행액');
  equal(finalA.unexecuted_amount, 0, '복수 목적지 적용 후 A 미집행액');
  equal(amount(bAfterMulti.adjusted_allocation) - amount(bBeforeMulti.adjusted_allocation), 3n * WON, '복수 목적지 B 증액');
  equal(amount(cAfterMulti.adjusted_allocation) - amount(cBeforeMulti.adjusted_allocation), 2n * WON, '복수 목적지 C 증액');
  const multiHistory = await rpc(localB.client, 'get_financial_budget_change_requests', {
    p_project_id: projects.sourceA.id, p_status: 'APPLIED', p_year: 2025, p_region_id: localB.profile.region_id,
  }, '복수 목적지 이력 조회');
  const multi = multiHistory.find((row) => row.id === multiRequest);
  assert(multi && multi.destinations.length === 3, '복수 목적지 이력은 3개 목적지를 보존해야 합니다.');
  equal(multi.destinations.reduce((sum, row) => sum + amount(row.amount), 0n), 10n * WON, '복수 목적지 합계');

  const pendingFinalRows = await rpc(localB.client, 'get_financial_pending_new_project_funds', {
    p_status: 'WAITING', p_year: 2025, p_region_id: localB.profile.region_id,
  }, '최종 예정재원 조회');
  const pendingD = pendingFinalRows.find((row) => row.source_request_id === multiRequest);
  assert(pendingD, '복수 목적지 신규사업 D 예정재원이 필요합니다.');
  equal(pendingD.amount, 5n * WON, '신규사업 D 예정재원');

  const beforeReplay = await databaseSnapshot(pg, localB.profile.region_id);
  const replay = await rpc(adminB.client, 'financial_apply_budget_change_request', {
    p_request_id: multiRequest,
  }, '예산조정 적용 멱등 재호출');
  equal(replay[0]?.status, 'APPLIED', '멱등 재호출 상태');
  const afterReplay = await databaseSnapshot(pg, localB.profile.region_id);
  equal(afterReplay.transfer_count, beforeReplay.transfer_count, '멱등 재호출 이체 건수');
  equal(afterReplay.lot_count, beforeReplay.lot_count, '멱등 재호출 lot 건수');

  const localRequests = await rpc(localB.client, 'get_financial_budget_change_requests', {
    p_project_id: null, p_status: null, p_year: 2025, p_region_id: localB.profile.region_id,
  }, 'local_b 자기 지역 요청 목록');
  assert(localRequests.length >= 5, 'local_b는 자기 지역 예산조정 이력을 조회해야 합니다.');
  const crossRegionReadError = await expectRpcError(localB.client, 'get_financial_budget_change_requests', {
    p_project_id: null, p_status: null, p_year: null, p_region_id: crossRegionId,
  }, 'local_b 타지역 요청 목록 차단');
  const adminRequests = await rpc(adminA.client, 'get_financial_budget_change_requests', {
    p_project_id: null, p_status: 'APPLIED', p_year: 2025, p_region_id: localB.profile.region_id,
  }, '관리자 전체 요청 조회');
  assert(adminRequests.length >= 5, '관리자는 지역 필터 예산조정 이력을 조회해야 합니다.');

  const directUpdate = await adminA.client.from('financial_budget_change_requests')
    .update({ reason: '직접 수정 차단' }).eq('id', scenarioARequest).select('id');
  assert(directUpdate.error, '인증 관리자 직접 UPDATE는 차단되어야 합니다.');
  const directInsert = await localB.client.from('financial_budget_change_request_lines')
    .insert({ request_id: scenarioARequest, line_no: 20, destination_type: 'PENDING_NEW_PROJECT', planned_project_name: '직접입력', planned_project_year: 2025, amount: 1 })
    .select('id');
  assert(directInsert.error, '인증 지역사용자 직접 INSERT는 차단되어야 합니다.');

  const statsAfter = await workflowStats(adminA.client, localB.profile.region_id);
  equal(amount(statsAfter.transfer_amount) - amount(statsBefore.transfer_amount), 36n * WON, '예산조정 기존사업 이체 통계');
  equal(amount(statsAfter.transfer_count) - amount(statsBefore.transfer_count), 6, '예산조정 기존사업 이체 건수');
  equal(amount(statsAfter.new_project_allocated_amount) - amount(statsBefore.new_project_allocated_amount), 4n * WON, '신규사업 연결 통계');
  equal(amount(statsAfter.pending_new_project_amount) - amount(statsBefore.pending_new_project_amount), 5n * WON, '신규사업 예정재원 통계');
  equal(amount(statsAfter.applied_request_count) - amount(statsBefore.applied_request_count), 5, '적용 요청 건수 통계');
  equal(statsAfter.transaction_gap_amount, 0, '통계 거래 차액');
  const filtered = await rpc(adminA.client, 'get_financial_budget_change_statistics_filtered', {
    p_year: 2025, p_sido: '부산', p_sigungu: '서구',
  }, '관리자 부산 서구 필터 통계');
  equal(filtered[0]?.transfer_amount, statsAfter.transfer_amount, '관리자 필터 통계 이체금액');
  equal(filtered[0]?.pending_new_project_amount, statsAfter.pending_new_project_amount, '관리자 필터 통계 예정재원');

  const invariants = await rpc(adminA.client, 'get_financial_funding_invariant_check', {
    p_budget_cohort_id: null,
  }, '전체 Ledger 불변식');
  assert(invariants.length > 0, 'Ledger 불변식 행이 필요합니다.');
  for (const row of invariants) {
    equal(row.cohort_conservation_gap, 0, 'cohort conservation gap');
    equal(row.decrease_resolution_gap, 0, 'decrease resolution gap');
  }

  const after = await databaseSnapshot(pg, localB.profile.region_id);
  equal(after.projects_money, before.projects_money, 'projects 물리 금액 fingerprint');
  equal(after.carryovers, before.carryovers, '기존 이월 이력 보존');
  equal(after.return_transfers, before.return_transfers, '기존 RETURN 이체 이력 보존');
  equal(after.return_movements, before.return_movements, '기존 RETURN 이동 이력 보존');
  equal(after.region_projects_plus_pending, before.region_projects_plus_pending, '지역 조정배정액 + 예정재원 보존');
  equal(after.request_count, 5, '신규 요청 최종 건수');
  equal(after.pending_count, 2, '신규 예정재원 최종 건수');
  equal(after.link_request_count, 1, '신규 연결요청 최종 건수');

  const runtimeAfter = await pg.query('select environment_kind, mode, bound_project_ref from public.financial_ledger_runtime where singleton = true');
  equal(runtimeAfter.rows[0]?.environment_kind, 'TEST', '최종 Ledger environment');
  equal(runtimeAfter.rows[0]?.mode, 'TEST', '최종 Ledger mode');
  equal(runtimeAfter.rows[0]?.bound_project_ref, TEST_REF, '최종 Ledger TEST ref');

  await pg.end();
  activePg = null;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    target: 'TEST',
    project_ref: TEST_REF,
    production_touched: false,
    authentication: { admin_accounts: 2, local_b: '부산 서구', cross_region_local: true, passwords_reset: false },
    workflow: {
      applied_requests: 5,
      existing_project_lines: 6,
      existing_project_amount: String(36n * WON),
      linked_new_project_amount: String(4n * WON),
      waiting_new_project_amount: String(5n * WON),
      all_gap_amount: '0',
      maker_checker: true,
      idempotent_apply: true,
    },
    scenario_a: {
      original_allocation: String(finalA.original_allocation),
      adjusted_allocation: String(finalA.adjusted_allocation),
      execution_amount: String(finalA.execution_amount),
      unexecuted_amount: String(finalA.unexecuted_amount),
    },
    permissions: {
      same_region_read: true,
      cross_region_candidate_blocked: Boolean(crossCandidateError),
      cross_region_write_blocked: Boolean(crossWriteError),
      cross_region_history_blocked: Boolean(crossRegionReadError),
      anonymous_blocked: Boolean(anonymousError),
      direct_write_blocked: Boolean(directUpdate.error && directInsert.error),
      empty_destination_blocked: Boolean(emptyDestinationError),
    },
    search: { project_code: true, project_name: true, current_and_past_year: true },
    integrity: {
      physical_projects_unchanged: true,
      legacy_history_unchanged: true,
      region_projects_plus_pending_conserved: true,
      ledger_invariant_gaps_zero: true,
    },
    statistics: { exact_filtered_match: true, transaction_gap_amount: '0' },
  }, null, 2)}\n`);
}

main().catch(async (error) => {
  process.stderr.write(`${error.message}\n`);
  if (activePg) await activePg.end().catch(() => undefined);
  process.exitCode = 1;
});
