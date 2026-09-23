#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';

function fail(message) { throw new Error(message); }

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

async function main() {
  const envArg = process.argv.indexOf('--env-file');
  const envPath = envArg >= 0 ? process.argv[envArg + 1] : null;
  if (!envPath) fail('--env-file is required.');
  const resolved = path.resolve(process.cwd(), envPath);
  if (!fs.existsSync(resolved)) fail('Explicit TEST env file does not exist.');
  const env = dotenv.parse(fs.readFileSync(resolved));
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '').trim();
  const publicRef = refFromPublicUrl(String(env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim());
  const databaseRef = refFromDatabaseUrl(databaseUrl);
  if (String(env.TARGET_ENV ?? '').trim().toUpperCase() !== 'TEST'
      || String(env.TEST_PROJECT_REF ?? '').trim() !== TEST_REF
      || String(env.PROD_PROJECT_REF ?? '').trim() !== PROD_REF
      || publicRef !== TEST_REF || databaseRef !== TEST_REF || databaseRef === PROD_REF) {
    fail('Fail-closed target gate rejected a non-TEST or mismatched configuration.');
  }

  const client = new Client({
    connectionString: databaseConnectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
    application_name: 'budget-change-source-readiness-audit',
  });
  await client.connect();
  try {
    const runtime = await client.query(`select environment_kind, bound_project_ref
      from public.financial_ledger_runtime where singleton = true`);
    if (runtime.rows[0]?.environment_kind !== 'TEST'
        || runtime.rows[0]?.bound_project_ref !== TEST_REF) {
      fail('Ledger runtime is not bound to the approved TEST project.');
    }

    const affected = await client.query(`select
        projects.project_code,
        coalesce(nullif(btrim(projects.detail_project_name), ''),
          nullif(btrim(projects.fund_project_name), ''),
          nullif(btrim(projects.project_name), ''), '사업명 확인 필요') as project_name,
        projects.year,
        regions.sido,
        regions.sigungu,
        coalesce(projects.total_budget, 0)::bigint::text as total_budget,
        coalesce(projects.original_alloc, 0)::bigint::text as original_alloc,
        coalesce(projects.increase_amount, 0)::bigint::text as increase_amount,
        coalesce(projects.decrease_amount, 0)::bigint::text as decrease_amount,
        coalesce(projects.alloc, 0)::bigint::text as adjusted_allocation,
        coalesce(projects.exec, 0)::bigint::text as execution_amount,
        count(wallets.id)::integer as wallet_count,
        count(*) filter (where positions.projection_ready)::integer as ready_position_count,
        coalesce(max(positions.ledger_original_allocation), 0)::bigint::text as ledger_original_allocation,
        coalesce(max(positions.ledger_adjusted_allocation), 0)::bigint::text as ledger_adjusted_allocation
      from public.projects as projects
      join public.regions as regions on regions.id = projects.region_id
      left join public.project_budget_years as wallets on wallets.project_id = projects.id
      left join public.financial_project_funding_positions as positions on positions.project_id = projects.id
      where coalesce(projects.alloc, 0) = 144000000
        and coalesce(projects.exec, 0) = 124800000
      group by projects.id, regions.id
      order by projects.year desc, projects.project_code`);

    const localC = await client.query(`with actor as (
        select profiles.region_id
        from auth.users
        join public.profiles on profiles.id = auth.users.id
        where lower(auth.users.email) = 'review-user-5@example.invalid'
        limit 1
      )
      select regions.sido, regions.sigungu,
        count(distinct projects.id)::integer as project_count,
        count(distinct wallets.id)::integer as wallet_count,
        count(distinct projects.id) filter (where coalesce(projects.alloc, 0) > 0)::integer
          as raw_allocated_project_count,
        count(distinct projects.id) filter (where coalesce(projects.exec, 0) > 0)::integer
          as raw_executed_project_count,
        count(distinct projects.id) filter (
          where coalesce(projects.increase_amount, 0) <> 0
             or coalesce(projects.decrease_amount, 0) <> 0
        )::integer as raw_adjusted_project_count,
        count(distinct projects.id) filter (
          where coalesce(projects.exec, 0) > coalesce(projects.alloc, 0)
        )::integer as invalid_execution_project_count,
        count(distinct projects.id) filter (
          where greatest(coalesce(projects.alloc, 0) - coalesce(projects.exec, 0), 0) > 0
        )::integer as raw_available_project_count,
        coalesce(sum(distinct pending.amount) filter (where pending.status = 'WAITING'), 0)::bigint::text
          as waiting_pending_amount,
        count(distinct pending.id) filter (where pending.status = 'WAITING')::integer
          as waiting_pending_count,
        count(distinct lots.id)::integer as unallocated_lot_count
      from actor
      join public.regions on regions.id = actor.region_id
      left join public.projects on projects.region_id = actor.region_id
      left join public.project_budget_years as wallets on wallets.project_id = projects.id
      left join public.financial_pending_new_project_funds as pending on pending.region_id = actor.region_id
      left join public.financial_unallocated_fund_lots as lots on lots.region_id = actor.region_id
      group by regions.id`);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      target: 'TEST',
      production_touched: false,
      affected_projects: affected.rows,
      local_c_region_readiness: localC.rows[0] ?? null,
    }, null, 2)}\n`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
