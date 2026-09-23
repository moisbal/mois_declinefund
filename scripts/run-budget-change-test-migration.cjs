#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const VERSION = '20260826000600';
const MIGRATION_PATH = path.resolve(
  process.cwd(),
  'supabase',
  'migrations',
  `${VERSION}_budget_change_workflow_delta.sql`,
);
const TABLES = [
  'financial_budget_change_requests',
  'financial_budget_change_request_lines',
  'financial_pending_new_project_funds',
  'financial_pending_new_project_link_requests',
];
const FUNCTIONS = [
  'financial_create_budget_change_request(uuid,jsonb,date,text,uuid,boolean)',
  'financial_submit_budget_change_request(uuid)',
  'financial_approve_budget_change_request(uuid)',
  'financial_reject_budget_change_request(uuid,text)',
  'financial_apply_budget_change_request(uuid)',
  'financial_request_pending_new_project_link(uuid,uuid,uuid)',
  'financial_review_pending_new_project_link(uuid,text,text)',
  'financial_apply_pending_new_project_link(uuid)',
  'get_financial_budget_change_candidates(uuid,text,integer,boolean)',
  'get_financial_budget_change_requests(uuid,text,integer,uuid)',
  'get_financial_pending_new_project_funds(text,integer,uuid)',
  'get_financial_pending_new_project_link_requests(text)',
  'get_financial_budget_change_project_position(uuid)',
  'get_financial_budget_change_statistics(integer,uuid)',
  'get_financial_budget_change_statistics_filtered(integer,text,text)',
];

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--confirm-test-write') {
      result.confirm = true;
      continue;
    }
    if (!['--env-file', '--action'].includes(key)) fail(`Unknown argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`${key} requires a value.`);
    result[key.slice(2).replace('-', '_')] = value;
    index += 1;
  }
  if (!['validate', 'apply'].includes(result.action)) fail('--action must be validate or apply.');
  if (!result.env_file) fail('--env-file is required.');
  if (result.action === 'apply' && result.confirm !== true) {
    fail('TEST apply requires --confirm-test-write.');
  }
  return {
    action: result.action,
    envFile: path.resolve(process.cwd(), result.env_file),
  };
}

function refFromPublicUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase().match(/^([a-z0-9-]+)\.supabase\.co$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function refFromDatabaseUrl(value) {
  try {
    const url = new URL(value);
    const username = decodeURIComponent(url.username);
    return url.hostname.toLowerCase().match(/^db\.([a-z0-9-]+)\.supabase\.co$/)?.[1]
      ?? username.match(/^postgres\.([a-z0-9-]+)$/)?.[1]
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

function stripOuterTransaction(sql) {
  const begin = sql.match(/^[ \t]*begin;[ \t]*\r?$/im);
  const commits = [...sql.matchAll(/^[ \t]*commit;[ \t]*\r?$/gim)];
  if (!begin || commits.length !== 1) fail('Migration must contain one outer BEGIN/COMMIT pair.');
  const commit = commits[0];
  if (begin.index >= commit.index || sql.slice(commit.index + commit[0].length).trim()) {
    fail('Migration outer transaction is malformed.');
  }
  return `${sql.slice(0, begin.index)}${sql.slice(begin.index + begin[0].length, commit.index)}`;
}

async function openClient(databaseUrl, label) {
  const client = new Client({
    connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
    application_name: `budget-change-${label}`,
  });
  await client.connect();
  return client;
}

async function snapshot(client) {
  const [runtime, monetary, ledger] = await Promise.all([
    client.query(`select environment_kind, mode, bound_project_ref,
      baseline_as_of::text, native_start_date::text
      from public.financial_ledger_runtime where singleton = true`),
    client.query(`select count(*)::bigint::text as project_count,
      coalesce(sum(total_budget),0)::numeric::text as total_budget,
      coalesce(sum(original_alloc),0)::numeric::text as original_alloc,
      coalesce(sum(increase_amount),0)::numeric::text as increase_amount,
      coalesce(sum(decrease_amount),0)::numeric::text as decrease_amount,
      coalesce(sum(alloc),0)::numeric::text as alloc,
      coalesce(sum(exec),0)::numeric::text as exec
      from public.projects`),
    client.query(`select
      (select count(*)::bigint::text from public.project_fund_transfers) as transfers,
      (select count(*)::bigint::text from public.financial_unallocated_fund_lots) as lots,
      (select count(*)::bigint::text from public.financial_unallocated_fund_movements) as movements,
      (select count(*)::bigint::text from public.financial_project_decrease_classifications) as classifications,
      (select coalesce(sum(amount),0)::numeric::text from public.project_fund_transfers) as transfer_amount,
      (select coalesce(sum(original_amount),0)::numeric::text from public.financial_unallocated_fund_lots) as lot_amount`),
  ]);
  return {
    runtime: runtime.rows[0] ?? null,
    monetary: monetary.rows[0],
    ledger: ledger.rows[0],
  };
}

async function objectState(client) {
  const tables = await client.query(`select requested.name,
      to_regclass('public.' || requested.name) is not null as present
    from unnest($1::text[]) as requested(name)`, [TABLES]);
  const functions = await client.query(`select requested.signature,
      to_regprocedure('public.' || requested.signature) is not null as present
    from unnest($1::text[]) as requested(signature)`, [FUNCTIONS]);
  return { tables: tables.rows, functions: functions.rows };
}

function assertRuntime(runtime, testRef) {
  if (!runtime || runtime.environment_kind !== 'TEST' || runtime.bound_project_ref !== testRef) {
    fail('Database runtime is not bound to the approved TEST project.');
  }
}

async function postChecks(client, before, testRef) {
  const after = await snapshot(client);
  assertRuntime(after.runtime, testRef);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    fail('Schema delta changed runtime or monetary rows.');
  }
  const state = await objectState(client);
  if (state.tables.some((row) => row.present !== true)
      || state.functions.some((row) => row.present !== true)) {
    fail('One or more budget-change objects are missing.');
  }
  const rls = await client.query(`select requested.name,
      classes.relrowsecurity as enabled, classes.relforcerowsecurity as forced,
      (select count(*)::integer from pg_policies
        where schemaname = 'public' and tablename = requested.name) as policy_count,
      has_table_privilege('authenticated', 'public.' || requested.name, 'SELECT') as auth_select,
      (has_table_privilege('authenticated', 'public.' || requested.name, 'INSERT')
        or has_table_privilege('authenticated', 'public.' || requested.name, 'UPDATE')
        or has_table_privilege('authenticated', 'public.' || requested.name, 'DELETE')) as auth_write,
      has_table_privilege('anon', 'public.' || requested.name, 'SELECT') as anon_select
    from unnest($1::text[]) as requested(name)
    join pg_class as classes on classes.oid = ('public.' || requested.name)::regclass`, [TABLES]);
  if (rls.rows.some((row) => row.enabled !== true || row.forced !== true
      || row.policy_count !== 1 || row.auth_select !== true
      || row.auth_write === true || row.anon_select === true)) {
    fail('Budget-change table RLS or privileges are not fail-closed.');
  }
  const privileges = await client.query(`select requested.signature,
      has_function_privilege('authenticated', 'public.' || requested.signature, 'EXECUTE') as auth_execute,
      has_function_privilege('anon', 'public.' || requested.signature, 'EXECUTE') as anon_execute
    from unnest($1::text[]) as requested(signature)`, [FUNCTIONS]);
  if (privileges.rows.some((row) => row.auth_execute !== true || row.anon_execute === true)) {
    fail('Budget-change RPC privileges are incomplete or exposed to anonymous users.');
  }
  return {
    monetary_unchanged: true,
    rls_table_count: rls.rows.length,
    authenticated_rpc_count: privileges.rows.length,
    mode: after.runtime.mode,
  };
}

async function main() {
  const { action, envFile } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(envFile)) fail('Explicit TEST env file does not exist.');
  if (!fs.existsSync(MIGRATION_PATH)) fail('Budget-change migration file does not exist.');
  const env = dotenv.parse(fs.readFileSync(envFile));
  const testRef = String(env.TEST_PROJECT_REF ?? '').trim();
  const prodRef = String(env.PROD_PROJECT_REF ?? '').trim();
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '').trim();
  const publicRef = refFromPublicUrl(env.NEXT_PUBLIC_SUPABASE_URL ?? '');
  const databaseRef = refFromDatabaseUrl(databaseUrl);
  if (String(env.TARGET_ENV ?? '').trim().toUpperCase() !== 'TEST'
      || testRef !== TEST_REF || !prodRef || prodRef === testRef
      || publicRef !== testRef || databaseRef !== testRef || databaseRef === prodRef) {
    fail('Fail-closed target gate rejected a non-TEST or mismatched configuration.');
  }
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const sha256 = crypto.createHash('sha256').update(sql).digest('hex');
  const body = stripOuterTransaction(sql);
  const client = await openClient(databaseUrl, action);
  let open = false;
  try {
    const before = await snapshot(client);
    assertRuntime(before.runtime, testRef);
    const existing = await objectState(client);
    if (existing.tables.some((row) => row.present) || existing.functions.some((row) => row.present)) {
      fail('Budget-change delta is already present; duplicate apply refused.');
    }
    await client.query('begin');
    open = true;
    const lock = await client.query(
      "select pg_try_advisory_xact_lock(pg_catalog.hashtextextended('budget-change-test-migration', 20260826000600)) as locked",
    );
    if (lock.rows[0]?.locked !== true) fail('Another TEST budget-change migration is running.');
    await client.query("set local lock_timeout = '10s'");
    await client.query("set local statement_timeout = '240s'");
    await client.query(body);
    const checks = await postChecks(client, before, testRef);
    if (action === 'validate') {
      await client.query('rollback');
      open = false;
      const verify = await openClient(databaseUrl, 'rollback-proof');
      try {
        const state = await objectState(verify);
        if (state.tables.some((row) => row.present) || state.functions.some((row) => row.present)) {
          fail('Rollback proof failed: one or more delta objects remain.');
        }
        if (JSON.stringify(await snapshot(verify)) !== JSON.stringify(before)) {
          fail('Rollback proof failed: TEST data changed.');
        }
      } finally {
        await verify.end();
      }
      process.stdout.write(`${JSON.stringify({ ok: true, action, target: 'TEST',
        transaction: 'ROLLED_BACK', migration_version: VERSION, migration_sha256: sha256,
        checks, rollback_proof: true }, null, 2)}\n`);
      return;
    }
    await client.query('commit');
    open = false;
    process.stdout.write(`${JSON.stringify({ ok: true, action, target: 'TEST',
      transaction: 'COMMITTED', migration_version: VERSION, migration_sha256: sha256,
      checks }, null, 2)}\n`);
  } finally {
    if (open) await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
