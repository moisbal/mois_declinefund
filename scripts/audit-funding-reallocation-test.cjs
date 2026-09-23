#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

// Two deterministic funding UAT runs have each materialized three approved
// TEST-only projects since the original 3,899-row clone baseline.
const EXPECTED_PROJECT_COUNT = 3_905;
const EXPECTED_UNCLASSIFIED_COUNT = 4;
const EXPECTED_UNCLASSIFIED_AMOUNT = '187703000';
const UAT_NEW_PROJECT_CODE = '2025-26-140-9001';
const DELTA_TABLES = [
  'financial_unallocated_fund_lots',
  'financial_unallocated_fund_movements',
  'financial_project_decrease_classifications',
  'financial_project_decrease_classification_reversals',
  'financial_project_baseline_attestations',
  'financial_funding_reallocation_requests',
  'financial_new_project_requests',
];

function fail(message) {
  throw new Error(message);
}

function projectRefFromHttp(value) {
  try {
    return new URL(value).hostname.toLowerCase()
      .match(/^([a-z0-9-]+)\.supabase\.co$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function projectRefFromDatabase(value) {
  try {
    const url = new URL(value);
    const username = decodeURIComponent(url.username);
    return url.hostname.toLowerCase().match(/^db\.([a-z0-9-]+)\.supabase\.co$/)?.[1]
      ?? username.match(/^postgres\.([a-z0-9-]+)$/)?.[1]
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

function maskRef(value) {
  return value.length <= 6 ? '***' : `${value.slice(0, 3)}***${value.slice(-3)}`;
}

async function main() {
  const envArgument = process.argv[2];
  if (!envArgument || process.argv.length !== 3) {
    fail('Usage: node scripts/audit-funding-reallocation-test.cjs <explicit-test-env-file>');
  }

  const envPath = path.resolve(process.cwd(), envArgument);
  if (!fs.existsSync(envPath)) fail('The explicit TEST env file does not exist.');
  const env = dotenv.parse(fs.readFileSync(envPath));
  const testRef = String(env.TEST_PROJECT_REF ?? '').trim();
  const prodRef = String(env.PROD_PROJECT_REF ?? '').trim();
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '').trim();
  const publicRef = projectRefFromHttp(env.NEXT_PUBLIC_SUPABASE_URL ?? '');
  const databaseRef = projectRefFromDatabase(databaseUrl);

  if (String(env.TARGET_ENV ?? '').trim().toUpperCase() !== 'TEST'
      || String(env.LEDGER_MODE ?? '').trim().toUpperCase() !== 'RECONCILIATION'
      || !testRef || !prodRef || testRef === prodRef
      || publicRef !== testRef || databaseRef !== testRef || databaseRef === prodRef) {
    fail('Fail-closed target gate rejected a non-TEST or mismatched configuration.');
  }

  const client = new Client({
    connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
    application_name: 'funding-delta-final-test-audit',
  });

  await client.connect();
  try {
    await client.query("set statement_timeout = '30s'");
    const runtimeResult = await client.query(`
      select environment_kind, mode, bound_project_ref,
        baseline_as_of::text, native_start_date::text
      from public.financial_ledger_runtime
    `);
    if (runtimeResult.rowCount !== 1) fail('Expected exactly one financial ledger runtime row.');
    const runtime = runtimeResult.rows[0];
    if (runtime.environment_kind !== 'TEST'
        || runtime.mode !== 'RECONCILIATION'
        || runtime.bound_project_ref !== testRef
        || runtime.baseline_as_of !== '2026-08-31'
        || runtime.native_start_date !== '2026-09-01') {
      fail('Runtime no longer matches the approved TEST reconciliation baseline.');
    }

    const projects = await client.query('select count(*)::integer as count from public.projects');
    const projectCount = projects.rows[0].count;
    if (projectCount !== EXPECTED_PROJECT_COUNT) {
      fail(`Unexpected project count: ${projectCount}`);
    }

    const officialCode = await client.query(
      'select count(*)::integer as count from public.projects where project_code = $1',
      [UAT_NEW_PROJECT_CODE],
    );
    if (officialCode.rows[0].count !== 1) fail('UAT official project code is missing or duplicated.');

    const unclassified = await client.query(`
      select count(*)::integer as count,
        coalesce(sum(unclassified_amount), 0)::text as amount
      from public.financial_unclassified_project_decreases
    `);
    if (unclassified.rows[0].count !== EXPECTED_UNCLASSIFIED_COUNT
        || unclassified.rows[0].amount !== EXPECTED_UNCLASSIFIED_AMOUNT) {
      fail('The four pre-existing unclassified decreases changed unexpectedly.');
    }

    const invariants = await client.query(`
      select count(*)::integer as cohort_count,
        count(*) filter (
          where cohort_conservation_gap <> 0 or decrease_resolution_gap <> 0
        )::integer as nonzero_gap_count,
        coalesce(max(abs(cohort_conservation_gap)), 0)::text as max_conservation_gap,
        coalesce(max(abs(decrease_resolution_gap)), 0)::text as max_decrease_gap
      from public.financial_funding_invariant_check
    `);
    if (invariants.rows[0].nonzero_gap_count !== 0) {
      fail('A funding accounting invariant is non-zero.');
    }

    const rls = await client.query(`
      select count(*)::integer as enabled_count
      from pg_catalog.pg_class as tables
      join pg_catalog.pg_namespace as schemas on schemas.oid = tables.relnamespace
      where schemas.nspname = 'public'
        and tables.relname = any($1::text[])
        and tables.relrowsecurity
    `, [DELTA_TABLES]);
    if (rls.rows[0].enabled_count !== DELTA_TABLES.length) {
      fail('RLS is not enabled on every funding delta table.');
    }

    const rowCounts = {};
    for (const table of DELTA_TABLES) {
      const result = await client.query(`select count(*)::integer as count from public.${table}`);
      rowCounts[table] = result.rows[0].count;
    }

    process.stdout.write(`${JSON.stringify({
      status: 'PASS',
      target: 'TEST',
      project_ref: maskRef(testRef),
      runtime: {
        mode: runtime.mode,
        baseline_as_of: runtime.baseline_as_of,
        native_start_date: runtime.native_start_date,
      },
      projects: {
        count: projectCount,
        uat_new_official_code_count: officialCode.rows[0].count,
      },
      pre_existing_unclassified_decreases: unclassified.rows[0],
      invariants: invariants.rows[0],
      rls_enabled_delta_tables: rls.rows[0].enabled_count,
      delta_table_row_counts: rowCounts,
    }, null, 2)}\n`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`FINAL TEST AUDIT FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
