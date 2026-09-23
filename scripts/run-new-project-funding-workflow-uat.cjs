#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dotenv = require('dotenv');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';
const A_AMOUNT = 333333n;
const B_AMOUNT = 111111n;
const C_AMOUNT = 222222n;

function fail(message) { throw new Error(message); }
function check(condition, message) { if (!condition) fail(message); }
function required(env, key) {
  const value = String(env[key] ?? '').trim();
  if (!value) fail(`${key} is required.`);
  return value;
}
function load(file) {
  const resolved = path.resolve(process.cwd(), file ?? '');
  if (!file || !fs.existsSync(resolved)) fail(`Missing explicit env file: ${file ?? '(none)'}`);
  return dotenv.parse(fs.readFileSync(resolved));
}
function apiRef(value) {
  return new URL(value).hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i)?.[1] ?? null;
}
function databaseRef(value) {
  const url = new URL(value);
  return url.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i)?.[1]
    ?? decodeURIComponent(url.username).match(/^postgres\.([a-z0-9-]+)$/i)?.[1] ?? null;
}
function connectionString(value) {
  const url = new URL(value);
  url.searchParams.delete('sslmode');
  url.searchParams.delete('uselibpqcompat');
  return url.toString();
}
function one(data, label) {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) fail(`${label} did not return a row.`);
  return row;
}
async function rpc(client, name, args, label = name) {
  const { data, error } = await client.rpc(name, args);
  if (error) fail(`${label}: ${error.code ?? 'RPC'} ${error.message}`);
  return data ?? [];
}
async function signIn(url, key, email, password, label) {
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) fail(`${label} authentication failed.`);
  return { client, user: data.user, label };
}
async function profile(client, id) {
  const { data, error } = await client.from('profiles')
    .select('id,role,region_id,region_name').eq('id', id).single();
  if (error) fail(`Profile lookup: ${error.message}`);
  return data;
}
async function snapshot(pg) {
  return (await pg.query(`select
    (select count(*)::bigint from public.projects)::text project_count,
    (select coalesce(sum(coalesce(alloc,0)),0)::bigint from public.projects)::text allocation,
    (select coalesce(sum(coalesce(exec,0)),0)::bigint from public.projects)::text execution,
    (select count(*)::bigint from public.financial_unallocated_fund_movements)::text movements,
    (select count(*)::bigint from public.project_fund_transfers)::text transfers`)).rows[0];
}
async function position(client, projectId) {
  return one(await rpc(client, 'get_financial_budget_change_project_position', {
    p_project_id: projectId,
  }), 'Project position');
}
async function chooseSource(account, regionId) {
  const { data, error } = await account.client.from('projects')
    .select('id,year,project_code,project_name,fund_project_name,detail_project_name,region_id')
    .eq('region_id', regionId).not('year', 'is', null).order('year', { ascending: false }).limit(80);
  if (error) fail(`Source project list: ${error.message}`);
  for (const project of data ?? []) {
    const row = await position(account.client, project.id).catch(() => null);
    if (row?.valid_execution === true
        && BigInt(row.unexecuted_amount ?? '0') > A_AMOUNT + B_AMOUNT + C_AMOUNT) {
      return { project, position: row };
    }
  }
  fail('No local_a source project has enough unexecuted budget for scenarios A/B/C.');
}
async function nextOfficialCode(pg, regionId, year, startSuffix) {
  const region = (await pg.query('select region_code from public.regions where id=$1', [regionId])).rows[0];
  const digits = String(region?.region_code ?? '').replace(/\D/g, '').padEnd(5, '0').slice(0, 5);
  const prefix = `${year}-${digits.slice(0, 2)}-${digits.slice(2)}`;
  for (let suffix = startSuffix; suffix <= 999; suffix += 1) {
    const code = `${prefix}-${suffix}`;
    const exists = (await pg.query(`select exists(select 1 from public.projects
      where project_code=$1 or project_id=$1) value`, [code])).rows[0]?.value;
    if (!exists) return code;
  }
  fail(`No unused official-code suffix remains for ${prefix}.`);
}
async function requestById(client, projectId, requestId) {
  const rows = await rpc(client, 'get_financial_budget_change_requests', {
    p_project_id: projectId, p_status: null, p_year: null, p_region_id: null,
  });
  const request = rows.find((row) => row.id === requestId);
  if (!request) fail('Budget-adjustment request did not appear in the authenticated queue.');
  return request;
}
async function adminApproveAndApplyBudget(admin, requestId, codeMap) {
  const approved = one(await rpc(admin.client, 'financial_approve_budget_change_request_group', {
    p_request_id: requestId,
    p_new_project_codes: codeMap,
  }), 'Budget approval');
  check(approved.status === 'APPROVED', 'Budget request did not become approved.');
  const applied = one(await rpc(admin.client, 'financial_apply_budget_change_request_dispatch', {
    p_request_id: requestId,
  }), 'Budget apply');
  check(applied.status === 'APPLIED', 'Budget request did not become applied.');
}

