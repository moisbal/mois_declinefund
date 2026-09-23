#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';

function fail(message) {
  throw new Error(message);
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function databaseRef(value) {
  try {
    const url = new URL(value);
    return url.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i)?.[1]
      ?? decodeURIComponent(url.username).match(/^postgres\.([a-z0-9-]+)$/i)?.[1]
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

async function main() {
  const envPath = path.resolve(process.cwd(), process.argv[2] ?? '');
  if (!process.argv.includes('--confirm-test-write') || !fs.existsSync(envPath)) {
    fail('Usage: node scripts/apply-generic-budget-adjustment-test.cjs <test-env> --confirm-test-write');
  }
  const env = dotenv.parse(fs.readFileSync(envPath));
  const migrationName = arg('--migration')
    ?? '20260829000100_generic_budget_adjustment_engine.sql';
  const allowedMigrations = new Set([
    '20260829000100_generic_budget_adjustment_engine.sql',
    '20260831000100_generic_budget_adjustment_trace_hotfix.sql',
    '20260831000200_generic_budget_adjustment_ambiguity_hotfix.sql',
    '20260831000300_generic_budget_adjustment_canonical_decrease_hotfix.sql',
    '20260831000400_budget_adjustment_idempotency_state_machine_hotfix.sql',
    '20260831000500_budget_adjustment_insert_defaults_hotfix.sql',
    '20260831000600_budget_adjustment_draft_upsert.sql',
  ]);
  if (!allowedMigrations.has(migrationName)) fail('Migration is not approved by this TEST runner.');
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '').trim();
  if (env.TARGET_ENV !== 'TEST'
      || env.TEST_PROJECT_REF !== TEST_REF
      || env.PROD_PROJECT_REF !== PROD_REF
      || databaseRef(databaseUrl) !== TEST_REF
      || databaseRef(databaseUrl) === PROD_REF) {
    fail('Fail-closed TEST target gate rejected configuration.');
  }
  const rollbackOnly = process.argv.includes('--rollback');

  const client = new Client({
    connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
    application_name: 'generic-budget-adjustment-test-migration',
  });
  await client.connect();
  try {
    await client.query("set statement_timeout = '120s'");
    const runtime = (await client.query(`select environment_kind, mode, bound_project_ref
      from public.financial_ledger_runtime where singleton = true`)).rows[0];
    if (runtime?.environment_kind !== 'TEST'
        || runtime?.mode !== 'TEST'
        || runtime?.bound_project_ref !== TEST_REF) {
      fail('Remote runtime is not the approved TEST runtime.');
    }

    const migration = fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations', migrationName), 'utf8');
    const executableMigration = rollbackOnly
      ? migration.replace(/commit;\s*$/i, '-- COMMIT withheld for rollback dry-run')
      : migration;
    if (rollbackOnly && executableMigration === migration) fail('Rollback dry-run could not replace terminal COMMIT.');
    await client.query(executableMigration);

    const check = (await client.query(`select
      current_database() as database_name,
      (select environment_kind from public.financial_ledger_runtime where singleton) as environment_kind,
      (select bound_project_ref from public.financial_ledger_runtime where singleton) as bound_project_ref,
      exists(select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'financial_budget_change_request_lines'
          and column_name = 'new_project_request_id') as new_column,
      to_regprocedure('public.financial_approve_budget_change_request_group(uuid,jsonb)') is not null
        as group_approve,
      position('atomic_group_apply' in lower(pg_get_functiondef(
        'public.financial_apply_budget_change_request(uuid)'::regprocedure))) > 0 as generic_apply,
      to_regprocedure('public.financial_trace_grouped_budget_destination()') is not null
        and exists(select 1 from pg_trigger
          where tgrelid = 'public.financial_budget_change_requests'::regclass
            and tgname = 'financial_trace_grouped_budget_destination'
            and not tgisinternal) as grouped_trace,
      exists(select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'financial_budget_change_requests'
          and column_name = 'adjustment_fingerprint') as adjustment_fingerprint_column,
      to_regclass('public.financial_budget_change_active_adjustment_uidx') is not null
        as active_adjustment_unique,
      to_regprocedure('public.financial_guard_budget_change_state_transition()') is not null
        and exists(select 1 from pg_trigger
          where tgrelid = 'public.financial_budget_change_requests'::regclass
            and tgname = 'financial_budget_change_state_transition_guard'
            and not tgisinternal) as state_guard,
      position('#variable_conflict use_column' in lower(pg_get_functiondef(
        'public.financial_reject_budget_change_request(uuid,text)'::regprocedure))) > 0
        as reject_ambiguity_guard,
      not exists(select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'financial_budget_change_requests'
          and column_name in ('source_adjustment_revision','draft_revision_id','adjustment_fingerprint')
          and column_default is null) as insert_defaults_ready,
      to_regprocedure('public.financial_test_uat_save_budget_change_request(uuid,uuid,jsonb,date,text,uuid,boolean)') is not null
        and position('new_requests.status=''draft''' in lower(pg_get_functiondef(
          'public.financial_submit_budget_change_request(uuid)'::regprocedure))) > 0
        as draft_upsert_ready,
      (select count(*)::integer from (
        select requests.id
        from public.financial_budget_change_requests as requests
        left join public.financial_budget_change_request_lines as lines
          on lines.request_id = requests.id
        group by requests.id, requests.total_amount
        having requests.total_amount <> coalesce(sum(lines.amount), 0)
      ) as gaps) as monetary_gap_count`)).rows[0];
    if (!check.new_column || !check.group_approve || !check.generic_apply
        || (migrationName.includes('trace_hotfix') && !check.grouped_trace)
        || (migrationName.includes('idempotency_state_machine_hotfix')
          && (!check.adjustment_fingerprint_column || !check.active_adjustment_unique
            || !check.state_guard || !check.reject_ambiguity_guard))
        || (migrationName.includes('insert_defaults_hotfix') && !check.insert_defaults_ready)
        || (migrationName.includes('draft_upsert') && !check.draft_upsert_ready)
        || Number(check.monetary_gap_count) !== 0) {
      fail('Post-migration integrity check failed.');
    }
    if (rollbackOnly) await client.query('rollback');
    process.stdout.write(`${JSON.stringify({
      status: 'PASS',
      transaction: rollbackOnly ? 'ROLLED_BACK' : 'COMMITTED',
      target: 'TEST',
      migration: migrationName,
      project_ref: TEST_REF,
      production_touched: false,
      ...check,
    }, null, 2)}\n`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`GENERIC BUDGET MIGRATION APPLY FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
