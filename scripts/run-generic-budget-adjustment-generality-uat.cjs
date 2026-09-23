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
const RUN_TAG = 'generic-budget-generality-20260831-v1';
const TRANSFER_AMOUNT = 500_000n;

function fail(message) { throw new Error(message); }
function check(value, message) { if (!value) fail(message); }
function equal(actual, expected, message) {
  if (String(actual) !== String(expected)) fail(`${message} (expected=${expected}, actual=${actual})`);
}
function amount(value) { return BigInt(value ?? 0); }
function has(name) { return process.argv.includes(name); }
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
function stableUuid(label) {
  const chars = crypto.createHash('sha256').update(`${RUN_TAG}:${label}`).digest('hex').slice(0, 32).split('');
  chars[12] = '4';
  chars[16] = ['8', '9', 'a', 'b'][Number.parseInt(chars[16], 16) % 4];
  const value = chars.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
function supabaseClient(url, key) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
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
  return amount(adjusted) <= 0n ? 0 : Number((Number(execution) * 100 / Number(adjusted)).toFixed(2));
}
async function position(account, projectId, label) {
  const row = first(await rpc(account, 'get_financial_budget_change_project_position', {
    p_project_id: projectId,
  }, label), label);
  equal(amount(row.original_allocation) + amount(row.increase_amount) - amount(row.decrease_amount),
    row.adjusted_allocation, `${label} allocation formula`);
  equal(amount(row.adjusted_allocation) - amount(row.execution_amount), row.unexecuted_amount,
    `${label} unexecuted formula`);
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
  };
}
async function profile(pg, account) {
  const row = (await pg.query(`select profiles.role, profiles.region_id,
      regions.sido, regions.sigungu
    from public.profiles
    left join public.regions on regions.id=profiles.region_id
    where profiles.id=$1`, [account.userId])).rows[0];
  check(row, `${account.alias} profile is missing.`);
  account.profile = row;
  return account;
}
async function regionSnapshot(pg, regionId) {
  return (await pg.query(`select
      (select count(*)::integer from public.projects where region_id=$1) project_count,
      (select coalesce(sum(coalesce(positions.ledger_adjusted_allocation, projects.alloc, 0)),0)::bigint::text
       from public.projects left join public.financial_project_funding_positions positions
         on positions.project_id=projects.id where projects.region_id=$1) adjusted,
      (select coalesce(sum(coalesce(positions.ledger_execution_amount, projects.exec, 0)),0)::bigint::text
       from public.projects left join public.financial_project_funding_positions positions
         on positions.project_id=projects.id where projects.region_id=$1) execution,
      (select coalesce(sum(amount),0)::bigint::text
       from public.financial_pending_new_project_funds where region_id=$1 and status='WAITING') waiting`,
  [regionId])).rows[0];
}
async function selectFixture(pg, local) {
  const rows = (await pg.query(`select projects.id, projects.project_code,
      coalesce(nullif(btrim(projects.detail_project_name), ''),
        nullif(btrim(projects.fund_project_name), ''),
        nullif(btrim(projects.project_name), ''), '사업명 확인 필요') as project_name,
      projects.year
    from public.projects
    where projects.region_id=$1 and projects.year<>2024
      and projects.project_code is not null and projects.project_code not like '%UAT%'
    order by case when projects.year=2025 then 0 else 1 end, projects.year desc,
      coalesce(projects.alloc,0)-coalesce(projects.exec,0) desc, projects.project_code`,
  [local.profile.region_id])).rows;
  for (const source of rows) {
    const destination = rows.find((row) => row.id !== source.id && row.year === source.year);
    if (!destination) continue;
    try {
      const sourcePosition = await position(local, source.id, `Fixture ${source.project_code}`);
      if (amount(sourcePosition.unexecuted_amount) >= TRANSFER_AMOUNT) {
        return { source, destination, sourcePosition };
      }
    } catch (error) {
      if (!String(error.message).includes('감액')) throw error;
    }
  }
  fail('No non-2024 cross-region fixture has enough project-local unexecuted amount.');
}
async function exactSnapshots(pg, requestId) {
  const rows = (await pg.query(`select project_id, project_role,
      original_before::text, increase_before::text, decrease_before::text,
      adjusted_before::text, execution_before::text, unexecuted_before::text,
      original_after::text, increase_after::text, decrease_after::text,
      adjusted_after::text, execution_after::text, unexecuted_after::text
    from public.financial_budget_workflow_amount_snapshots
    where budget_request_id=$1 and capture_kind='EXACT_AT_APPLY'
    order by project_role`, [requestId])).rows;
  equal(rows.length, 2, 'Generality exact snapshot count');
  return Object.fromEntries(rows.map((row) => [row.project_role, row]));
}

