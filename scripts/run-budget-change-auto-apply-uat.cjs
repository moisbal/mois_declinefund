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
const AMOUNT = 10_000n;

function fail(message) { throw new Error(message); }
function check(condition, message) { if (!condition) fail(message); }
function equal(actual, expected, message) {
  if (String(actual) !== String(expected)) {
    fail(`${message} (expected=${expected}, actual=${actual})`);
  }
}
function amount(value) { return BigInt(value ?? 0); }
function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
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
  try {
    return new URL(value).hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i)?.[1] ?? null;
  } catch {
    return null;
  }
}
function refFromDatabase(value) {
  try {
    const url = new URL(value);
    return url.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i)?.[1]
      ?? decodeURIComponent(url.username).match(/^postgres\.([a-z0-9-]+)$/i)?.[1]
      ?? null;
  } catch {
    return null;
  }
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
  return error.code ?? 'RPC_ERROR';
}
function one(rows, label) {
  check(Array.isArray(rows) && rows.length === 1, `${label} must return one row.`);
  return rows[0];
}
async function position(account, projectId, label) {
  const row = one(await rpc(account, 'get_financial_budget_change_project_position', {
    p_project_id: projectId,
  }, label), label);
  equal(amount(row.original_allocation) + amount(row.increase_amount) - amount(row.decrease_amount),
    row.adjusted_allocation, `${label} adjusted allocation formula`);
  equal(amount(row.adjusted_allocation) - amount(row.execution_amount),
    row.unexecuted_amount, `${label} unexecuted formula`);
  return row;
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

  const [localA, localB] = await Promise.all([
    signIn(url, anonKey, credentials, 'LOCAL_A', 'local_a'),
    signIn(url, anonKey, credentials, 'LOCAL_B', 'local_b'),
  ]);
  const pg = new Client({
    connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
    application_name: 'budget-change-auto-apply-uat',
  });
  await pg.connect();
  let requestId = null;
  let correctionId = null;
  try {
    await pg.query("set statement_timeout='180s'");
    const runtime = (await pg.query(`select environment_kind,mode,bound_project_ref,
        native_start_date::text
      from public.financial_ledger_runtime where singleton=true`)).rows[0];
    equal(runtime.environment_kind, 'TEST', 'runtime environment');
    equal(runtime.mode, 'TEST', 'runtime mode');
    equal(runtime.bound_project_ref, TEST_REF, 'runtime project ref');

    const profiles = (await pg.query(`select id,role,region_id from public.profiles
      where id=any($1::uuid[])`, [[localA.userId, localB.userId]])).rows;
    const profileA = profiles.find((row) => row.id === localA.userId);
    const profileB = profiles.find((row) => row.id === localB.userId);
    equal(profileA?.role, 'local_user', 'local_a role');
    equal(profileB?.role, 'local_user', 'local_b role');
    check(profileA.region_id && profileB.region_id && profileA.region_id !== profileB.region_id,
      'UAT requires local users from two different TEST regions.');

    const source = (await pg.query(`select projects.id,projects.year,projects.project_code,
        positions.current_wallet_balance
      from public.financial_project_funding_positions as positions
      join public.projects as projects on projects.id=positions.project_id
      where projects.region_id=$1 and projects.project_code is not null
        and positions.projection_ready and positions.current_wallet_balance >= $2
      order by positions.current_wallet_balance desc,projects.id
      limit 1`, [profileA.region_id, AMOUNT.toString()])).rows[0];
    check(source, 'No TEST source project has enough available Ledger balance.');
    const destinations = (await pg.query(`select projects.id,projects.year,projects.project_code
      from public.projects as projects
      where projects.region_id=$1 and projects.year=$2 and projects.project_code is not null
        and projects.id<>$3
      order by projects.id
      limit 2`, [profileA.region_id, source.year, source.id])).rows;
    check(destinations.length === 2, 'UAT requires two registered same-year destination projects.');
    const [originalDestination, replacementDestination] = destinations;

    const [sourceBefore, originalBefore, replacementBefore] = await Promise.all([
      position(localA, source.id, 'source before'),
      position(localA, originalDestination.id, 'original destination before'),
      position(localA, replacementDestination.id, 'replacement destination before'),
    ]);
    check(amount(sourceBefore.unexecuted_amount) >= AMOUNT, 'Selected source became unavailable.');
    const regionBefore = amount(sourceBefore.adjusted_allocation)
      + amount(originalBefore.adjusted_allocation)
      + amount(replacementBefore.adjusted_allocation);

    const mode = one(await rpc(localA, 'get_financial_budget_change_workflow_mode', {},
      'automatic-apply mode'), 'automatic-apply mode');
    equal(mode.auto_approval_enabled, true, 'automatic-apply setting');

    const created = one(await rpc(localA,
      'financial_test_uat_save_budget_change_request_complete_v2', {
        p_source_project_id: source.id,
        p_source_budget_year_id: null,
        p_destinations: [{
          destination_type: 'EXISTING_PROJECT',
          destination_project_id: originalDestination.id,
          amount: AMOUNT.toString(),
          note: '자동반영 및 목적지 정정 UAT',
        }],
        p_effective_date: runtime.native_start_date,
        p_reason: '자동반영 및 목적지 정정 UAT',
        p_idempotency_key: crypto.randomUUID(),
        p_submit: true,
      }, 'automatic budget change'), 'automatic budget change');
    requestId = created.request_id;
    equal(created.status, 'APPLIED', 'automatic request status');
    equal(created.gap_amount, 0, 'automatic request gap');

    const request = (await pg.query(`select id,status,approval_mode,requested_by,approved_by,applied_by
      from public.financial_budget_change_requests where id=$1`, [requestId])).rows[0];
    equal(request.status, 'APPLIED', 'stored request status');
    equal(request.approval_mode, 'AUTO', 'stored approval mode');
    equal(request.requested_by, localA.userId, 'request actor');
    equal(request.approved_by, localA.userId, 'automatic approval actor');
    equal(request.applied_by, localA.userId, 'automatic apply actor');
    const line = (await pg.query(`select id,materialized_transfer_id from
      public.financial_budget_change_request_lines where request_id=$1`, [requestId])).rows[0];
    check(line?.id && line?.materialized_transfer_id, 'Automatic apply did not materialize a transfer.');

    const initialStates = await rpc(localA, 'get_financial_budget_change_destination_states', {
      p_project_id: source.id,
    }, 'initial destination state');
    const initialState = initialStates.find((row) => row.line_id === line.id);
    equal(initialState?.current_destination_project_id, originalDestination.id,
      'initial current destination');
    equal(initialState?.correction_allowed, true, 'initial correction eligibility');

    const crossRegionError = await expectRpcError(localB,
      'financial_correct_budget_change_destination', {
        p_line_id: line.id,
        p_replacement_project_id: replacementDestination.id,
        p_reason: '다른 지자체 정정 차단 검증',
        p_effective_date: runtime.native_start_date,
        p_idempotency_key: crypto.randomUUID(),
      }, 'cross-region correction');

    const idempotencyKey = crypto.randomUUID();
    const corrected = one(await rpc(localA, 'financial_correct_budget_change_destination', {
      p_line_id: line.id,
      p_replacement_project_id: replacementDestination.id,
      p_reason: '목적지 선택 정정 UAT',
      p_effective_date: runtime.native_start_date,
      p_idempotency_key: idempotencyKey,
    }, 'destination correction'), 'destination correction');
    correctionId = corrected.correction_id;
    equal(corrected.status, 'APPLIED', 'correction status');
    equal(corrected.request_id, requestId, 'correction request');
    equal(corrected.line_id, line.id, 'correction line');
    equal(corrected.destination_project_id, replacementDestination.id, 'corrected destination');
    const replay = one(await rpc(localA, 'financial_correct_budget_change_destination', {
      p_line_id: line.id,
      p_replacement_project_id: replacementDestination.id,
      p_reason: '목적지 선택 정정 UAT',
      p_effective_date: runtime.native_start_date,
      p_idempotency_key: idempotencyKey,
    }, 'destination correction replay'), 'destination correction replay');
    equal(replay.correction_id, correctionId, 'correction idempotency');

    const correction = (await pg.query(`select * from
      public.financial_budget_change_destination_corrections where id=$1`, [correctionId])).rows[0];
    equal(correction.sequence_no, 1, 'correction sequence');
    equal(correction.original_destination_project_id, originalDestination.id,
      'correction original destination');
    equal(correction.replacement_destination_project_id, replacementDestination.id,
      'correction replacement destination');
    equal(correction.original_materialization_kind, 'TRANSFER', 'correction materialization kind');
    const transfers = (await pg.query(`select id,source_budget_year_id,destination_budget_year_id,
        amount,status,transaction_kind,reversal_of,reason_code
      from public.project_fund_transfers
      where id=any($1::uuid[])`, [[
      correction.original_materialization_id,
      correction.reversal_materialization_id,
      correction.replacement_materialization_id,
    ]])).rows;
    equal(transfers.length, 3, 'correction transfer chain length');
    const original = transfers.find((row) => row.id === correction.original_materialization_id);
    const reversal = transfers.find((row) => row.id === correction.reversal_materialization_id);
    const replacement = transfers.find((row) => row.id === correction.replacement_materialization_id);
    equal(original.transaction_kind, 'NORMAL', 'original transfer kind');
    equal(reversal.transaction_kind, 'REVERSAL', 'reversal transfer kind');
    equal(reversal.reversal_of, original.id, 'reversal linkage');
    equal(replacement.transaction_kind, 'NORMAL', 'replacement transfer kind');
    equal(reversal.amount, AMOUNT, 'reversal amount');
    equal(replacement.amount, AMOUNT, 'replacement amount');

    const [sourceAfter, originalAfter, replacementAfter] = await Promise.all([
      position(localA, source.id, 'source after'),
      position(localA, originalDestination.id, 'original destination after'),
      position(localA, replacementDestination.id, 'replacement destination after'),
    ]);
    equal(sourceAfter.adjusted_allocation,
      (amount(sourceBefore.adjusted_allocation) - AMOUNT).toString(), 'source net decrease');
    equal(originalAfter.adjusted_allocation, originalBefore.adjusted_allocation,
      'original destination restored');
    equal(replacementAfter.adjusted_allocation,
      (amount(replacementBefore.adjusted_allocation) + AMOUNT).toString(),
      'replacement destination increase');
    const regionAfter = amount(sourceAfter.adjusted_allocation)
      + amount(originalAfter.adjusted_allocation)
      + amount(replacementAfter.adjusted_allocation);
    equal(regionAfter, regionBefore, 'three-project budget conservation');

    const finalStates = await rpc(localA, 'get_financial_budget_change_destination_states', {
      p_project_id: source.id,
    }, 'final destination state');
    const finalState = finalStates.find((row) => row.line_id === line.id);
    equal(finalState?.current_destination_project_id, replacementDestination.id,
      'final current destination');
    equal(finalState?.correction_count, 1, 'final correction count');
    const audit = (await pg.query(`select action from public.audit_logs
      where (field_name='financial_budget_change_requests'
          and (new_value::jsonb ->> 'record_id')::uuid=$1)
         or (field_name='financial_budget_change_destination_corrections'
          and (new_value::jsonb ->> 'record_id')::uuid=$2)`,
    [requestId, correctionId])).rows.map((row) => row.action);
    check(audit.includes('BUDGET_REALLOCATION_AUTO_APPROVED'), 'Automatic approval audit is missing.');
    check(audit.includes('BUDGET_REALLOCATION_APPLIED'), 'Automatic apply audit is missing.');
    check(audit.includes('BUDGET_REALLOCATION_DESTINATION_CORRECTED'),
      'Destination correction audit is missing.');

    process.stdout.write(`${JSON.stringify({
      ok: true,
      target: 'TEST',
      production_touched: false,
      request_id: requestId,
      correction_id: correctionId,
      amount: AMOUNT.toString(),
      automatic_status: created.status,
      approval_mode: request.approval_mode,
      original_destination_restored: true,
      replacement_destination_increased: true,
      budget_conservation_gap: '0',
      correction_idempotent: true,
      cross_region_error: crossRegionError,
      audit_actions_verified: 3,
    }, null, 2)}\n`);
  } catch (error) {
    if (requestId || correctionId) {
      error.message = `${error.message} (request_id=${requestId ?? 'none'}, correction_id=${correctionId ?? 'none'})`;
    }
    throw error;
  } finally {
    await Promise.all([
      localA.client.auth.signOut().catch(() => undefined),
      localB.client.auth.signOut().catch(() => undefined),
      pg.end().catch(() => undefined),
    ]);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
