#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const VERSION = '20260907000100';
const SQL_PATH = path.resolve(process.cwd(), 'supabase/migrations',
  `${VERSION}_multi_destination_budget_change.sql`);

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
  const commits = [...sql.matchAll(/^[ \t]*commit;[ \t]*\r?$/gim)];
  if (!begin || commits.length !== 1) fail('Migration must contain one outer transaction.');
  return `${sql.slice(0, begin.index)}${sql.slice(begin.index + begin[0].length, commits[0].index)}`;
}
async function snapshot(client) {
  const result = await client.query(`select
    (select environment_kind || ':' || mode || ':' || bound_project_ref
      from public.financial_ledger_runtime where singleton=true) runtime,
    (select count(*)::text || ':' || coalesce(sum(alloc),0)::text || ':' || coalesce(sum(exec),0)::text
      from public.projects) projects,
    (select count(*)::text from public.financial_new_project_requests) new_projects,
    (select count(*)::text from public.financial_budget_change_requests) budget_requests,
    (select count(*)::text from public.financial_budget_change_request_lines) budget_lines,
    (select count(*)::text || ':' || coalesce(sum(amount),0)::text
      from public.financial_pending_new_project_funds) pending,
    (select count(*)::text || ':' || coalesce(sum(original_amount),0)::text
      from public.financial_unallocated_fund_lots) lots,
    (select count(*)::text || ':' || coalesce(sum(amount),0)::text
      from public.financial_unallocated_fund_movements) movements,
    (select count(*)::text || ':' || coalesce(sum(amount),0)::text
      from public.project_fund_transfers) transfers`);
  return result.rows[0];
}

async function main() {
  const action = arg('--action');
  if (!['validate', 'apply'].includes(action)) fail('--action must be validate or apply.');
  if (action === 'apply' && !has('--confirm-test-write')) fail('TEST apply requires --confirm-test-write.');
  const envFile = arg('--env-file');
  const resolved = path.resolve(process.cwd(), envFile ?? '');
  if (!envFile || !fs.existsSync(resolved)) fail('Explicit TEST env file is required.');
  if (!fs.existsSync(SQL_PATH)) fail('Migration file is missing.');
  const env = dotenv.parse(fs.readFileSync(resolved));
  const testRef = String(env.TEST_PROJECT_REF ?? '').trim();
  const prodRef = String(env.PROD_PROJECT_REF ?? '').trim();
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '').trim();
  if (String(env.TARGET_ENV ?? '').toUpperCase() !== 'TEST'
      || testRef !== TEST_REF || !prodRef || testRef === prodRef
      || refFromUrl(env.NEXT_PUBLIC_SUPABASE_URL ?? '') !== testRef
      || refFromDatabase(databaseUrl) !== testRef || refFromDatabase(databaseUrl) === prodRef) {
    fail('Fail-closed TEST target gate rejected configuration.');
  }

  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const sha = crypto.createHash('sha256').update(sql).digest('hex');
  const client = new Client({
    connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    application_name: `multi-destination-budget-change-${action}`,
  });
  await client.connect();
  let transaction = false;
  try {
    const before = await snapshot(client);
    if (before.runtime !== `TEST:TEST:${TEST_REF}`) fail('TEST runtime is not active.');
    await client.query('begin');
    transaction = true;
    const lock = await client.query(
      "select pg_try_advisory_xact_lock(pg_catalog.hashtextextended('multi-destination-budget-change', 20260907000100)) locked",
    );
    if (lock.rows[0]?.locked !== true) fail('Another TEST migration is running.');
    await client.query("set local lock_timeout = '10s'");
    await client.query("set local statement_timeout = '180s'");
    await client.query(body(sql));

    const functions = await client.query(`select signature,
      to_regprocedure('public.' || signature) is not null present,
      has_function_privilege('authenticated', 'public.' || signature, 'EXECUTE') auth_execute,
      has_function_privilege('anon', 'public.' || signature, 'EXECUTE') anon_execute
      from unnest($1::text[]) signature`, [[
      'financial_test_uat_save_budget_change_request_complete(uuid,uuid,jsonb,date,text,uuid,boolean)',
      'financial_submit_budget_change_request(uuid)',
      'financial_approve_budget_change_request_group(uuid,jsonb)',
      'financial_apply_budget_change_request_dispatch(uuid)',
      'financial_apply_new_project_request_v2(uuid)',
    ]]);
    if (functions.rows.some((row) => !row.present || !row.auth_execute || row.anon_execute)) {
      fail('Public RPC existence or privilege postcondition failed.');
    }
    const internal = await client.query(`select signature,
      to_regprocedure('public.' || signature) is not null present,
      has_function_privilege('authenticated', 'public.' || signature, 'EXECUTE') auth_execute
      from unnest($1::text[]) signature`, [[
      'financial_validate_budget_change_request(uuid)',
      'financial_apply_budget_change_request(uuid)',
      'financial_apply_budget_change_to_pending_funds(uuid)',
    ]]);
    if (internal.rows.some((row) => !row.present || row.auth_execute)) {
      fail('Internal RPC privilege postcondition failed.');
    }
    if (JSON.stringify(await snapshot(client)) !== JSON.stringify(before)) {
      fail('Migration changed TEST business rows or monetary values.');
    }

    if (action === 'validate') {
      await client.query('rollback');
      transaction = false;
      process.stdout.write(`${JSON.stringify({ ok: true, target: 'TEST', production_touched: false,
        action, transaction: 'ROLLED_BACK', migration_version: VERSION,
        migration_sha256: sha, business_rows_unchanged: true }, null, 2)}\n`);
    } else {
      await client.query('commit');
      transaction = false;
      process.stdout.write(`${JSON.stringify({ ok: true, target: 'TEST', production_touched: false,
        action, transaction: 'COMMITTED', migration_version: VERSION,
        migration_sha256: sha, business_rows_unchanged: true }, null, 2)}\n`);
    }
  } finally {
    if (transaction) await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
