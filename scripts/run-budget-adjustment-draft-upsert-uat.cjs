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
const SOURCE_CODE = '2026-52-770-0004';
const DESTINATION_CODE = '2026-52-770-0003';

function fail(message) { throw new Error(message); }
function check(value, message) { if (!value) fail(message); }
function equal(actual, expected, message) {
  if (String(actual) !== String(expected)) fail(`${message} (expected=${expected}, actual=${actual})`);
}
function load(file) {
  const resolved = path.resolve(process.cwd(), file ?? '');
  check(file && fs.existsSync(resolved), `Missing explicit file: ${file ?? '(none)'}`);
  return dotenv.parse(fs.readFileSync(resolved));
}
function required(env, key) {
  const value = String(env[key] ?? '').trim();
  check(value, `${key} is required.`);
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
function client(url, key) {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function signIn(url, key, email, password, alias) {
  const instance = client(url, key);
  const { data, error } = await instance.auth.signInWithPassword({ email, password });
  if (error || !data.user || !data.session) fail(`${alias} TEST authentication failed.`);
  return { alias, client: instance, userId: data.user.id };
}
async function rpc(account, name, args, label) {
  const { data, error } = await account.client.rpc(name, args);
  if (error) fail(`${label}: ${error.code ?? 'RPC'} ${error.message}`);
  return data ?? [];
}
function one(rows, label) {
  check(Array.isArray(rows) && rows.length === 1, `${label} must return one row.`);
  return rows[0];
}
async function state(pg, requestId) {
  const request = (await pg.query(`select id,status,total_amount::bigint::text,reason
    from public.financial_budget_change_requests where id=$1`, [requestId])).rows[0];
  const lines = (await pg.query(`select id,line_no,destination_type,amount::bigint::text,
      planned_project_name,new_project_request_id from public.financial_budget_change_request_lines
    where request_id=$1 order by line_no`, [requestId])).rows;
  const children = (await pg.query(`select id,status,project_name,requested_amount::bigint::text,
      source_budget_change_request_id,source_budget_change_line_id,materialized_project_id
    from public.financial_new_project_requests where source_budget_change_request_id=$1`, [requestId])).rows;
  return { request, lines, children };
}
async function queueParity(pg, admin, expectedId) {
  const db = Number((await pg.query(`select count(*)::integer value
    from public.financial_budget_change_requests where status='SUBMITTED'`)).rows[0].value);
  const rows = await rpc(admin, 'get_financial_budget_change_requests', {
    p_project_id: null, p_status: 'SUBMITTED', p_year: null, p_region_id: null,
  }, 'Admin submitted queue');
  equal(rows.length, db, 'DB pending/Admin queue');
  if (expectedId) check(rows.some((row) => row.id === expectedId), 'Draft-upsert request missing from Admin queue.');
  return { db_pending_request: db, admin_queue: rows.length };
}

async function main() {
  check(process.argv.includes('--confirm-test-write'), '--confirm-test-write is required.');
  const env = { ...load(process.argv[2]), ...load(process.argv[3]) };
  const url = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  if (env.TARGET_ENV !== 'TEST' || env.TEST_PROJECT_REF !== TEST_REF || env.PROD_PROJECT_REF !== PROD_REF
      || ref(url) !== TEST_REF || ref(databaseUrl, true) !== TEST_REF || ref(databaseUrl, true) === PROD_REF) {
    fail('Fail-closed TEST target gate rejected configuration.');
  }
  const anonKey = required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const [local, admin] = await Promise.all([
    signIn(url, anonKey, required(env, 'UAT_LOCAL_A_EMAIL'), required(env, 'UAT_LOCAL_A_PASSWORD'), 'local_a'),
    signIn(url, anonKey, required(env, 'UAT_ADMIN_A_EMAIL'), required(env, 'UAT_ADMIN_A_PASSWORD'), 'admin_a'),
  ]);
  const pg = new Client({ connectionString: connectionString(databaseUrl), ssl: { rejectUnauthorized: false },
    application_name: 'budget-adjustment-draft-upsert-uat' });
  await pg.connect();
  try {
    const runtime = (await pg.query(`select environment_kind,mode,bound_project_ref,native_start_date::text
      from public.financial_ledger_runtime where singleton=true`)).rows[0];
    equal(runtime.environment_kind, 'TEST', 'Runtime environment');
    equal(runtime.mode, 'TEST', 'Runtime mode');
    equal(runtime.bound_project_ref, TEST_REF, 'Runtime ref');
    const profile = (await pg.query(`select profiles.region_id,regions.display_name
      from public.profiles join public.regions on regions.id=profiles.region_id where profiles.id=$1`,
    [local.userId])).rows[0];
    equal(profile.display_name, '전북 순창군', 'Local region');
    const projects = (await pg.query(`select id,project_code from public.projects
      where region_id=$1 and project_code=any($2::text[])`,
    [profile.region_id, [SOURCE_CODE, DESTINATION_CODE]])).rows;
    const source = projects.find((row) => row.project_code === SOURCE_CODE);
    const destination = projects.find((row) => row.project_code === DESTINATION_CODE);
    check(source && destination, 'Draft-upsert fixtures are missing.');
    const before = (await pg.query(`select
      (select count(*)::integer from public.projects where region_id=$1) projects,
      (select count(*)::integer from public.project_fund_transfers) transfers,
      (select count(*)::integer from public.financial_unallocated_fund_movements) movements,
      (select coalesce(sum(coalesce(alloc,0)),0)::bigint::text from public.projects) allocation,
      (select coalesce(sum(coalesce(exec,0)),0)::bigint::text from public.projects) execution`,
    [profile.region_id])).rows[0];
    const idempotencyKey = crypto.randomUUID();
    const common = {
      p_source_project_id: source.id, p_source_budget_year_id: null,
      p_effective_date: runtime.native_start_date,
      p_reason: '순창 신규사업 데이터베이스 임시저장 갱신 사용자 검증', p_idempotency_key: idempotencyKey,
    };
    const initialDestinations = [
      { destination_type: 'EXISTING_PROJECT', destination_project_id: destination.id,
        amount: '1000000', note: 'DRAFT_EXISTING' },
      { destination_type: 'PENDING_NEW_PROJECT', planned_project_name: '순창 청년활력 신규사업 최초안',
        planned_project_year: 2027, planned_project_period: '2027.01~2027.12',
        planned_project_start_year: 2027, planned_project_end_year: 2027,
        planned_project_status: '정상추진', planned_business_type: 'SW',
        amount: '1000000', note: 'DRAFT_NEW' },
    ];
    const created = one(await rpc(local, 'financial_test_uat_save_budget_change_request', {
      ...common, p_destinations: initialDestinations, p_submit: false,
    }, 'Create grouped DB DRAFT'), 'Create grouped DB DRAFT');
    equal(created.status, 'DRAFT', 'Initial parent DRAFT status');
    equal(created.gap_amount, 0, 'Initial DRAFT gap');
    const initial = await state(pg, created.request_id);
    equal(initial.request.total_amount, 2_000_000, 'Initial DRAFT total');
    equal(initial.lines.length, 2, 'Initial DRAFT destination count');
    equal(initial.children.length, 1, 'Initial DRAFT child count');
    equal(initial.children[0].status, 'DRAFT', 'Initial child DRAFT status');
    equal(initial.children[0].source_budget_change_request_id, created.request_id, 'Initial child group link');
    equal(initial.children[0].source_budget_change_line_id,
      initial.lines.find((line) => line.destination_type === 'PENDING_NEW_PROJECT').id, 'Initial child line link');

    const revisedDestinations = [
      { ...initialDestinations[0], amount: '500000' },
      { ...initialDestinations[1], planned_project_name: '순창 청년활력 신규사업 수정안', amount: '1500000' },
    ];
    const revised = one(await rpc(local, 'financial_test_uat_save_budget_change_request', {
      ...common, p_destinations: revisedDestinations, p_submit: false,
    }, 'Update grouped DB DRAFT'), 'Update grouped DB DRAFT');
    equal(revised.request_id, created.request_id, 'DRAFT upsert parent identity');
    equal(revised.status, 'DRAFT', 'Revised parent DRAFT status');
    const revisedState = await state(pg, created.request_id);
    equal(revisedState.lines.length, 2, 'Revised DRAFT destination count');
    equal(revisedState.children.length, 1, 'Revised DRAFT child count');
    equal(revisedState.children[0].project_name, 'UAT 순창 DRAFT 신규사업 수정', 'Revised child name');
    equal(revisedState.children[0].requested_amount, 1_500_000, 'Revised child amount');
    equal(revisedState.children[0].status, 'DRAFT', 'Revised child status');

    const submitted = one(await rpc(local, 'financial_test_uat_save_budget_change_request', {
      ...common, p_destinations: revisedDestinations, p_submit: true,
    }, 'Submit grouped DB DRAFT'), 'Submit grouped DB DRAFT');
    equal(submitted.request_id, created.request_id, 'Submitted parent identity');
    equal(submitted.status, 'SUBMITTED', 'Submitted parent status');
    equal(submitted.gap_amount, 0, 'Submitted DRAFT gap');
    const submittedState = await state(pg, created.request_id);
    equal(submittedState.request.status, 'SUBMITTED', 'Fresh parent submitted status');
    equal(submittedState.children[0].status, 'SUBMITTED', 'Fresh child submitted status');
    const queue = await queueParity(pg, admin, created.request_id);
    const rejected = one(await rpc(admin, 'financial_reject_budget_change_request', {
      p_request_id: created.request_id, p_reason: '임시저장 갱신 처리 흐름 검증 후 금액 영향 없이 반려',
    }, 'Reject DRAFT-upsert UAT'), 'Reject DRAFT-upsert UAT');
    equal(rejected.status, 'REJECTED', 'Rejected parent status');
    const finalState = await state(pg, created.request_id);
    equal(finalState.children[0].status, 'REJECTED', 'Rejected child status');
    const after = (await pg.query(`select
      (select count(*)::integer from public.projects where region_id=$1) projects,
      (select count(*)::integer from public.project_fund_transfers) transfers,
      (select count(*)::integer from public.financial_unallocated_fund_movements) movements,
      (select coalesce(sum(coalesce(alloc,0)),0)::bigint::text from public.projects) allocation,
      (select coalesce(sum(coalesce(exec,0)),0)::bigint::text from public.projects) execution`,
    [profile.region_id])).rows[0];
    for (const field of ['projects', 'transfers', 'movements', 'allocation', 'execution']) {
      equal(after[field], before[field], `Rejected DRAFT monetary/project invariant ${field}`);
    }
    const finalQueue = await queueParity(pg, admin, null);
    process.stdout.write(`${JSON.stringify({
      status: 'PASS', target: 'TEST', project_ref: TEST_REF, production_touched: false,
      request_id: created.request_id,
      initial: { parent: initial.request.status, child: initial.children[0].status,
        destinations: initial.lines.length, group_link: true, line_link: true },
      revised: { parent_identity_preserved: true, child_name: revisedState.children[0].project_name,
        child_amount: revisedState.children[0].requested_amount, destinations: revisedState.lines.length },
      submitted: { parent: submittedState.request.status, child: submittedState.children[0].status,
        queue_parity: queue },
      final: { parent: finalState.request.status, child: finalState.children[0].status,
        queue: finalQueue, monetary_delta: '0', project_count_delta: 0 },
    }, null, 2)}\n`);
  } finally {
    await pg.end().catch(() => undefined);
    await Promise.allSettled([local.client.auth.signOut(), admin.client.auth.signOut()]);
  }
}

main().catch((error) => {
  process.stderr.write(`BUDGET DRAFT UPSERT UAT FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
