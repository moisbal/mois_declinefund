#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const VERSION = '20260903000500';
const SQL_PATH = path.resolve(
  process.cwd(),
  'supabase/migrations/20260903000500_project_delay_reason.sql',
);

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
      ?? decodeURIComponent(url.username).match(/^postgres\.([a-z0-9-]+)$/i)?.[1]
      ?? null;
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
    (select count(*)::text || ':' || coalesce(sum(coalesce(total_budget,0)),0)::text || ':'
      || coalesce(sum(coalesce(original_alloc,0)),0)::text || ':'
      || coalesce(sum(coalesce(increase_amount,0)),0)::text || ':'
      || coalesce(sum(coalesce(decrease_amount,0)),0)::text || ':'
      || coalesce(sum(coalesce(alloc,0)),0)::text || ':'
      || coalesce(sum(coalesce(exec,0)),0)::text from public.projects) projects,
    (select count(*)::text from public.audit_logs) audit_logs`)).rows[0];
}

async function main() {
  const action = arg('--action');
  if (!['validate', 'apply'].includes(action)) fail('--action must be validate or apply.');
  if (action === 'apply' && !process.argv.includes('--confirm-test-write')) {
    fail('TEST apply requires --confirm-test-write.');
  }
  const envFile = arg('--env-file');
  const resolved = path.resolve(process.cwd(), envFile ?? '');
  if (!envFile || !fs.existsSync(resolved) || !fs.existsSync(SQL_PATH)) {
    fail('Migration or TEST env file is missing.');
  }
  const env = dotenv.parse(fs.readFileSync(resolved));
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '').trim();
  if (String(env.TARGET_ENV ?? '').toUpperCase() !== 'TEST'
      || env.TEST_PROJECT_REF !== TEST_REF
      || !env.PROD_PROJECT_REF
      || env.PROD_PROJECT_REF === TEST_REF
      || refFromUrl(env.NEXT_PUBLIC_SUPABASE_URL ?? '') !== TEST_REF
      || refFromDatabase(databaseUrl) !== TEST_REF
      || refFromDatabase(databaseUrl) === env.PROD_PROJECT_REF) {
    fail('Fail-closed target gate rejected configuration.');
  }

  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const sha = crypto.createHash('sha256').update(sql).digest('hex');
  const client = new Client({
    connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    application_name: `project-delay-reason-${VERSION}-${action}`,
  });
  await client.connect();
  let transaction = false;
  try {
    const before = await snapshot(client);
    if (before.runtime !== `TEST:TEST:${TEST_REF}`) fail('TEST runtime is not active.');
    await client.query('begin');
    transaction = true;
    const lock = await client.query(
      `select pg_try_advisory_xact_lock(pg_catalog.hashtextextended('project-delay-reason-${VERSION}', ${VERSION})) locked`,
    );
    if (lock.rows[0]?.locked !== true) fail('Another TEST migration is running.');
    await client.query("set local lock_timeout='10s'");
    await client.query("set local statement_timeout='180s'");
    await client.query(migrationBody(sql));

    const postcondition = (await client.query(`select
      exists (
        select 1 from information_schema.columns
        where table_schema='public' and table_name='projects' and column_name='delay_reason'
      ) delay_reason_column,
      to_regprocedure(
        'public.update_my_project_metadata_v3(uuid,text,text,integer,text,jsonb,uuid,uuid[],text,text,text,text[],text,text,boolean,text,text)'
      ) is not null save_function,
      has_function_privilege(
        'authenticated',
        'public.update_my_project_metadata_v3(uuid,text,text,integer,text,jsonb,uuid,uuid[],text,text,text,text[],text,text,boolean,text,text)',
        'EXECUTE'
      ) authenticated_execute`)).rows[0];
    if (!postcondition?.delay_reason_column || !postcondition?.save_function || !postcondition?.authenticated_execute) {
      fail('Delay-reason migration postcondition failed.');
    }
    if (JSON.stringify(await snapshot(client)) !== JSON.stringify(before)) {
      fail('Migration changed TEST business rows, money, or audit history.');
    }

    if (action === 'validate') {
      await client.query('rollback');
      transaction = false;
    } else {
      await client.query('commit');
      transaction = false;
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      target: 'TEST',
      production_touched: false,
      action,
      transaction: action === 'validate' ? 'ROLLED_BACK' : 'COMMITTED',
      migration_version: VERSION,
      migration_sha256: sha,
      business_rows_unchanged: true,
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
