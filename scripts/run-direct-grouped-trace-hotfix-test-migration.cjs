#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const VERSION = '20260914000400';
const SQL_PATH = path.resolve(process.cwd(),
  'supabase/migrations/20260914000400_direct_grouped_destination_trace_hotfix.sql');

function fail(message) { throw new Error(message); }
function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
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
async function snapshot(client) {
  return (await client.query(`select
    (select concat_ws(':',environment_kind,mode,bound_project_ref)
      from public.financial_ledger_runtime where singleton=true) runtime,
    (select concat_ws(':',count(*)::text,coalesce(sum(amount),0)::text)
      from public.project_fund_transfers) transfers,
    (select concat_ws(':',count(*)::text,coalesce(sum(amount),0)::text)
      from public.financial_unallocated_fund_movements) movements,
    (select count(*)::text from public.projects) projects,
    (select count(*)::text from public.financial_budget_change_requests) budget_requests,
    (select count(*)::text from public.financial_pending_new_project_link_requests) link_requests`)).rows[0];
}
async function definition(client) {
  return (await client.query(`select lower(pg_get_functiondef(
    'public.financial_trace_grouped_budget_destination()'::regprocedure)) value`)).rows[0].value;
}
function installed(value) {
  return value.includes('approval_mode, processing_mode')
    && value.includes("case when v_direct then 'direct' else 'legacy_approval' end");
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
      || env.TEST_PROJECT_REF !== TEST_REF || !prodRef || prodRef === TEST_REF
      || refFromUrl(env.NEXT_PUBLIC_SUPABASE_URL ?? '') !== TEST_REF
      || refFromDatabase(databaseUrl) !== TEST_REF || refFromDatabase(databaseUrl) === prodRef) {
    fail('Fail-closed TEST target gate rejected configuration.');
  }
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const sha256 = crypto.createHash('sha256').update(sql).digest('hex');
  const client = new Client({ connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000,
    application_name: `direct-grouped-trace-${VERSION}-${action}` });
  await client.connect();
  let transaction = false;
  try {
    const before = await snapshot(client);
    if (before.runtime !== `TEST:TEST:${TEST_REF}`) fail('TEST ledger runtime is not active.');
    const beforeDefinition = await definition(client);
    if (installed(beforeDefinition)) fail('Direct grouped trace hotfix is already installed.');
    await client.query('begin');
    transaction = true;
    const lock = await client.query(`select pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended('direct-grouped-trace-${VERSION}', ${VERSION})) locked`);
    if (lock.rows[0]?.locked !== true) fail('Another TEST migration is running.');
    await client.query("set local lock_timeout='10s'");
    await client.query("set local statement_timeout='120s'");
    await client.query(migrationBody(sql));
    if (!installed(await definition(client))) fail('Hotfix function definition is incomplete.');
    if (JSON.stringify(await snapshot(client)) !== JSON.stringify(before)) {
      fail('Migration changed existing business rows or financial totals.');
    }
    if (action === 'validate') {
      await client.query('rollback');
      transaction = false;
      if (installed(await definition(client)) || JSON.stringify(await snapshot(client)) !== JSON.stringify(before)) {
        fail('Rollback proof failed.');
      }
    } else {
      await client.query('commit');
      transaction = false;
    }
    console.log(JSON.stringify({ ok: true, target: 'TEST', production_touched: false,
      action, transaction: action === 'validate' ? 'ROLLED_BACK' : 'COMMITTED',
      migration_version: VERSION, migration_sha256: sha256,
      business_rows_unchanged: true, rollback_proof: action === 'validate' }, null, 2));
  } finally {
    if (transaction) await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
