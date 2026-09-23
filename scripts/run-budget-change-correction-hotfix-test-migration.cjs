#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const VERSION = '20260914000100';
const SQL_PATH = path.resolve(
  process.cwd(),
  'supabase/migrations/20260914000100_budget_change_destination_correction_classification_hotfix.sql',
);
const HELPER_SIGNATURE =
  'public.financial_reclassify_budget_change_destination_transfer(uuid,uuid,uuid,uuid,uuid)';
const CORRECTION_SIGNATURE =
  'public.financial_correct_budget_change_destination(uuid,uuid,text,date,uuid)';

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
    application_name: `budget-change-correction-hotfix-${VERSION}-${action}`,
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
      from public.financial_project_decrease_classifications) classifications,
    (select concat_ws(':',count(*)::text,coalesce(sum(amount),0)::text)
      from public.financial_project_decrease_classification_reversals) reversals,
    (select count(*)::text from public.financial_budget_change_destination_corrections)
      corrections,
    (select count(*)::text from public.audit_logs) audit_logs`)).rows[0];
}
async function functionState(client) {
  const result = await client.query(`select
    to_regprocedure($1) is not null as helper_present,
    pg_get_functiondef($2::regprocedure) as correction_definition`,
  [HELPER_SIGNATURE, CORRECTION_SIGNATURE]);
  return result.rows[0];
}
function isInstalled(state) {
  return state.helper_present === true
    || state.correction_definition.includes('financial_reclassify_budget_change_destination_transfer');
}
async function assertPostconditions(client) {
  const state = await functionState(client);
  if (state.helper_present !== true
      || !state.correction_definition.includes('financial_reclassify_budget_change_destination_transfer')) {
    fail('Destination-correction classification hotfix is incomplete.');
  }
  const privileges = (await client.query(`select
    has_function_privilege('authenticated',$1,'EXECUTE') as authenticated_execute,
    has_function_privilege('anon',$1,'EXECUTE') as anon_execute,
    has_function_privilege('service_role',$1,'EXECUTE') as service_execute`,
  [HELPER_SIGNATURE])).rows[0];
  if (privileges.authenticated_execute || privileges.anon_execute || privileges.service_execute) {
    fail('Internal classification helper is externally executable.');
  }
  return { helper_present: true, correction_function_patched: true, helper_rpc_private: true };
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
    fail('Hotfix migration or explicit TEST env file is missing.');
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
    const originalState = await functionState(client);
    if (isInstalled(originalState)) fail('Classification hotfix is already installed.');
    await client.query('begin');
    transaction = true;
    const lock = await client.query(
      `select pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
        'budget-change-correction-hotfix-${VERSION}', ${VERSION})) as locked`,
    );
    if (lock.rows[0]?.locked !== true) fail('Another TEST migration is running.');
    await client.query("set local lock_timeout='10s'");
    await client.query("set local statement_timeout='240s'");
    await client.query(migrationBody(sql));
    const checks = await assertPostconditions(client);
    if (JSON.stringify(await snapshot(client)) !== JSON.stringify(before)) {
      fail('Hotfix changed TEST business rows, money, classifications, or audit history.');
    }

    if (action === 'validate') {
      await client.query('rollback');
      transaction = false;
      const verify = await openClient(databaseUrl, 'rollback-proof');
      try {
        const rolledBack = await functionState(verify);
        if (rolledBack.helper_present
            || rolledBack.correction_definition !== originalState.correction_definition
            || JSON.stringify(await snapshot(verify)) !== JSON.stringify(before)) {
          fail('Rollback proof failed for destination-correction classification hotfix.');
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
