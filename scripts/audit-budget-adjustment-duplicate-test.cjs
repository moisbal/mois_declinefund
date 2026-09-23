#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';
const SOURCE_NAME = '양구 명품사과 유통시설 강화';
const DESTINATION_NAME = '프리뷰 양구살이';
const AMOUNT = 62_450_000n;

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
function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
}

async function queryJsonRows(pg, tableName, whereSql, params = []) {
  const exists = (await pg.query('select to_regclass($1) is not null as value', [`public.${tableName}`])).rows[0]?.value;
  if (!exists) return [];
  return (await pg.query(`select to_jsonb(rows) as row from public.${tableName} as rows where ${whereSql}`, params))
    .rows.map((entry) => entry.row);
}

async function main() {
  const envIndex = process.argv.indexOf('--env-file');
  const envPath = envIndex >= 0 ? process.argv[envIndex + 1] : null;
  if (!envPath) fail('--env-file is required.');
  const resolved = path.resolve(process.cwd(), envPath);
  if (!fs.existsSync(resolved)) fail('Explicit TEST env file does not exist.');
  const env = dotenv.parse(fs.readFileSync(resolved));
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  const supabaseUrl = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
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
    application_name: 'audit-budget-adjustment-duplicate-test-read-only',
  });
  await pg.connect();
  try {
    await pg.query('begin transaction read only');
    const runtime = (await pg.query(`select environment_kind, mode, bound_project_ref,
        native_start_date::text as native_start_date
      from public.financial_ledger_runtime where singleton = true`)).rows[0];
    if (runtime?.environment_kind !== 'TEST' || runtime?.mode !== 'TEST'
        || runtime?.bound_project_ref !== TEST_REF) fail('Ledger runtime is not approved TEST runtime.');

    const projects = (await pg.query(`select
        projects.id, projects.project_code, projects.year, projects.region_id,
        coalesce(nullif(btrim(projects.detail_project_name), ''),
          nullif(btrim(projects.fund_project_name), ''),
          nullif(btrim(projects.project_name), '')) as project_name,
        projects.original_alloc::bigint, projects.increase_amount::bigint,
        projects.decrease_amount::bigint, projects.alloc::bigint,
        projects.exec::bigint, (projects.alloc - projects.exec)::bigint as unexecuted_amount,
        case when projects.alloc > 0 then round(projects.exec::numeric * 100 / projects.alloc, 2) else 0 end as execution_rate,
        regions.sido, regions.sigungu
      from public.projects
      join public.regions on regions.id = projects.region_id
      where projects.year = 2025 and regions.sido = '강원' and regions.sigungu = '양구군'
        and coalesce(nullif(btrim(projects.detail_project_name), ''),
          nullif(btrim(projects.fund_project_name), ''),
          nullif(btrim(projects.project_name), '')) = any($1::text[])
      order by project_name`, [[SOURCE_NAME, DESTINATION_NAME]])).rows;
    const source = projects.find((row) => row.project_name === SOURCE_NAME);
    const destination = projects.find((row) => row.project_name === DESTINATION_NAME);
    if (!source || !destination) fail('The exact Yanggu source/destination projects were not both found in TEST.');

    const positionRows = (await pg.query(`select to_jsonb(positions) as row
      from public.financial_project_funding_positions as positions
      where positions.project_id = any($1::uuid[])
      order by positions.project_id`, [[source.id, destination.id]])).rows.map((entry) => entry.row);
    const sourcePosition = positionRows.find((row) => String(row.project_id) === String(source.id));
    const destinationPosition = positionRows.find((row) => String(row.project_id) === String(destination.id));

    const requests = (await pg.query(`select requests.*
      from public.financial_budget_change_requests as requests
      where requests.source_project_id = $1
        and requests.fiscal_year = 2025
        and exists (
          select 1 from public.financial_budget_change_request_lines as lines
          where lines.request_id = requests.id
            and lines.destination_type = 'EXISTING_PROJECT'
            and lines.destination_project_id = $2
            and lines.amount = requests.total_amount)
      order by requests.submitted_at nulls last, requests.id`, [source.id, destination.id])).rows;
    const requestIds = requests.map((row) => row.id);
    const lines = requestIds.length === 0 ? [] : (await pg.query(`select lines.*
      from public.financial_budget_change_request_lines as lines
      where lines.request_id = any($1::uuid[])
      order by lines.request_id, lines.line_no`, [requestIds])).rows;
    const transferIds = lines.map((row) => row.materialized_transfer_id).filter(Boolean);
    const movementIds = lines.map((row) => row.materialized_movement_id).filter(Boolean);
    const lotIds = lines.map((row) => row.materialized_lot_id).filter(Boolean);
    const pendingFundIds = lines.map((row) => row.pending_fund_id).filter(Boolean);
    const entityIds = [...new Set([
      source.id, destination.id, ...requestIds,
      ...lines.map((row) => row.id), ...transferIds, ...movementIds, ...lotIds, ...pendingFundIds,
    ].map(String))];

    const transfers = transferIds.length === 0 ? [] : await queryJsonRows(
      pg, 'project_fund_transfers', 'rows.id = any($1::uuid[])', [transferIds],
    );
    const movements = movementIds.length === 0 ? [] : await queryJsonRows(
      pg, 'financial_unallocated_fund_movements', 'rows.id = any($1::uuid[])', [movementIds],
    );
    const snapshots = requestIds.length === 0 ? [] : await queryJsonRows(
      pg, 'financial_budget_workflow_amount_snapshots',
      'rows.budget_request_id = any($1::uuid[])', [requestIds],
    );
    const audits = entityIds.length === 0 ? [] : await queryJsonRows(
      pg, 'audit_logs',
      'to_jsonb(rows)::text like any($1::text[])',
      [entityIds.map((id) => `%${id}%`)],
    );
    const changes = await queryJsonRows(
      pg, 'project_change_requests',
      'to_jsonb(rows)::text like any($1::text[])',
      [[source.id, destination.id, ...requestIds].map((id) => `%${id}%`)],
    ).catch(() => []);
    const columns = (await pg.query(`select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('financial_budget_change_requests', 'financial_budget_change_request_lines',
          'project_fund_transfers', 'financial_unallocated_fund_movements', 'audit_logs',
          'project_change_requests', 'financial_budget_workflow_amount_snapshots')
      order by table_name, ordinal_position`)).rows;
    const rejectDefinition = (await pg.query(`select pg_get_functiondef(
      'public.financial_reject_budget_change_request(uuid,text)'::regprocedure) as definition`)).rows[0]?.definition;

    const requestSummaries = requests.map((request) => {
      const requestLines = lines.filter((line) => String(line.request_id) === String(request.id));
      const requestTransfers = requestLines.filter((line) => line.materialized_transfer_id);
      const requestMovements = requestLines.filter((line) => line.materialized_movement_id);
      return {
        id: request.id,
        status: request.status,
        idempotency_key: request.idempotency_key,
        request_fingerprint: request.request_fingerprint,
        total_amount: String(request.total_amount),
        decrease_amount_before: String(request.decrease_amount_before),
        decrease_amount_after: String(request.decrease_amount_after),
        submitted_at: request.submitted_at,
        approved_at: request.approved_at,
        applied_at: request.applied_at,
        rejected_at: request.rejected_at,
        line_count: requestLines.length,
        materialized_transfer_count: requestTransfers.length,
        materialized_movement_count: requestMovements.length,
      };
    });
    const transferAmount = transfers.reduce((sum, row) => sum + BigInt(row.amount ?? 0), 0n);
    const materializedApplied = requestSummaries.filter((row) => row.status === 'APPLIED');
    const visibleSourceDecrease = BigInt(sourcePosition?.ledger_decrease_amount ?? source.decrease_amount ?? 0);
    const visibleDestinationIncrease = BigInt(destinationPosition?.ledger_increase_amount ?? destination.increase_amount ?? 0);

    process.stdout.write(`${JSON.stringify(jsonSafe({
      ok: true,
      target: 'TEST',
      project_ref: TEST_REF,
      production_touched: false,
      transaction: 'READ ONLY',
      runtime,
      source,
      destination,
      source_position: sourcePosition,
      destination_position: destinationPosition,
      duplicate_case: {
        reported_amount: AMOUNT,
        request_count: requests.length,
        request_summaries: requestSummaries,
        applied_request_count: materializedApplied.length,
        transfer_count: transfers.length,
        transfer_amount: transferAmount,
        movement_count: movements.length,
        visible_source_decrease: visibleSourceDecrease,
        visible_destination_increase: visibleDestinationIncrease,
        source_destination_gap: visibleSourceDecrease - visibleDestinationIncrease,
      },
      requests,
      lines,
      transfers,
      movements,
      snapshots,
      audits,
      project_change_requests: changes,
      relevant_columns: columns,
      reject_function_definition: rejectDefinition,
    }), null, 2)}\n`);
    await pg.query('rollback');
  } catch (error) {
    await pg.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await pg.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
