#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';
const TARGET_CODE = '2024-51-800-0001';

function fail(message) { throw new Error(message); }
function required(env, key) {
  const value = String(env[key] ?? '').trim();
  if (!value) fail(`Missing ${key}.`);
  return value;
}
function refFromPublicUrl(value) {
  try { return new URL(value).hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i)?.[1] ?? null; }
  catch { return null; }
}
function refFromDatabaseUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i)?.[1]
      ?? decodeURIComponent(url.username).match(/^postgres\.([a-z0-9-]+)$/i)?.[1]
      ?? null;
  } catch { return null; }
}
function databaseConnectionString(value) {
  const url = new URL(value);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('uselibpqcompat');
  return url.toString();
}
async function signIn(url, anonKey, email, password, alias) {
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user || !data.session) fail(`${alias} TEST authentication failed.`);
  return { alias, client, userId: data.user.id };
}
async function rpc(account, functionName, args, label) {
  const { data, error } = await account.client.rpc(functionName, args);
  if (error) fail(`${label}: ${error.message}`);
  return data ?? [];
}

async function main() {
  const envIndex = process.argv.indexOf('--env-file');
  const envPath = envIndex >= 0 ? process.argv[envIndex + 1] : null;
  const credentialsIndex = process.argv.indexOf('--credentials-file');
  const credentialsPath = credentialsIndex >= 0 ? process.argv[credentialsIndex + 1] : null;
  if (!envPath) fail('--env-file is required.');
  if (!credentialsPath) fail('--credentials-file is required.');
  const resolved = path.resolve(process.cwd(), envPath);
  const credentialsResolved = path.resolve(process.cwd(), credentialsPath);
  if (!fs.existsSync(resolved)) fail('Explicit TEST env file does not exist.');
  if (!fs.existsSync(credentialsResolved)) fail('Explicit TEST credentials file does not exist.');
  const env = dotenv.parse(fs.readFileSync(resolved));
  const credentials = dotenv.parse(fs.readFileSync(credentialsResolved));
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  const supabaseUrl = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const publicRef = refFromPublicUrl(supabaseUrl);
  const databaseRef = refFromDatabaseUrl(databaseUrl);
  if (required(env, 'TARGET_ENV').toUpperCase() !== 'TEST'
      || required(env, 'TEST_PROJECT_REF') !== TEST_REF
      || required(env, 'PROD_PROJECT_REF') !== PROD_REF
      || publicRef !== TEST_REF || databaseRef !== TEST_REF || databaseRef === PROD_REF) {
    fail('Fail-closed target gate rejected a non-TEST or mismatched configuration.');
  }

  const pg = new Client({
    connectionString: databaseConnectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
    application_name: 'trace-yanggu-budget-change-e2e-test',
  });
  await pg.connect();
  const localC = await signIn(supabaseUrl, anonKey,
    required(credentials, 'UAT_LOCAL_C_EMAIL'), required(credentials, 'UAT_LOCAL_C_PASSWORD'), 'local_c');
  const adminA = await signIn(supabaseUrl, anonKey,
    required(credentials, 'UAT_ADMIN_A_EMAIL'), required(credentials, 'UAT_ADMIN_A_PASSWORD'), 'admin_a');
  try {
    const runtime = (await pg.query(`select environment_kind, mode, bound_project_ref,
        native_start_date::text as native_start_date
      from public.financial_ledger_runtime where singleton = true`)).rows[0];
    if (runtime?.environment_kind !== 'TEST' || runtime?.mode !== 'TEST'
        || runtime?.bound_project_ref !== TEST_REF) fail('Ledger runtime is not approved TEST runtime.');

    const profile = (await pg.query(`select profiles.region_id, regions.sido, regions.sigungu
      from public.profiles join public.regions on regions.id = profiles.region_id
      where profiles.id = $1`, [localC.userId])).rows[0];
    if (`${profile?.sido} ${profile?.sigungu}` !== '강원 양구군') {
      fail('local_c is not scoped to 강원 양구군.');
    }

    const rows = (await pg.query(`select
        projects.id::text as project_id, projects.project_code,
        coalesce(nullif(btrim(projects.detail_project_name), ''),
          nullif(btrim(projects.fund_project_name), ''),
          nullif(btrim(projects.project_name), ''), '사업명 확인 필요') as project_name,
        projects.year,
        coalesce(projects.original_alloc, 0)::bigint::text as raw_original,
        coalesce(projects.increase_amount, 0)::bigint::text as raw_increase,
        coalesce(projects.decrease_amount, 0)::bigint::text as raw_decrease,
        coalesce(projects.alloc, 0)::bigint::text as raw_adjusted,
        coalesce(projects.exec, 0)::bigint::text as raw_execution,
        (coalesce(projects.alloc, 0) - coalesce(projects.exec, 0))::bigint::text as raw_unexecuted,
        coalesce(max(positions.ledger_original_allocation), projects.original_alloc,
          projects.alloc + projects.decrease_amount - projects.increase_amount, 0)::bigint::text as visible_original,
        coalesce(max(positions.ledger_increase_amount), projects.increase_amount, 0)::bigint::text as visible_increase,
        coalesce(max(positions.ledger_decrease_amount), projects.decrease_amount, 0)::bigint::text as visible_decrease,
        coalesce(max(positions.ledger_adjusted_allocation), projects.alloc, 0)::bigint::text as visible_adjusted,
        coalesce(max(positions.ledger_execution_amount), projects.exec, 0)::bigint::text as visible_execution,
        (coalesce(max(positions.ledger_adjusted_allocation), projects.alloc, 0)
          - coalesce(max(positions.ledger_execution_amount), projects.exec, 0))::bigint::text as visible_unexecuted,
        coalesce(max(positions.ledger_execution_rate),
          case when coalesce(projects.alloc, 0) > 0
            then round(projects.exec::numeric * 100 / projects.alloc::numeric, 2) else 0 end)::text as visible_rate,
        coalesce(bool_or(positions.projection_ready), false) as projection_ready,
        max(bootstraps.bootstrap_kind) as bootstrap_kind,
        count(wallets.id)::integer as wallet_count,
        coalesce(max(balances.available_to_commit), 0)::bigint::text as wallet_available_to_commit
      from public.projects
      left join public.financial_project_funding_positions positions on positions.project_id = projects.id
      left join public.financial_test_uat_project_bootstraps bootstraps on bootstraps.project_id = projects.id
      left join public.project_budget_years wallets on wallets.project_id = projects.id
      left join lateral public.financial_get_budget_year_balance(wallets.id) balances on wallets.id is not null
      where projects.region_id = $1 and projects.year = 2024
      group by projects.id
      order by (coalesce(max(positions.ledger_adjusted_allocation), projects.alloc, 0)
        - coalesce(max(positions.ledger_execution_amount), projects.exec, 0)) desc,
        projects.project_code`, [profile.region_id])).rows;
    const target = rows.find((row) => row.project_code === TARGET_CODE);
    if (!target) fail(`${TARGET_CODE} was not found in TEST.`);
    const rpcPosition = (await rpc(localC, 'get_financial_budget_change_project_position', {
      p_project_id: target.project_id,
    }, 'local_c target position'))[0];

    const [localSubmitted, adminSubmitted, newProjectSubmitted, pendingFunds, pendingLinks] = await Promise.all([
      rpc(localC, 'get_financial_budget_change_requests', {
        p_project_id: null, p_status: 'SUBMITTED', p_year: null, p_region_id: null,
      }, 'local_c submitted budget queue'),
      rpc(adminA, 'get_financial_budget_change_requests', {
        p_project_id: null, p_status: 'SUBMITTED', p_year: null, p_region_id: profile.region_id,
      }, 'admin submitted budget queue'),
      rpc(adminA, 'get_financial_new_project_requests', { p_status: 'SUBMITTED' }, 'admin new-project queue'),
      rpc(adminA, 'get_financial_pending_new_project_funds', {
        p_status: 'WAITING', p_year: null, p_region_id: profile.region_id,
      }, 'admin pending funds'),
      rpc(adminA, 'get_financial_pending_new_project_link_requests', { p_status: 'SUBMITTED' }, 'admin pending links'),
    ]);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      target: 'TEST',
      project_ref: TEST_REF,
      production_touched: false,
      runtime,
      region: `${profile.sido} ${profile.sigungu}`,
      target_project: target,
      target_rpc_position: rpcPosition,
      sufficient_2024_candidates: rows.filter((row) => BigInt(row.visible_unexecuted) >= 20_000_000n),
      queue_counts: {
        local_submitted_budget: localSubmitted.length,
        admin_submitted_budget: adminSubmitted.length,
        admin_submitted_new_project: newProjectSubmitted.length,
        admin_waiting_pending_funds: pendingFunds.length,
        admin_submitted_pending_links: pendingLinks.length,
      },
    }, null, 2)}\n`);
  } finally {
    await Promise.allSettled([localC.client.auth.signOut(), adminA.client.auth.signOut()]);
    await pg.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
