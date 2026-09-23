'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';
const SAVE_SIGNATURE =
  'public.financial_test_uat_save_budget_change_request(uuid,uuid,jsonb,date,text,uuid,boolean)';

function fail(message) { throw new Error(message); }
function load(file) {
  const resolved = path.resolve(process.cwd(), file ?? '');
  if (!file || !fs.existsSync(resolved)) fail(`Missing explicit file: ${file ?? '(none)'}`);
  return dotenv.parse(fs.readFileSync(resolved));
}
function required(env, key) {
  const value = String(env[key] ?? '').trim();
  if (!value) fail(`${key} is required.`);
  return value;
}
function projectRef(value, database = false) {
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

async function main() {
  const env = load(process.argv[2]);
  const credentials = load(process.argv[3]);
  const supabaseUrl = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  if (env.TARGET_ENV !== 'TEST' || env.TEST_PROJECT_REF !== TEST_REF
      || env.PROD_PROJECT_REF !== PROD_REF || projectRef(supabaseUrl) !== TEST_REF
      || projectRef(databaseUrl, true) !== TEST_REF || projectRef(databaseUrl, true) === PROD_REF) {
    fail('Fail-closed TEST target gate rejected configuration.');
  }

  const admin = createClient(supabaseUrl, required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authError } = await admin.auth.signInWithPassword({
    email: required(credentials, 'UAT_ADMIN_A_EMAIL'),
    password: required(credentials, 'UAT_ADMIN_A_PASSWORD'),
  });
  if (authError || !auth.user) fail('TEST admin_a authentication failed.');
  const { data: pending, error: pendingError } = await admin.rpc(
    'get_financial_budget_change_requests',
    { p_project_id: null, p_status: 'SUBMITTED', p_year: null, p_region_id: null },
  );
  if (pendingError) fail(`Authenticated admin queue failed: ${pendingError.message}`);

  const pg = new Client({
    connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    application_name: 'audit-budget-adjustment-final-test',
  });
  await pg.connect();
  try {
    await pg.query('begin read only');
    const runtime = (await pg.query(`select environment_kind, mode, bound_project_ref
      from public.financial_ledger_runtime where singleton=true`)).rows[0];
    const migrations = (await pg.query(`select
      to_regprocedure('public.financial_create_budget_change_request(uuid,jsonb,date,text,uuid,boolean)')
        is not null generic_engine_ready,
      to_regprocedure($1) is not null draft_upsert_ready`, [SAVE_SIGNATURE])).rows[0];
    const security = (await pg.query(`select
      has_function_privilege('authenticated', $1, 'EXECUTE') authenticated_execute,
      exists(select 1
        from pg_proc p
        cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        left join pg_roles roles on roles.oid=acl.grantee
        where p.oid=to_regprocedure($1)
          and acl.privilege_type='EXECUTE' and acl.grantee=0) public_execute,
      exists(select 1
        from pg_proc p
        cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        join pg_roles roles on roles.oid=acl.grantee
        where p.oid=to_regprocedure($1)
          and acl.privilege_type='EXECUTE' and roles.rolname='anon') anon_execute`,
    [SAVE_SIGNATURE])).rows[0];
    const integrity = (await pg.query(`select
      (select count(*)::integer from public.financial_budget_change_requests
        where status='SUBMITTED') db_pending_requests,
      (select count(*)::integer from public.financial_budget_change_requests
        where status in ('DRAFT','APPROVED')) active_nonqueue_requests,
      (select count(*)::integer from (
        select requests.id from public.financial_budget_change_requests requests
        left join public.financial_budget_change_request_lines lines on lines.request_id=requests.id
        group by requests.id,requests.total_amount
        having requests.total_amount<>coalesce(sum(lines.amount),0)) gaps) request_gaps,
      (select count(*)::integer from public.financial_funding_invariant_check
        where cohort_conservation_gap<>0 or decrease_resolution_gap<>0) invariant_gaps,
      (select count(*)::integer from public.financial_budget_change_request_lines lines
        join public.financial_budget_change_requests requests on requests.id=lines.request_id
        where requests.status='APPLIED' and (
          (lines.destination_type='EXISTING_PROJECT' and lines.materialized_transfer_id is null)
          or (lines.destination_type='PENDING_NEW_PROJECT' and lines.materialized_lot_id is null)
        )) partial_apply_lines,
      (select count(*)::integer from (
        select adjustment_fingerprint from public.financial_budget_change_requests
        where status in ('SUBMITTED','APPROVED','APPLIED') and duplicate_of_request_id is null
        group by adjustment_fingerprint having count(*)>1) duplicates) active_canonical_duplicates,
      (select count(*)::integer from public.financial_budget_change_requests
        where status in ('SUBMITTED','APPROVED') and duplicate_of_request_id is not null)
        active_duplicate_requests`)).rows[0];
    await pg.query('commit');

    const adminPending = Array.isArray(pending) ? pending.length : 0;
    const pass = runtime?.environment_kind === 'TEST'
      && runtime?.bound_project_ref === TEST_REF
      && Object.values(migrations).every(Boolean)
      && security.authenticated_execute === true
      && security.public_execute === false
      && security.anon_execute === false
      && Number(integrity.db_pending_requests) === adminPending
      && Number(integrity.active_nonqueue_requests) === 0
      && Number(integrity.request_gaps) === 0
      && Number(integrity.invariant_gaps) === 0
      && Number(integrity.partial_apply_lines) === 0
      && Number(integrity.active_canonical_duplicates) === 0
      && Number(integrity.active_duplicate_requests) === 0;
    if (!pass) fail('Final TEST audit found a failed gate.');
    process.stdout.write(`${JSON.stringify({
      status: 'PASS', target: 'TEST', project_ref: TEST_REF,
      production_touched: false, runtime, migrations, security,
      queue: { db_pending_requests: integrity.db_pending_requests, admin_queue: adminPending },
      integrity,
    }, null, 2)}\n`);
  } finally {
    await pg.query('rollback').catch(() => undefined);
    await pg.end().catch(() => undefined);
    await admin.auth.signOut().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`FINAL TEST AUDIT FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
