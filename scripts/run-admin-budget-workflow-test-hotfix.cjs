#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';
const VERSION = '20260827000500';
const SQL_PATH = path.resolve(process.cwd(), 'supabase/migrations', `${VERSION}_admin_budget_workflow_uat_hotfix.sql`);

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
  const url = new URL(value); url.searchParams.delete('sslmode'); url.searchParams.delete('uselibpqcompat');
  return url.toString();
}
function body(sql) {
  const begin = sql.match(/^[ \t]*begin;[ \t]*\r?$/im);
  const commit = [...sql.matchAll(/^[ \t]*commit;[ \t]*\r?$/gim)];
  if (!begin || commit.length !== 1) fail('Hotfix must contain one outer transaction.');
  return `${sql.slice(0, begin.index)}${sql.slice(begin.index + begin[0].length, commit[0].index)}`;
}
async function monetarySnapshot(client) {
  return (await client.query(`select
    (select environment_kind || ':' || mode || ':' || bound_project_ref from public.financial_ledger_runtime) runtime,
    (select count(*)::text || ':' || coalesce(sum(original_alloc),0)::text || ':'
      || coalesce(sum(increase_amount),0)::text || ':' || coalesce(sum(decrease_amount),0)::text || ':'
      || coalesce(sum(alloc),0)::text || ':' || coalesce(sum(exec),0)::text from public.projects) projects,
    (select count(*)::text || ':' || coalesce(sum(amount),0)::text from public.project_fund_transfers) transfers,
    (select count(*)::text || ':' || coalesce(sum(original_amount),0)::text from public.financial_unallocated_fund_lots) lots,
    (select count(*)::text || ':' || coalesce(sum(amount),0)::text from public.financial_unallocated_fund_movements) movements,
    (select count(*)::text from public.financial_budget_change_requests) budget_requests,
    (select count(*)::text from public.financial_new_project_requests) new_project_requests,
    (select count(*)::text from public.financial_pending_new_project_link_requests) link_requests`)).rows[0];
}

async function main() {
  const action = arg('--action');
  if (!['validate', 'apply'].includes(action)) fail('--action must be validate or apply.');
  if (action === 'apply' && !has('--confirm-test-write')) fail('TEST apply requires --confirm-test-write.');
  const envFile = arg('--env-file');
  const resolved = path.resolve(process.cwd(), envFile ?? '');
  if (!envFile || !fs.existsSync(resolved) || !fs.existsSync(SQL_PATH)) fail('Explicit TEST env and hotfix SQL are required.');
  const env = dotenv.parse(fs.readFileSync(resolved));
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '').trim();
  if (String(env.TARGET_ENV ?? '').toUpperCase() !== 'TEST'
      || env.TEST_PROJECT_REF !== TEST_REF || env.PROD_PROJECT_REF !== PROD_REF
      || env.TEST_PROJECT_REF === env.PROD_PROJECT_REF
      || refFromUrl(env.NEXT_PUBLIC_SUPABASE_URL ?? '') !== TEST_REF
      || refFromDatabase(databaseUrl) !== TEST_REF || refFromDatabase(databaseUrl) === PROD_REF) {
    fail('Fail-closed target gate rejected configuration.');
  }
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  const sha = crypto.createHash('sha256').update(sql).digest('hex');
  const client = new Client({ connectionString: connectionString(databaseUrl), ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000, application_name: `admin-budget-workflow-${action}` });
  await client.connect();
  let transaction = false;
  try {
    const before = await monetarySnapshot(client);
    await client.query('begin'); transaction = true;
    await client.query("set local lock_timeout = '10s'");
    await client.query("set local statement_timeout = '240s'");
    await client.query(body(sql));
    const check = (await client.query(`select
      to_regclass('public.financial_budget_workflow_amount_snapshots') is not null has_snapshot_table,
      to_regprocedure('public.get_financial_budget_workflow_amount_snapshots(uuid)') is not null has_snapshot_rpc,
      pg_get_functiondef('public.financial_create_new_project_request(uuid,integer,text,text,text,text,integer,integer,text,text,uuid,uuid,uuid,bigint,uuid,boolean)'::regprocedure)
        like '%planned_project_year <> p_fiscal_year%' create_accepts_plan_year,
      pg_get_functiondef('public.financial_apply_new_project_request(uuid)'::regprocedure)
        like '%financial_pending_new_project_link_requests%' apply_creates_link,
      (select count(*)::integer from public.financial_budget_workflow_amount_snapshots) snapshot_count,
      (select count(*)::integer from public.financial_budget_workflow_amount_snapshots s
        where s.adjusted_before <> s.original_before + s.increase_before - s.decrease_before
           or s.unexecuted_before <> s.adjusted_before - s.execution_before
           or s.adjusted_after <> s.original_after + s.increase_after - s.decrease_after
           or s.unexecuted_after <> s.adjusted_after - s.execution_after) formula_errors`)).rows[0];
    if (!check?.has_snapshot_table || !check.has_snapshot_rpc || !check.create_accepts_plan_year
        || !check.apply_creates_link || Number(check.formula_errors) !== 0 || Number(check.snapshot_count) < 1) {
      fail(`Admin budget workflow hotfix postcondition failed: ${JSON.stringify(check)}`);
    }
    if (JSON.stringify(await monetarySnapshot(client)) !== JSON.stringify(before)) {
      fail('Hotfix changed TEST monetary or workflow business rows.');
    }
    if (action === 'validate') {
      await client.query('rollback'); transaction = false;
    } else {
      await client.query('commit'); transaction = false;
    }
    process.stdout.write(`${JSON.stringify({ ok: true, target: 'TEST', production_touched: false,
      action, transaction: action === 'validate' ? 'ROLLED_BACK' : 'COMMITTED',
      migration_version: VERSION, migration_sha256: sha, monetary_rows_unchanged: true,
      snapshot_count: Number(check.snapshot_count), formula_errors: Number(check.formula_errors) }, null, 2)}\n`);
  } finally {
    if (transaction) await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
