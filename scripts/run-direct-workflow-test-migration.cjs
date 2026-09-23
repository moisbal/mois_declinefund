#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const VERSION = '20260914000200';
const SQL_PATH = path.resolve(
  process.cwd(),
  'supabase/migrations/20260914000200_direct_new_project_and_post_checks.sql',
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
    application_name: `direct-workflow-${VERSION}-${action}`,
  });
  await client.connect();
  return client;
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
    (select count(*)::text from public.audit_logs) audit_logs`)).rows[0];
}
async function installed(client) {
  return (await client.query(`select
    to_regclass('public.financial_post_check_requests') is not null as checks,
    to_regprocedure('public.financial_complete_new_project_request(uuid)') is not null as complete_rpc`)).rows[0];
}
async function assertPostconditions(client) {
  const schema = await client.query(`select
    to_regclass('public.financial_post_check_requests') is not null as checks,
    to_regclass('public.system_notifications') is not null as notifications,
    to_regclass('public.financial_direct_processing_transitions') is not null as transitions,
    to_regprocedure('public.financial_complete_new_project_request(uuid)') is not null as complete_rpc,
    to_regprocedure('public.financial_create_post_check_request(text,uuid,text,date,uuid)') is not null as create_check_rpc`);
  const state = schema.rows[0];
  if (!Object.values(state).every(Boolean)) fail('Direct workflow schema is incomplete.');
  const privileges = (await client.query(`select
    has_function_privilege('authenticated','public.financial_approve_new_project_request(uuid,text)','EXECUTE') as approve_new,
    has_function_privilege('authenticated','public.financial_submit_new_project_request(uuid)','EXECUTE') as legacy_submit_new,
    has_function_privilege('authenticated','public.financial_apply_new_project_request_v2(uuid)','EXECUTE') as apply_new,
    has_function_privilege('authenticated','public.financial_review_pending_new_project_link(uuid,text,text)','EXECUTE') as review_link,
    has_function_privilege('authenticated','public.financial_apply_pending_new_project_link(uuid)','EXECUTE') as apply_link,
    has_function_privilege('authenticated','public.financial_approve_budget_change_request_group(uuid,jsonb)','EXECUTE') as approve_budget,
    has_function_privilege('authenticated','public.financial_reject_budget_change_request(uuid,text)','EXECUTE') as reject_budget,
    has_function_privilege('authenticated','public.financial_apply_budget_change_request_dispatch(uuid)','EXECUTE') as apply_budget,
    has_function_privilege('authenticated','public.financial_complete_new_project_request(uuid)','EXECUTE') as complete_new,
    has_function_privilege('authenticated','public.financial_create_post_check_request(text,uuid,text,date,uuid)','EXECUTE') as create_check`)).rows[0];
  if (privileges.approve_new || privileges.legacy_submit_new || privileges.apply_new
      || privileges.review_link || privileges.apply_link || privileges.approve_budget
      || privileges.reject_budget || privileges.apply_budget) {
    fail('Legacy new-project or funding-link approval RPC remains executable.');
  }
  if (!privileges.complete_new || !privileges.create_check) {
    fail('Direct completion or post-check RPC is not executable.');
  }
  const definitions = (await client.query(`select
    pg_get_functiondef('public.financial_submit_new_project_request_v2(uuid)'::regprocedure) as submit_new,
    pg_get_functiondef('public.financial_submit_budget_change_request(uuid)'::regprocedure) as submit_budget,
    pg_get_functiondef('public.financial_request_pending_new_project_link(uuid,uuid,uuid)'::regprocedure) as link`)).rows[0];
  if (!definitions.submit_new.includes('financial_complete_new_project_request')
      || !definitions.submit_budget.includes('financial_next_project_code')
      || !definitions.link.includes("'DIRECT'")) {
    fail('Direct processing function definitions are incomplete.');
  }
  return { ...state, legacy_approval_rpc_blocked: true, direct_rpc_enabled: true };
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
    const originalState = await installed(client);
    if (originalState.checks || originalState.complete_rpc) fail('Direct workflow migration is already installed.');
    await client.query('begin');
    transaction = true;
    const lock = await client.query(
      `select pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
        'direct-workflow-${VERSION}', ${VERSION})) as locked`,
    );
    if (lock.rows[0]?.locked !== true) fail('Another TEST migration is running.');
    await client.query("set local lock_timeout='10s'");
    await client.query("set local statement_timeout='240s'");
    await client.query(migrationBody(sql));
    const checks = await assertPostconditions(client);
    if (JSON.stringify(await snapshot(client)) !== JSON.stringify(before)) {
      fail('Migration changed existing business rows, amounts, or audit history.');
    }

    if (action === 'validate') {
      await client.query('rollback');
      transaction = false;
      const verify = await openClient(databaseUrl, 'rollback-proof');
      try {
        const rolledBack = await installed(verify);
        if (rolledBack.checks || rolledBack.complete_rpc
            || JSON.stringify(await snapshot(verify)) !== JSON.stringify(before)) {
          fail('Rollback proof failed.');
        }
      } finally {
        await verify.end();
      }
      process.stdout.write(`${JSON.stringify({
        ok: true, target: 'TEST', production_touched: false, action,
        transaction: 'ROLLED_BACK', migration_version: VERSION,
        migration_sha256: sha256, business_rows_unchanged: true,
        rollback_proof: true, checks,
      }, null, 2)}\n`);
      return;
    }
    await client.query('commit');
    transaction = false;
    process.stdout.write(`${JSON.stringify({
      ok: true, target: 'TEST', production_touched: false, action,
      transaction: 'COMMITTED', migration_version: VERSION,
      migration_sha256: sha256, business_rows_unchanged: true, checks,
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
