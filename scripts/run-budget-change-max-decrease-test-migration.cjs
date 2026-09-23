#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';
const VERSION = '20260827000600';
const SQL_PATH = path.resolve(process.cwd(), 'supabase/migrations',
  `${VERSION}_budget_change_max_decrease_and_same_year_guard.sql`);

function fail(message) { throw new Error(message); }
function arg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function has(name) { return process.argv.includes(name); }
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
function migrationBody(sql) {
  const begin = sql.match(/^[ \t]*begin;[ \t]*\r?$/im);
  const commits = [...sql.matchAll(/^[ \t]*commit;[ \t]*\r?$/gim)];
  if (!begin || commits.length !== 1) fail('Migration must contain exactly one outer transaction.');
  return `${sql.slice(0, begin.index)}${sql.slice(begin.index + begin[0].length, commits[0].index)}`;
}
async function snapshot(client) {
  return (await client.query(`select
    (select environment_kind || ':' || mode || ':' || bound_project_ref from public.financial_ledger_runtime) runtime,
    (select count(*)::text || ':' || coalesce(sum(original_alloc),0)::text || ':'
      || coalesce(sum(increase_amount),0)::text || ':' || coalesce(sum(decrease_amount),0)::text || ':'
      || coalesce(sum(alloc),0)::text || ':' || coalesce(sum(exec),0)::text from public.projects) projects,
    (select count(*)::text || ':' || coalesce(sum(amount),0)::text from public.project_fund_transfers) transfers,
    (select count(*)::text || ':' || coalesce(sum(amount),0)::text from public.financial_unallocated_fund_movements) movements,
    (select count(*)::text from public.financial_budget_change_requests) budget_requests,
    (select count(*)::text from public.financial_new_project_requests) new_project_requests,
    (select count(*)::text from public.financial_pending_new_project_link_requests) link_requests`)).rows[0];
}

async function main() {
  const action = arg('--action');
  if (!['validate', 'apply'].includes(action)) fail('--action must be validate or apply.');
  if (action === 'apply' && !has('--confirm-test-write')) fail('TEST apply requires --confirm-test-write.');
  const envFile = arg('--env-file');
  const resolved = path.resolve(process.cwd(), envFile ?? '');
  if (!envFile || !fs.existsSync(resolved) || !fs.existsSync(SQL_PATH)) {
    fail('Explicit TEST env and migration SQL are required.');
  }
  const env = dotenv.parse(fs.readFileSync(resolved));
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '').trim();
  if (String(env.TARGET_ENV ?? '').trim().toUpperCase() !== 'TEST'
      || String(env.TEST_PROJECT_REF ?? '').trim() !== TEST_REF
      || String(env.PROD_PROJECT_REF ?? '').trim() !== PROD_REF
      || refFromUrl(String(env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()) !== TEST_REF
      || refFromDatabase(databaseUrl) !== TEST_REF || refFromDatabase(databaseUrl) === PROD_REF) {
    fail('Fail-closed target gate rejected configuration.');
  }
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const sha = crypto.createHash('sha256').update(sql).digest('hex');
  const client = new Client({ connectionString: connectionString(databaseUrl), ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000, application_name: `budget-max-decrease-${action}` });
  await client.connect();
  let transaction = false;
  try {
    const before = await snapshot(client);
    await client.query('begin'); transaction = true;
    await client.query("set local lock_timeout = '10s'");
    await client.query("set local statement_timeout = '240s'");
    await client.query(migrationBody(sql));
    const definitions = (await client.query(`select
      pg_get_functiondef('public.get_financial_budget_change_candidates(uuid,text,integer,boolean)'::regprocedure) candidate,
      pg_get_functiondef('public.financial_test_uat_create_budget_change_request(uuid,uuid,jsonb,date,text,uuid,boolean)'::regprocedure) create_request,
      pg_get_functiondef('public.financial_validate_budget_change_line_year()'::regprocedure) year_guard`)).rows[0];
    if (!definitions?.candidate.includes('projects.year = v_anchor_year')
        || !definitions.create_request.includes('최대 감액 가능액')
        || !definitions.year_guard.includes('v_destination_year <> v_fiscal_year')) {
      fail('Migration postcondition failed.');
    }
    if (JSON.stringify(await snapshot(client)) !== JSON.stringify(before)) {
      fail('Migration changed TEST monetary or workflow business rows.');
    }
    if (action === 'validate') {
      await client.query('rollback'); transaction = false;
    } else {
      await client.query('commit'); transaction = false;
    }
    process.stdout.write(`${JSON.stringify({ ok: true, target: 'TEST', production_touched: false,
      action, transaction: action === 'validate' ? 'ROLLED_BACK' : 'COMMITTED',
      migration_version: VERSION, migration_sha256: sha, business_rows_unchanged: true }, null, 2)}\n`);
  } finally {
    if (transaction) await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
