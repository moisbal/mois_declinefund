#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const MIGRATION_PATH = path.resolve(process.cwd(), 'supabase/migrations/20260826000500_project_similarity_return_hotfix.sql');
const EXPECTED_SHA256 = '6add68fe3f5700bef80d3850b46741ff986a89f3b5788b9ff93d40256c68db49';
const SIGNATURE = 'public.get_project_similarity_candidates(uuid,text,integer)';

function fail(message) { throw new Error(message); }
function arg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function has(name) { return process.argv.includes(name); }
function refFromUrl(value) {
  try { return new URL(value).hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i)?.[1] ?? null; } catch { return null; }
}
function refFromDatabaseUrl(value) {
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
function stripTransaction(sql) {
  const begins = [...sql.matchAll(/^[ \t]*begin;[ \t]*\r?$/gim)];
  const commits = [...sql.matchAll(/^[ \t]*commit;[ \t]*\r?$/gim)];
  if (begins.length !== 1 || commits.length !== 1) fail('Hotfix must contain one outer transaction.');
  const begin = begins[0];
  const commit = commits[0];
  return `${sql.slice(0, begin.index)}${sql.slice(begin.index + begin[0].length, commit.index)}`;
}
async function open(databaseUrl) {
  const client = new Client({ connectionString: connectionString(databaseUrl), ssl: { rejectUnauthorized: false }, application_name: 'project-change-hotfix' });
  await client.connect();
  return client;
}
async function snapshot(client) {
  const result = await client.query(`
    select
      (select environment_kind from public.financial_ledger_runtime where singleton) as environment_kind,
      (select bound_project_ref from public.financial_ledger_runtime where singleton) as bound_project_ref,
      (select md5(string_agg(concat_ws('|', id::text, total_budget::text,
        original_alloc::text, increase_amount::text, decrease_amount::text,
        alloc::text, exec::text, rate::text), E'\\n' order by id)) from public.projects) as monetary_digest,
      pg_get_functiondef($1::regprocedure) as definition,
      has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated_execute,
      has_function_privilege('anon', $1, 'EXECUTE') as anon_execute
  `, [SIGNATURE]);
  return result.rows[0];
}

async function main() {
  const action = arg('--action');
  const envFile = arg('--env-file');
  if (!['validate', 'apply'].includes(action)) fail('--action must be validate or apply.');
  if (action === 'apply' && !has('--confirm-test-write')) fail('TEST apply requires --confirm-test-write.');
  if (!envFile || !fs.existsSync(path.resolve(process.cwd(), envFile))) fail('Explicit TEST env file is required.');
  const env = dotenv.parse(fs.readFileSync(path.resolve(process.cwd(), envFile)));
  const testRef = String(env.TEST_PROJECT_REF ?? '').trim();
  const prodRef = String(env.PROD_PROJECT_REF ?? '').trim();
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '').trim();
  if (String(env.TARGET_ENV ?? '').toUpperCase() !== 'TEST'
      || testRef !== 'reviewtestxxxxxxxxxx' || testRef === prodRef
      || refFromUrl(env.NEXT_PUBLIC_SUPABASE_URL ?? '') !== testRef
      || refFromDatabaseUrl(databaseUrl) !== testRef) {
    fail('Fail-closed target gate rejected configuration.');
  }
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const hash = crypto.createHash('sha256').update(sql).digest('hex');
  if (hash !== EXPECTED_SHA256) fail('Hotfix SHA-256 differs from the reviewed file.');
  const client = await open(databaseUrl);
  let transactionOpen = false;
  try {
    const before = await snapshot(client);
    if (before.environment_kind !== 'TEST' || before.bound_project_ref !== testRef
        || !before.definition.includes('ranked.display_name,')
        || before.definition.includes('ranked.display_name::text,')) {
      fail('Hotfix precondition is not the reviewed similarity return definition.');
    }
    await client.query('begin');
    transactionOpen = true;
    await client.query("set local lock_timeout = '10s'");
    await client.query("set local statement_timeout = '60s'");
    await client.query(stripTransaction(sql));
    const after = await snapshot(client);
    if (after.monetary_digest !== before.monetary_digest
        || !after.definition.includes('ranked.display_name::text,')
        || !after.definition.includes('ranked.project_code::text,')
        || !after.definition.includes('regions.display_name::text,')
        || !after.definition.includes('large_categories.name::text,')
        || after.authenticated_execute !== true || after.anon_execute === true) {
      fail('Hotfix post-check failed.');
    }
    if (action === 'validate') {
      await client.query('rollback');
      transactionOpen = false;
      const rollback = await snapshot(client);
      if (rollback.monetary_digest !== before.monetary_digest || rollback.definition !== before.definition) fail('Hotfix rollback proof failed.');
      process.stdout.write(`${JSON.stringify({ ok: true, action, target: 'TEST', transaction: 'ROLLED_BACK', sha256: hash, monetary_gap: '0', rollback_proof: true }, null, 2)}\n`);
    } else {
      await client.query('commit');
      transactionOpen = false;
      const committed = await snapshot(client);
      if (!committed.definition.includes('ranked.display_name::text,')
          || !committed.definition.includes('ranked.project_code::text,')
          || !committed.definition.includes('regions.display_name::text,')
          || !committed.definition.includes('large_categories.name::text,')
          || committed.monetary_digest !== before.monetary_digest) fail('Hotfix commit proof failed.');
      process.stdout.write(`${JSON.stringify({ ok: true, action, target: 'TEST', transaction: 'COMMITTED', sha256: hash, monetary_gap: '0', commit_proof: true }, null, 2)}\n`);
    }
  } catch (error) {
    if (transactionOpen) await client.query('rollback').catch(() => undefined);
    let message = String(error?.message ?? error);
    for (const secret of [databaseUrl, (() => { try { return new URL(databaseUrl).password; } catch { return ''; } })()]) if (secret) message = message.split(secret).join('[redacted]');
    process.stderr.write(`${JSON.stringify({ ok: false, action, target: 'TEST', message }, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, target: 'TEST', message: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
