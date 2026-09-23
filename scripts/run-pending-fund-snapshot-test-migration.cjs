#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const VERSION = arg('--version') ?? '20260903000300';
const MIGRATION_FILES = {
  '20260903000300': '20260903000300_pending_fund_snapshot_trigger.sql',
  '20260903000400': '20260903000400_pending_fund_business_year.sql',
};
if (!MIGRATION_FILES[VERSION]) fail('Unsupported TEST migration version.');
const SQL_PATH = path.resolve(process.cwd(), 'supabase/migrations',
  MIGRATION_FILES[VERSION]);

function fail(message) { throw new Error(message); }
function arg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
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
  return `${sql.slice(0, begin.index)}${sql.slice(begin.index + begin[0].length, commits[0].index)}`;
}
async function snapshot(client) {
  return (await client.query(`select
    (select environment_kind || ':' || mode || ':' || bound_project_ref
      from public.financial_ledger_runtime where singleton=true) runtime,
    (select count(*)::text || ':' || coalesce(sum(alloc),0)::text || ':' || coalesce(sum(exec),0)::text
      from public.projects) projects,
    (select count(*)::text from public.financial_budget_workflow_amount_snapshots) snapshots,
    (select count(*)::text from public.financial_pending_new_project_funds) pending,
    (select count(*)::text from public.financial_unallocated_fund_movements) movements`)).rows[0];
}

async function main() {
  const action = arg('--action');
  if (!['validate', 'apply'].includes(action)) fail('--action must be validate or apply.');
  if (action === 'apply' && !process.argv.includes('--confirm-test-write')) {
    fail('TEST apply requires --confirm-test-write.');
  }
  const envFile = arg('--env-file');
  const resolved = path.resolve(process.cwd(), envFile ?? '');
  if (!envFile || !fs.existsSync(resolved) || !fs.existsSync(SQL_PATH)) fail('Migration or TEST env file is missing.');
  const env = dotenv.parse(fs.readFileSync(resolved));
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '').trim();
  if (String(env.TARGET_ENV ?? '').toUpperCase() !== 'TEST'
      || env.TEST_PROJECT_REF !== TEST_REF || !env.PROD_PROJECT_REF
      || env.PROD_PROJECT_REF === TEST_REF
      || refFromUrl(env.NEXT_PUBLIC_SUPABASE_URL ?? '') !== TEST_REF
      || refFromDatabase(databaseUrl) !== TEST_REF
      || refFromDatabase(databaseUrl) === env.PROD_PROJECT_REF) {
    fail('Fail-closed target gate rejected configuration.');
  }
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const sha = crypto.createHash('sha256').update(sql).digest('hex');
  const client = new Client({ connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000,
    application_name: `pending-fund-${VERSION}-${action}` });
  await client.connect();
  let transaction = false;
  try {
    const before = await snapshot(client);
    if (before.runtime !== `TEST:TEST:${TEST_REF}`) fail('TEST runtime is not active.');
    await client.query('begin');
    transaction = true;
    const lock = await client.query(
      `select pg_try_advisory_xact_lock(pg_catalog.hashtextextended('pending-fund-${VERSION}', ${VERSION})) locked`,
    );
    if (lock.rows[0]?.locked !== true) fail('Another TEST migration is running.');
    await client.query("set local lock_timeout='10s'");
    await client.query("set local statement_timeout='180s'");
    await client.query(migrationBody(sql));
    if (VERSION === '20260903000300') {
      const definition = (await client.query(`select lower(pg_get_functiondef(
        'public.financial_capture_budget_change_amount_snapshots()'::regprocedure)) value`)).rows[0]?.value;
      if (!definition?.includes('and not lines.unlinked_funding_only')) fail('Trigger postcondition failed.');
    } else {
      const postcondition = (await client.query(`select
        to_regprocedure('public.financial_align_unlinked_pending_fund_business_year()') is not null trigger_function,
        not exists (
          select 1 from public.financial_pending_new_project_funds pending
          join public.financial_budget_change_request_lines lines on lines.id=pending.source_line_id
          join public.financial_budget_change_requests requests on requests.id=pending.source_request_id
          where lines.unlinked_funding_only and pending.status='WAITING'
            and pending.planned_project_year=requests.fiscal_year+1
            and pending.fiscal_year<>requests.fiscal_year
        ) years_aligned`)).rows[0];
      if (!postcondition?.trigger_function || !postcondition?.years_aligned) {
        fail('Business-year postcondition failed.');
      }
    }
    if (JSON.stringify(await snapshot(client)) !== JSON.stringify(before)) fail('Migration changed TEST business rows or money.');
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
