#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const VERSION = '20260824000200';
const FILE = path.resolve(
  process.cwd(),
  'supabase/migrations/20260824000200_funding_reallocation_uat_hotfix.sql',
);
const EXPECTED_SHA256 = '71bd7db24c97314b6dfad804b68eca068ec48aa13a48f4e30ca653139341cda2';
const SIGNATURE = 'public.financial_apply_funding_reallocation_request(uuid)';
const NEW_PROJECT_SIGNATURE = 'public.financial_apply_new_project_request(uuid)';

function abort(message) {
  throw new Error(message);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function refFromHttp(value) {
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
      ?? decodeURIComponent(url.username).match(/^postgres\.([a-z0-9-]+)$/)?.[1]
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
  const begins = [...sql.matchAll(/^[ \t]*begin;[ \t]*\r?$/gim)];
  const commits = [...sql.matchAll(/^[ \t]*commit;[ \t]*\r?$/gim)];
  if (begins.length !== 1 || commits.length !== 1 || begins[0].index >= commits[0].index) {
    abort('Hotfix must contain one valid outer transaction.');
  }
  const begin = begins[0];
  const commit = commits[0];
  if (sql.slice(commit.index + commit[0].length).trim() !== '') {
    abort('Hotfix has SQL after its outer COMMIT.');
  }
  return `${sql.slice(0, begin.index)}${sql.slice(begin.index + begin[0].length, commit.index)}`;
}

async function open(databaseUrl, label) {
  const client = new Client({
    connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
    application_name: `funding-uat-hotfix-${label}`,
  });
  await client.connect();
  return client;
}

async function definition(client, signature) {
  const result = await client.query(
    'select pg_catalog.pg_get_functiondef($1::regprocedure) as definition',
    [signature],
  );
  return result.rows[0]?.definition ?? '';
}

function assertNewProjectFixed(value) {
  const normalized = value.toLowerCase();
  if (/where\s+project_code\s*=/.test(normalized)
      || /or\s+project_id\s*=/.test(normalized)
      || !normalized.includes('existing_projects.project_code')
      || !normalized.includes('existing_projects.project_id')) {
    abort('New-project hotfix function postcondition failed.');
  }
}

function assertFixed(value) {
  const normalized = value.toLowerCase();
  if (normalized.includes("and status = 'confirmed'")
      || !normalized.includes("transfers.status = 'confirmed'")
      || !normalized.includes("adjustments.status = 'confirmed'")
      || !normalized.includes("reversals.status = 'confirmed'")) {
    abort('Hotfix function postcondition failed.');
  }
}

async function main() {
  const action = argument('--action');
  const envFile = argument('--env-file');
  if (!['validate', 'apply'].includes(action)) abort('--action must be validate or apply.');
  if (!envFile) abort('--env-file is required.');
  if (action === 'apply' && !process.argv.includes('--confirm-test-write')) {
    abort('TEST apply requires --confirm-test-write.');
  }
  const envPath = path.resolve(process.cwd(), envFile);
  if (!fs.existsSync(envPath)) abort('Explicit TEST env file does not exist.');
  const env = dotenv.parse(fs.readFileSync(envPath));
  const testRef = String(env.TEST_PROJECT_REF ?? '').trim();
  const prodRef = String(env.PROD_PROJECT_REF ?? '').trim();
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '').trim();
  if (String(env.TARGET_ENV ?? '').trim().toUpperCase() !== 'TEST'
      || String(env.LEDGER_MODE ?? '').trim().toUpperCase() !== 'RECONCILIATION'
      || !testRef || !prodRef || testRef === prodRef
      || refFromHttp(env.NEXT_PUBLIC_SUPABASE_URL) !== testRef
      || refFromDatabase(databaseUrl) !== testRef
      || databaseUrl.includes(prodRef)) {
    abort('Fail-closed TEST target gate rejected the environment.');
  }

  const sql = fs.readFileSync(FILE, 'utf8');
  const sha256 = crypto.createHash('sha256').update(sql).digest('hex');
  if (sha256 !== EXPECTED_SHA256) abort('Hotfix differs from its reviewed SHA-256.');
  const body = stripOuterTransaction(sql);

  const client = await open(databaseUrl, action);
  let transactionOpen = false;
  try {
    const runtime = await client.query(`
      select environment_kind, mode, bound_project_ref,
        baseline_as_of::text, native_start_date::text
      from public.financial_ledger_runtime where singleton = true
    `);
    const row = runtime.rows[0];
    if (!row || row.environment_kind !== 'TEST' || row.mode !== 'RECONCILIATION'
        || row.bound_project_ref !== testRef || row.baseline_as_of !== '2026-08-31'
        || row.native_start_date !== '2026-09-01') {
      abort('Database runtime does not match approved TEST policy.');
    }
    const before = {
      funding: await definition(client, SIGNATURE),
      newProject: await definition(client, NEW_PROJECT_SIGNATURE),
    };
    await client.query('begin');
    transactionOpen = true;
    const lock = await client.query(
      "select pg_try_advisory_xact_lock(pg_catalog.hashtextextended('funding-reallocation-uat-hotfix', 20260824000200)) as locked",
    );
    if (lock.rows[0]?.locked !== true) abort('Another TEST hotfix transaction is running.');
    await client.query("set local lock_timeout = '10s'");
    await client.query("set local statement_timeout = '120s'");
    await client.query(body);
    const changed = {
      funding: await definition(client, SIGNATURE),
      newProject: await definition(client, NEW_PROJECT_SIGNATURE),
    };
    assertFixed(changed.funding);
    assertNewProjectFixed(changed.newProject);

    if (action === 'validate') {
      await client.query('rollback');
      transactionOpen = false;
      const rolledBack = {
        funding: await definition(client, SIGNATURE),
        newProject: await definition(client, NEW_PROJECT_SIGNATURE),
      };
      if (rolledBack.funding !== before.funding
          || rolledBack.newProject !== before.newProject) {
        abort('Rollback proof failed for TEST function definitions.');
      }
      process.stdout.write(`${JSON.stringify({
        ok: true, action, transaction: 'ROLLED_BACK', target: 'TEST',
        migration_version: VERSION, migration_sha256: sha256,
        function_postcondition: true, rollback_proof: true,
      }, null, 2)}\n`);
      return;
    }

    await client.query('commit');
    transactionOpen = false;
    assertFixed(await definition(client, SIGNATURE));
    assertNewProjectFixed(await definition(client, NEW_PROJECT_SIGNATURE));
    process.stdout.write(`${JSON.stringify({
      ok: true, action, transaction: 'COMMITTED', target: 'TEST',
      migration_version: VERSION, migration_sha256: sha256,
      function_postcondition: true, commit_proof: true,
    }, null, 2)}\n`);
  } catch (error) {
    if (transactionOpen) await client.query('rollback').catch(() => undefined);
    let message = String(error?.message ?? 'Hotfix failed.');
    for (const secret of [databaseUrl, new URL(databaseUrl).password].filter(Boolean)) {
      message = message.split(secret).join('[redacted]');
    }
    process.stderr.write(`${JSON.stringify({
      ok: false, action, target: 'TEST', code: error?.code ?? null,
      message,
      position: error?.position ?? null,
      where: error?.where ?? null,
      transaction: transactionOpen ? 'ROLLED_BACK' : 'NOT_OPEN_OR_ALREADY_CLOSED',
    }, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, message: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