async function main() {
  if (process.argv.length !== 4) {
    fail('Usage: node scripts/run-new-project-funding-workflow-uat.cjs <test-env> <uat-credentials>');
  }
  const env = { ...load(process.argv[2]), ...load(process.argv[3]) };
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  const url = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const key = required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (String(env.TARGET_ENV).toUpperCase() !== 'TEST'
      || env.TEST_PROJECT_REF !== TEST_REF || env.PROD_PROJECT_REF !== PROD_REF
      || apiRef(url) !== TEST_REF || databaseRef(databaseUrl) !== TEST_REF
      || databaseRef(databaseUrl) === PROD_REF) {
    fail('Fail-closed TEST target gate rejected configuration.');
  }

  const [localA, localB, adminA] = await Promise.all([
    signIn(url, key, required(env, 'UAT_LOCAL_A_EMAIL'), required(env, 'UAT_LOCAL_A_PASSWORD'), 'local_a'),
    signIn(url, key, required(env, 'UAT_LOCAL_B_EMAIL'), required(env, 'UAT_LOCAL_B_PASSWORD'), 'local_b'),
    signIn(url, key, required(env, 'UAT_ADMIN_A_EMAIL'), required(env, 'UAT_ADMIN_A_PASSWORD'), 'admin_a'),
  ]);
  const [profileA, profileB, profileAdmin] = await Promise.all([
    profile(localA.client, localA.user.id),
    profile(localB.client, localB.user.id),
    profile(adminA.client, adminA.user.id),
  ]);
  check(profileA.role === 'local_user' && profileB.role === 'local_user', 'Local UAT roles are invalid.');
  check(profileAdmin.role === 'admin', 'Admin UAT role is invalid.');

  const pg = new Client({
    connectionString: connectionString(databaseUrl),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    application_name: 'new-project-funding-workflow-uat',
  });
  await pg.connect();
  try {
    const runtime = (await pg.query(`select environment_kind,mode,bound_project_ref,native_start_date
      from public.financial_ledger_runtime where singleton`)).rows[0];
    check(runtime?.environment_kind === 'TEST' && runtime?.mode === 'TEST'
      && runtime?.bound_project_ref === TEST_REF, 'Approved TEST runtime is not active.');
    const effectiveDate = new Date().toISOString().slice(0, 10) < runtime.native_start_date
      ? runtime.native_start_date
      : new Date().toISOString().slice(0, 10);

    // A prior checkpoint may have materialized the project and stopped before the
    // pending-fund link was applied. Complete that same TEST UAT transaction so
    // retries do not leave an active claim that hides a valid source.
    const partialLinksA = (await pg.query(`select links.id,links.status
      from public.financial_pending_new_project_link_requests links
      join public.financial_pending_new_project_funds pending on pending.id=links.pending_fund_id
      join public.financial_budget_change_requests budget on budget.id=pending.source_request_id
      join public.financial_new_project_requests new_requests
        on new_requests.source_lot_id=pending.lot_id
      where budget.requested_by=$1
        and budget.reason='차년도 신규사업 예정예산 우선 확보'
        and new_requests.status='APPLIED'
        and links.status in ('SUBMITTED','APPROVED')
      order by links.requested_at`, [localA.user.id])).rows;
    for (const partialLink of partialLinksA) {
      if (partialLink.status === 'SUBMITTED') {
        const recoveredApproval = one(await rpc(adminA.client,
          'financial_review_pending_new_project_link', {
            p_request_id: partialLink.id, p_decision: 'APPROVE', p_reason: null,
          }), 'Scenario A checkpoint funding approval');
        check(recoveredApproval.status === 'APPROVED',
          'Scenario A checkpoint funding link was not approved.');
      }
      const recoveredApply = one(await rpc(adminA.client,
        'financial_apply_pending_new_project_link', { p_request_id: partialLink.id }),
      'Scenario A checkpoint funding apply');
      check(recoveredApply.status === 'APPLIED' && String(recoveredApply.gap_amount ?? '0') === '0',
        'Scenario A checkpoint funding link was not applied with zero gap.');
    }

    // Scenarios A/B/C share a real local_a source but use distinct approval groups.
    const selected = await chooseSource(localA, profileA.region_id);
    const sourceProject = selected.project;
    const sourceName = sourceProject.detail_project_name || sourceProject.fund_project_name
      || sourceProject.project_name || '현재 사업';
    const targetYear = Number(sourceProject.year) + 1;

    // Scenario A: N-year decrease -> N+1 waiting fund -> later direct new-project request.
    const aPlannedName = '청년 정착지원 기반사업 예정예산';
    const beforeA = await position(localA.client, sourceProject.id);
    const resumableA = (await pg.query(`select requests.id,requests.status
      from public.financial_budget_change_requests requests
      join public.financial_budget_change_request_lines lines on lines.request_id=requests.id
      left join public.financial_pending_new_project_funds pending
        on pending.source_request_id=requests.id and pending.source_line_id=lines.id
      where requests.source_project_id=$1 and requests.requested_by=$2
        and requests.reason='차년도 신규사업 예정예산 우선 확보'
        and lines.unlinked_funding_only
        and (
          (requests.status='APPROVED' and lines.pending_fund_id is null)
          or (requests.status='APPLIED' and pending.status='WAITING'
            and not exists (select 1 from public.financial_new_project_requests new_requests
              where new_requests.source_lot_id=pending.lot_id
                and new_requests.status in ('DRAFT','SUBMITTED','APPROVED'))
            and not exists (select 1 from public.financial_pending_new_project_link_requests links
              where links.pending_fund_id=pending.id
                and links.status in ('SUBMITTED','APPROVED','APPLIED')))
        )
      order by requests.requested_at desc limit 1`, [sourceProject.id, localA.user.id])).rows[0];
    let aBudget;
    if (resumableA) {
      aBudget = { request_id: resumableA.id, status: resumableA.status, gap_amount: '0' };
    } else {
      const beforeAPending = await snapshot(pg);
      aBudget = one(await rpc(localA.client,
        'financial_test_uat_save_budget_change_request_complete', {
          p_source_project_id: sourceProject.id,
          p_source_budget_year_id: null,
          p_destinations: [{
            destination_type: 'PENDING_NEW_PROJECT',
            create_unlinked_funding: true,
            planned_project_name: aPlannedName,
            planned_project_year: targetYear,
            amount: A_AMOUNT.toString(),
            note: '',
          }],
          p_effective_date: effectiveDate,
          p_reason: '차년도 신규사업 예정예산 우선 확보',
          p_idempotency_key: crypto.randomUUID(),
          p_submit: true,
        }), 'Scenario A pending-fund request');
      check(aBudget.status === 'SUBMITTED' && String(aBudget.gap_amount) === '0',
        'Scenario A pending-fund budget request is invalid.');
      const afterARequest = await snapshot(pg);
      check(afterARequest.project_count === beforeAPending.project_count
        && afterARequest.allocation === beforeAPending.allocation
        && afterARequest.execution === beforeAPending.execution
        && afterARequest.movements === beforeAPending.movements
        && afterARequest.transfers === beforeAPending.transfers,
      'Scenario A request changed official monetary state before approval.');
      const adminBudgetQueueA = await rpc(adminA.client, 'get_financial_budget_change_requests', {
        p_project_id: sourceProject.id, p_status: 'SUBMITTED', p_year: null, p_region_id: null,
      });
      check(adminBudgetQueueA.some((row) => row.id === aBudget.request_id),
        'Scenario A pending-fund request is missing from the admin queue.');
      const aBudgetApproved = one(await rpc(adminA.client,
        'financial_approve_budget_change_request_group', {
          p_request_id: aBudget.request_id, p_new_project_codes: {},
        }), 'Scenario A pending-fund approval');
      check(aBudgetApproved.status === 'APPROVED', 'Scenario A pending-fund request was not approved.');
    }
    if (aBudget.status !== 'APPLIED') {
      const aBudgetApplied = one(await rpc(adminA.client,
        'financial_apply_budget_change_request_dispatch', {
          p_request_id: aBudget.request_id,
        }), 'Scenario A pending-fund apply');
      check(aBudgetApplied.status === 'APPLIED' && String(aBudgetApplied.gap_amount ?? '0') === '0',
        'Scenario A pending-fund request was not applied with zero gap.');
      const afterAFunding = await position(localA.client, sourceProject.id);
      check(BigInt(afterAFunding.decrease_amount) - BigInt(beforeA.decrease_amount) === A_AMOUNT,
        'Scenario A source decrease is incorrect.');
    }

    const pendingAKey = (await pg.query(`select pending.id,pending.lot_id
      from public.financial_pending_new_project_funds pending
      where pending.source_request_id=$1 and pending.status='WAITING'`, [aBudget.request_id])).rows[0];
    check(pendingAKey, 'Scenario A did not materialize a waiting fund.');
    const sourcesA = await rpc(localA.client, 'get_financial_new_project_funding_sources', {
      p_year: targetYear, p_request_id: null,
    });
    const sourceA = sourcesA.find((row) => row.pending_fund_id === pendingAKey.id);
    check(sourceA && sourceA.region_id === profileA.region_id && sourceA.pending_status === 'WAITING'
      && Number(sourceA.target_fiscal_year) === Number(sourceA.source_fiscal_year) + 1
      && BigInt(sourceA.remaining_amount) >= BigInt(sourceA.amount),
    'Scenario A source is not eligible under the strict N-to-N+1 contract.');
    const databaseEligibleCount = Number((await pg.query(`select count(*)::integer value
      from public.financial_pending_new_project_funds pending
      join public.financial_unallocated_fund_lot_balances balances on balances.lot_id=pending.lot_id
      where pending.region_id=$1 and pending.planned_project_year=$2
        and pending.status='WAITING'
        and pending.planned_project_year=pending.fiscal_year+1
        and balances.remaining_amount>0 and balances.remaining_amount>=pending.amount
        and not exists (select 1 from public.financial_pending_new_project_link_requests links
          where links.pending_fund_id=pending.id and links.status in ('SUBMITTED','APPROVED','APPLIED'))
        and not exists (select 1 from public.financial_new_project_requests requests
          where requests.source_lot_id=pending.lot_id and requests.status in ('DRAFT','SUBMITTED','APPROVED'))`,
    [profileA.region_id, targetYear])).rows[0].value);
    check(databaseEligibleCount === sourcesA.length,
      'Scenario A local_a raw eligible count and UI RPC count differ.');
    const crossRegionSources = await rpc(localB.client, 'get_financial_new_project_funding_sources', {
      p_year: targetYear, p_request_id: null,
    });
    check(!crossRegionSources.some((row) => row.pending_fund_id === pendingAKey.id),
      'Scenario A pending source crossed the municipality RLS boundary.');

    const beforeADraft = await snapshot(pg);
    const aDraft = one(await rpc(localA.client, 'financial_save_new_project_request_draft', {
      p_request_id: null,
      p_region_id: profileA.region_id,
      p_fiscal_year: sourceA.target_fiscal_year,
      p_project_name: sourceA.planned_project_name,
      p_fund_project_name: sourceA.planned_project_name,
      p_detail_project_name: sourceA.planned_project_name,
      p_project_period: `${sourceA.target_fiscal_year}.01~${sourceA.target_fiscal_year}.12`,
      p_project_start_year: sourceA.target_fiscal_year,
      p_project_end_year: sourceA.target_fiscal_year,
      p_status: '정상추진',
      p_business_type: 'HW',
      p_large_category_id: null,
      p_middle_category_id: null,
      p_source_lot_id: sourceA.source_lot_id,
      p_requested_amount: sourceA.amount,
      p_idempotency_key: crypto.randomUUID(),
    }), 'Scenario A direct draft');
    check(aDraft.status === 'DRAFT', 'Scenario A was not saved as a draft.');
    const ownClaimedSourceA = await rpc(localA.client, 'get_financial_new_project_funding_sources', {
      p_year: targetYear, p_request_id: aDraft.request_id,
    });
    check(ownClaimedSourceA.some((row) => row.pending_fund_id === pendingAKey.id),
      'Scenario A own draft could not reload its claimed source.');
    const afterADraft = await snapshot(pg);
    check(afterADraft.project_count === beforeADraft.project_count
      && afterADraft.allocation === beforeADraft.allocation
      && afterADraft.execution === beforeADraft.execution
      && afterADraft.movements === beforeADraft.movements,
    'Scenario A draft changed official monetary state.');
    const aSubmitted = one(await rpc(localA.client, 'financial_submit_new_project_request', {
      p_request_id: aDraft.request_id,
    }), 'Scenario A submit');
    check(aSubmitted.status === 'SUBMITTED', 'Scenario A did not reach the admin queue.');
    const adminQueueA = await rpc(adminA.client, 'get_financial_new_project_requests', { p_status: 'SUBMITTED' });
    check(adminQueueA.some((row) => row.id === aDraft.request_id), 'Scenario A is missing from the admin queue.');
    const codeA = await nextOfficialCode(pg, profileA.region_id, targetYear, 901);
    const aApproved = one(await rpc(adminA.client, 'financial_approve_new_project_request', {
      p_request_id: aDraft.request_id, p_official_project_code: codeA,
    }), 'Scenario A approve');
    check(aApproved.status === 'APPROVED', 'Scenario A was not approved.');
    const aApplied = one(await rpc(adminA.client, 'financial_apply_new_project_request', {
      p_request_id: aDraft.request_id,
    }), 'Scenario A project materialization');
    check(aApplied.project_id && aApplied.project_code === codeA,
      'Scenario A project was not materialized with the approved official code.');
    const linkA = (await rpc(adminA.client, 'get_financial_pending_new_project_link_requests', {
      p_status: 'SUBMITTED',
    })).find((row) => row.pending_fund_id === sourceA.pending_fund_id);
    check(linkA, 'Scenario A automatic pending-fund link request is missing.');
    const linkApprovedA = one(await rpc(adminA.client, 'financial_review_pending_new_project_link', {
      p_request_id: linkA.id, p_decision: 'APPROVE', p_reason: null,
    }), 'Scenario A funding approval');
    check(linkApprovedA.status === 'APPROVED', 'Scenario A funding link was not approved.');
    const linkAppliedA = one(await rpc(adminA.client, 'financial_apply_pending_new_project_link', {
      p_request_id: linkA.id,
    }), 'Scenario A funding apply');
    check(linkAppliedA.status === 'APPLIED' && String(linkAppliedA.gap_amount ?? '0') === '0',
      'Scenario A funding link did not apply with zero gap.');
    const aPosition = await position(localA.client, aApplied.project_id);
    check(String(aPosition.original_allocation) === '0'
      && String(aPosition.increase_amount) === A_AMOUNT.toString()
      && String(aPosition.adjusted_allocation) === A_AMOUNT.toString()
      && String(aPosition.execution_amount) === '0',
    'Scenario A canonical monetary position is incorrect.');

    const beforeB = await position(localA.client, sourceProject.id);

    const bKey = crypto.randomUUID();
    const bDestinations = [{
      destination_type: 'PENDING_NEW_PROJECT',
      planned_project_name: '농촌 생활서비스 연계 지원사업',
      planned_project_year: targetYear,
      planned_fund_project_name: '농촌 생활서비스 연계 지원사업',
      planned_detail_project_name: '농촌 생활서비스 연계 지원사업',
      planned_project_period: `${targetYear}.01~${targetYear}.12`,
      planned_project_start_year: targetYear,
      planned_project_end_year: targetYear,
      planned_project_status: '정상추진',
      planned_business_type: 'SW',
      amount: B_AMOUNT.toString(),
      note: '',
    }];
    const beforeBDraft = await snapshot(pg);
    const bDraft = one(await rpc(localA.client,
      'financial_test_uat_save_budget_change_request_complete', {
        p_source_project_id: sourceProject.id,
        p_source_budget_year_id: null,
        p_destinations: bDestinations,
        p_effective_date: effectiveDate,
        p_reason: '차년도 생활서비스 신규사업 예산 배분',
        p_idempotency_key: bKey,
        p_submit: false,
      }), 'Scenario B budget draft');
    check(bDraft.status === 'DRAFT' && String(bDraft.gap_amount) === '0',
      'Scenario B budget draft is invalid.');
    const bRequestDraft = await requestById(localA.client, sourceProject.id, bDraft.request_id);
    const bLineDraft = bRequestDraft.destinations[0];
    check(bLineDraft?.new_project_request_id && bLineDraft.new_project_request_status === 'DRAFT',
      'Scenario B did not auto-link its generated new-project draft.');
    const afterBDraft = await snapshot(pg);
    check(afterBDraft.project_count === beforeBDraft.project_count
      && afterBDraft.allocation === beforeBDraft.allocation
      && afterBDraft.execution === beforeBDraft.execution
      && afterBDraft.movements === beforeBDraft.movements
      && afterBDraft.transfers === beforeBDraft.transfers,
    'Scenario B draft changed official monetary state.');
    const bSubmitted = one(await rpc(localA.client,
      'financial_test_uat_save_budget_change_request_complete', {
        p_source_project_id: sourceProject.id,
        p_source_budget_year_id: null,
        p_destinations: bDestinations,
        p_effective_date: effectiveDate,
        p_reason: '차년도 생활서비스 신규사업 예산 배분',
        p_idempotency_key: bKey,
        p_submit: true,
      }), 'Scenario B submit');
    check(bSubmitted.status === 'SUBMITTED', 'Scenario B was not submitted with its new project.');
    const bRequest = await requestById(adminA.client, sourceProject.id, bDraft.request_id);
    const bChildId = bRequest.destinations[0]?.new_project_request_id;
    check(bChildId, 'Scenario B submitted child is missing.');
    const codeB = await nextOfficialCode(pg, profileA.region_id, targetYear, 911);
    await adminApproveAndApplyBudget(adminA, bDraft.request_id, { [bChildId]: codeB });
    const afterB = await position(localA.client, sourceProject.id);
    check(BigInt(afterB.decrease_amount) - BigInt(beforeB.decrease_amount) === B_AMOUNT,
      'Scenario B source decrease is incorrect.');
    const bMaterialized = (await pg.query(`select projects.id,projects.original_alloc::bigint::text,
      projects.increase_amount::bigint::text,projects.alloc::bigint::text,projects.exec::bigint::text
      from public.financial_new_project_requests requests
      join public.projects on projects.id=requests.materialized_project_id where requests.id=$1`, [bChildId])).rows[0];
    check(bMaterialized?.original_alloc === '0' && bMaterialized.increase_amount === B_AMOUNT.toString()
      && bMaterialized.alloc === B_AMOUNT.toString() && bMaterialized.exec === '0',
    'Scenario B materialized monetary state is incorrect.');

    const beforeCDraft = await snapshot(pg);
    const cDraft = one(await rpc(localA.client, 'financial_save_new_project_request_draft', {
      p_request_id: null,
      p_region_id: profileA.region_id,
      p_fiscal_year: targetYear,
      p_project_name: '지역활력 복합거점 조성사업',
      p_fund_project_name: '지역활력 복합거점 조성사업',
      p_detail_project_name: '지역활력 복합거점 조성사업',
      p_project_period: `${targetYear}.01~${targetYear}.12`,
      p_project_start_year: targetYear,
      p_project_end_year: targetYear,
      p_status: '정상추진',
      p_business_type: 'COMPOSITE',
      p_large_category_id: null,
      p_middle_category_id: null,
      p_source_lot_id: null,
      p_requested_amount: 0,
      p_idempotency_key: crypto.randomUUID(),
    }), 'Scenario C standalone draft');
    check(cDraft.status === 'DRAFT', 'Scenario C unfunded draft was not saved.');
    const afterCDraft = await snapshot(pg);
    check(afterCDraft.project_count === beforeCDraft.project_count
      && afterCDraft.allocation === beforeCDraft.allocation
      && afterCDraft.execution === beforeCDraft.execution
      && afterCDraft.movements === beforeCDraft.movements
      && afterCDraft.transfers === beforeCDraft.transfers,
    'Scenario C standalone draft changed official monetary state.');
    const attachable = await rpc(localA.client, 'get_financial_attachable_new_project_drafts', {
      p_source_project_id: sourceProject.id,
    });
    check(attachable.some((row) => row.id === cDraft.request_id),
      'Scenario C standalone draft is missing from the budget-adjustment selector.');

    const beforeC = await position(localA.client, sourceProject.id);
    const cDestinations = [{
      destination_type: 'PENDING_NEW_PROJECT',
      existing_new_project_request_id: cDraft.request_id,
      planned_project_name: '지역활력 복합거점 조성사업',
      planned_project_year: targetYear,
      planned_fund_project_name: '지역활력 복합거점 조성사업',
      planned_detail_project_name: '지역활력 복합거점 조성사업',
      planned_project_period: `${targetYear}.01~${targetYear}.12`,
      planned_project_start_year: targetYear,
      planned_project_end_year: targetYear,
      planned_project_status: '정상추진',
      planned_business_type: 'COMPOSITE',
      amount: C_AMOUNT.toString(),
      note: '',
    }];
    const cBudget = one(await rpc(localA.client,
      'financial_test_uat_save_budget_change_request_complete', {
        p_source_project_id: sourceProject.id,
        p_source_budget_year_id: null,
        p_destinations: cDestinations,
        p_effective_date: effectiveDate,
        p_reason: '차년도 지역활력 신규사업 예산 배분',
        p_idempotency_key: crypto.randomUUID(),
        p_submit: true,
      }), 'Scenario C attach and submit');
    check(cBudget.status === 'SUBMITTED' && String(cBudget.gap_amount) === '0',
      'Scenario C was not atomically attached and submitted.');
    const linkedC = (await pg.query(`select status,source_budget_change_request_id,
      source_budget_change_line_id,source_lot_id,requested_amount::bigint::text,linked_from_standalone
      from public.financial_new_project_requests where id=$1`, [cDraft.request_id])).rows[0];
    check(linkedC?.status === 'SUBMITTED' && linkedC.source_budget_change_request_id === cBudget.request_id
      && linkedC.source_budget_change_line_id && linkedC.source_lot_id === null
      && linkedC.requested_amount === C_AMOUNT.toString() && linkedC.linked_from_standalone === true,
    'Scenario C standalone draft did not join the budget group correctly.');
    const codeC = await nextOfficialCode(pg, profileA.region_id, targetYear, 921);
    await adminApproveAndApplyBudget(adminA, cBudget.request_id, { [cDraft.request_id]: codeC });
    const afterC = await position(localA.client, sourceProject.id);
    check(BigInt(afterC.decrease_amount) - BigInt(beforeC.decrease_amount) === C_AMOUNT,
      'Scenario C source decrease is incorrect.');
    const cMaterialized = (await pg.query(`select projects.id,projects.original_alloc::bigint::text,
      projects.increase_amount::bigint::text,projects.alloc::bigint::text,projects.exec::bigint::text
      from public.financial_new_project_requests requests
      join public.projects on projects.id=requests.materialized_project_id where requests.id=$1`, [cDraft.request_id])).rows[0];
    check(cMaterialized?.original_alloc === '0' && cMaterialized.increase_amount === C_AMOUNT.toString()
      && cMaterialized.alloc === C_AMOUNT.toString() && cMaterialized.exec === '0',
    'Scenario C materialized monetary state is incorrect.');

    const freshLocalA = await signIn(url, key, required(env, 'UAT_LOCAL_A_EMAIL'),
      required(env, 'UAT_LOCAL_A_PASSWORD'), 'local_a fresh');
    const freshRequestsA = await rpc(freshLocalA.client, 'get_financial_new_project_requests', { p_status: null });
    check(freshRequestsA.some((row) => row.id === aDraft.request_id && row.status === 'APPLIED')
      && freshRequestsA.some((row) => row.id === cDraft.request_id && row.status === 'APPLIED'),
    'Scenario A/C admin results are missing from a fresh local read.');

    const finalInvariant = (await pg.query(`select
      (select coalesce(sum(requests.total_amount - lines.amount_sum),0)::bigint::text
       from public.financial_budget_change_requests requests
       join lateral (select coalesce(sum(amount),0)::bigint amount_sum
         from public.financial_budget_change_request_lines where request_id=requests.id) lines on true
       where requests.id=any($1::uuid[])) request_gap,
      (select count(*)::integer from public.financial_new_project_requests requests
       where requests.id=any($2::uuid[]) and requests.status<>'APPLIED') unapplied_new_projects,
      (select count(*)::integer from public.financial_budget_change_requests requests
       where requests.id=any($1::uuid[]) and requests.status<>'APPLIED') unapplied_budget_requests`,
    [[aBudget.request_id, bDraft.request_id, cBudget.request_id],
      [aDraft.request_id, bChildId, cDraft.request_id]])).rows[0];
    check(finalInvariant.request_gap === '0' && finalInvariant.unapplied_new_projects === 0
      && finalInvariant.unapplied_budget_requests === 0, 'Final workflow invariant failed.');

    process.stdout.write(`${JSON.stringify({
      status: 'PASS',
      target: 'TEST',
      production_touched: false,
      local_a_region: profileA.region_name,
      local_b_region: profileB.region_name,
      recovered_partial_checkpoint_count: partialLinksA.length,
      scenario_a: {
        source_year: sourceA.source_fiscal_year,
        target_year: sourceA.target_fiscal_year,
        source_project: sourceA.source_project_name,
        new_project: sourceA.planned_project_name,
        amount: String(sourceA.amount),
        pending_budget_created_without_project: true,
        database_eligible_count_after_creation: databaseEligibleCount,
        ui_rpc_count_after_creation: sourcesA.length,
        cross_region_visible: false,
        final_status: '적용완료',
        official_project_code: codeA,
        monetary_gap: '0',
      },
      scenario_b: {
        source_year: sourceProject.year,
        target_year: targetYear,
        source_project: sourceName,
        new_project: '농촌 생활서비스 연계 지원사업',
        amount: B_AMOUNT.toString(),
        auto_linked_without_selector: true,
        draft_monetary_effect: '0',
        final_status: '적용완료',
        official_project_code: codeB,
        monetary_gap: (BigInt(afterB.decrease_amount) - BigInt(beforeB.decrease_amount) - B_AMOUNT).toString(),
      },
      scenario_c: {
        source_year: sourceProject.year,
        target_year: targetYear,
        source_project: sourceName,
        new_project: '지역활력 복합거점 조성사업',
        amount: C_AMOUNT.toString(),
        unfunded_draft_saved: true,
        appeared_in_draft_selector: true,
        linked_to_budget_group: true,
        draft_monetary_effect: '0',
        final_status: '적용완료',
        official_project_code: codeC,
        monetary_gap: (BigInt(afterC.decrease_amount) - BigInt(beforeC.decrease_amount) - C_AMOUNT).toString(),
      },
      admin_local_fresh_read_synced: true,
      request_group_gap: finalInvariant.request_gap,
    }, null, 2)}\n`);

    await freshLocalA.client.auth.signOut().catch(() => undefined);
  } finally {
    await pg.end().catch(() => undefined);
    await Promise.all([localA.client.auth.signOut(), localB.client.auth.signOut(), adminA.client.auth.signOut()])
      .catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`NEW PROJECT FUNDING WORKFLOW UAT FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
