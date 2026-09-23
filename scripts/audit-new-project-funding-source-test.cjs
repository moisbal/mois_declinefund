#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';

function fail(message) { throw new Error(message); }
function required(env, key) {
  const value = String(env[key] ?? '').trim();
  if (!value) fail(`${key} is required.`);
  return value;
}
function load(file) {
  const resolved = path.resolve(process.cwd(), file ?? '');
  if (!file || !fs.existsSync(resolved)) fail(`Missing explicit env file: ${file ?? '(none)'}`);
  return dotenv.parse(fs.readFileSync(resolved));
}
function databaseRef(value) {
  const url = new URL(value);
  return url.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i)?.[1]
    ?? decodeURIComponent(url.username).match(/^postgres\.([a-z0-9-]+)$/i)?.[1] ?? null;
}
function apiRef(value) {
  return new URL(value).hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i)?.[1] ?? null;
}
function connectionString(value) {
  const url = new URL(value);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('uselibpqcompat');
  return url.toString();
}
async function rpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) fail(`${name}: ${error.code ?? 'RPC'} ${error.message}`);
  return data ?? [];
}

async function main() {
  if (process.argv.length !== 4) {
    fail('Usage: node scripts/audit-new-project-funding-source-test.cjs <test-env> <uat-credentials>');
  }
  const env = { ...load(process.argv[2]), ...load(process.argv[3]) };
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  const supabaseUrl = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (String(env.TARGET_ENV).toUpperCase() !== 'TEST'
      || env.TEST_PROJECT_REF !== TEST_REF || env.PROD_PROJECT_REF !== PROD_REF
      || apiRef(supabaseUrl) !== TEST_REF || databaseRef(databaseUrl) !== TEST_REF
      || databaseRef(databaseUrl) === PROD_REF) {
    fail('Fail-closed TEST target gate rejected configuration.');
  }

  const local = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: auth, error: authError } = await local.auth.signInWithPassword({
    email: required(env, 'UAT_LOCAL_A_EMAIL'),
    password: required(env, 'UAT_LOCAL_A_PASSWORD'),
  });
  if (authError || !auth.user) fail('TEST local_a authentication failed.');

  const pg = new Client({
    connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
    application_name: 'audit-new-project-funding-source-test',
  });
  await pg.connect();
  try {
    await pg.query('begin read only');
    await pg.query("set local statement_timeout='45s'");
    const runtime = (await pg.query(`select environment_kind,mode,bound_project_ref
      from public.financial_ledger_runtime where singleton`)).rows[0];
    if (runtime?.environment_kind !== 'TEST' || runtime?.bound_project_ref !== TEST_REF) {
      fail('Ledger runtime is not the approved TEST target.');
    }
    const profile = (await pg.query(`select profiles.role,profiles.region_id,profiles.region_name
      from public.profiles where profiles.id=$1`, [auth.user.id])).rows[0];
    if (profile?.role !== 'local_user') fail('local_a is not a local_user.');

    const [fundingSourceRows, pendingRows, requestRows] = await Promise.all([
      rpc(local, 'get_financial_new_project_funding_sources', {
        p_year: null, p_request_id: null,
      }),
      rpc(local, 'get_financial_pending_new_project_funds', {
        p_status: 'WAITING', p_year: null, p_region_id: profile.region_id,
      }),
      rpc(local, 'get_financial_new_project_requests', { p_status: null }),
    ]);
    const eligible = (await pg.query(`select pending.id,pending.lot_id,pending.amount::text,
      balances.remaining_amount::text,pending.status,pending.region_id,
      pending.fiscal_year source_fiscal_year,pending.planned_project_year expected_target_year,
      source.id source_project_id,source.project_code source_project_code,
      coalesce(nullif(btrim(source.detail_project_name),''),
        nullif(btrim(source.fund_project_name),''),source.project_name) source_project_name,
      claimed.id claimed_request_id,claimed.status claimed_request_status,
      pending.linked_project_id,pending.created_at
      from public.financial_pending_new_project_funds pending
      join public.financial_unallocated_fund_lot_balances balances on balances.lot_id=pending.lot_id
      join public.financial_budget_change_requests budget on budget.id=pending.source_request_id
      join public.projects source on source.id=budget.source_project_id
      left join lateral (select requests.id,requests.status
        from public.financial_new_project_requests requests
        where requests.source_lot_id=pending.lot_id
          and requests.status in ('DRAFT','SUBMITTED','APPROVED')
        order by requests.requested_at desc limit 1) claimed on true
      where pending.region_id=$1 and pending.status='WAITING'
        and pending.planned_project_year=pending.fiscal_year+1
        and balances.remaining_amount>0
        and balances.remaining_amount>=pending.amount
        and not exists (select 1 from public.financial_pending_new_project_link_requests links
          where links.pending_fund_id=pending.id and links.status in ('SUBMITTED','APPROVED','APPLIED'))
        and claimed.id is null
      order by pending.created_at desc`, [profile.region_id])).rows;
    const allWaiting = (await pg.query(`select regions.display_name region,
      count(*)::integer waiting_count,coalesce(sum(pending.amount),0)::text amount
      from public.financial_pending_new_project_funds pending
      join public.regions on regions.id=pending.region_id
      where pending.status='WAITING' group by regions.display_name order by regions.display_name`)).rows;
    let crossRegionBlocked = false;
    const otherRegion = (await pg.query(`select id from public.regions where id<>$1 order by id limit 1`,
      [profile.region_id])).rows[0];
    if (otherRegion) {
      const { error } = await local.rpc('get_financial_pending_new_project_funds', {
        p_status: 'WAITING', p_year: null, p_region_id: otherRegion.id,
      });
      crossRegionBlocked = error?.code === '42501';
    }
    await pg.query('commit');

    const currentUiRows = fundingSourceRows.filter((row) => BigInt(row.remaining_amount ?? '0') >= BigInt(row.amount ?? '0'));
    const directPendingRows = pendingRows.filter((row) => row.status === 'WAITING');
    process.stdout.write(`${JSON.stringify({
      status: 'PASS', target: 'TEST', production_touched: false, runtime,
      local_a: profile,
      current_ui_query: 'get_financial_new_project_funding_sources',
      current_ui_dropdown_count: currentUiRows.length,
      correct_pending_rpc_count: directPendingRows.length,
      database_eligible_count: eligible.length,
      eligible_rows: eligible,
      existing_local_request_count: requestRows.length,
      all_waiting_by_region: allWaiting,
      cross_region_rpc_blocked: crossRegionBlocked,
      mismatch: currentUiRows.length !== eligible.length,
    }, null, 2)}\n`);
  } finally {
    await pg.query('rollback').catch(() => undefined);
    await pg.end().catch(() => undefined);
    await local.auth.signOut().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`NEW PROJECT FUNDING SOURCE TEST AUDIT FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