async function main() {
  check(has('--confirm-test-write'), 'UAT requires --confirm-test-write.');
  const env = { ...load(arg('--env-file')), ...load(arg('--credentials-file')) };
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  const supabaseUrl = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (String(env.TARGET_ENV).toUpperCase() !== 'TEST'
      || env.TEST_PROJECT_REF !== TEST_REF || env.PROD_PROJECT_REF !== PROD_REF
      || refFromUrl(supabaseUrl) !== TEST_REF || refFromDatabase(databaseUrl) !== TEST_REF
      || refFromDatabase(databaseUrl) === PROD_REF) fail('Fail-closed TEST target gate rejected configuration.');

  const pg = new Client({ connectionString: connectionString(databaseUrl), ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000, application_name: 'generic-budget-adjustment-generality-uat' });
  await pg.connect();
  const [local, crossLocal, adminA, adminB] = await Promise.all([
    signIn(supabaseUrl, anonKey, required(env, 'UAT_LOCAL_B_EMAIL'), required(env, 'UAT_LOCAL_B_PASSWORD'), 'local_b'),
    signIn(supabaseUrl, anonKey, required(env, 'UAT_LOCAL_C_EMAIL'), required(env, 'UAT_LOCAL_C_PASSWORD'), 'local_c'),
    signIn(supabaseUrl, anonKey, required(env, 'UAT_ADMIN_A_EMAIL'), required(env, 'UAT_ADMIN_A_PASSWORD'), 'admin_a'),
    signIn(supabaseUrl, anonKey, required(env, 'UAT_ADMIN_B_EMAIL'), required(env, 'UAT_ADMIN_B_PASSWORD'), 'admin_b'),
  ]);
  try {
    await pg.query("set statement_timeout='90s'");
    const runtime = (await pg.query(`select environment_kind, mode, bound_project_ref,
      native_start_date::text from public.financial_ledger_runtime where singleton=true`)).rows[0];
    equal(runtime?.environment_kind, 'TEST', 'Ledger environment');
    equal(runtime?.mode, 'TEST', 'Ledger mode');
    equal(runtime?.bound_project_ref, TEST_REF, 'Ledger TEST ref');
    await Promise.all([profile(pg, local), profile(pg, crossLocal), profile(pg, adminA), profile(pg, adminB)]);
    equal(local.profile.role, 'local_user', 'local_b role');
    equal(crossLocal.profile.role, 'local_user', 'local_c role');
    equal(adminA.profile.role, 'admin', 'admin_a role');
    equal(adminB.profile.role, 'admin', 'admin_b role');
    check(local.profile.region_id !== crossLocal.profile.region_id, 'Cross-region accounts must have different regions.');
    check(`${local.profile.sido} ${local.profile.sigungu}` !== '강원 양구군', 'Generality region must not be Yanggu.');

    const fixture = await selectFixture(pg, local);
    check(Number(fixture.source.year) !== 2024, 'Generality source year must not be 2024.');
    equal(fixture.destination.year, fixture.source.year, 'Generality destination year');
    const baseline = await regionSnapshot(pg, local.profile.region_id);
    const conservedBaseline = amount(baseline.adjusted) + amount(baseline.waiting);
    const crossBefore = (await pg.query(`select
      (select count(*)::integer from public.financial_budget_change_requests where idempotency_key=$1) requests,
      (select count(*)::integer from public.financial_test_uat_project_bootstraps where project_id=$2) bootstraps`,
    [stableUuid('cross-region-write'), fixture.source.id])).rows[0];
    const crossError = await expectRpcError(crossLocal, 'financial_test_uat_create_budget_change_request', {
      p_source_project_id: fixture.source.id,
      p_source_budget_year_id: null,
      p_destinations: [{ destination_type: 'EXISTING_PROJECT',
        destination_project_id: fixture.destination.id, amount: TRANSFER_AMOUNT.toString(),
        note: 'UAT cross-region write must fail' }],
      p_effective_date: runtime.native_start_date,
      p_reason: 'UAT cross-region write denied',
      p_idempotency_key: stableUuid('cross-region-write'),
      p_submit: true,
    }, 'Cross-region budget write');
    equal(crossError.code, '42501', 'Cross-region write SQLSTATE');
    const crossAfter = (await pg.query(`select
      (select count(*)::integer from public.financial_budget_change_requests where idempotency_key=$1) requests,
      (select count(*)::integer from public.financial_test_uat_project_bootstraps where project_id=$2) bootstraps`,
    [stableUuid('cross-region-write'), fixture.source.id])).rows[0];
    equal(crossAfter.requests, crossBefore.requests, 'Cross-region request rollback');
    equal(crossAfter.bootstraps, crossBefore.bootstraps, 'Cross-region bootstrap rollback');

    let sourceBefore = await position(local, fixture.source.id, 'Generality source before');
    let destinationBefore = await position(local, fixture.destination.id, 'Generality destination before');
    const existingCreated = (await pg.query(`select id as request_id,status,0::bigint::text as gap_amount
      from public.financial_budget_change_requests where idempotency_key=$1`,
    [stableUuid('valid-transfer')])).rows[0];
    const created = existingCreated ?? first(await rpc(local, 'financial_test_uat_create_budget_change_request', {
      p_source_project_id: fixture.source.id,
      p_source_budget_year_id: null,
      p_destinations: [{ destination_type: 'EXISTING_PROJECT',
        destination_project_id: fixture.destination.id, amount: TRANSFER_AMOUNT.toString(),
        note: 'UAT generic other region/year existing transfer' }],
      p_effective_date: runtime.native_start_date,
      p_reason: `UAT generic ${fixture.source.year} ${local.profile.sido} ${local.profile.sigungu}`,
      p_idempotency_key: stableUuid('valid-transfer'),
      p_submit: true,
    }, 'Generality request'), 'Generality request');
    check(['SUBMITTED', 'APPROVED', 'APPLIED'].includes(created.status), 'Generality resumable status');
    equal(created.gap_amount, 0, 'Generality request gap');
    const dbPending = Number((await pg.query(`select count(*)::integer as value
      from public.financial_budget_change_requests where status='SUBMITTED'`)).rows[0].value);
    const adminPending = await rpc(adminA, 'get_financial_budget_change_requests', {
      p_project_id: null, p_status: 'SUBMITTED', p_year: null, p_region_id: null,
    }, 'Generality admin pending queue');
    equal(adminPending.length, dbPending, 'DB pending request/Admin queue');
    const adminAll = await rpc(adminA, 'get_financial_budget_change_requests', {
      p_project_id: null, p_status: null, p_year: fixture.source.year, p_region_id: local.profile.region_id,
    }, 'Generality admin queue');
    const queued = adminAll.find((row) => row.id === created.request_id);
    check(queued, 'Admin queue omitted generality request.');
    equal(queued.source_project_code, fixture.source.project_code, 'Generality queue source');
    equal(queued.destinations?.[0]?.destination_project_code, fixture.destination.project_code,
      'Generality queue destination');
    equal(queued.destinations?.[0]?.amount, TRANSFER_AMOUNT, 'Generality queue amount');

    if (created.status === 'SUBMITTED') {
      check(adminPending.some((row) => row.id === created.request_id),
        'Submitted generality request is missing from Admin pending queue.');
      const approved = first(await rpc(adminA, 'financial_approve_budget_change_request_group', {
        p_request_id: created.request_id, p_new_project_codes: {},
      }, 'Generality grouped approval'), 'Generality grouped approval');
      equal(approved.status, 'APPROVED', 'Generality approved status');
    }
    const applied = first(await rpc(adminB, 'financial_apply_budget_change_request', {
      p_request_id: created.request_id,
    }, 'Generality APPLY'), 'Generality APPLY');
    equal(applied.status, 'APPLIED', 'Generality applied status');
    equal(applied.gap_amount, 0, 'Generality APPLY gap');
    const snapshots = await exactSnapshots(pg, created.request_id);
    sourceBefore = snapshotPosition(snapshots.SOURCE, 'before');
    destinationBefore = snapshotPosition(snapshots.DESTINATION, 'before');
    const sourceAfter = snapshotPosition(snapshots.SOURCE, 'after');
    const destinationAfter = snapshotPosition(snapshots.DESTINATION, 'after');
    equal(sourceAfter.original_allocation, sourceBefore.original_allocation, 'Generality source original');
    equal(amount(sourceAfter.decrease_amount) - amount(sourceBefore.decrease_amount), TRANSFER_AMOUNT,
      'Generality source decrease');
    equal(amount(sourceBefore.adjusted_allocation) - amount(sourceAfter.adjusted_allocation), TRANSFER_AMOUNT,
      'Generality source adjusted');
    equal(sourceAfter.execution_amount, sourceBefore.execution_amount, 'Generality source execution');
    equal(destinationAfter.original_allocation, destinationBefore.original_allocation, 'Generality destination original');
    equal(amount(destinationAfter.increase_amount) - amount(destinationBefore.increase_amount), TRANSFER_AMOUNT,
      'Generality destination increase');
    equal(amount(destinationAfter.adjusted_allocation) - amount(destinationBefore.adjusted_allocation), TRANSFER_AMOUNT,
      'Generality destination adjusted');
    equal(destinationAfter.execution_amount, destinationBefore.execution_amount, 'Generality destination execution');

    const beforeDuplicate = (await pg.query(`select
      (select count(*)::integer from public.project_fund_transfers) transfers,
      (select count(*)::integer from public.financial_project_decrease_classifications) classifications,
      (select count(*)::integer from public.financial_budget_workflow_amount_snapshots) snapshots`)).rows[0];
    const duplicate = first(await rpc(adminB, 'financial_apply_budget_change_request', {
      p_request_id: created.request_id,
    }, 'Generality duplicate APPLY'), 'Generality duplicate APPLY');
    equal(duplicate.status, 'APPLIED', 'Generality duplicate status');
    equal(duplicate.gap_amount, 0, 'Generality duplicate gap');
    const afterDuplicate = (await pg.query(`select
      (select count(*)::integer from public.project_fund_transfers) transfers,
      (select count(*)::integer from public.financial_project_decrease_classifications) classifications,
      (select count(*)::integer from public.financial_budget_workflow_amount_snapshots) snapshots`)).rows[0];
    equal(afterDuplicate.transfers, beforeDuplicate.transfers, 'Duplicate APPLY transfer count');
    equal(afterDuplicate.classifications, beforeDuplicate.classifications, 'Duplicate APPLY classification count');
    equal(afterDuplicate.snapshots, beforeDuplicate.snapshots, 'Duplicate APPLY snapshot count');

    const history = await Promise.all([
      rpc(local, 'get_financial_budget_change_requests', { p_project_id: fixture.source.id,
        p_status: 'APPLIED', p_year: fixture.source.year, p_region_id: local.profile.region_id }, 'Source history'),
      rpc(local, 'get_financial_budget_change_requests', { p_project_id: fixture.destination.id,
        p_status: 'APPLIED', p_year: fixture.source.year, p_region_id: local.profile.region_id }, 'Destination history'),
    ]);
    check(history.every((rows) => rows.some((row) => row.id === created.request_id)),
      'Generality counterpart history is missing.');
    const crossRead = await expectRpcError(local, 'get_financial_budget_change_requests', {
      p_project_id: null, p_status: null, p_year: null, p_region_id: crossLocal.profile.region_id,
    }, 'Cross-region history read');
    equal(crossRead.code, '42501', 'Cross-region read SQLSTATE');

    await Promise.allSettled([local.client.auth.signOut(), adminA.client.auth.signOut()]);
    const [freshLocal, freshAdmin] = await Promise.all([
      signIn(supabaseUrl, anonKey, required(env, 'UAT_LOCAL_B_EMAIL'), required(env, 'UAT_LOCAL_B_PASSWORD'), 'local_b fresh'),
      signIn(supabaseUrl, anonKey, required(env, 'UAT_ADMIN_A_EMAIL'), required(env, 'UAT_ADMIN_A_PASSWORD'), 'admin_a fresh'),
    ]);
    const [freshLocalSource, freshAdminSource, freshLocalDestination, freshAdminDestination] = await Promise.all([
      position(freshLocal, fixture.source.id, 'Fresh local source'),
      position(freshAdmin, fixture.source.id, 'Fresh admin source'),
      position(freshLocal, fixture.destination.id, 'Fresh local destination'),
      position(freshAdmin, fixture.destination.id, 'Fresh admin destination'),
    ]);
    for (const field of ['original_allocation', 'increase_amount', 'decrease_amount', 'adjusted_allocation',
      'execution_amount', 'unexecuted_amount', 'execution_rate']) {
      equal(freshLocalSource[field], freshAdminSource[field], `Fresh source ${field}`);
      equal(freshLocalDestination[field], freshAdminDestination[field], `Fresh destination ${field}`);
    }
    const final = await regionSnapshot(pg, local.profile.region_id);
    equal(amount(final.adjusted) + amount(final.waiting), conservedBaseline, 'Generality region conservation');
    equal(final.execution, baseline.execution, 'Generality region execution');
    const integrity = (await pg.query(`select
      (select count(*)::integer from public.financial_funding_invariant_check
       where cohort_conservation_gap<>0 or decrease_resolution_gap<>0) invariant_gaps,
      (select count(*)::integer from (
        select requests.id from public.financial_budget_change_requests requests
        join public.financial_budget_change_request_lines lines on lines.request_id=requests.id
        where requests.id=$1 group by requests.id, requests.total_amount
        having requests.total_amount<>sum(lines.amount)) gaps) request_gaps`,
    [created.request_id])).rows[0];
    equal(integrity.invariant_gaps, 0, 'Generality invariant gaps');
    equal(integrity.request_gaps, 0, 'Generality request gaps');

    process.stdout.write(`${JSON.stringify({
      status: 'PASS', target: 'TEST', project_ref: TEST_REF, production_touched: false,
      region: `${local.profile.sido} ${local.profile.sigungu}`, fiscal_year: fixture.source.year,
      amount: TRANSFER_AMOUNT.toString(), request_id: created.request_id,
      source: { code: fixture.source.project_code, name: fixture.source.project_name,
        before: sourceBefore, after: sourceAfter },
      destination: { code: fixture.destination.project_code, name: fixture.destination.project_name,
        before: destinationBefore, after: destinationAfter },
      queue: { db_pending_request: dbPending, admin_queue: adminPending.length,
        request_visible_in_admin_queue: true, resumed_from_status: created.status },
      rls: { cross_region_write: 'BLOCKED', sqlstate: crossError.code,
        request_rows_created: Number(crossAfter.requests) - Number(crossBefore.requests),
        bootstrap_rows_created: Number(crossAfter.bootstraps) - Number(crossBefore.bootstraps),
        cross_region_read: 'BLOCKED' },
      duplicate_apply: { status: 'PASS', counts_before: beforeDuplicate, counts_after: afterDuplicate },
      fresh_read: { local_admin_identical: true },
      history_counterpart: 'PASS', monetary_gap: (amount(final.adjusted) + amount(final.waiting) - conservedBaseline).toString(),
      integrity, region_before: baseline, region_after: final,
    }, null, 2)}\n`);
    await Promise.allSettled([freshLocal.client.auth.signOut(), freshAdmin.client.auth.signOut()]);
  } finally {
    await Promise.allSettled([local.client.auth.signOut(), crossLocal.client.auth.signOut(),
      adminA.client.auth.signOut(), adminB.client.auth.signOut()]);
    await pg.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`GENERIC BUDGET GENERALITY UAT FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
