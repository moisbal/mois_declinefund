#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';
const AMOUNT = 10_000n;

function fail(message) { throw new Error(message); }
function check(value, message) { if (!value) fail(message); }
function equal(actual, expected, message) {
  if (String(actual) !== String(expected)) fail(`${message} (expected=${expected}, actual=${actual})`);
}
function arg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function load(file) {
  const resolved = path.resolve(process.cwd(), file ?? '');
  check(file && fs.existsSync(resolved), `Missing explicit env file: ${file ?? '(none)'}`);
  return dotenv.parse(fs.readFileSync(resolved));
}
function required(env, name) {
  const value = String(env[name] ?? '').trim();
  check(value, `${name} is required.`);
  return value;
}
function projectRef(value, database = false) {
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
function client(url, key) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
async function signIn(url, key, email, password, label) {
  const instance = client(url, key);
  const { data, error } = await instance.auth.signInWithPassword({ email, password });
  if (error || !data.user) fail(`${label} TEST sign-in failed.`);
  return { label, id: data.user.id, client: instance };
}
async function rpc(account, name, args, label = name) {
  const { data, error } = await account.client.rpc(name, args ?? {});
  if (error) fail(`${label}: ${error.code ?? 'RPC'} ${error.message}`);
  return Array.isArray(data) ? data : data == null ? [] : [data];
}
function first(rows, label) {
  check(rows.length === 1, `${label} must return exactly one row.`);
  return rows[0];
}
async function allBudget(account) {
  return rpc(account, 'get_financial_budget_change_requests', {
    p_project_id: null, p_status: null, p_year: null, p_region_id: null,
  });
}
async function allNewProjects(account) {
  return rpc(account, 'get_financial_new_project_requests', { p_status: null });
}
async function createBudget(local, runtime, sourceId, destination, reason) {
  return first(await rpc(local, 'financial_test_uat_create_budget_change_request', {
    p_source_project_id: sourceId,
    p_source_budget_year_id: null,
    p_destinations: [destination],
    p_effective_date: runtime.native_start_date,
    p_reason: reason,
    p_idempotency_key: crypto.randomUUID(),
    p_submit: true,
  }, reason), reason);
}
async function regionSnapshot(pg, regionId) {
  return (await pg.query(`select
    (coalesce(sum(positions.ledger_adjusted_allocation),0)
      + (select coalesce(sum(amount),0) from public.financial_pending_new_project_funds
         where region_id=$1 and status='WAITING'))::text conserved_total,
    coalesce(sum(positions.ledger_execution_amount),0)::text execution_total
    from public.financial_project_funding_positions positions
    join public.projects on projects.id=positions.project_id
    where projects.region_id=$1`, [regionId])).rows[0];
}

async function main() {
  check(process.argv.includes('--confirm-test-write'), '--confirm-test-write is required.');
  const env = { ...load(arg('--env-file')), ...load(arg('--credentials-file')) };
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  const supabaseUrl = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const officialCode = required({ value: arg('--new-project-code') }, 'value');
  check(!/(?:^|[-_\s])(?:UAT|AUTO|GENERIC|RAW|GOLDEN|REJECTED)(?=$|[-_\s])/i.test(officialCode),
    'The official project code must not contain a TEST run identifier.');
  if (String(env.TARGET_ENV).toUpperCase() !== 'TEST'
      || env.TEST_PROJECT_REF !== TEST_REF || env.PROD_PROJECT_REF !== PROD_REF
      || projectRef(supabaseUrl) !== TEST_REF || projectRef(databaseUrl, true) !== TEST_REF
      || projectRef(databaseUrl, true) === PROD_REF) {
    fail('Fail-closed TEST target gate rejected configuration.');
  }

  const [adminA, adminB, ...locals] = await Promise.all([
    signIn(supabaseUrl, anonKey, required(env, 'UAT_ADMIN_A_EMAIL'), required(env, 'UAT_ADMIN_A_PASSWORD'), 'admin_a'),
    signIn(supabaseUrl, anonKey, required(env, 'UAT_ADMIN_B_EMAIL'), required(env, 'UAT_ADMIN_B_PASSWORD'), 'admin_b'),
    ...['A', 'B', 'C'].filter((suffix) => env[`UAT_LOCAL_${suffix}_EMAIL`] && env[`UAT_LOCAL_${suffix}_PASSWORD`])
      .map((suffix) => signIn(supabaseUrl, anonKey, env[`UAT_LOCAL_${suffix}_EMAIL`], env[`UAT_LOCAL_${suffix}_PASSWORD`], `local_${suffix.toLowerCase()}`)),
  ]);
  check(locals.length > 0, 'At least one TEST local account is required.');

  const pg = new Client({
    connectionString: connectionString(databaseUrl), ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000, application_name: 'admin-funding-approval-ia-uat',
  });
  await pg.connect();
  try {
    await pg.query("set statement_timeout='120s'");
    const runtime = (await pg.query(`select environment_kind,mode,bound_project_ref,native_start_date::text
      from public.financial_ledger_runtime where singleton`)).rows[0];
    equal(runtime?.environment_kind, 'TEST', 'Runtime environment');
    equal(runtime?.mode, 'TEST', 'Runtime mode');
    equal(runtime?.bound_project_ref, TEST_REF, 'Runtime project ref');

    for (const account of locals) {
      account.profile = (await pg.query(`select id,role,region_id,region_name
        from public.profiles where id=$1`, [account.id])).rows[0];
      equal(account.profile?.role, 'local_user', `${account.label} role`);
    }
    const fixtureCandidates = [];
    for (const account of locals) {
      const rows = (await pg.query(`select projects.id,projects.year,projects.project_code,
        coalesce(nullif(btrim(projects.detail_project_name),''),nullif(btrim(projects.fund_project_name),''),projects.project_name) project_name,
        (positions.ledger_adjusted_allocation-positions.ledger_execution_amount)::text available_amount
        from public.projects
        join public.financial_project_funding_positions positions on positions.project_id=projects.id
        where projects.region_id=$1 and positions.projection_ready
          and (positions.ledger_adjusted_allocation-positions.ledger_execution_amount) >= $2
          and not exists (select 1 from public.financial_budget_change_requests active
            where active.source_project_id=projects.id and active.status in ('SUBMITTED','APPROVED'))
        order by projects.year desc,
          (positions.ledger_adjusted_allocation-positions.ledger_execution_amount) desc,projects.id`,
      [account.profile.region_id, (AMOUNT * 3n).toString()])).rows;
      const source = rows[0];
      const destination = rows.find((row) => row.id !== source?.id && row.year === source?.year);
      if (source && destination) fixtureCandidates.push({ account, source, destination });
    }
    const fixture = fixtureCandidates[0];
    check(fixture, 'No safe same-region, same-year TEST fixture is available.');
    const local = fixture.account;
    const regionBefore = await regionSnapshot(pg, local.profile.region_id);
    const existingCode = (await pg.query(`select count(*)::integer value from public.projects
      where project_code=$1 or project_id=$1`, [officialCode])).rows[0].value;
    equal(existingCode, 0, 'Explicit official project code availability');

    const scenarioA = await createBudget(local, runtime, fixture.source.id, {
      destination_type: 'EXISTING_PROJECT', destination_project_id: fixture.destination.id,
      amount: AMOUNT.toString(), note: '관리자 승인 정보구조 검증',
    }, '기존사업 예산조정 승인 검증');
    equal(scenarioA.status, 'SUBMITTED', 'Scenario A submitted');
    check((await allBudget(adminA)).some((row) => row.id === scenarioA.request_id && row.status === 'SUBMITTED'),
      'Scenario A missing from budget approval queue.');
    equal(first(await rpc(adminA, 'financial_approve_budget_change_request_group', {
      p_request_id: scenarioA.request_id, p_new_project_codes: {},
    }), 'Scenario A approval').status, 'APPROVED', 'Scenario A approved');
    check((await allBudget(adminA)).some((row) => row.id === scenarioA.request_id && row.status === 'APPROVED'),
      'Scenario A missing from apply queue.');
    equal(first(await rpc(adminB, 'financial_apply_budget_change_request', {
      p_request_id: scenarioA.request_id,
    }), 'Scenario A apply').status, 'APPLIED', 'Scenario A applied');

    const scenarioB = await createBudget(local, runtime, fixture.source.id, {
      destination_type: 'EXISTING_PROJECT', destination_project_id: fixture.destination.id,
      amount: AMOUNT.toString(), note: '관리자 반려 정보구조 검증',
    }, '기존사업 예산조정 반려 검증');
    equal(scenarioB.status, 'SUBMITTED', 'Scenario B submitted');
    equal(first(await rpc(adminA, 'financial_reject_budget_change_request', {
      p_request_id: scenarioB.request_id, p_reason: '반려 후 이력 이동 검증',
    }), 'Scenario B rejection').status, 'REJECTED', 'Scenario B rejected');

    const plannedYear = Number(fixture.source.year) + 1;
    const scenarioCName = `${plannedYear} 지역돌봄 기반확충사업`;
    const scenarioC = await createBudget(local, runtime, fixture.source.id, {
      destination_type: 'PENDING_NEW_PROJECT', planned_project_name: scenarioCName,
      planned_project_year: plannedYear, amount: AMOUNT.toString(), note: '신규사업 포함 예산조정 검증',
    }, '신규사업 포함 예산조정 승인 검증');
    const scenarioCParent = (await allBudget(adminA)).find((row) => row.id === scenarioC.request_id);
    const scenarioCChildId = scenarioCParent?.destinations?.[0]?.new_project_request_id;
    check(scenarioCChildId, 'Scenario C grouped new-project child is missing.');
    const scenarioCChildBefore = (await allNewProjects(adminA)).find((row) => row.id === scenarioCChildId);
    equal(scenarioCChildBefore?.status, 'SUBMITTED', 'Scenario C child submitted');
    check(scenarioCChildBefore?.source_budget_change_request_id,
      'Scenario C child must belong to its parent budget request.');
    equal(first(await rpc(adminA, 'financial_approve_budget_change_request_group', {
      p_request_id: scenarioC.request_id, p_new_project_codes: { [scenarioCChildId]: officialCode },
    }), 'Scenario C approval').status, 'APPROVED', 'Scenario C approved');
    const scenarioCApplied = first(await rpc(adminB, 'financial_apply_budget_change_request', {
      p_request_id: scenarioC.request_id,
    }), 'Scenario C apply');
    equal(scenarioCApplied.status, 'APPLIED', 'Scenario C applied');
    equal(scenarioCApplied.gap_amount, 0, 'Scenario C monetary gap');
    const scenarioCChildAfter = (await allNewProjects(adminA)).find((row) => row.id === scenarioCChildId);
    equal(scenarioCChildAfter?.status, 'APPLIED', 'Scenario C child applied');
    check(scenarioCChildAfter?.materialized_project_id, 'Scenario C official project was not created.');
    const scenarioCTrace = (await pg.query(`select pending.status pending_status,links.status link_status
      from public.financial_pending_new_project_funds pending
      left join public.financial_pending_new_project_link_requests links on links.pending_fund_id=pending.id
      where pending.source_request_id=$1`, [scenarioC.request_id])).rows[0];
    equal(scenarioCTrace?.pending_status, 'LINKED', 'Scenario C pending fund linked');
    equal(scenarioCTrace?.link_status, 'APPLIED', 'Scenario C link trace applied');

    const waiting = (await pg.query(`select pending.id,pending.lot_id,pending.region_id,pending.planned_project_year,
      pending.amount::text,regions.display_name
      from public.financial_pending_new_project_funds pending
      join public.regions on regions.id=pending.region_id
      where pending.status='WAITING' order by pending.created_at desc`)).rows;
    const standaloneFixture = waiting.map((pending) => ({
      pending,
      account: locals.find((candidate) => candidate.profile.region_id === pending.region_id),
    })).find((item) => item.account);
    check(standaloneFixture, 'No TEST local account can own the waiting fund needed for Scenario D.');
    const standaloneLocal = standaloneFixture.account;
    const pendingFund = standaloneFixture.pending;
    const scenarioDName = `${pendingFund.planned_project_year} 지역청년 생활안정 지원사업`;
    const scenarioD = first(await rpc(standaloneLocal, 'financial_create_new_project_request', {
      p_region_id: pendingFund.region_id, p_fiscal_year: Number(pendingFund.planned_project_year),
      p_project_name: scenarioDName, p_fund_project_name: scenarioDName,
      p_detail_project_name: scenarioDName, p_project_period: `${pendingFund.planned_project_year}.01~${pendingFund.planned_project_year}.12`,
      p_project_start_year: Number(pendingFund.planned_project_year),
      p_project_end_year: Number(pendingFund.planned_project_year), p_status: '정상추진',
      p_business_type: 'SW', p_large_category_id: null, p_middle_category_id: null,
      p_source_lot_id: pendingFund.lot_id, p_requested_amount: pendingFund.amount,
      p_idempotency_key: crypto.randomUUID(), p_submit: true,
    }, 'Scenario D standalone new-project submit'), 'Scenario D standalone new-project submit');
    equal(scenarioD.status, 'SUBMITTED', 'Scenario D submitted');
    const scenarioDQueued = (await allNewProjects(adminA)).find((row) => row.id === scenarioD.request_id);
    check(scenarioDQueued && !scenarioDQueued.source_budget_change_request_id,
      'Scenario D missing from standalone new-project queue.');
    equal(first(await rpc(adminA, 'financial_reject_new_project_request', {
      p_request_id: scenarioD.request_id, p_reason: '신규사업 반려 후 미생성 검증',
    }), 'Scenario D rejection').status, 'REJECTED', 'Scenario D rejected');
    const scenarioDAfter = (await pg.query(`select status,materialized_project_id,materialized_movement_id
      from public.financial_new_project_requests where id=$1`, [scenarioD.request_id])).rows[0];
    equal(scenarioDAfter?.status, 'REJECTED', 'Scenario D final status');
    check(!scenarioDAfter?.materialized_project_id && !scenarioDAfter?.materialized_movement_id,
      'Scenario D must not create a project or funding movement.');
    equal((await pg.query(`select count(*)::integer value from public.projects
      where project_name=$1`, [scenarioDName])).rows[0].value, 0, 'Scenario D official project rows');

    const finalBudget = await allBudget(adminA);
    const finalNewProjects = await allNewProjects(adminA);
    for (const [id, status] of [[scenarioA.request_id, 'APPLIED'], [scenarioB.request_id, 'REJECTED'], [scenarioC.request_id, 'APPLIED']]) {
      const row = finalBudget.find((request) => request.id === id);
      equal(row?.status, status, `${id} terminal status`);
      check(!['SUBMITTED', 'APPROVED'].includes(row.status), `${id} remained in the actionable budget queue.`);
    }
    const finalD = finalNewProjects.find((request) => request.id === scenarioD.request_id);
    equal(finalD?.status, 'REJECTED', 'Scenario D history status');
    check(!['SUBMITTED', 'APPROVED'].includes(finalD.status), 'Scenario D remained in the new-project queue.');

    const integrity = (await pg.query(`select
      (select count(*)::integer from (
        select requests.id from public.financial_budget_change_requests requests
        join public.financial_budget_change_request_lines lines on lines.request_id=requests.id
        where requests.id=any($1::uuid[]) group by requests.id,requests.total_amount
        having requests.total_amount<>sum(lines.amount)) gaps) request_gaps,
      (select count(*)::integer from public.financial_funding_invariant_check
        where cohort_conservation_gap<>0 or decrease_resolution_gap<>0) invariant_gaps,
      (select count(*)::integer from public.project_fund_transfers transfers
        join public.financial_budget_change_request_lines lines on lines.materialized_transfer_id=transfers.id
        where lines.request_id=$2) rejected_transfers,
      (select count(*)::integer from public.financial_unallocated_fund_lots lots
        join public.financial_budget_change_request_lines lines on lines.materialized_lot_id=lots.id
        where lines.request_id=$3) rejected_lots`,
    [[scenarioA.request_id, scenarioB.request_id, scenarioC.request_id], scenarioB.request_id, scenarioB.request_id])).rows[0];
    equal(integrity.request_gaps, 0, 'Scenario request gaps');
    equal(integrity.invariant_gaps, 0, 'Ledger invariant gaps');
    equal(integrity.rejected_transfers, 0, 'Rejected request transfer rows');
    equal(integrity.rejected_lots, 0, 'Rejected request lot rows');
    const regionAfter = await regionSnapshot(pg, local.profile.region_id);
    equal(regionAfter.conserved_total, regionBefore.conserved_total, 'Region monetary conservation');
    equal(regionAfter.execution_total, regionBefore.execution_total, 'Execution amount unchanged');

    await Promise.allSettled([...locals, adminA, adminB].map((account) => account.client.auth.signOut()));
    const freshLocal = await signIn(supabaseUrl, anonKey,
      required(env, `UAT_LOCAL_${local.label.slice(-1).toUpperCase()}_EMAIL`),
      required(env, `UAT_LOCAL_${local.label.slice(-1).toUpperCase()}_PASSWORD`), 'fresh_local');
    const freshPosition = first(await rpc(freshLocal, 'get_financial_budget_change_project_position', {
      p_project_id: scenarioCChildAfter.materialized_project_id,
    }), 'Fresh local new-project position');
    equal(freshPosition.increase_amount, AMOUNT, 'Fresh local new-project increase');
    await freshLocal.client.auth.signOut();

    process.stdout.write(`${JSON.stringify({
      status: 'PASS', target: 'TEST', production_touched: false,
      runtime, region: local.profile.region_name, amount: AMOUNT.toString(),
      scenario_a: { request_id: scenarioA.request_id, route: ['예산조정 승인대기', '처리 이력'], status: 'APPLIED' },
      scenario_b: { request_id: scenarioB.request_id, route: ['예산조정 승인대기', '처리 이력'], status: 'REJECTED', monetary_delta: '0' },
      scenario_c: { request_id: scenarioC.request_id, new_project_request_id: scenarioCChildId,
        project_id: scenarioCChildAfter.materialized_project_id, project_code: officialCode,
        route: ['예산조정 승인대기', '처리 이력'], pending_status: scenarioCTrace.pending_status,
        link_status: scenarioCTrace.link_status, status: 'APPLIED' },
      scenario_d: { request_id: scenarioD.request_id, route: ['신규사업 승인대기', '처리 이력'],
        status: 'REJECTED', project_created: false, movement_created: false },
      integrity, region_before: regionBefore, region_after: regionAfter, monetary_gap: '0',
      fresh_local_admin_sync: 'PASS',
    }, null, 2)}\n`);
  } finally {
    await Promise.allSettled([...locals, adminA, adminB].map((account) => account.client.auth.signOut()));
    await pg.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`ADMIN FUNDING APPROVAL IA UAT FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
