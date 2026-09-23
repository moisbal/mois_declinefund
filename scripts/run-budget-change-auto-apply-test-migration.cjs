#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const VERSION = '20260911000100';
const SQL_PATH = path.resolve(
  process.cwd(),
  'supabase/migrations/20260911000100_budget_change_auto_apply_and_destination_correction.sql',
);
const TABLES = [
  'financial_workflow_settings',
  'financial_workflow_setting_events',
  'financial_budget_change_destination_corrections',
];
const FUNCTIONS = [
  'financial_set_budget_change_auto_apply(boolean,text)',
  'get_financial_budget_change_workflow_mode()',
  'financial_correct_budget_change_destination(uuid,uuid,text,date,uuid)',
  'get_financial_budget_change_destination_states(uuid)',
];

function fail(message) { throw new Error(message); }
function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
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
function migrationBody(sql) {
  const begin = sql.match(/^[ \t]*begin;[ \t]*\r?$/im);
  const commits = [...sql.matchAll(/^[ \t]*commit;[ \t]*\r?$/gim)];
  if (!begin || commits.length !== 1) fail('Migration must contain one outer transaction.');
  const commit = commits[0];
  if (begin.index >= commit.index || sql.slice(commit.index + commit[0].length).trim()) {
    fail('Migration outer transaction is malformed.');
  }
  return `${sql.slice(0, begin.index)}${sql.slice(begin.index + begin[0].length, commit.index)}`;
}

async function openClient(databaseUrl, action) {
  const client = new Client({
    connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
    application_name: `budget-change-auto-apply-${VERSION}-${action}`,
  });
  await client.connect();
  return client;
}

async function snapshot(client) {
  const result = await client.query(`select
    (select concat_ws(':', environment_kind, mode, bound_project_ref)
      from public.financial_ledger_runtime where singleton = true) runtime,
    (select concat_ws(':', count(*)::text,
      coalesce(sum(total_budget),0)::text, coalesce(sum(original_alloc),0)::text,
      coalesce(sum(increase_amount),0)::text, coalesce(sum(decrease_amount),0)::text,
      coalesce(sum(alloc),0)::text, coalesce(sum(exec),0)::text)
      from public.projects) projects,
    (select concat_ws(':', count(*)::text, coalesce(sum(amount),0)::text)
      from public.project_fund_transfers) transfers,
    (select concat_ws(':', count(*)::text, coalesce(sum(original_amount),0)::text)
      from public.financial_unallocated_fund_lots) lots,
    (select concat_ws(':', count(*)::text, coalesce(sum(amount),0)::text)
      from public.financial_unallocated_fund_movements) movements,
    (select concat_ws(':', count(*)::text, coalesce(sum(amount),0)::text)
      from public.financial_project_decrease_classifications) classifications,
    (select count(*)::text from public.financial_budget_change_requests) budget_requests,
    (select count(*)::text from public.financial_pending_new_project_link_requests) pending_links,
    (select count(*)::text from public.audit_logs) audit_logs`);
  return result.rows[0];
}

async function definitionState(client) {
  const result = await client.query(`select
    pg_get_functiondef('public.financial_apply_budget_change_request(uuid)'::regprocedure)
      as budget_apply,
    pg_get_functiondef('public.financial_apply_pending_new_project_link(uuid)'::regprocedure)
      as pending_apply`);
  return result.rows[0];
}

async function installState(client) {
  const result = await client.query(`select
    to_regclass('public.financial_workflow_settings') is not null as settings_table,
    to_regclass('public.financial_workflow_setting_events') is not null as events_table,
    to_regclass('public.financial_budget_change_destination_corrections') is not null
      as corrections_table,
    exists (select 1 from information_schema.columns
      where table_schema='public' and table_name='financial_budget_change_requests'
        and column_name='approval_mode') as budget_approval_mode,
    exists (select 1 from information_schema.columns
      where table_schema='public' and table_name='financial_pending_new_project_link_requests'
        and column_name='approval_mode') as pending_approval_mode`);
  return result.rows[0];
}

function isInstalled(state) {
  return Object.values(state).some((value) => value === true);
}

