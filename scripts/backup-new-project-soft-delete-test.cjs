#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const MIGRATION = '20260914000500_new_project_soft_delete.sql';
function fail(message) { throw new Error(message); }
function databaseRef(value) {
  try {
    const url = new URL(value);
    return url.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i)?.[1]
      ?? decodeURIComponent(url.username).match(/^postgres\.([a-z0-9-]+)$/i)?.[1] ?? null;
  } catch { return null; }
}
function connectionString(value) {
  const url = new URL(value);
  url.searchParams.delete('sslmode'); url.searchParams.delete('uselibpqcompat');
  return url.toString();
}

(async () => {
  const envPath = path.resolve(process.cwd(), process.argv[2] ?? '');
  if (!process.argv[2] || !fs.existsSync(envPath)) fail('Explicit TEST env file is required.');
  const env = dotenv.parse(fs.readFileSync(envPath));
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '');
  if (String(env.TARGET_ENV).toUpperCase() !== 'TEST'
      || env.TEST_PROJECT_REF !== TEST_REF
      || env.PROD_PROJECT_REF === TEST_REF
      || databaseRef(databaseUrl) !== TEST_REF) fail('Fail-closed TEST backup target gate rejected configuration.');
  const client = new Client({ connectionString: connectionString(databaseUrl), ssl: { rejectUnauthorized: false }, application_name: 'new-project-soft-delete-test-backup' });
  await client.connect();
  try {
    const runtime = (await client.query('select environment_kind,mode,bound_project_ref from public.financial_ledger_runtime where singleton=true')).rows[0];
    if (`${runtime?.environment_kind}:${runtime?.mode}:${runtime?.bound_project_ref}` !== `TEST:TEST:${TEST_REF}`) fail('TEST ledger runtime is not active.');
    const functions = ['get_financial_new_project_requests','get_financial_project_funding_positions','get_dashboard_filter_options','get_financial_budget_change_candidates','get_financial_budget_change_next_year_candidates','get_transfer_destination_projects','get_financial_carryover_destinations','get_financial_post_check_requests','financial_save_new_project_request_draft','financial_submit_new_project_request'];
    const backup = {
      metadata: { environment: 'TEST', project_ref: TEST_REF, captured_at: new Date().toISOString(), purpose: `before ${MIGRATION}` },
      business_snapshot: (await client.query(`select
        (select count(*) from public.projects)::text project_count,
        (select count(*) from public.financial_new_project_requests)::text request_count,
        (select count(*) from public.audit_logs)::text audit_count,
        (select coalesce(sum(coalesce(total_budget,0)),0) from public.projects)::text total_budget,
        (select coalesce(sum(coalesce(original_alloc,0)),0) from public.projects)::text original_alloc,
        (select coalesce(sum(coalesce(increase_amount,0)),0) from public.projects)::text increase_amount,
        (select coalesce(sum(coalesce(decrease_amount,0)),0) from public.projects)::text decrease_amount,
        (select coalesce(sum(coalesce(alloc,0)),0) from public.projects)::text allocation,
        (select coalesce(sum(coalesce(exec,0)),0) from public.projects)::text execution`)).rows[0],
      new_project_requests: (await client.query('select * from public.financial_new_project_requests order by requested_at,id')).rows,
      materialized_new_projects: (await client.query(`select projects.* from public.projects
        join public.financial_new_project_requests requests on requests.materialized_project_id=projects.id
        order by projects.id`)).rows,
      policies: (await client.query(`select tablename,policyname,cmd,roles,qual,with_check from pg_policies
        where schemaname='public' and tablename=any($1::text[]) order by tablename,policyname`, [['projects','financial_new_project_requests']])).rows,
      indexes: (await client.query(`select tablename,indexname,indexdef from pg_indexes where schemaname='public'
        and tablename=any($1::text[]) order by tablename,indexname`, [['projects','financial_new_project_requests']])).rows,
      functions: (await client.query(`select p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname=any($1::text[]) order by p.proname,p.oid`, [functions])).rows,
    };
    const body = JSON.stringify(backup, null, 2);
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    const stamp = backup.metadata.captured_at.replace(/[:.]/g, '-');
    const outputDir = path.resolve(process.cwd(), 'test-results', 'backups');
    fs.mkdirSync(outputDir, { recursive: true });
    const output = path.join(outputDir, `new-project-soft-delete-test-before-${stamp}.json`);
    fs.writeFileSync(output, body, { flag: 'wx' });
    fs.writeFileSync(`${output}.sha256`, `${sha256}  ${path.basename(output)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ ok: true, target: 'TEST', production_touched: false, output: path.relative(process.cwd(), output), sha256, business_snapshot: backup.business_snapshot }, null, 2)}\n`);
  } finally { await client.end(); }
})().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
