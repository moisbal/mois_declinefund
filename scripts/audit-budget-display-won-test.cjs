const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';
const TARGET_PROJECT_SEARCH = '%농촌유학%';

function fail(message) { throw new Error(message); }

function projectRefFromUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i)?.[1] ?? null;
  } catch { return null; }
}

function projectRefFromDatabase(value) {
  try {
    const url = new URL(value);
    return url.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i)?.[1]
      ?? decodeURIComponent(url.username).match(/^postgres\.([a-z0-9-]+)$/i)?.[1]
      ?? null;
  } catch { return null; }
}

function connectionString(value) {
  const url = new URL(value);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('uselibpqcompat');
  return url.toString();
}

async function main() {
  const envPath = path.resolve(process.cwd(), process.argv[2] ?? '.env.ledger-test.local');
  if (!fs.existsSync(envPath)) fail(`Environment file not found: ${envPath}`);
  const env = dotenv.parse(fs.readFileSync(envPath));
  const databaseUrl = String(env.TEST_DATABASE_URL ?? '').trim();
  const supabaseUrl = String(env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim();
  if (env.TARGET_ENV !== 'TEST'
      || projectRefFromUrl(supabaseUrl) !== TEST_REF
      || projectRefFromDatabase(databaseUrl) !== TEST_REF
      || projectRefFromDatabase(databaseUrl) === PROD_REF) {
    fail('Fail-closed TEST target gate rejected configuration.');
  }

  const client = new Client({
    connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    application_name: 'budget-display-won-read-only-audit',
  });
  await client.connect();
  try {
    await client.query('begin transaction read only');
    await client.query("set local statement_timeout = '30s'");
    const runtime = (await client.query(`select environment_kind, mode, bound_project_ref
      from public.financial_ledger_runtime where singleton = true`)).rows[0];
    if (runtime?.environment_kind !== 'TEST' || runtime?.bound_project_ref !== TEST_REF) {
      fail('Connected Ledger runtime is not the expected TEST project.');
    }

    const columns = (await client.query(`select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = 'public'
        and ((table_name = 'projects' and column_name in
          ('original_alloc','increase_amount','decrease_amount','alloc','exec'))
          or (table_name = 'financial_budget_change_requests' and column_name in
          ('total_amount','decrease_amount_before','decrease_amount_after'))
          or (table_name = 'financial_budget_change_request_lines' and column_name = 'amount'))
      order by table_name, ordinal_position`)).rows;
    if (columns.length !== 9 || columns.some((column) => column.data_type !== 'bigint')) {
      fail('Expected all nine budget amount columns to be bigint won values.');
    }

    const projects = (await client.query(`select
        projects.id::text,
        projects.region_id::text,
        projects.year,
        projects.project_name,
        projects.original_alloc::bigint::text,
        projects.increase_amount::bigint::text,
        projects.decrease_amount::bigint::text,
        projects.alloc::bigint::text,
        projects.exec::bigint::text,
        (projects.alloc::bigint - projects.exec::bigint)::text as project_unexecuted_amount,
        positions.ledger_adjusted_allocation::bigint::text,
        positions.ledger_execution_amount::bigint::text,
        positions.current_wallet_balance::bigint::text
      from public.projects projects
      left join public.financial_project_funding_positions positions on positions.project_id = projects.id
      where projects.year = 2023 and projects.project_name ilike $1
      order by projects.project_name, projects.id`, [TARGET_PROJECT_SEARCH])).rows;
    if (projects.length === 0) fail(`Target project not found: ${TARGET_PROJECT_SEARCH}`);

    const actor = (await client.query(`select id::text, role from public.profiles
      where role = 'admin' order by id limit 1`)).rows[0];
    if (!actor) fail('TEST admin profile not found.');
    await client.query(`select
      set_config('request.jwt.claim.sub', $1, true),
      set_config('request.jwt.claim.role', 'authenticated', true),
      set_config('request.jwt.claims', $2, true)`, [
      actor.id,
      JSON.stringify({ sub: actor.id, role: 'authenticated' }),
    ]);

    const positions = [];
    for (const project of projects) {
      const result = await client.query(`select project_id::text, original_allocation::bigint::text,
          increase_amount::bigint::text, decrease_amount::bigint::text,
          adjusted_allocation::bigint::text, execution_amount::bigint::text,
          unexecuted_amount::bigint::text, valid_execution
        from public.get_financial_budget_change_project_position($1::uuid)`, [project.id]);
      positions.push(...result.rows);
    }
    for (const project of projects) {
      const position = positions.find((item) => item.project_id === project.id);
      if (!position || position.unexecuted_amount !== project.project_unexecuted_amount) {
        fail(`RPC and projects raw won balances differ for ${project.project_name}.`);
      }
    }

    await client.query('rollback');
    console.log(JSON.stringify({
      target: 'TEST',
      runtime,
      amount_columns: columns,
      projects,
      positions,
      raw_won_unit_verified: true,
      transaction: 'READ ONLY / ROLLED BACK',
    }, null, 2));
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
