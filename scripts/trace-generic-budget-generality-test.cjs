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
function load(file) {
  const resolved = path.resolve(process.cwd(), file ?? '');
  if (!file || !fs.existsSync(resolved)) fail(`Missing explicit file: ${file ?? '(none)'}`);
  return dotenv.parse(fs.readFileSync(resolved));
}
function ref(value, database = false) {
  try {
    const url = new URL(value);
    return database
      ? url.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i)?.[1]
        ?? decodeURIComponent(url.username).match(/^postgres\.([a-z0-9-]+)$/i)?.[1] ?? null
      : url.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i)?.[1] ?? null;
  } catch { return null; }
}
function connectionString(value) {
  const url = new URL(value);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('uselibpqcompat');
  return url.toString();
}
async function signIn(url, key, email, password) {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) fail('TEST authentication failed.');
  return { client, userId: data.user.id };
}

async function main() {
  const env = { ...load(process.argv[2]), ...load(process.argv[3]) };
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const databaseUrl = env.TEST_DATABASE_URL;
  if (env.TARGET_ENV !== 'TEST' || env.TEST_PROJECT_REF !== TEST_REF || env.PROD_PROJECT_REF !== PROD_REF
      || ref(url) !== TEST_REF || ref(databaseUrl, true) !== TEST_REF || ref(databaseUrl, true) === PROD_REF) {
    fail('Fail-closed TEST target gate rejected configuration.');
  }
  const [local, admin] = await Promise.all([
    signIn(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, env.UAT_LOCAL_B_EMAIL, env.UAT_LOCAL_B_PASSWORD),
    signIn(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, env.UAT_ADMIN_B_EMAIL, env.UAT_ADMIN_B_PASSWORD),
  ]);
  const pg = new Client({ connectionString: connectionString(databaseUrl), ssl: { rejectUnauthorized: false },
    application_name: 'trace-generic-budget-generality-test' });
  await pg.connect();
  try {
    const request = (await pg.query(`select requests.id, requests.status, requests.total_amount::text,
        requests.source_project_id, source.project_code as source_code,
        lines.destination_project_id, destination.project_code as destination_code,
        lines.amount::text as line_amount
      from public.financial_budget_change_requests requests
      join public.projects source on source.id=requests.source_project_id
      join public.financial_budget_change_request_lines lines on lines.request_id=requests.id
      join public.projects destination on destination.id=lines.destination_project_id
      where requests.status='APPROVED' and requests.reason like 'UAT generic %'
      order by requests.requested_at desc limit 1`)).rows[0];
    if (!request) fail('Approved generality request was not found.');
    const positions = {};
    for (const [role, projectId] of [['source', request.source_project_id], ['destination', request.destination_project_id]]) {
      const { data, error } = await local.client.rpc('get_financial_budget_change_project_position', { p_project_id: projectId });
      positions[role] = { data: data?.[0] ?? null, error };
    }
    const ledger = (await pg.query(`select projects.project_code, projects.original_alloc::text as raw_original,
        projects.increase_amount::text as raw_increase, projects.decrease_amount::text as raw_decrease,
        projects.alloc::text as raw_adjusted, projects.exec::text as raw_execution,
        positions.*, bootstraps.baseline_decrease_amount::text,
        (select coalesce(sum(effects.classification_effect),0)::bigint::text
         from public.financial_project_decrease_classification_effects effects
         where effects.source_project_id=projects.id) as classified_decrease
      from public.projects
      left join public.financial_project_funding_positions positions on positions.project_id=projects.id
      left join public.financial_test_uat_project_bootstraps bootstraps on bootstraps.project_id=projects.id
      where projects.id=any($1::uuid[]) order by projects.project_code`,
    [[request.source_project_id, request.destination_project_id]])).rows;
    const definitions = (await pg.query(`select
      pg_get_functiondef('public.financial_budget_change_visible_decrease(uuid)'::regprocedure) as visible_decrease,
      pg_get_functiondef('public.get_financial_budget_change_project_position(uuid)'::regprocedure) as position`)).rows[0];
    const decreaseImpact = (await pg.query(`with effects as (
        select source_project_id, count(*)::integer as effect_count,
          coalesce(sum(classification_effect),0)::bigint as effect_amount
        from public.financial_project_decrease_classification_effects group by source_project_id
      ), comparison as (
        select projects.id, projects.project_code,
          public.financial_budget_change_visible_decrease(projects.id)::bigint as current_amount,
          ((case when bootstraps.project_id is not null then bootstraps.baseline_decrease_amount
             when coalesce(effects.effect_count,0)>0 then 0
             else coalesce(projects.decrease_amount,0) end)
           + coalesce(effects.effect_amount,0))::bigint as proposed_amount
        from public.projects
        left join public.financial_test_uat_project_bootstraps bootstraps on bootstraps.project_id=projects.id
        left join effects on effects.source_project_id=projects.id
      ) select count(*) filter(where current_amount<>proposed_amount)::integer as changed_projects,
          coalesce(sum(abs(current_amount-proposed_amount)) filter(where current_amount<>proposed_amount),0)::bigint::text
            as absolute_difference,
          coalesce(jsonb_agg(jsonb_build_object('project_code',project_code,
            'current',current_amount,'proposed',proposed_amount))
            filter(where current_amount<>proposed_amount),'[]'::jsonb) as differences
        from comparison`)).rows[0];
    const countsBefore = (await pg.query(`select
      (select count(*)::integer from public.project_fund_transfers) transfers,
      (select count(*)::integer from public.financial_budget_workflow_amount_snapshots) snapshots`)).rows[0];
    const applyResult = await admin.client.rpc('financial_apply_budget_change_request', { p_request_id: request.id });
    const countsAfter = (await pg.query(`select
      (select count(*)::integer from public.project_fund_transfers) transfers,
      (select count(*)::integer from public.financial_budget_workflow_amount_snapshots) snapshots`)).rows[0];
    let rollbackSimulation;
    await pg.query('begin');
    try {
      await pg.query(`alter table public.financial_budget_change_requests
        disable trigger financial_capture_budget_change_amount_snapshots`);
      await pg.query(`select set_config('request.jwt.claim.sub',$1,true),
        set_config('request.jwt.claim.role','authenticated',true)`, [admin.userId]);
      const simulatedApply = await pg.query(
        'select * from public.financial_apply_budget_change_request($1)', [request.id]);
      const simulatedPositions = (await pg.query(`select projects.project_code, positions.*
        from public.projects
        join public.financial_project_funding_positions positions on positions.project_id=projects.id
        where projects.id=any($1::uuid[]) order by projects.project_code`,
      [[request.source_project_id, request.destination_project_id]])).rows;
      const simulatedFunctionPositions = {};
      for (const [role, projectId] of [['source', request.source_project_id], ['destination', request.destination_project_id]]) {
        simulatedFunctionPositions[role] = (await pg.query(
          'select * from public.get_financial_budget_change_project_position($1)', [projectId])).rows[0];
      }
      rollbackSimulation = { apply: simulatedApply.rows, positions: simulatedPositions,
        function_positions: simulatedFunctionPositions };
    } finally {
      await pg.query('rollback');
    }
    process.stdout.write(`${JSON.stringify({ status: 'PASS', target: 'TEST', production_touched: false,
      request, positions, ledger, definitions, decrease_impact: decreaseImpact,
      apply: applyResult, counts_before: countsBefore, counts_after: countsAfter,
      rollback_simulation: rollbackSimulation }, null, 2)}\n`);
  } finally {
    await Promise.allSettled([local.client.auth.signOut(), admin.client.auth.signOut()]);
    await pg.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`GENERIC GENERALITY TRACE FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
