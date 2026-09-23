#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const TABLES = [
  'financial_new_project_requests',
  'financial_pending_new_project_link_requests',
  'financial_pending_new_project_funds',
  'financial_budget_change_requests',
  'financial_budget_change_request_lines',
  'financial_unallocated_fund_lots',
  'financial_unallocated_fund_movements',
  'financial_project_decrease_classifications',
  'project_fund_transfers',
  'project_budget_years',
];

function fail(message) { throw new Error(message); }
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

async function main() {
  const envFile = path.resolve(process.cwd(), process.argv[2] ?? '');
  if (!process.argv[2] || !fs.existsSync(envFile)) fail('Explicit TEST env file is required.');
  const env = dotenv.parse(fs.readFileSync(envFile));
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '');
  if (String(env.TARGET_ENV).toUpperCase() !== 'TEST'
      || env.TEST_PROJECT_REF !== TEST_REF
      || refFromDatabase(databaseUrl) !== TEST_REF
      || env.PROD_PROJECT_REF === TEST_REF) {
    fail('Fail-closed TEST backup target gate rejected configuration.');
  }
  const client = new Client({
    connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    application_name: 'direct-workflow-pre-migration-backup',
  });
  await client.connect();
  try {
    const runtime = (await client.query(`select environment_kind,mode,bound_project_ref
      from public.financial_ledger_runtime where singleton=true`)).rows[0];
    if (`${runtime?.environment_kind}:${runtime?.mode}:${runtime?.bound_project_ref}` !== `TEST:TEST:${TEST_REF}`) {
      fail('TEST ledger runtime is not active.');
    }
    const backup = {
      metadata: {
        environment: 'TEST',
        project_ref: TEST_REF,
        captured_at: new Date().toISOString(),
        purpose: 'before 20260914000200 direct workflow and post-check migration',
      },
      schema: {},
      rows: {},
    };
    for (const table of TABLES) {
      backup.rows[table] = (await client.query(`select * from public.${table} order by 1`)).rows;
      backup.schema[table] = (await client.query(`select pg_get_constraintdef(oid) definition
        from pg_constraint where conrelid=$1::regclass order by conname`, [`public.${table}`])).rows;
    }
    backup.schema.workflow_functions = (await client.query(`select p.oid::regprocedure::text signature,
      pg_get_functiondef(p.oid) definition
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in (
        'financial_submit_new_project_request_v2',
        'financial_apply_new_project_request',
        'financial_apply_new_project_request_v2',
        'financial_submit_budget_change_request',
        'financial_approve_budget_change_request_group',
        'financial_request_pending_new_project_link',
        'financial_review_pending_new_project_link',
        'financial_apply_pending_new_project_link'
      ) order by p.proname`)).rows;
    const body = JSON.stringify(backup, null, 2);
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const stamp = backup.metadata.captured_at.replace(/[:.]/g, '-');
    const outputDir = path.resolve(process.cwd(), 'test-results', 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `direct-workflow-test-before-${stamp}.json`);
    fs.writeFileSync(outputPath, body, { flag: 'wx' });
    fs.writeFileSync(`${outputPath}.sha256`, `${sha256}  ${path.basename(outputPath)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      target: 'TEST',
      production_touched: false,
      output: path.relative(process.cwd(), outputPath),
      sha256,
      tables: Object.fromEntries(TABLES.map((table) => [table, backup.rows[table].length])),
    }, null, 2)}\n`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
