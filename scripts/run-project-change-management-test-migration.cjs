#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const MIGRATION_VERSION = '20260826000100';
const MIGRATION_NAME = 'project_change_management_delta';
const EXPECTED_SHA256 = '475d9bc026a2ef1c4f74d72c837be4927cb018748c1908d3cf5f0c0d9006db8b';
const MIGRATION_PATH = path.resolve(
  process.cwd(),
  'supabase',
  'migrations',
  `${MIGRATION_VERSION}_${MIGRATION_NAME}.sql`,
);
const NEW_TABLES = [
  'project_related_small_categories',
  'project_small_category_proposals',
  'project_change_events',
  'project_similarity_decisions',
];
const NEW_VIEW = 'project_primary_classification_statistics';
const AUTH_FUNCTIONS = [
  'get_project_similarity_candidates(uuid,text,integer)',
  'record_project_similarity_decision(uuid,text,text,uuid,numeric,text,text)',
  'submit_project_small_category_proposal(uuid,text,text)',
  'review_project_small_category_proposal(uuid,text,uuid,uuid,text)',
  'update_my_project_metadata_v2(uuid,text,text,integer,text,jsonb,uuid,uuid[],text,text,text,text[],text,text,boolean,text)',
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
  if (!['validate', 'apply'].includes(values.action)) fail('--action must be validate or apply.');
  if (!values.env_file) fail('--env-file is required.');
  if (values.action === 'apply' && values.confirm !== true) {
    fail('TEST apply requires --confirm-test-write.');
  }
  return {
    envFile: path.resolve(process.cwd(), values.env_file),
    action: values.action,
  };
}

function refFromPublicUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase().match(/^([a-z0-9-]+)\.supabase\.co$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function refFromDatabaseUrl(value) {
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
  url.searchParams.delete('sslmode');
  url.searchParams.delete('uselibpqcompat');
  return url.toString();
}

function maskRef(value) {
  return value.length <= 6 ? '***' : `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function stripOuterTransaction(sql) {
  const begins = [...sql.matchAll(/^[ \t]*begin;[ \t]*\r?$/gim)];
  const commits = [...sql.matchAll(/^[ \t]*commit;[ \t]*\r?$/gim)];
  if (begins.length !== 1 || commits.length !== 1) {
    fail('Pinned migration must contain exactly one outer BEGIN/COMMIT pair.');
  }
  const begin = begins[0];
  const commit = commits[0];
  if (begin.index >= commit.index || sql.slice(commit.index + commit[0].length).trim() !== '') {
    fail('Pinned migration outer transaction is malformed.');
  }
  return `${sql.slice(0, begin.index)}${sql.slice(begin.index + begin[0].length, commit.index)}`;
}

function assertRuntime(runtime, testRef) {
  if (!runtime || runtime.environment_kind !== 'TEST' || runtime.bound_project_ref !== testRef) {
    fail('Database runtime is not bound to the approved TEST project.');
  }
}

async function snapshot(client) {
  const [projects, classification, runtime, parentFunction, extension] = await Promise.all([
    client.query(`
      select
        count(*)::bigint::text as project_count,
        coalesce(sum(total_budget), 0)::numeric::text as total_budget,
        coalesce(sum(original_alloc), 0)::numeric::text as original_alloc,
        coalesce(sum(increase_amount), 0)::numeric::text as increase_amount,
        coalesce(sum(decrease_amount), 0)::numeric::text as decrease_amount,
        coalesce(sum(alloc), 0)::numeric::text as alloc,
        coalesce(sum(exec), 0)::numeric::text as exec,
        coalesce(sum(rate), 0)::numeric::text as rate,
        md5(string_agg(concat_ws('|', id::text, total_budget::text, original_alloc::text,
          increase_amount::text, decrease_amount::text, alloc::text, exec::text, rate::text),
          E'\\n' order by id)) as monetary_row_digest
      from public.projects
    `),
    client.query(`
      select count(*)::bigint::text as assignment_count,
        count(distinct project_id)::bigint::text as assigned_project_count
      from public.project_small_categories
    `),
    client.query(`
      select environment_kind, mode, bound_project_ref,
        baseline_as_of::text, native_start_date::text
      from public.financial_ledger_runtime where singleton = true
    `),
    client.query("select pg_get_functiondef('public.validate_project_classification_parent()'::regprocedure) as definition"),
    client.query("select exists(select 1 from pg_extension where extname = 'pg_trgm') as present"),
  ]);
  return {
    monetary: projects.rows[0],
    classification: classification.rows[0],
    runtime: runtime.rows[0] ?? null,
    parentFunction: parentFunction.rows[0]?.definition ?? null,
    pgTrgm: extension.rows[0]?.present === true,
  };
}

async function deltaObjectState(client) {
  const result = await client.query(`
    select
      exists(select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'projects'
          and column_name = 'primary_small_category_id') as primary_column,
      to_regclass('public.${NEW_VIEW}') is not null as official_view,
      coalesce(array_agg(requested.name order by requested.name)
        filter (where to_regclass('public.' || requested.name) is not null), array[]::text[]) as tables
    from unnest($1::text[]) as requested(name)
  `, [NEW_TABLES]);
  return result.rows[0];
}

async function postChecks(client, before, testRef) {
  const after = await snapshot(client);
  assertRuntime(after.runtime, testRef);
  if (JSON.stringify(after.monetary) !== JSON.stringify(before.monetary)) {
    fail('Migration changed one or more project monetary values.');
  }
  if (JSON.stringify(after.runtime) !== JSON.stringify(before.runtime)) {
    fail('Migration changed the TEST runtime policy.');
  }

  const state = await deltaObjectState(client);
  if (!state.primary_column || !state.official_view || state.tables.length !== NEW_TABLES.length) {
    fail('One or more required project-change schema objects were not created.');
  }

  const counts = await client.query(`
    select
      (select count(*)::bigint::text from public.projects
        where primary_small_category_id is not null) as primary_count,
      (select count(*)::bigint::text from public.project_related_small_categories) as related_count,
      (select count(*)::bigint::text from public.project_small_category_proposals) as proposal_count,
      (select count(*)::bigint::text from public.project_change_events) as event_count,
      (select count(*)::bigint::text from public.project_similarity_decisions) as decision_count,
      (select count(*)::bigint::text from public.${NEW_VIEW}) as official_count,
      (select count(*)::bigint::text from (
        select project_id from public.${NEW_VIEW} group by project_id having count(*) <> 1
      ) as duplicates) as official_duplicate_count,
      (select coalesce(sum(alloc), 0)::numeric::text from public.${NEW_VIEW}) as official_alloc,
      (select coalesce(sum(exec), 0)::numeric::text from public.${NEW_VIEW}) as official_exec
  `);
  const row = counts.rows[0];
  const expectedRelated = String(
    BigInt(before.classification.assignment_count) - BigInt(before.classification.assigned_project_count),
  );
  if (row.primary_count !== before.classification.assigned_project_count
      || row.related_count !== expectedRelated
      || row.proposal_count !== '0' || row.event_count !== '0' || row.decision_count !== '0'
      || row.official_count !== before.monetary.project_count
      || row.official_duplicate_count !== '0'
      || row.official_alloc !== before.monetary.alloc
      || row.official_exec !== before.monetary.exec) {
    fail('Classification backfill or official one-row-per-project statistics check failed.');
  }

  const rls = await client.query(`
    select requested.name, coalesce(classes.relrowsecurity, false) as enabled,
      (select count(*)::integer from pg_policies
       where schemaname = 'public' and tablename = requested.name) as policy_count,
      has_table_privilege('authenticated', 'public.' || requested.name, 'SELECT') as auth_select,
      has_table_privilege('anon', 'public.' || requested.name, 'SELECT') as anon_select,
      (has_table_privilege('authenticated', 'public.' || requested.name, 'INSERT')
       or has_table_privilege('authenticated', 'public.' || requested.name, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || requested.name, 'DELETE')) as auth_write
    from unnest($1::text[]) as requested(name)
    left join pg_namespace as namespaces on namespaces.nspname = 'public'
    left join pg_class as classes
      on classes.relnamespace = namespaces.oid and classes.relname = requested.name
  `, [NEW_TABLES]);
  if (rls.rows.some((item) => item.enabled !== true || item.policy_count !== 1
      || item.auth_select !== true || item.anon_select === true || item.auth_write === true)) {
    fail('RLS policies or table privileges are not fail-closed.');
  }

  const functions = await client.query(`
    select requested.signature,
      to_regprocedure('public.' || requested.signature) is not null as present,
      has_function_privilege('authenticated', 'public.' || requested.signature, 'EXECUTE') as auth_execute,
      has_function_privilege('anon', 'public.' || requested.signature, 'EXECUTE') as anon_execute
    from unnest($1::text[]) as requested(signature)
  `, [AUTH_FUNCTIONS]);
  if (functions.rows.some((item) => item.present !== true
      || item.auth_execute !== true || item.anon_execute === true)) {
    fail('Project-change RPC privileges are incomplete or exposed to anonymous users.');
  }

  const viewSecurity = await client.query(`
    select coalesce(reloptions, array[]::text[]) @> array['security_invoker=true'] as invoker
    from pg_class where oid = 'public.${NEW_VIEW}'::regclass
  `);
  if (viewSecurity.rows[0]?.invoker !== true) fail('Official statistics view must use invoker security.');
  if (!after.parentFunction.includes('primary_small_category_id')
      || after.parentFunction.includes('project_custom_small_categories')) {
    fail('Parent classification trigger still treats historical custom suggestions as active categories.');
  }

  return {
    project_count: row.official_count,
    monetary_row_digest: after.monetary.monetary_row_digest,
    primary_classification_count: row.primary_count,
    related_classification_count: row.related_count,
    official_duplicate_count: row.official_duplicate_count,
    official_alloc_total: row.official_alloc,
    official_exec_total: row.official_exec,
    rls_table_count: rls.rows.length,
    authenticated_rpc_count: functions.rows.length,
    security_invoker_view: true,
    metadata_history_rows_created_by_migration: row.event_count,
  };
}

async function openClient(databaseUrl, action) {
  const client = new Client({
    connectionString: databaseConnectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
    application_name: `project-change-delta-${action}`,
  });
  await client.connect();
  return client;
}

async function confirmRolledBack(databaseUrl, before) {
  const client = await openClient(databaseUrl, 'rollback-proof');
  try {
    const after = await snapshot(client);
    const state = await deltaObjectState(client);
    if (JSON.stringify(after) !== JSON.stringify(before)
        || state.primary_column || state.official_view || state.tables.length !== 0) {
      fail('Rollback proof failed: schema, data, runtime, extension, or trigger state changed.');
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main() {
  const { envFile, action } = parseArguments(process.argv.slice(2));
  if (!fs.existsSync(envFile)) fail('The explicit TEST env file does not exist.');
  const env = dotenv.parse(fs.readFileSync(envFile));
  const targetEnv = String(env.TARGET_ENV ?? '').trim().toUpperCase();
  const testRef = String(env.TEST_PROJECT_REF ?? '').trim();
  const prodRef = String(env.PROD_PROJECT_REF ?? '').trim();
  const publicRef = refFromPublicUrl(env.NEXT_PUBLIC_SUPABASE_URL ?? '');
  const databaseUrl = env.TEST_DATABASE_URL ?? '';
  const databaseRef = refFromDatabaseUrl(databaseUrl);
  if (targetEnv !== 'TEST' || !testRef || !prodRef || testRef === prodRef
      || publicRef !== testRef || databaseRef !== testRef || databaseRef === prodRef
      || testRef !== 'reviewtestxxxxxxxxxx') {
    fail('Fail-closed target gate rejected a non-TEST or mismatched configuration.');
  }

  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const actualSha256 = crypto.createHash('sha256').update(sql).digest('hex');
  if (actualSha256 !== EXPECTED_SHA256) {
    fail('Migration SHA-256 differs from the independently reviewed SQL.');
  }
  const bodySql = stripOuterTransaction(sql);
  const client = await openClient(databaseUrl, action);
  let transactionOpen = false;
  try {
    const before = await snapshot(client);
    assertRuntime(before.runtime, testRef);
    const existing = await deltaObjectState(client);
    if (existing.primary_column || existing.official_view || existing.tables.length !== 0) {
      fail('Project-change delta is already present; refusing a duplicate apply.');
    }

    await client.query('begin');
    transactionOpen = true;
    const lock = await client.query(
      "select pg_try_advisory_xact_lock(pg_catalog.hashtextextended('project-change-management-test-migration', 20260826000100)) as locked",
    );
    if (lock.rows[0]?.locked !== true) fail('Another TEST project-change migration is already running.');
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
        checks,
        rollback_proof: true,
      }, null, 2)}\n`);
      return;
    }

    await client.query('commit');
    transactionOpen = false;
    const committed = await deltaObjectState(client);
    if (!committed.primary_column || !committed.official_view
        || committed.tables.length !== NEW_TABLES.length) {
      fail('Commit proof failed: required objects are not visible after commit.');
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      action,
      transaction: 'COMMITTED',
      target: 'TEST',
      test_project_ref: maskRef(testRef),
      migration_version: MIGRATION_VERSION,
      migration_sha256: actualSha256,
      checks,
      commit_proof: true,
    }, null, 2)}\n`);
  } catch (error) {
    if (transactionOpen) await client.query('rollback').catch(() => undefined);
    let message = String(error?.message ?? 'Migration failed.');
    for (const secret of [databaseUrl, (() => { try { return new URL(databaseUrl).password; } catch { return ''; } })()]) {
      if (secret) message = message.split(secret).join('[redacted]');
    }
    process.stderr.write(`${JSON.stringify({
      ok: false,
      action,
      target: 'TEST',
      code: typeof error?.code === 'string' ? error.code : null,
      message,
      transaction: transactionOpen ? 'ROLLED_BACK' : 'NOT_OPEN_OR_ALREADY_CLOSED',
    }, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, message: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