async function assertPostconditions(client) {
  const state = await installState(client);
  if (Object.values(state).some((value) => value !== true)) {
    fail('One or more automatic-apply schema objects are missing.');
  }
  const settings = await client.query(`select count(*)::integer as row_count,
      bool_and(singleton and budget_change_auto_apply) as enabled
    from public.financial_workflow_settings`);
  if (settings.rows[0]?.row_count !== 1 || settings.rows[0]?.enabled !== true) {
    fail('Automatic-apply singleton setting was not initialized safely.');
  }
  const definitions = await definitionState(client);
  if (!definitions.budget_apply.includes('app.financial_budget_change_auto_request_id')
      || !definitions.budget_apply.includes("approval_mode = 'AUTO'")
      || !definitions.pending_apply.includes('app.financial_pending_link_auto_request_id')
      || !definitions.pending_apply.includes("approval_mode = 'AUTO'")) {
    fail('Existing apply functions were not patched with the transaction-local safety gate.');
  }
  const tables = await client.query(`select requested.name,
      classes.relrowsecurity as rls_enabled,
      (select count(*)::integer from pg_policies
        where schemaname='public' and tablename=requested.name) as policy_count,
      has_table_privilege('authenticated', 'public.' || requested.name, 'SELECT') as auth_select,
      (has_table_privilege('authenticated', 'public.' || requested.name, 'INSERT')
        or has_table_privilege('authenticated', 'public.' || requested.name, 'UPDATE')
        or has_table_privilege('authenticated', 'public.' || requested.name, 'DELETE')) as auth_write,
      has_table_privilege('anon', 'public.' || requested.name, 'SELECT') as anon_select
    from unnest($1::text[]) as requested(name)
    join pg_class as classes on classes.oid=('public.' || requested.name)::regclass`, [TABLES]);
  if (tables.rows.some((row) => row.rls_enabled !== true || row.policy_count < 1
      || row.auth_select !== true || row.auth_write === true || row.anon_select === true)) {
    fail('Automatic-apply table RLS or grants are not fail-closed.');
  }
  const functions = await client.query(`select requested.signature,
      to_regprocedure('public.' || requested.signature) is not null as present,
      has_function_privilege('authenticated', 'public.' || requested.signature, 'EXECUTE')
        as auth_execute,
      has_function_privilege('anon', 'public.' || requested.signature, 'EXECUTE')
        as anon_execute
    from unnest($1::text[]) as requested(signature)`, [FUNCTIONS]);
  if (functions.rows.some((row) => row.present !== true
      || row.auth_execute !== true || row.anon_execute === true)) {
    fail('Automatic-apply RPC grants are incomplete or exposed to anonymous users.');
  }
  return {
    settings_enabled: true,
    rls_table_count: tables.rows.length,
    authenticated_rpc_count: functions.rows.length,
    transaction_local_apply_gate: true,
  };
}

async function main() {
  const action = arg('--action');
  if (!['validate', 'apply'].includes(action)) fail('--action must be validate or apply.');
  if (action === 'apply' && !process.argv.includes('--confirm-test-write')) {
    fail('TEST apply requires --confirm-test-write.');
  }
  const envFile = arg('--env-file');
  const resolvedEnv = path.resolve(process.cwd(), envFile ?? '');
  if (!envFile || !fs.existsSync(resolvedEnv) || !fs.existsSync(SQL_PATH)) {
    fail('Migration or explicit TEST env file is missing.');
  }
  const env = dotenv.parse(fs.readFileSync(resolvedEnv));
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '').trim();
  const prodRef = String(env.PROD_PROJECT_REF ?? '').trim();
  if (String(env.TARGET_ENV ?? '').toUpperCase() !== 'TEST'
      || env.TEST_PROJECT_REF !== TEST_REF
      || !prodRef || prodRef === TEST_REF
      || refFromUrl(env.NEXT_PUBLIC_SUPABASE_URL ?? '') !== TEST_REF
      || refFromDatabase(databaseUrl) !== TEST_REF
      || refFromDatabase(databaseUrl) === prodRef) {
    fail('Fail-closed target gate rejected configuration.');
  }

  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const sha256 = crypto.createHash('sha256').update(sql).digest('hex');
  const client = await openClient(databaseUrl, action);
  let transaction = false;
  try {
    const before = await snapshot(client);
    if (before.runtime !== `TEST:TEST:${TEST_REF}`) fail('TEST runtime is not active.');
    const originalDefinitions = await definitionState(client);
    if (isInstalled(await installState(client))) {
      fail('Automatic-apply migration is already present; duplicate apply refused.');
    }
    await client.query('begin');
    transaction = true;
    const lock = await client.query(
      `select pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
        'budget-change-auto-apply-${VERSION}', ${VERSION})) as locked`,
    );
    if (lock.rows[0]?.locked !== true) fail('Another TEST migration is running.');
    await client.query("set local lock_timeout='10s'");
    await client.query("set local statement_timeout='240s'");
    await client.query(migrationBody(sql));
    const checks = await assertPostconditions(client);
    if (JSON.stringify(await snapshot(client)) !== JSON.stringify(before)) {
      fail('Migration changed TEST business rows, money, or audit history.');
    }

    if (action === 'validate') {
      await client.query('rollback');
      transaction = false;
      const verify = await openClient(databaseUrl, 'rollback-proof');
      try {
        if (isInstalled(await installState(verify))) {
          fail('Rollback proof failed: automatic-apply objects remain.');
        }
        if (JSON.stringify(await snapshot(verify)) !== JSON.stringify(before)
            || JSON.stringify(await definitionState(verify)) !== JSON.stringify(originalDefinitions)) {
          fail('Rollback proof failed: TEST data or existing functions changed.');
        }
      } finally {
        await verify.end();
      }
      process.stdout.write(`${JSON.stringify({
        ok: true,
        target: 'TEST',
        production_touched: false,
        action,
        transaction: 'ROLLED_BACK',
        migration_version: VERSION,
        migration_sha256: sha256,
        business_rows_unchanged: true,
        rollback_proof: true,
        checks,
      }, null, 2)}\n`);
      return;
    }

    await client.query('commit');
    transaction = false;
    process.stdout.write(`${JSON.stringify({
      ok: true,
      target: 'TEST',
      production_touched: false,
      action,
      transaction: 'COMMITTED',
      migration_version: VERSION,
      migration_sha256: sha256,
      business_rows_unchanged: true,
      checks,
    }, null, 2)}\n`);
  } finally {
    if (transaction) await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
