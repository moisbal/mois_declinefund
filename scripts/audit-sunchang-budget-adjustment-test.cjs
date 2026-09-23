#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';
const SOURCE_NAME = '고향사랑 연계 농촌사랑 동행순창 운영';

function fail(message) { throw new Error(message); }
function load(file) {
  const resolved = path.resolve(process.cwd(), file ?? '');
  if (!file || !fs.existsSync(resolved)) fail(`Missing explicit file: ${file ?? '(none)'}`);
  return dotenv.parse(fs.readFileSync(resolved));
}
function ref(value, database = false) {
  try {
    const url = new URL(value);
    return database
      ? url.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i)?.[1]
        ?? decodeURIComponent(url.username).match(/^postgres\.([a-z0-9-]+)$/i)?.[1] ?? null
      : url.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i)?.[1] ?? null;
  } catch { return null; }
}
function connectionString(value) {
  const url = new URL(value);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('uselibpqcompat');
  return url.toString();
}
function required(env, key) {
  const value = String(env[key] ?? '').trim();
  if (!value) fail(`${key} is required.`);
  return value;
}
function client(url, key) {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
async function signIn(url, key, email, password, alias) {
  const supabase = client(url, key);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user || !data.session) fail(`${alias} TEST authentication failed.`);
  return { client: supabase, userId: data.user.id };
}
async function rpc(supabase, name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) fail(`${name}: ${error.message}`);
  return data ?? [];
}

