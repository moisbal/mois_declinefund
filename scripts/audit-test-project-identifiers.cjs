'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';

function fail(message) { throw new Error(message); }
function load(file) {
  const resolved = path.resolve(process.cwd(), file ?? '');
  if (!file || !fs.existsSync(resolved)) fail(`Missing explicit file: ${file ?? '(none)'}`);
  return dotenv.parse(fs.readFileSync(resolved));
}
function required(env, key) {
  const value = String(env[key] ?? '').trim();
  if (!value) fail(`${key} is required.`);
  return value;
}
function ref(value) {
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
  const env = load(process.argv[2]);
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  if (env.TARGET_ENV !== 'TEST' || env.TEST_PROJECT_REF !== TEST_REF
      || env.PROD_PROJECT_REF !== PROD_REF || ref(databaseUrl) !== TEST_REF
      || ref(databaseUrl) === PROD_REF) fail('Fail-closed TEST target gate rejected configuration.');

  const pg = new Client({
    connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    application_name: 'audit-test-project-identifiers',
  });
  await pg.connect();
  try {
    await pg.query('begin read only');
    const runtime = (await pg.query(`select environment_kind, mode, bound_project_ref
      from public.financial_ledger_runtime where singleton=true`)).rows[0];
    if (runtime?.environment_kind !== 'TEST' || runtime?.bound_project_ref !== TEST_REF) {
      fail('TEST ledger runtime binding mismatch.');
    }
    const monetary = (await pg.query(`select
      count(*)::integer project_count,
      coalesce(sum(original_alloc),0)::bigint::text original_total,
      coalesce(sum(increase_amount),0)::bigint::text increase_total,
      coalesce(sum(decrease_amount),0)::bigint::text decrease_total,
      coalesce(sum(alloc),0)::bigint::text adjusted_total,
      coalesce(sum(exec),0)::bigint::text execution_total
      from public.projects`)).rows[0];
    const materialized = (await pg.query(`select
      'A_MATERIALIZED_PROJECT' data_class, projects.id, projects.year fiscal_year,
      regions.display_name region_name, projects.project_code raw_project_code,
      coalesce(nullif(btrim(projects.detail_project_name),''),
        nullif(btrim(projects.fund_project_name),''),nullif(btrim(projects.project_name),'')) raw_project_name,
      requests.id new_project_request_id, requests.status request_status
      from public.projects
      join public.financial_new_project_requests requests
        on requests.materialized_project_id=projects.id
      left join public.regions on regions.id=projects.region_id
      where concat_ws(' ',projects.project_code,projects.project_name,
        projects.fund_project_name,projects.detail_project_name) ~* '(UAT|AUTO|GENERIC)'
      order by projects.year,projects.project_code`)).rows;
    const requests = (await pg.query(`select
      'B_NEW_PROJECT_REQUEST' data_class, requests.id, requests.fiscal_year,
      regions.display_name region_name, requests.status,
      requests.project_name raw_project_name,
      requests.official_project_code raw_official_project_code,
      requests.materialized_project_id,
      requests.source_budget_change_request_id, requests.source_budget_change_line_id
      from public.financial_new_project_requests requests
      left join public.regions on regions.id=requests.region_id
      where concat_ws(' ',requests.project_name,requests.official_project_code) ~* '(UAT|AUTO|GENERIC)'
      order by requests.requested_at`)).rows;
    const fixtures = (await pg.query(`select
      'C_UAT_FIXTURE' data_class, projects.id, projects.year fiscal_year,
      regions.display_name region_name, projects.project_code raw_project_code,
      coalesce(nullif(btrim(projects.detail_project_name),''),
        nullif(btrim(projects.fund_project_name),''),nullif(btrim(projects.project_name),'')) raw_project_name
      from public.projects
      left join public.regions on regions.id=projects.region_id
      where concat_ws(' ',projects.project_code,projects.project_name,
        projects.fund_project_name,projects.detail_project_name) ~* '(UAT|AUTO|GENERIC)'
        and not exists(select 1 from public.financial_new_project_requests requests
          where requests.materialized_project_id=projects.id)
      order by projects.year,projects.project_code`)).rows;
    const workflow = (await pg.query(`select 'BUDGET_CHANGE_LINE' source_table,
        lines.id, requests.status, lines.planned_project_year fiscal_year,
        lines.planned_project_name raw_project_name,
        new_requests.official_project_code raw_project_code,
        lines.new_project_request_id internal_request_id
      from public.financial_budget_change_request_lines lines
      join public.financial_budget_change_requests requests on requests.id=lines.request_id
      left join public.financial_new_project_requests new_requests on new_requests.id=lines.new_project_request_id
      where concat_ws(' ',lines.planned_project_name,new_requests.official_project_code) ~* '(UAT|AUTO|GENERIC)'
      union all
      select 'PENDING_NEW_PROJECT_FUND', pending.id, pending.status,
        pending.planned_project_year, pending.planned_project_name,
        linked.project_code, pending.source_request_id
      from public.financial_pending_new_project_funds pending
      left join public.projects linked on linked.id=pending.linked_project_id
      where concat_ws(' ',pending.planned_project_name,linked.project_code) ~* '(UAT|AUTO|GENERIC)'
      order by source_table,fiscal_year`)).rows;
    await pg.query('commit');
    process.stdout.write(`${JSON.stringify({
      status: 'PASS', target: 'TEST', project_ref: TEST_REF, production_touched: false,
      runtime, monetary_snapshot: monetary,
      classifications: {
        materialized_projects: materialized,
        new_project_requests: requests,
        uat_fixtures: fixtures,
        workflow_exposure_fields: workflow,
      },
      database_writes: 0,
    }, null, 2)}\n`);
  } finally {
    await pg.query('rollback').catch(() => undefined);
    await pg.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`TEST PROJECT IDENTIFIER AUDIT FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
