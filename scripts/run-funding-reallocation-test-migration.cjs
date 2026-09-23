#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const MIGRATION_VERSION = '20260824000100';
const MIGRATION_NAME = 'funding_reallocation_delta';
const EXPECTED_SHA256 = 'fd17044b1cadcdf53fefa7e1c9d7fc7970b060bcd17ceb80bb619c7dc0916505';
const MIGRATION_PATH = path.resolve(
  process.cwd(),
  'supabase',
  'migrations',
  `${MIGRATION_VERSION}_${MIGRATION_NAME}.sql`,
);
const NEW_TABLES = [
  'financial_unallocated_fund_lots',
  'financial_unallocated_fund_movements',
  'financial_project_decrease_classifications',
  'financial_project_decrease_classification_reversals',
  'financial_project_baseline_attestations',
  'financial_funding_reallocation_requests',
  'financial_new_project_requests',
];
const SERVICE_VIEWS = [
  'financial_unallocated_fund_lot_balances',
  'financial_project_decrease_classification_effects',
  'financial_unclassified_project_decreases',
  'financial_funding_cohort_execution',
  'financial_project_funding_positions',
  'financial_project_funding_history',
  'financial_funding_invariant_check',
];

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const allowed = new Set(['--env-file', '--action', '--confirm-test-write']);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!allowed.has(argument)) fail(`Unknown argument: ${argument}`);
    if (argument === '--confirm-test-write') {
      values.confirm = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`${argument} requires a value.`);
    values[argument.slice(2).replace('-', '_')] = value;
    index += 1;
  }
  const action = values.action;
  if (!['validate', 'apply'].includes(action)) {
    fail('--action must be validate or apply.');
  }
  if (!values.env_file) fail('--env-file is required.');
  if (action === 'apply' && values.confirm !== true) {
    fail('TEST apply requires --confirm-test-write.');
  }
  return { envFile: path.resolve(process.cwd(), values.env_file), action };
}

function supabaseRefFromUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase()
      .match(/^([a-z0-9-]+)\.supabase\.co$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function supabaseRefFromDatabaseUrl(value) {
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

function databaseConnectionString(value) {
  const url = new URL(value);
  // node-postgres 8.16 lets sslmode from the URL override the explicit TLS
  // object. Remove only those mode selectors and keep every endpoint/auth fact.
  url.searchParams.delete('sslmode');
  url.searchParams.delete('uselibpqcompat');
  return url.toString();
}

function maskRef(value) {
  if (!value) return '(missing)';
  return value.length <= 6 ? '***' : `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function stripOuterTransaction(sql) {
  const beginMatches = [...sql.matchAll(/^[ \t]*begin;[ \t]*\r?$/gim)];
  const commitMatches = [...sql.matchAll(/^[ \t]*commit;[ \t]*\r?$/gim)];
  if (beginMatches.length !== 1 || commitMatches.length !== 1) {
    fail('Pinned migration must contain exactly one outer BEGIN/COMMIT pair.');
  }
  const begin = beginMatches[0];
  const commit = commitMatches[0];
  if (begin.index >= commit.index || sql.slice(commit.index + commit[0].length).trim() !== '') {
    fail('Pinned migration outer transaction is malformed.');
  }
  return `${sql.slice(0, begin.index)}${sql.slice(begin.index + begin[0].length, commit.index)}`;
}

function assertRuntime(runtime, testRef) {
  if (!runtime
      || runtime.environment_kind !== 'TEST'
      || runtime.mode !== 'RECONCILIATION'
      || runtime.bound_project_ref !== testRef
      || runtime.baseline_as_of !== '2026-08-31'
      || runtime.native_start_date !== '2026-09-01') {
    fail('Database runtime is not the approved TEST/RECONCILIATION baseline.');
  }
}

async function snapshot(client) {
  const factsResult = await client.query(`
    select
      count(*)::bigint::text as project_count,
      count(*) filter (where coalesce(decrease_amount, 0) > 0)::bigint::text
        as decreased_project_count,
      coalesce(sum(decrease_amount), 0)::numeric::text as project_decrease_total
    from public.projects
  `);
  const runtimeResult = await client.query(`
    select environment_kind, mode, bound_project_ref,
      baseline_as_of::text, native_start_date::text
    from public.financial_ledger_runtime
    where singleton = true
  `);
  return {
    facts: factsResult.rows[0],
    runtime: runtimeResult.rows[0] ?? null,
  };
}

async function existingDeltaObjects(client) {
  const result = await client.query(`
    select requested.name
    from unnest($1::text[]) as requested(name)
    where to_regclass('public.' || requested.name) is not null
    order by requested.name
  `, [NEW_TABLES]);
  return result.rows.map((row) => row.name);
}

async function postChecks(client, before, testRef) {
  const after = await snapshot(client);
  assertRuntime(after.runtime, testRef);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    fail('Migration changed pre-existing project money or runtime policy.');
  }

  const objectRows = await client.query(`
    select requested.name,
      to_regclass('public.' || requested.name) is not null as present
    from unnest($1::text[]) as requested(name)
  `, [NEW_TABLES]);
  if (objectRows.rows.some((row) => row.present !== true)) {
    fail('One or more required funding tables were not created.');
  }

  const rowCounts = {};
  for (const table of NEW_TABLES) {
    const result = await client.query(`select count(*)::bigint::text as count from public.${table}`);
    rowCounts[table] = result.rows[0].count;
    if (result.rows[0].count !== '0') {
      fail('Migration unexpectedly materialized TEST transaction rows.');
    }
  }

  const unclassified = await client.query(`
    select count(*)::bigint::text as count,
      coalesce(sum(unclassified_amount), 0)::numeric::text as amount
    from public.financial_unclassified_project_decreases
  `);
  if (unclassified.rows[0].count !== before.facts.decreased_project_count
      || unclassified.rows[0].amount !== before.facts.project_decrease_total) {
    fail('Existing decreases were classified, materialized, or hidden during migration.');
  }

  const rls = await client.query(`
    select requested.name, coalesce(classes.relrowsecurity, false) as enabled
    from unnest($1::text[]) as requested(name)
    left join pg_catalog.pg_namespace as namespaces on namespaces.nspname = 'public'
    left join pg_catalog.pg_class as classes
      on classes.relnamespace = namespaces.oid and classes.relname = requested.name
  `, [NEW_TABLES]);
  if (rls.rows.some((row) => row.enabled !== true)) {
    fail('RLS is not enabled on every new funding table.');
  }

  const serviceGrants = await client.query(`
    select requested.name,
      has_table_privilege('service_role', 'public.' || requested.name, 'SELECT') as service_select
    from unnest($1::text[]) as requested(name)
  `, [SERVICE_VIEWS]);
  if (serviceGrants.rows.some((row) => row.service_select !== true)) {
    fail('Service-role analytics SELECT chain is incomplete.');
  }

  const tableGrants = await client.query(`
    select requested.name,
      has_table_privilege('authenticated', 'public.' || requested.name, 'SELECT')
        as authenticated_select,
      has_table_privilege('anon', 'public.' || requested.name, 'SELECT') as anon_select,
      (
        has_table_privilege('authenticated', 'public.' || requested.name, 'INSERT')
        or has_table_privilege('authenticated', 'public.' || requested.name, 'UPDATE')
        or has_table_privilege('authenticated', 'public.' || requested.name, 'DELETE')
        or has_table_privilege('service_role', 'public.' || requested.name, 'INSERT')
        or has_table_privilege('service_role', 'public.' || requested.name, 'UPDATE')
        or has_table_privilege('service_role', 'public.' || requested.name, 'DELETE')
      ) as forbidden_dml
    from unnest($1::text[]) as requested(name)
  `, [NEW_TABLES]);
  if (tableGrants.rows.some((row) => row.authenticated_select !== true
      || row.anon_select === true || row.forbidden_dml === true)) {
    fail('Funding table role grants do not match SELECT-only RLS policy.');
  }

  return {
    project_count: after.facts.project_count,
    existing_decrease_count: after.facts.decreased_project_count,
    existing_decrease_total: after.facts.project_decrease_total,
    unclassified_decrease_count: unclassified.rows[0].count,
    unclassified_decrease_total: unclassified.rows[0].amount,
    new_table_row_counts: rowCounts,
    rls_tables: rls.rows.length,
    service_views: serviceGrants.rows.length,
  };
}

async function openClient(databaseUrl, action) {
  const client = new Client({
    connectionString: databaseConnectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
    application_name: `funding-delta-${action}`,
  });
  await client.connect();
  return client;
}

async function confirmRolledBack(databaseUrl, before) {
  const client = await openClient(databaseUrl, 'rollback-proof');
  try {
    const after = await snapshot(client);
    const objects = await existingDeltaObjects(client);
    if (JSON.stringify(after) !== JSON.stringify(before) || objects.length !== 0) {
      fail('Rollback proof failed: schema/data/runtime state changed.');
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main() {
  const { envFile, action } = parseArguments(process.argv.slice(2));
  if (!fs.existsSync(envFile)) fail('The explicit TEST env file does not exist.');
  const env = dotenv.parse(fs.readFileSync(envFile));
  const targetEnv = (env.TARGET_ENV ?? '').trim().toUpperCase();
  const ledgerMode = (env.LEDGER_MODE ?? '').trim().toUpperCase();
  const testRef = (env.TEST_PROJECT_REF ?? '').trim();
  const prodRef = (env.PROD_PROJECT_REF ?? '').trim();
  const publicRef = supabaseRefFromUrl(env.NEXT_PUBLIC_SUPABASE_URL ?? '');
  const databaseUrl = env.TEST_DATABASE_URL ?? '';
  const databaseRef = supabaseRefFromDatabaseUrl(databaseUrl);
  if (targetEnv !== 'TEST' || ledgerMode !== 'RECONCILIATION'
      || !testRef || !prodRef || testRef === prodRef
      || publicRef !== testRef || databaseRef !== testRef || databaseRef === prodRef) {
    fail('Fail-closed target gate rejected a non-TEST or mismatched configuration.');
  }

  const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const actualSha256 = crypto.createHash('sha256').update(migrationSql).digest('hex');
  if (actualSha256 !== EXPECTED_SHA256) {
    fail('Migration SHA-256 differs from the independently reviewed SQL.');
  }
  const bodySql = stripOuterTransaction(migrationSql);

  const client = await openClient(databaseUrl, action);
  let transactionOpen = false;
  let before;
  try {
    before = await snapshot(client);
    assertRuntime(before.runtime, testRef);
    const existingObjects = await existingDeltaObjects(client);
    if (existingObjects.length !== 0) {
      fail(`Funding delta objects already exist: ${existingObjects.join(', ')}`);
    }
    if (before.facts.decreased_project_count !== '4') {
      fail('Approved TEST precondition requires exactly four unclassified physical decreases.');
    }

    await client.query('begin');
    transactionOpen = true;
    const migrationLock = await client.query(
      "select pg_try_advisory_xact_lock(pg_catalog.hashtextextended('funding-reallocation-test-migration', 20260824000100)) as locked",
    );
    if (migrationLock.rows[0]?.locked !== true) {
      fail('Another TEST funding migration is already running.');
    }
    await client.query("set local lock_timeout = '10s'");
    await client.query("set local statement_timeout = '240s'");
    await client.query("set local idle_in_transaction_session_timeout = '260s'");
    await client.query(bodySql);
    const checks = await postChecks(client, before, testRef);

    if (action === 'validate') {
      await client.query('rollback');
      transactionOpen = false;
      await confirmRolledBack(databaseUrl, before);
      process.stdout.write(`${JSON.stringify({
        ok: true,
        action,
        transaction: 'ROLLED_BACK',
        target: 'TEST',
        test_project_ref: maskRef(testRef),
        migration_version: MIGRATION_VERSION,
        migration_sha256: actualSha256,
        migration_history: 'target-has-no-app-migration-history-table',
        checks,
        rollback_proof: true,
      }, null, 2)}\n`);
      return;
    }

    await client.query('commit');
    transactionOpen = false;
    const committedObjects = await existingDeltaObjects(client);
    if (committedObjects.length !== NEW_TABLES.length) {
      fail('Commit proof failed: required tables are not all visible after commit.');
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      action,
      transaction: 'COMMITTED',
      target: 'TEST',
      test_project_ref: maskRef(testRef),
      migration_version: MIGRATION_VERSION,
      migration_sha256: actualSha256,
      migration_history: 'target-has-no-app-migration-history-table',
      checks,
      commit_proof: true,
    }, null, 2)}\n`);
  } catch (error) {
    if (transactionOpen) await client.query('rollback').catch(() => undefined);
    const secretValues = [databaseUrl, new URL(databaseUrl).password].filter(Boolean);
    let message = String(error?.message ?? 'Migration failed.');
    for (const secret of secretValues) message = message.split(secret).join('[redacted]');
    const safe = {
      ok: false,
      action,
      target: 'TEST',
      code: typeof error?.code === 'string' ? error.code : null,
      message,
      transaction: transactionOpen ? 'ROLLED_BACK' : 'NOT_OPEN_OR_ALREADY_CLOSED',
    };
    process.stderr.write(`${JSON.stringify(safe, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, message: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