async function main() {
  const env = { ...load(process.argv[2]), ...load(process.argv[3]) };
  const url = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  if (env.TARGET_ENV !== 'TEST' || env.TEST_PROJECT_REF !== TEST_REF || env.PROD_PROJECT_REF !== PROD_REF
      || ref(url) !== TEST_REF || ref(databaseUrl, true) !== TEST_REF || ref(databaseUrl, true) === PROD_REF) {
    fail('Fail-closed TEST target gate rejected configuration.');
  }
  const [local, admin] = await Promise.all([
    signIn(url, required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY'),
      required(env, 'UAT_LOCAL_A_EMAIL'), required(env, 'UAT_LOCAL_A_PASSWORD'), 'local_a'),
    signIn(url, required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY'),
      required(env, 'UAT_ADMIN_A_EMAIL'), required(env, 'UAT_ADMIN_A_PASSWORD'), 'admin_a'),
  ]);
  const pg = new Client({
    connectionString: connectionString(databaseUrl), ssl: { rejectUnauthorized: false },
    application_name: 'audit-sunchang-budget-adjustment-test',
  });
  await pg.connect();
  try {
    await pg.query('begin read only');
    const runtime = (await pg.query(`select environment_kind, mode, bound_project_ref
      from public.financial_ledger_runtime where singleton=true`)).rows[0];
    if (runtime?.environment_kind !== 'TEST' || runtime?.bound_project_ref !== TEST_REF) {
      fail('TEST ledger runtime binding mismatch.');
    }
    const profile = (await pg.query(`select profiles.region_id, regions.display_name
      from public.profiles
      join public.regions on regions.id=profiles.region_id
      where profiles.id=$1`, [local.userId])).rows[0];
    if (profile?.display_name !== '전북 순창군') fail('local_a is not bound to 전북 순창군.');

    const projects = (await pg.query(`select projects.id, projects.project_id, projects.project_code,
        projects.year, coalesce(nullif(btrim(projects.detail_project_name),''),
          nullif(btrim(projects.fund_project_name),''), nullif(btrim(projects.project_name),'')) project_name,
        projects.original_alloc::bigint::text original_alloc,
        projects.increase_amount::bigint::text increase_amount,
        projects.decrease_amount::bigint::text decrease_amount,
        projects.alloc::bigint::text adjusted_allocation,
        projects.exec::bigint::text execution_amount,
        public.financial_budget_change_visible_decrease(projects.id)::bigint::text visible_decrease,
        (coalesce(projects.alloc,0)-coalesce(projects.exec,0))::bigint::text raw_unexecuted,
        positions.ledger_original_allocation::bigint::text ledger_original,
        positions.ledger_increase_amount::bigint::text ledger_increase,
        positions.ledger_decrease_amount::bigint::text ledger_decrease,
        positions.ledger_adjusted_allocation::bigint::text ledger_adjusted,
        positions.ledger_execution_amount::bigint::text ledger_execution,
        positions.current_wallet_balance::bigint::text ledger_unexecuted,
        positions.projection_ready
      from public.projects
      left join public.financial_project_funding_positions positions on positions.project_id=projects.id
      where projects.region_id=$1 and projects.year in (2026,2027)
      order by projects.year, project_name, projects.project_code`, [profile.region_id])).rows;
    const sources = projects.filter((row) => row.year === 2026 && row.project_name === SOURCE_NAME);
    if (sources.length !== 1) fail(`Expected one exact Sunchang source, found ${sources.length}.`);
    const source = sources[0];

    const [position, existingCandidates, nextYearCandidates, adminRequests] = await Promise.all([
      rpc(local.client, 'get_financial_budget_change_project_position', { p_project_id: source.id }),
      rpc(local.client, 'get_financial_budget_change_candidates', {
        p_anchor_project_id: source.id, p_search: null, p_year: null, p_require_available: false,
      }),
      rpc(local.client, 'get_financial_budget_change_next_year_candidates', {
        p_anchor_project_id: source.id, p_search: null,
      }),
      rpc(admin.client, 'get_financial_budget_change_requests', {
        p_project_id: null, p_status: null, p_year: null, p_region_id: profile.region_id,
      }),
    ]);
    const active = (await pg.query(`select requests.id, requests.status, requests.total_amount::bigint::text,
        requests.reason, requests.idempotency_key, requests.requested_at,
        coalesce(jsonb_agg(jsonb_build_object(
          'line_id', lines.id,
          'line_no', lines.line_no,
          'type', lines.destination_type,
          'amount', lines.amount,
          'destination_project_id', lines.destination_project_id,
          'planned_project_name', lines.planned_project_name,
          'planned_project_year', lines.planned_project_year,
          'new_project_request_id', lines.new_project_request_id
        ) order by lines.line_no) filter(where lines.id is not null),'[]'::jsonb) destinations
      from public.financial_budget_change_requests requests
      left join public.financial_budget_change_request_lines lines on lines.request_id=requests.id
      where requests.source_project_id=$1
        and requests.status in ('DRAFT','SUBMITTED','APPROVED')
      group by requests.id order by requests.requested_at desc`, [source.id])).rows;
    const queue = (await pg.query(`select
        count(*) filter(where status='SUBMITTED')::integer db_pending_requests,
        count(*) filter(where status='SUBMITTED' and region_id=$1)::integer sunchang_pending_requests
      from public.financial_budget_change_requests`, [profile.region_id])).rows[0];
    const newProjectLinks = (await pg.query(`select new_requests.id, new_requests.status,
        new_requests.project_name, new_requests.fiscal_year,
        new_requests.requested_amount::bigint::text, new_requests.source_budget_change_request_id,
        new_requests.source_budget_change_line_id, new_requests.materialized_project_id
      from public.financial_new_project_requests new_requests
      where new_requests.region_id=$1
        and new_requests.source_budget_change_request_id is not null
      order by new_requests.requested_at desc limit 20`, [profile.region_id])).rows;
    const migrations = (await pg.query(`select
        to_regprocedure('public.financial_create_budget_change_request(uuid,jsonb,date,text,uuid,boolean)') is not null generic_engine,
        to_regprocedure('public.financial_test_uat_create_budget_change_request(uuid,uuid,jsonb,date,text,uuid,boolean)') is not null test_uat_wrapper,
        to_regprocedure('public.financial_approve_budget_change_request_group(uuid,jsonb)') is not null grouped_approval,
        exists(select 1 from information_schema.columns where table_schema='public'
          and table_name='financial_budget_change_request_lines' and column_name='new_project_request_id') linked_new_project_request`)).rows[0];
    await pg.query('commit');

    const normalizedAdminRequests = Array.isArray(adminRequests) ? adminRequests : [];
    const adminPending = normalizedAdminRequests.filter((row) => row.status === 'SUBMITTED');
    process.stdout.write(`${JSON.stringify({
      status: 'PASS', target: 'TEST', project_ref: TEST_REF, production_touched: false,
      auth: { local_a: 'PASS', admin_a: 'PASS', region: profile.display_name },
      runtime, migrations,
      source, authenticated_position: position[0] ?? null,
      inventory: {
        sunchang_2026_projects: projects.filter((row) => row.year === 2026).length,
        sunchang_2027_projects: projects.filter((row) => row.year === 2027).length,
        same_year_candidates: existingCandidates,
        registered_next_year_candidates: nextYearCandidates,
      },
      source_active_requests: active,
      linked_new_project_requests: newProjectLinks,
      queue: { ...queue, admin_rpc_pending_requests: adminPending.length },
    }, null, 2)}\n`);
  } finally {
    await pg.query('rollback').catch(() => undefined);
    await pg.end().catch(() => undefined);
    await Promise.allSettled([local.client.auth.signOut(), admin.client.auth.signOut()]);
  }
}

main().catch((error) => {
  process.stderr.write(`SUNCHANG READ-ONLY AUDIT FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
