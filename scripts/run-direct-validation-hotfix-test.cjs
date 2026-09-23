#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const TEST_REF = 'reviewtestxxxxxxxxxx';
function fail(message) { throw new Error(message); }
function ref(value) { try { const url = new URL(value); return url.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i)?.[1] ?? decodeURIComponent(url.username).match(/^postgres\.([a-z0-9-]+)$/i)?.[1] ?? null; } catch { return null; } }
function connection(value) { const url = new URL(value); url.searchParams.delete('sslmode'); url.searchParams.delete('uselibpqcompat'); return url.toString(); }
function body(sql) { return sql.replace(/^\s*begin;\s*/i, '').replace(/\s*commit;\s*$/i, ''); }
async function main() {
  const envPath = path.resolve(process.cwd(), process.argv[2] ?? '');
  if (!process.argv[2] || !process.argv.includes('--confirm-test-write') || !fs.existsSync(envPath)) fail('Explicit TEST env and --confirm-test-write are required.');
  const env = dotenv.parse(fs.readFileSync(envPath));
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '');
  if (String(env.TARGET_ENV).toUpperCase() !== 'TEST' || env.TEST_PROJECT_REF !== TEST_REF || env.PROD_PROJECT_REF === TEST_REF || ref(databaseUrl) !== TEST_REF) fail('Fail-closed TEST gate rejected configuration.');
  const sql = fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations/20260914000300_direct_new_project_existing_validation_hotfix.sql'), 'utf8');
  const client = new Client({ connectionString: connection(databaseUrl), ssl: { rejectUnauthorized: false }, application_name: 'direct-validation-hotfix' });
  await client.connect();
  let open = false;
  try {
    const before = (await client.query(`select pg_get_functiondef('public.financial_complete_new_project_request(uuid)'::regprocedure) definition,
      (select concat_ws(':',count(*)::text,coalesce(sum(amount),0)::text) from public.financial_unallocated_fund_movements) money`)).rows[0];
    await client.query('begin'); open = true;
    await client.query(body(sql));
    const after = (await client.query(`select pg_get_functiondef('public.financial_complete_new_project_request(uuid)'::regprocedure) definition,
      (select concat_ws(':',count(*)::text,coalesce(sum(amount),0)::text) from public.financial_unallocated_fund_movements) money`)).rows[0];
    if (after.definition.includes('v_request.large_category_id is null') || before.money !== after.money) fail('Hotfix postcondition failed.');
    await client.query('commit'); open = false;
    process.stdout.write(`${JSON.stringify({ ok: true, target: 'TEST', production_touched: false, migration_version: '20260914000300', business_rows_unchanged: true }, null, 2)}\n`);
  } finally { if (open) await client.query('rollback').catch(() => undefined); await client.end(); }
}
main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
