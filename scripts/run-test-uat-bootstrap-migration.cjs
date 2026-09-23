#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const VERSION = '20260827000300';
const SQL_PATH = path.resolve(process.cwd(), 'supabase/migrations', `${VERSION}_test_uat_on_demand_budget_bootstrap.sql`);

function fail(message) { throw new Error(message); }
function arg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function has(name) { return process.argv.includes(name); }
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
function body(sql) {
  const begin = sql.match(/^[ \t]*begin;[ \t]*\r?$/im);
  const commit = [...sql.matchAll(/^[ \t]*commit;[ \t]*\r?$/gim)];
  if (!begin || commit.length !== 1) fail('Migration must contain one outer transaction.');
  return `${sql.slice(0, begin.index)}${sql.slice(begin.index + begin[0].length, commit[0].index)}`;
}
async function snapshot(client) {
  const result = await client.query(`select
    (select environment_kind || ':' || mode || ':' || bound_project_ref from public.financial_ledger_runtime) as runtime,
    (select count(*)::text || ':' || coalesce(sum(original_alloc),0)::text || ':' || coalesce(sum(increase_amount),0)::text || ':' || coalesce(sum(decrease_amount),0)::text || ':' || coalesce(sum(alloc),0)::text || ':' || coalesce(sum(exec),0)::text from public.projects) as projects,
    (select count(*)::text || ':' || coalesce(sum(initial_allocation),0)::text from public.project_budget_cohorts) as cohorts,
    (select count(*)::text from public.project_budget_years) as wallets,
    (select count(*)::text || ':' || coalesce(sum(amount),0)::text from public.project_execution_records) as executions,
    (select count(*)::text || ':' || coalesce(sum(amount),0)::text from public.project_fund_transfers) as transfers,
    (select count(*)::text from public.financial_budget_change_requests) as requests`);
  return result.rows[0];
}

async function main() {
  const action = arg('--action');
  if (!['validate', 'apply'].includes(action)) fail('--action must be validate or apply.');
  if (action === 'apply' && !has('--confirm-test-write')) fail('TEST apply requires --confirm-test-write.');
  const envFile = arg('--env-file');
  const resolved = path.resolve(process.cwd(), envFile ?? '');
  if (!envFile || !fs.existsSync(resolved)) fail('Explicit TEST env file is required.');
  const env = dotenv.parse(fs.readFileSync(resolved));
  const testRef = String(env.TEST_PROJECT_REF ?? '').trim();
  const prodRef = String(env.PROD_PROJECT_REF ?? '').trim();
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '').trim();
  if (String(env.TARGET_ENV ?? '').toUpperCase() !== 'TEST' || testRef !== TEST_REF || testRef === prodRef
      || refFromUrl(env.NEXT_PUBLIC_SUPABASE_URL ?? '') !== testRef
      || refFromDatabase(databaseUrl) !== testRef || refFromDatabase(databaseUrl) === prodRef) {
    fail('Fail-closed target gate rejected configuration.');
  }

  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const sha = crypto.createHash('sha256').update(sql).digest('hex');
  const client = new Client({ connectionString: connectionString(databaseUrl), ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000, application_name: `test-uat-bootstrap-${action}` });
  await client.connect();
  let transaction = false;
  try {
    const before = await snapshot(client);
    await client.query('begin'); transaction = true;
    await client.query("set local statement_timeout = '120s'");
    await client.query(body(sql));
    const postcondition = await client.query(`select
      to_regclass('public.financial_test_uat_project_bootstraps') is not null as has_table,
      to_regprocedure('public.financial_test_uat_bootstrap_project(uuid)') is not null as has_bootstrap,
      to_regprocedure('public.financial_test_uat_create_budget_change_request(uuid,uuid,jsonb,date,text,uuid,boolean)') is not null as has_create,
      (select count(*) from public.financial_test_uat_project_bootstraps) as bootstrap_count,
      pg_get_functiondef('public.financial_apply_budget_change_request(uuid)'::regprocedure) like '%financial_test_uat_bootstrap_project%' as apply_bootstraps_destination`);
    const check = postcondition.rows[0];
    if (!check?.has_table || !check.has_bootstrap || !check.has_create
        || Number(check.bootstrap_count) !== 0 || !check.apply_bootstraps_destination) {
      fail('TEST UAT bootstrap migration postcondition failed.');
    }
    if (JSON.stringify(await snapshot(client)) !== JSON.stringify(before)) {
      fail('Migration changed TEST monetary data before any UAT action.');
    }
    if (action === 'validate') {
      await client.query('rollback'); transaction = false;
    } else {
      await client.query('commit'); transaction = false;
    }
    process.stdout.write(`${JSON.stringify({ ok: true, target: 'TEST', production_touched: false, action,
      transaction: action === 'validate' ? 'ROLLED_BACK' : 'COMMITTED', migration_version: VERSION,
      migration_sha256: sha, bootstrap_count: 0, monetary_unchanged: true }, null, 2)}\n`);
  } finally {
    if (transaction) await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
