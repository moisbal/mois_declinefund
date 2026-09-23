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
const RUN_TAG = 'sunchang-mixed-budget-adjustment-20260831-v1';
const YEAR = 2026;
const NEXT_YEAR = 2027;
const CASES = {
  A: {
    source: '2026-52-770-0001', destination: '2026-52-770-0002', amount: 100_000_000n,
    reason: '순창 기존사업 간 예산 재배분', key: 'case-a-existing',
  },
  B: {
    source: '2026-52-770-0006', amount: 50_000_000n,
    name: '순창 청년활력 지원사업', code: arg('--case-b-official-code'),
    reason: '순창 차년도 신규사업 예정재원 배분', key: 'case-b-new',
  },
  C: {
    source: '2026-52-770-0005', destination: '2026-52-770-0007', amount: 100_000_000n,
    existingAmount: 50_000_000n, newAmount: 50_000_000n,
    name: '순창 지역상생 복합지원사업', code: arg('--case-c-official-code'),
    reason: '순창 기존사업·차년도 신규사업 혼합 배분', key: 'case-c-mixed',
  },
};

function fail(message) { throw new Error(message); }
function check(value, message) { if (!value) fail(message); }
function equal(actual, expected, message) {
  if (String(actual) !== String(expected)) fail(`${message} (expected=${expected}, actual=${actual})`);
}
function amount(value) { return BigInt(value ?? 0); }
function arg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function flag(name) { return process.argv.includes(name); }
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
function stableUuid(label) {
  const bytes = crypto.createHash('sha256').update(`${RUN_TAG}:${label}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [bytes.subarray(0, 4), bytes.subarray(4, 6), bytes.subarray(6, 8), bytes.subarray(8, 10), bytes.subarray(10, 16)]
    .map((part) => part.toString('hex')).join('-');
}
function supabaseClient(url, key) {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}
async function signIn(url, key, email, password, alias) {
  const client = supabaseClient(url, key);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user || !data.session) fail(`${alias} TEST authentication failed.`);
  return { alias, client, userId: data.user.id };
}
async function rpc(account, name, args, label = name) {
  const { data, error } = await account.client.rpc(name, args ?? {});
  if (error) fail(`${label}: ${error.code ?? 'RPC'} ${error.message}`);
  return data ?? [];
}
function first(rows, label) {
  check(Array.isArray(rows) && rows.length === 1, `${label} must return exactly one row.`);
  return rows[0];
}
function executionRate(execution, adjusted) {
  if (amount(adjusted) <= 0n) return 0;
  return Number((Number(execution) * 100 / Number(adjusted)).toFixed(2));
}
async function position(account, projectId, label) {
  const row = first(await rpc(account, 'get_financial_budget_change_project_position', {
    p_project_id: projectId,
  }, label), label);
  equal(amount(row.original_allocation) + amount(row.increase_amount) - amount(row.decrease_amount),
    row.adjusted_allocation, `${label} adjusted formula`);
  equal(amount(row.adjusted_allocation) - amount(row.execution_amount),
    row.unexecuted_amount, `${label} unexecuted formula`);
  equal(row.execution_rate, executionRate(row.execution_amount, row.adjusted_allocation),
    `${label} execution rate`);
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    ['original_allocation', 'increase_amount', 'decrease_amount', 'adjusted_allocation',
      'execution_amount', 'unexecuted_amount'].includes(key) ? String(value) : value]));
}
async function projectByCode(pg, regionId, code) {
  const rows = (await pg.query(`select id,project_code,year,
      coalesce(nullif(btrim(detail_project_name),''),nullif(btrim(fund_project_name),''),
        nullif(btrim(project_name),''),'사업명 확인 필요') project_name
    from public.projects where region_id=$1 and project_code=$2`, [regionId, code])).rows;
  return first(rows, code);
}
async function exactSnapshot(pg, requestId, projectId, role) {
  const row = (await pg.query(`select
      original_before::bigint::text,increase_before::bigint::text,decrease_before::bigint::text,
      adjusted_before::bigint::text,execution_before::bigint::text,unexecuted_before::bigint::text,
      original_after::bigint::text,increase_after::bigint::text,decrease_after::bigint::text,
      adjusted_after::bigint::text,execution_after::bigint::text,unexecuted_after::bigint::text
    from public.financial_budget_workflow_amount_snapshots
    where budget_request_id=$1 and project_id=$2 and project_role=$3 and capture_kind='EXACT_AT_APPLY'
    order by captured_at desc limit 1`, [requestId, projectId, role])).rows[0];
  check(row, `${role} exact amount snapshot is missing for ${requestId}.`);
  const make = (suffix) => ({
    original_allocation: row[`original_${suffix}`], increase_amount: row[`increase_${suffix}`],
    decrease_amount: row[`decrease_${suffix}`], adjusted_allocation: row[`adjusted_${suffix}`],
    execution_amount: row[`execution_${suffix}`], unexecuted_amount: row[`unexecuted_${suffix}`],
    execution_rate: executionRate(row[`execution_${suffix}`], row[`adjusted_${suffix}`]),
  });
  return { before: make('before'), after: make('after') };
}
function assertSourceDelta(snapshot, delta, label) {
  equal(snapshot.after.original_allocation, snapshot.before.original_allocation, `${label} source original unchanged`);
  equal(amount(snapshot.after.decrease_amount) - amount(snapshot.before.decrease_amount), delta,
    `${label} source decrease delta`);
  equal(amount(snapshot.before.adjusted_allocation) - amount(snapshot.after.adjusted_allocation), delta,
    `${label} source adjusted delta`);
  equal(snapshot.after.execution_amount, snapshot.before.execution_amount, `${label} source execution unchanged`);
  equal(amount(snapshot.after.adjusted_allocation) - amount(snapshot.after.execution_amount),
    snapshot.after.unexecuted_amount, `${label} source unexecuted recalculated`);
}
function assertDestinationDelta(snapshot, delta, label) {
  equal(snapshot.after.original_allocation, snapshot.before.original_allocation, `${label} destination original unchanged`);
  equal(amount(snapshot.after.increase_amount) - amount(snapshot.before.increase_amount), delta,
    `${label} destination increase delta`);
  equal(amount(snapshot.after.adjusted_allocation) - amount(snapshot.before.adjusted_allocation), delta,
    `${label} destination adjusted delta`);
  equal(snapshot.after.execution_amount, snapshot.before.execution_amount, `${label} destination execution unchanged`);
  equal(amount(snapshot.after.adjusted_allocation) - amount(snapshot.after.execution_amount),
    snapshot.after.unexecuted_amount, `${label} destination unexecuted recalculated`);
}
async function authenticatedProjectCount(account, regionId) {
  const { count, error } = await account.client.from('projects')
    .select('id', { count: 'exact', head: true }).eq('region_id', regionId);
  if (error) fail(`${account.alias} project count: ${error.message}`);
  return Number(count ?? 0);
}
async function regionSnapshot(pg, regionId) {
  return (await pg.query(`select
      (select count(*)::integer from public.projects where region_id=$1) project_count,
      (select coalesce(sum(coalesce(positions.ledger_adjusted_allocation,projects.alloc,0)),0)::bigint::text
        from public.projects left join public.financial_project_funding_positions positions
          on positions.project_id=projects.id where projects.region_id=$1) adjusted_total,
      (select coalesce(sum(coalesce(positions.ledger_execution_amount,projects.exec,0)),0)::bigint::text
        from public.projects left join public.financial_project_funding_positions positions
          on positions.project_id=projects.id where projects.region_id=$1) execution_total,
      (select count(*)::integer from public.financial_budget_change_requests
        where region_id=$1 and status='SUBMITTED') submitted_budget_count`, [regionId])).rows[0];
}
async function createRequest(pg, local, sourceId, destinations, spec, effectiveDate) {
  const existing = (await pg.query(`select id request_id,status,0::bigint::text gap_amount
    from public.financial_budget_change_requests where idempotency_key=$1`, [stableUuid(spec.key)])).rows[0];
  if (existing) return { ...existing, resumed: true };
  const row = first(await rpc(local, 'financial_test_uat_create_budget_change_request', {
    p_source_project_id: sourceId,
    p_source_budget_year_id: null,
    p_destinations: destinations,
    p_effective_date: effectiveDate,
    p_reason: spec.reason,
    p_idempotency_key: stableUuid(spec.key),
    p_submit: true,
  }, spec.reason), spec.reason);
  equal(row.status, 'SUBMITTED', `${spec.key} submit status`);
  equal(row.gap_amount, 0, `${spec.key} submit gap`);
  return { ...row, resumed: false };
}
async function queueParity(pg, admin, requestId) {
  const dbCount = Number((await pg.query(`select count(*)::integer value
    from public.financial_budget_change_requests where status='SUBMITTED'`)).rows[0].value);
  const queue = await rpc(admin, 'get_financial_budget_change_requests', {
    p_project_id: null, p_status: 'SUBMITTED', p_year: null, p_region_id: null,
  }, 'Admin submitted budget queue');
  equal(queue.length, dbCount, 'DB pending request/Admin queue');
  check(queue.some((row) => row.id === requestId), `Admin queue omitted ${requestId}.`);
  return { db_pending_request: dbCount, admin_queue: queue.length };
}
async function requestInQueue(admin, requestId, regionId) {
  const requests = await rpc(admin, 'get_financial_budget_change_requests', {
    p_project_id: null, p_status: null, p_year: YEAR, p_region_id: regionId,
  }, 'Admin regional budget queue');
  const request = requests.find((row) => row.id === requestId);
  check(request, `Admin regional queue omitted ${requestId}.`);
  equal(request.total_amount, request.destinations.reduce((sum, line) => sum + amount(line.amount), 0n),
    'Admin request monetary gap');
  return request;
}
async function approveApply(pg, adminA, adminB, request, newProjectCodes) {
  let current = request;
  let parity = null;
  if (current.status === 'SUBMITTED') {
    parity = await queueParity(pg, adminA, current.id);
    const approved = first(await rpc(adminA, 'financial_approve_budget_change_request_group', {
      p_request_id: current.id, p_new_project_codes: newProjectCodes,
    }, 'Admin grouped approval'), 'Admin grouped approval');
    equal(approved.status, 'APPROVED', 'Grouped approval status');
    current = { ...current, status: 'APPROVED' };
  }
  if (current.status === 'APPROVED') {
    const applied = first(await rpc(adminB, 'financial_apply_budget_change_request', {
      p_request_id: current.id,
    }, 'Admin atomic APPLY'), 'Admin atomic APPLY');
    equal(applied.status, 'APPLIED', 'Atomic APPLY status');
    equal(applied.gap_amount, 0, 'Atomic APPLY gap');
    current = { ...current, status: 'APPLIED' };
  }
  equal(current.status, 'APPLIED', 'Final request state');
  const duplicateApply = first(await rpc(adminB, 'financial_apply_budget_change_request', {
    p_request_id: current.id,
  }, 'Duplicate APPLY replay'), 'Duplicate APPLY replay');
  equal(duplicateApply.status, 'APPLIED', 'Duplicate APPLY idempotent status');
  equal(duplicateApply.gap_amount, 0, 'Duplicate APPLY replay gap');
  return { status: current.status, queue_parity: parity, duplicate_apply: 'IDEMPOTENT' };
}
async function linkedNewProject(admin, request) {
  const line = request.destinations.find((destination) => destination.destination_type === 'PENDING_NEW_PROJECT');
  check(line?.new_project_request_id, 'Grouped new-project request link is missing.');
  const rows = await rpc(admin, 'get_financial_new_project_requests', { p_status: null }, 'Admin new-project queue');
  const child = rows.find((row) => row.id === line.new_project_request_id);
  check(child, 'Admin new-project queue omitted grouped child request.');
  equal(child.source_budget_change_request_id, request.id, 'New-project parent request correlation');
  equal(child.source_budget_change_line_id, line.line_id, 'New-project line correlation');
  return { line, child };
}
async function correlation(pg, requestId) {
  return (await pg.query(`select lines.id line_id,lines.destination_type,lines.amount::bigint::text,
      lines.new_project_request_id,lines.pending_fund_id,lines.materialized_lot_id,
      new_requests.source_budget_change_request_id,new_requests.source_budget_change_line_id,
      new_requests.status new_project_status,new_requests.materialized_project_id,
      pending.status pending_status,links.id link_request_id,links.status link_status
    from public.financial_budget_change_request_lines lines
    join public.financial_new_project_requests new_requests on new_requests.id=lines.new_project_request_id
    left join public.financial_pending_new_project_funds pending on pending.id=lines.pending_fund_id
    left join public.financial_pending_new_project_link_requests links on links.pending_fund_id=pending.id
    where lines.request_id=$1 and lines.destination_type='PENDING_NEW_PROJECT'
    order by lines.line_no`, [requestId])).rows;
}
async function freshPair(url, key, env, projectId, regionAlias) {
  const local = await signIn(url, key, required(env, 'UAT_LOCAL_A_EMAIL'), required(env, 'UAT_LOCAL_A_PASSWORD'), `${regionAlias} fresh local`);
  const admin = await signIn(url, key, required(env, 'UAT_ADMIN_A_EMAIL'), required(env, 'UAT_ADMIN_A_PASSWORD'), `${regionAlias} fresh admin`);
  try {
    const [localPosition, adminPosition] = await Promise.all([
      position(local, projectId, `${regionAlias} fresh local position`),
      position(admin, projectId, `${regionAlias} fresh admin position`),
    ]);
    for (const field of ['original_allocation', 'increase_amount', 'decrease_amount',
      'adjusted_allocation', 'execution_amount', 'unexecuted_amount', 'execution_rate']) {
      equal(localPosition[field], adminPosition[field], `${regionAlias} fresh local/admin ${field}`);
    }
    return localPosition;
  } finally {
    await Promise.allSettled([local.client.auth.signOut(), admin.client.auth.signOut()]);
  }
}

async function main() {
  check(flag('--confirm-test-write'), '--confirm-test-write is required.');
  for (const [label, code] of [['B', CASES.B.code], ['C', CASES.C.code]]) {
    check(code?.trim(), `Case ${label} requires an explicit official project code.`);
    check(!/(?:^|[-_\s])(?:UAT|AUTO|GENERIC)(?=$|[-_\s])/i.test(code),
      `Case ${label} official project code must not contain a TEST run identifier.`);
  }
  const env = { ...load(arg('--env-file')), ...load(arg('--credentials-file')) };
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  const url = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (env.TARGET_ENV !== 'TEST' || env.TEST_PROJECT_REF !== TEST_REF || env.PROD_PROJECT_REF !== PROD_REF
      || ref(url) !== TEST_REF || ref(databaseUrl, true) !== TEST_REF || ref(databaseUrl, true) === PROD_REF) {
    fail('Fail-closed TEST target gate rejected configuration.');
  }
  const [local, adminA, adminB] = await Promise.all([
    signIn(url, anonKey, required(env, 'UAT_LOCAL_A_EMAIL'), required(env, 'UAT_LOCAL_A_PASSWORD'), 'local_a'),
    signIn(url, anonKey, required(env, 'UAT_ADMIN_A_EMAIL'), required(env, 'UAT_ADMIN_A_PASSWORD'), 'admin_a'),
    signIn(url, anonKey, required(env, 'UAT_ADMIN_B_EMAIL'), required(env, 'UAT_ADMIN_B_PASSWORD'), 'admin_b'),
  ]);
  const pg = new Client({ connectionString: connectionString(databaseUrl), ssl: { rejectUnauthorized: false },
    application_name: 'run-sunchang-mixed-budget-adjustment-uat' });
  await pg.connect();
  try {
    await pg.query("set statement_timeout='120s'");
    const runtime = (await pg.query(`select environment_kind,mode,bound_project_ref,native_start_date::text
      from public.financial_ledger_runtime where singleton=true`)).rows[0];
    equal(runtime.environment_kind, 'TEST', 'Runtime environment');
    equal(runtime.mode, 'TEST', 'Runtime mode');
    equal(runtime.bound_project_ref, TEST_REF, 'Runtime TEST ref');
    const profile = (await pg.query(`select profiles.role,profiles.region_id,regions.display_name
      from public.profiles join public.regions on regions.id=profiles.region_id where profiles.id=$1`,
    [local.userId])).rows[0];
    equal(profile.role, 'local_user', 'Local role');
    equal(profile.display_name, '전북 순창군', 'Local region');
    const regionId = profile.region_id;
    const projects = {};
    for (const code of [...new Set(Object.values(CASES).flatMap((spec) => [spec.source, spec.destination].filter(Boolean)))]) {
      projects[code] = await projectByCode(pg, regionId, code);
      equal(projects[code].year, YEAR, `${code} year`);
    }
    equal(projects[CASES.A.source].project_name, '고향사랑 연계 농촌사랑 동행순창 운영', 'Actual Sunchang source name');
    const candidates = await rpc(local, 'get_financial_budget_change_candidates', {
      p_anchor_project_id: projects[CASES.A.source].id, p_search: null, p_year: null, p_require_available: false,
    }, 'Sunchang same-year candidate search');
    check(candidates.length > 0 && candidates.every((row) => Number(row.fiscal_year) === YEAR),
      'Existing candidates must be same region and same year.');
    check(!candidates.some((row) => row.project_id === projects[CASES.A.source].id), 'Source must be excluded from candidates.');
    const nextYearCandidates = await rpc(local, 'get_financial_budget_change_next_year_candidates', {
      p_anchor_project_id: projects[CASES.A.source].id, p_search: null,
    }, 'Sunchang next-year candidate search');
    check(nextYearCandidates.every((row) => Number(row.fiscal_year) === NEXT_YEAR), 'Next-year candidates must use N+1.');

    const regionBefore = await regionSnapshot(pg, regionId);
    const officialCountBefore = Number(regionBefore.project_count);
    const caseABeforeSource = await position(local, projects[CASES.A.source].id, 'Case A source before');
    equal(caseABeforeSource.unexecuted_amount, '107500000', 'Actual Sunchang source own available amount');
    check(amount(caseABeforeSource.unexecuted_amount) >= CASES.A.amount, 'Case A source cannot fund 100m.');
    const caseARequestRow = await createRequest(pg, local, projects[CASES.A.source].id, [{
      destination_type: 'EXISTING_PROJECT', destination_project_id: projects[CASES.A.destination].id,
      amount: CASES.A.amount.toString(), note: 'Sunchang actual existing destination',
    }], CASES.A, runtime.native_start_date);
    let caseARequest = await requestInQueue(adminA, caseARequestRow.request_id, regionId);
    check(caseARequest.destinations.some((line) => line.destination_project_id === projects[CASES.A.destination].id),
      'Case A destination missing in Admin queue.');
    const caseAState = await approveApply(pg, adminA, adminB, caseARequest, {});
    const caseASource = await exactSnapshot(pg, caseARequest.id, projects[CASES.A.source].id, 'SOURCE');
    const caseADestination = await exactSnapshot(pg, caseARequest.id, projects[CASES.A.destination].id, 'DESTINATION');
    assertSourceDelta(caseASource, CASES.A.amount, 'Case A');
    assertDestinationDelta(caseADestination, CASES.A.amount, 'Case A');

    const beforeB = await regionSnapshot(pg, regionId);
    const countsBeforeB = {
      official: Number(beforeB.project_count), local: await authenticatedProjectCount(local, regionId),
      admin: await authenticatedProjectCount(adminA, regionId),
    };
    const caseBRequestRow = await createRequest(pg, local, projects[CASES.B.source].id, [{
      destination_type: 'PENDING_NEW_PROJECT', planned_project_name: CASES.B.name,
      planned_project_year: NEXT_YEAR, planned_fund_project_name: CASES.B.name,
      planned_detail_project_name: CASES.B.name, planned_project_period: `${NEXT_YEAR}.01~${NEXT_YEAR}.12`,
      planned_project_start_year: NEXT_YEAR, planned_project_end_year: NEXT_YEAR,
      planned_project_status: '정상추진', planned_business_type: 'SW',
      amount: CASES.B.amount.toString(), note: '순창 차년도 신규사업 목적지',
    }], CASES.B, runtime.native_start_date);
    let caseBRequest = await requestInQueue(adminA, caseBRequestRow.request_id, regionId);
    const caseBChildBefore = await linkedNewProject(adminA, caseBRequest);
    equal(caseBChildBefore.child.status, caseBRequest.status === 'APPLIED' ? 'APPLIED' : 'SUBMITTED',
      'Case B child state before APPLY');
    const beforeBApply = await regionSnapshot(pg, regionId);
    const countsBeforeBApply = {
      official: Number(beforeBApply.project_count), local: await authenticatedProjectCount(local, regionId),
      admin: await authenticatedProjectCount(adminA, regionId),
    };
    equal(countsBeforeBApply.official, countsBeforeB.official, 'Case B official count before APPLY');
    equal(countsBeforeBApply.local, countsBeforeB.local, 'Case B local count before APPLY');
    equal(countsBeforeBApply.admin, countsBeforeB.admin, 'Case B admin count before APPLY');
    const caseBState = await approveApply(pg, adminA, adminB, caseBRequest, {
      [caseBChildBefore.child.id]: CASES.B.code,
    });
    caseBRequest = await requestInQueue(adminA, caseBRequest.id, regionId);
    const caseBChildren = await rpc(adminA, 'get_financial_new_project_requests', { p_status: null }, 'Case B child final');
    const caseBChildAfter = caseBChildren.find((row) => row.id === caseBChildBefore.child.id);
    equal(caseBChildAfter?.status, 'APPLIED', 'Case B child APPLIED');
    equal(caseBChildAfter?.official_project_code, CASES.B.code, 'Case B official code');
    check(caseBChildAfter?.materialized_project_id, 'Case B official project missing.');
    const caseBSource = await exactSnapshot(pg, caseBRequest.id, projects[CASES.B.source].id, 'SOURCE');
    assertSourceDelta(caseBSource, CASES.B.amount, 'Case B');
    const caseBNewPosition = await position(local, caseBChildAfter.materialized_project_id, 'Case B new project');
    equal(caseBNewPosition.original_allocation, 0, 'Case B new original allocation');
    equal(caseBNewPosition.increase_amount, CASES.B.amount, 'Case B new increase');
    equal(caseBNewPosition.adjusted_allocation, CASES.B.amount, 'Case B new adjusted allocation');
    equal(caseBNewPosition.execution_amount, 0, 'Case B new execution');
    equal(caseBNewPosition.unexecuted_amount, CASES.B.amount, 'Case B new unexecuted');
    equal(caseBNewPosition.execution_rate, 0, 'Case B new execution rate');
    const afterB = await regionSnapshot(pg, regionId);
    const countsAfterB = {
      official: Number(afterB.project_count), local: await authenticatedProjectCount(local, regionId),
      admin: await authenticatedProjectCount(adminA, regionId),
    };
    equal(countsAfterB.official, countsBeforeB.official + (caseBRequestRow.status === 'APPLIED' ? 0 : 1), 'Case B official count after APPLY');
    equal(countsAfterB.local, countsBeforeB.local + (caseBRequestRow.status === 'APPLIED' ? 0 : 1), 'Case B local count after APPLY');
    equal(countsAfterB.admin, countsBeforeB.admin + (caseBRequestRow.status === 'APPLIED' ? 0 : 1), 'Case B admin count after APPLY');

    const beforeC = await regionSnapshot(pg, regionId);
    const countsBeforeC = {
      official: Number(beforeC.project_count), local: await authenticatedProjectCount(local, regionId),
      admin: await authenticatedProjectCount(adminA, regionId),
    };
    const caseCRequestRow = await createRequest(pg, local, projects[CASES.C.source].id, [
      { destination_type: 'EXISTING_PROJECT', destination_project_id: projects[CASES.C.destination].id,
        amount: CASES.C.existingAmount.toString(), note: 'Sunchang mixed existing destination' },
      { destination_type: 'PENDING_NEW_PROJECT', planned_project_name: CASES.C.name,
        planned_project_year: NEXT_YEAR, planned_fund_project_name: CASES.C.name,
        planned_detail_project_name: CASES.C.name, planned_project_period: `${NEXT_YEAR}.01~${NEXT_YEAR}.12`,
        planned_project_start_year: NEXT_YEAR, planned_project_end_year: NEXT_YEAR,
        planned_project_status: '정상추진', planned_business_type: 'COMPOSITE',
        amount: CASES.C.newAmount.toString(), note: '순창 혼합 배분 신규사업 목적지' },
    ], CASES.C, runtime.native_start_date);
    let caseCRequest = await requestInQueue(adminA, caseCRequestRow.request_id, regionId);
    equal(caseCRequest.destinations.length, 2, 'Case C destination count');
    check(caseCRequest.destinations.some((line) => line.destination_type === 'EXISTING_PROJECT'),
      'Case C existing destination missing.');
    check(caseCRequest.destinations.some((line) => line.destination_type === 'PENDING_NEW_PROJECT'),
      'Case C new-project destination missing.');
    const caseCChildBefore = await linkedNewProject(adminA, caseCRequest);
    const beforeCApply = await regionSnapshot(pg, regionId);
    equal(beforeCApply.project_count, beforeC.project_count, 'Case C official count before APPLY');
    const caseCState = await approveApply(pg, adminA, adminB, caseCRequest, {
      [caseCChildBefore.child.id]: CASES.C.code,
    });
    caseCRequest = await requestInQueue(adminA, caseCRequest.id, regionId);
    const caseCChildren = await rpc(adminA, 'get_financial_new_project_requests', { p_status: null }, 'Case C child final');
    const caseCChildAfter = caseCChildren.find((row) => row.id === caseCChildBefore.child.id);
    equal(caseCChildAfter?.status, 'APPLIED', 'Case C child APPLIED');
    equal(caseCChildAfter?.official_project_code, CASES.C.code, 'Case C official code');
    check(caseCChildAfter?.materialized_project_id, 'Case C official project missing.');
    const caseCSource = await exactSnapshot(pg, caseCRequest.id, projects[CASES.C.source].id, 'SOURCE');
    const caseCExisting = await exactSnapshot(pg, caseCRequest.id, projects[CASES.C.destination].id, 'DESTINATION');
    assertSourceDelta(caseCSource, CASES.C.amount, 'Case C');
    assertDestinationDelta(caseCExisting, CASES.C.existingAmount, 'Case C existing');
    const caseCNewPosition = await position(local, caseCChildAfter.materialized_project_id, 'Case C new project');
    equal(caseCNewPosition.original_allocation, 0, 'Case C new original allocation');
    equal(caseCNewPosition.increase_amount, CASES.C.newAmount, 'Case C new increase');
    equal(caseCNewPosition.adjusted_allocation, CASES.C.newAmount, 'Case C new adjusted allocation');
    equal(caseCNewPosition.execution_amount, 0, 'Case C new execution');
    equal(caseCNewPosition.unexecuted_amount, CASES.C.newAmount, 'Case C new unexecuted');
    equal(caseCNewPosition.execution_rate, 0, 'Case C new execution rate');
    const afterC = await regionSnapshot(pg, regionId);
    const countsAfterC = {
      official: Number(afterC.project_count), local: await authenticatedProjectCount(local, regionId),
      admin: await authenticatedProjectCount(adminA, regionId),
    };
    equal(countsAfterC.official, countsBeforeC.official + (caseCRequestRow.status === 'APPLIED' ? 0 : 1), 'Case C official count after APPLY');
    equal(countsAfterC.local, countsBeforeC.local + (caseCRequestRow.status === 'APPLIED' ? 0 : 1), 'Case C local count after APPLY');
    equal(countsAfterC.admin, countsBeforeC.admin + (caseCRequestRow.status === 'APPLIED' ? 0 : 1), 'Case C admin count after APPLY');

    const requestIds = [caseARequest.id, caseBRequest.id, caseCRequest.id];
    const integrity = (await pg.query(`select
        (select count(*)::integer from (
          select requests.id from public.financial_budget_change_requests requests
          join public.financial_budget_change_request_lines lines on lines.request_id=requests.id
          where requests.id=any($1::uuid[]) group by requests.id,requests.total_amount
          having requests.total_amount<>sum(lines.amount)) gaps) request_gaps,
        (select count(*)::integer from public.financial_funding_invariant_check
          where cohort_conservation_gap<>0 or decrease_resolution_gap<>0) invariant_gaps,
        (select count(*)::integer from public.financial_budget_workflow_amount_snapshots
          where budget_request_id=any($1::uuid[]) and
            (adjusted_before<>original_before+increase_before-decrease_before
              or unexecuted_before<>adjusted_before-execution_before
              or adjusted_after<>original_after+increase_after-decrease_after
              or unexecuted_after<>adjusted_after-execution_after)) snapshot_formula_errors,
        (select count(*)::integer from public.financial_budget_change_requests
          where id=any($1::uuid[]) and status<>'APPLIED') non_applied_requests`, [requestIds])).rows[0];
    equal(integrity.request_gaps, 0, 'UAT request GAP');
    equal(integrity.invariant_gaps, 0, 'Ledger invariant GAP');
    equal(integrity.snapshot_formula_errors, 0, 'Snapshot formula errors');
    equal(integrity.non_applied_requests, 0, 'Partial APPLY');
    const finalQueue = await queueParity(pg, adminA, '__NO_PENDING_UAT_REQUEST__').catch((error) => {
      if (String(error.message).includes('omitted')) return null;
      throw error;
    });
    const dbPending = Number((await pg.query(`select count(*)::integer value
      from public.financial_budget_change_requests where status='SUBMITTED'`)).rows[0].value);
    const adminPending = (await rpc(adminA, 'get_financial_budget_change_requests', {
      p_project_id: null, p_status: 'SUBMITTED', p_year: null, p_region_id: null,
    }, 'Final Admin pending queue')).length;
    equal(adminPending, dbPending, 'Final DB pending/Admin queue parity');
    const correlations = {
      B: await correlation(pg, caseBRequest.id), C: await correlation(pg, caseCRequest.id),
    };
    check(correlations.B.length === 1 && correlations.C.length === 1, 'Grouped correlation rows are incomplete.');
    for (const row of [...correlations.B, ...correlations.C]) {
      equal(row.source_budget_change_request_id, row.new_project_request_id ?
        (row === correlations.B[0] ? caseBRequest.id : caseCRequest.id) : null, 'Grouped request correlation');
      equal(row.source_budget_change_line_id, row.line_id, 'Grouped line correlation');
      equal(row.new_project_status, 'APPLIED', 'Grouped new-project status');
      equal(row.pending_status, 'LINKED', 'Grouped pending trace');
      equal(row.link_status, 'APPLIED', 'Grouped link trace');
    }
    const finalRegion = await regionSnapshot(pg, regionId);
    equal(amount(finalRegion.adjusted_total), amount(regionBefore.adjusted_total), 'Sunchang managed total conservation');
    equal(finalRegion.execution_total, regionBefore.execution_total, 'Sunchang execution total unchanged');
    const fresh = {
      A_source: await freshPair(url, anonKey, env, projects[CASES.A.source].id, 'Case A source'),
      A_destination: await freshPair(url, anonKey, env, projects[CASES.A.destination].id, 'Case A destination'),
      B_new: await freshPair(url, anonKey, env, caseBChildAfter.materialized_project_id, 'Case B new'),
      C_source: await freshPair(url, anonKey, env, projects[CASES.C.source].id, 'Case C source'),
      C_existing: await freshPair(url, anonKey, env, projects[CASES.C.destination].id, 'Case C existing'),
      C_new: await freshPair(url, anonKey, env, caseCChildAfter.materialized_project_id, 'Case C new'),
    };
    const history = {};
    for (const [label, projectId, requestId] of [
      ['A_source', projects[CASES.A.source].id, caseARequest.id],
      ['A_destination', projects[CASES.A.destination].id, caseARequest.id],
      ['B_new', caseBChildAfter.materialized_project_id, caseBRequest.id],
      ['C_existing', projects[CASES.C.destination].id, caseCRequest.id],
      ['C_new', caseCChildAfter.materialized_project_id, caseCRequest.id],
    ]) {
      const rows = await rpc(local, 'get_financial_budget_change_requests', {
        p_project_id: projectId, p_status: 'APPLIED', p_year: YEAR, p_region_id: regionId,
      }, `${label} history`);
      history[label] = rows.some((row) => row.id === requestId) ? 'PASS' : 'FAIL';
      equal(history[label], 'PASS', `${label} counterpart history`);
    }

    const result = {
      status: 'PASS', target: 'TEST', project_ref: TEST_REF, production_touched: false,
      auth: { local_a: 'PASS', admin_a: 'PASS', admin_b: 'PASS', region: profile.display_name },
      candidate_policy: { same_region: true, same_year: YEAR, source_excluded: true,
        existing_count: candidates.length, next_year: NEXT_YEAR, registered_next_year_count: nextYearCandidates.length },
      case_a: { request_id: caseARequest.id, state: caseAState, amount: CASES.A.amount.toString(),
        source: { code: CASES.A.source, name: projects[CASES.A.source].project_name, ...caseASource },
        destination: { code: CASES.A.destination, name: projects[CASES.A.destination].project_name, ...caseADestination },
        monetary_gap: '0' },
      case_b: { request_id: caseBRequest.id, state: caseBState, amount: CASES.B.amount.toString(),
        source: { code: CASES.B.source, name: projects[CASES.B.source].project_name, ...caseBSource },
        new_project_request_id: caseBChildAfter.id,
        new_project: { id: caseBChildAfter.materialized_project_id, code: CASES.B.code,
          name: CASES.B.name, position: caseBNewPosition },
        project_counts: { before_request: countsBeforeB, before_apply: countsBeforeBApply, after_apply: countsAfterB },
        correlation: correlations.B[0], monetary_gap: '0' },
      case_c: { request_id: caseCRequest.id, state: caseCState, amount: CASES.C.amount.toString(),
        source: { code: CASES.C.source, name: projects[CASES.C.source].project_name, ...caseCSource },
        existing_destination: { code: CASES.C.destination, name: projects[CASES.C.destination].project_name,
          amount: CASES.C.existingAmount.toString(), ...caseCExisting },
        new_destination: { amount: CASES.C.newAmount.toString(), id: caseCChildAfter.materialized_project_id,
          code: CASES.C.code, name: CASES.C.name, position: caseCNewPosition },
        project_counts: { before_request: countsBeforeC, before_apply: Number(beforeCApply.project_count), after_apply: countsAfterC },
        correlation: correlations.C[0], monetary_gap: '0' },
      queue: { db_pending_request: dbPending, admin_queue: adminPending, parity: true, final_queue_probe: finalQueue },
      region: { before: regionBefore, after: finalRegion, adjusted_total_gap: '0', execution_gap: '0',
        official_project_count_delta: Number(finalRegion.project_count) - officialCountBefore },
      integrity, fresh_read: { local_admin_identical: true, projects: fresh }, history,
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
    await Promise.allSettled([local.client.auth.signOut(), adminA.client.auth.signOut(), adminB.client.auth.signOut()]);
  }
}

main().catch((error) => {
  process.stderr.write(`SUNCHANG MIXED BUDGET UAT FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
