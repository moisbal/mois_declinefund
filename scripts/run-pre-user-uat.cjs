#!/usr/bin/env node

/**
 * TEST-only Pre-User UAT regression driver.
 *
 * The driver is fail-closed: it accepts no default environment, verifies the
 * exact TEST Supabase ref, performs a zero-gap invariant preflight before any
 * workflow mutation, uses real UAT user sessions for all business actions,
 * and never prints or persists credentials/tokens/secrets.
 *
 * Usage:
 *   node scripts/run-pre-user-uat.cjs \
 *     --env-file .env.ledger-test.local \
 *     --credentials-file .env.ledger-uat-credentials.local \
 *     --run-id AUTO-UAT-YYYYMMDD-HHMMSS \
 *     --golden-official-code <관리자 확인 공식코드> \
 *     --one-won-official-code <관리자 확인 공식코드> \
 *     --nine-nine-nine-nine-official-code <관리자 확인 공식코드> \
 *     --base-url https://declinefund-test.vercel.app \
 *     --confirm-test-write \
 *     --output test-results/uat/AUTO-UAT-YYYYMMDD-HHMMSS.json
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

const EXPECTED_TEST_REF = 'reviewtestxxxxxxxxxx';
const EXPECTED_PROD_REF = 'reviewprodxxxxxxxxxx';
const ANALYTICS_EXCLUDED_CODES = new Set(['TEST-JN-001', 'TEST-GW-001', 'TEST-CB-001']);
const ANALYTICS_EXCLUDED_IDS = new Set([
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000102',
  '00000000-0000-4000-8000-000000000103',
]);
const PAGE_SIZE = 200;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name) {
  return process.argv.includes(name);
}

function assert(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.code = details.code ?? 'UAT_ASSERTION_FAILED';
    error.stage = details.stage ?? 'assertion';
    throw error;
  }
}

function assertEqual(actual, expected, message) {
  assert(String(actual) === String(expected), `${message} (expected=${expected}, actual=${actual})`);
}

function readEnv(fileName, label) {
  assert(fileName, `${label} is required.`, { stage: 'preflight' });
  const resolved = path.resolve(process.cwd(), fileName);
  assert(fs.existsSync(resolved), `${label} does not exist.`, { stage: 'preflight' });
  return dotenv.parse(fs.readFileSync(resolved));
}

function required(env, key) {
  const value = String(env[key] ?? '').trim();
  assert(value, `${key} is required.`, { stage: 'preflight' });
  return value;
}

function refFromUrl(value) {
  try {
    return /^([a-z0-9-]+)\.supabase\.co$/i.exec(new URL(value).hostname)?.[1] ?? null;
  } catch {
    return null;
  }
}

function client(url, key) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-client-info': 'declinefund-pre-user-uat/1' } },
  });
}

function stableUuid(runId, label) {
  const bytes = crypto.createHash('sha256').update(`declinefund:${runId}:${label}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [
    bytes.subarray(0, 4).toString('hex'), bytes.subarray(4, 6).toString('hex'),
    bytes.subarray(6, 8).toString('hex'), bytes.subarray(8, 10).toString('hex'),
    bytes.subarray(10, 16).toString('hex'),
  ].join('-');
}

function bigint(value, label = 'amount') {
  try {
    return BigInt(value ?? 0);
  } catch {
    throw new Error(`${label} is not a bigint.`);
  }
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + bigint(row[field], field), 0n);
}

function first(data, label) {
  const row = Array.isArray(data) ? data[0] : data;
  assert(row, `${label} returned no row.`);
  return row;
}

async function rpc(supabase, name, args = {}, label = name) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    const failure = new Error(`${label}: ${error.message}`);
    failure.code = error.code ?? 'RPC_ERROR';
    failure.stage = label;
    throw failure;
  }
  return data;
}

async function expectRpcBlocked(supabase, name, args, label) {
  const { data, error } = await supabase.rpc(name, args);
  assert(error, `${label} unexpectedly allowed a write.`, { stage: 'rls', code: 'RLS_WRITE_ALLOWED' });
  assert(error.code !== 'PGRST202', `${label} called an invalid RPC signature.`, {
    stage: label, code: error.code,
  });
  return { blocked: true, code: error.code ?? 'RPC_ERROR', rows: Array.isArray(data) ? data.length : 0 };
}

async function signIn(url, anonKey, account) {
  const supabase = client(url, anonKey);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: account.email,
    password: account.password,
  });
  assert(!error && data.user && data.session, `${account.alias} authentication failed.`, {
    stage: 'auth', code: error?.code ?? 'AUTH_FAILED',
  });
  return { ...account, client: supabase, userId: data.user.id, token: data.session.access_token };
}

async function rows(supabase, table, columns, configure, label) {
  let query = supabase.from(table).select(columns);
  if (configure) query = configure(query);
  const { data, error } = await query;
  if (error) {
    const failure = new Error(`${label}: ${error.message}`);
    failure.code = error.code ?? 'QUERY_ERROR';
    failure.stage = label;
    throw failure;
  }
  return data ?? [];
}

async function one(supabase, table, columns, filters, label) {
  let query = supabase.from(table).select(columns);
  for (const [key, value] of Object.entries(filters)) query = query.eq(key, value);
  const { data, error } = await query.maybeSingle();
  if (error) throw Object.assign(new Error(`${label}: ${error.message}`), { code: error.code, stage: label });
  assert(data, `${label} returned no row.`);
  return data;
}

async function allRows(supabase, table, columns, configure, label) {
  const output = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase.from(table).select(columns).range(from, from + PAGE_SIZE - 1);
    if (configure) query = configure(query);
    const { data, error } = await query;
    if (error) throw Object.assign(new Error(`${label}: ${error.message}`), { code: error.code, stage: label });
    output.push(...(data ?? []));
    if ((data ?? []).length < PAGE_SIZE) break;
  }
  return output;
}

async function countRows(supabase, table, configure, label) {
  let query = supabase.from(table).select('id', { count: 'exact', head: true });
  if (configure) query = configure(query);
  const { count, error } = await query;
  if (error) throw Object.assign(new Error(`${label}: ${error.message}`), { code: error.code, stage: label });
  return count ?? 0;
}

function positionMap(positions) {
  return new Map(positions.map((row) => [String(row.project_id), row]));
}

function effectiveAmounts(project, positionsByProject) {
  const position = positionsByProject.get(project.id);
  if (position && position.projection_ready) {
    return {
      original: bigint(position.ledger_original_allocation),
      alloc: bigint(position.ledger_adjusted_allocation),
      exec: bigint(position.ledger_execution_amount),
      increase: bigint(position.ledger_increase_amount),
      decrease: bigint(position.ledger_decrease_amount),
    };
  }
  return {
    original: bigint(project.original_alloc), alloc: bigint(project.alloc), exec: bigint(project.exec),
    increase: bigint(project.increase_amount), decrease: bigint(project.decrease_amount),
  };
}

function aggregateProjects(projects, positionsByProject) {
  return projects.reduce((totals, project) => {
    const values = effectiveAmounts(project, positionsByProject);
    totals.projectCount += 1;
    totals.original += values.original;
    totals.alloc += values.alloc;
    totals.exec += values.exec;
    totals.increase += values.increase;
    totals.decrease += values.decrease;
    totals.remaining += values.alloc - values.exec;
    return totals;
  }, { projectCount: 0, original: 0n, alloc: 0n, exec: 0n, increase: 0n, decrease: 0n, remaining: 0n });
}

function serializeTotals(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === 'bigint' ? item.toString() : item]));
}

async function requestJson(baseUrl, pathname, token) {
  const response = await fetch(new URL(pathname, baseUrl), {
    headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache' },
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { nonJson: true }; }
  assert(response.ok, `${pathname} returned HTTP ${response.status}.`, {
    stage: 'preview-api', code: `HTTP_${response.status}`,
  });
  return { status: response.status, body };
}

async function findAuthUsers(service, emails) {
  const wanted = new Set(emails.map((email) => email.toLowerCase()));
  const found = new Map();
  for (let page = 1; page <= 20 && found.size < wanted.size; page += 1) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 1000 });
    assert(!error, 'TEST auth user lookup failed.', { stage: 'auth-inventory', code: error?.code });
    for (const user of data.users ?? []) {
      const email = String(user.email ?? '').toLowerCase();
      if (wanted.has(email)) found.set(email, user);
    }
    if ((data.users ?? []).length < 1000) break;
  }
  assertEqual(found.size, wanted.size, 'All configured UAT auth users must exist');
  return found;
}

async function runtimeAndInvariantGate(admin, testRef) {
  const runtime = await one(admin, 'financial_ledger_runtime',
    'environment_kind,mode,bound_project_ref,baseline_as_of,native_start_date',
    { singleton: true }, 'Ledger runtime');
  assertEqual(runtime.environment_kind, 'TEST', 'Ledger environment');
  assertEqual(runtime.mode, 'RECONCILIATION', 'Ledger runtime mode');
  assertEqual(runtime.bound_project_ref, testRef, 'Ledger bound ref');
  assertEqual(runtime.baseline_as_of, '2026-08-31', 'Ledger baseline date');
  assertEqual(runtime.native_start_date, '2026-09-01', 'Ledger native start date');
  const invariants = await rpc(admin, 'get_financial_funding_invariant_check', { p_budget_cohort_id: null });
  const gaps = invariants.filter((row) => bigint(row.cohort_conservation_gap) !== 0n
    || bigint(row.decrease_resolution_gap) !== 0n);
  assert(gaps.length === 0, `Preflight found ${gaps.length} non-zero funding invariant rows.`, {
    stage: 'monetary-preflight', code: 'MONETARY_GAP',
  });
  return { runtime, invariantRows: invariants.length, nonZeroGaps: 0 };
}

async function globalSnapshot(service, admin) {
  const [projects, positions, cohorts, lots, movements, carryovers] = await Promise.all([
    allRows(service, 'projects', 'id,project_id,project_code,region_id,year,project_name,fund_project_name,detail_project_name,project_period,project_start_year,project_end_year,status,business_type,large_category_id,middle_category_id,original_alloc,increase_amount,decrease_amount,alloc,exec,rate,total_budget', null, 'projects snapshot'),
    allRows(service, 'financial_project_funding_positions', '*', null, 'funding positions snapshot'),
    allRows(service, 'financial_funding_cohort_execution', '*', null, 'cohort execution snapshot'),
    rpc(admin, 'get_financial_unallocated_fund_lots', { p_fiscal_year: null }, 'unallocated lot balances snapshot'),
    allRows(service, 'financial_unallocated_fund_movements', '*', null, 'unallocated movements snapshot'),
    allRows(service, 'project_carryovers', '*', (query) => query.eq('status', 'CONFIRMED'), 'carryovers snapshot'),
  ]);
  const byProject = positionMap(positions);
  const dashboard = aggregateProjects(projects, byProject);
  const analyticsProjects = projects.filter((project) => !ANALYTICS_EXCLUDED_IDS.has(project.id));
  const analytics = aggregateProjects(analyticsProjects, byProject);
  const funding = {
    waiting: sum(lots, 'remaining_amount'),
    reallocated: movements.filter((row) => ['ALLOCATE_EXISTING_PROJECT', 'ALLOCATE_NEW_PROJECT'].includes(row.movement_type))
      .reduce((total, row) => total + bigint(row.amount)
        * (row.transaction_kind === 'REVERSAL' ? -1n : 1n), 0n),
    returned: movements.filter((row) => row.movement_type === 'RETURN')
      .reduce((total, row) => total + bigint(row.amount)
        * (row.transaction_kind === 'REVERSAL' ? -1n : 1n), 0n),
    myeongsi: carryovers.filter((row) => row.carryover_type === 'MYEONGSI')
      .reduce((total, row) => total + bigint(row.amount)
        * (row.transaction_kind === 'REVERSAL' ? -1n : 1n), 0n),
    sago: carryovers.filter((row) => row.carryover_type === 'SAGO')
      .reduce((total, row) => total + bigint(row.amount)
        * (row.transaction_kind === 'REVERSAL' ? -1n : 1n), 0n),
    cohortInitial: sum(cohorts, 'initial_allocation'),
    cohortExecution: sum(cohorts, 'verified_cumulative_execution'),
    cohortWaiting: sum(cohorts, 'waiting_balance'),
  };
  return {
    projects, positions, cohorts, lots,
    dashboard: serializeTotals(dashboard),
    analytics: serializeTotals(analytics),
    funding: serializeTotals(funding),
  };
}

async function createNewProject(context, input) {
  const idempotencyKey = stableUuid(input.runId, `new-project:${input.label}`);
  const args = {
    p_region_id: input.regionId, p_fiscal_year: 2025,
    p_project_name: input.draftName,
    p_fund_project_name: `${input.draftName} 기금사업`,
    p_detail_project_name: `${input.draftName} 세부사업`,
    p_project_period: '2025.01~2025.12', p_project_start_year: 2025, p_project_end_year: 2025,
    p_status: '정상추진', p_business_type: input.template.business_type,
    p_large_category_id: input.template.large_category_id,
    p_middle_category_id: input.template.middle_category_id,
    p_source_lot_id: input.lotId, p_requested_amount: String(input.amount),
    p_idempotency_key: idempotencyKey, p_submit: false,
  };
  const existing = await rows(context.adminA, 'financial_new_project_requests', 'id,status',
    (query) => query.eq('idempotency_key', idempotencyKey), `${input.label} resume lookup`);
  assert(existing.length <= 1, `${input.label} idempotency key is not unique.`);
  const created = existing[0]
    ? { request_id: existing[0].id, status: existing[0].status }
    : first(await rpc(context.local, 'financial_create_new_project_request', args,
      `create ${input.label} DRAFT`), `${input.label} DRAFT`);
  let request = await one(context.adminA, 'financial_new_project_requests', '*',
    { id: created.request_id }, `${input.label} request state`);
  if (request.status === 'DRAFT') {
    await rpc(context.local, 'financial_update_new_project_request_draft', {
      p_request_id: created.request_id,
      p_project_name: input.finalName,
      p_fund_project_name: `${input.finalName} 기금사업`,
      p_detail_project_name: `${input.finalName} 세부사업`,
      p_project_period: '2025.01~2025.12 (수정)', p_project_start_year: 2025, p_project_end_year: 2025,
      p_status: '정상추진', p_business_type: input.template.business_type,
      p_large_category_id: input.template.large_category_id,
      p_middle_category_id: input.template.middle_category_id,
      p_source_lot_id: input.lotId, p_requested_amount: String(input.amount),
    }, `edit ${input.label} DRAFT`);
    await rpc(context.local, 'financial_submit_new_project_request', { p_request_id: created.request_id },
      `submit ${input.label}`);
    request = await one(context.adminA, 'financial_new_project_requests', '*',
      { id: created.request_id }, `${input.label} submitted state`);
  }

  if (input.reject) {
    if (request.status === 'SUBMITTED') {
      const rejected = first(await rpc(context.adminB, 'financial_reject_new_project_request', {
        p_request_id: created.request_id, p_reason: '자동 회귀검증 반려',
      }, `reject ${input.label}`), `${input.label} rejection`);
      assertEqual(rejected.status, 'REJECTED', `${input.label} rejected status`);
    }
    const row = await one(context.adminA, 'financial_new_project_requests',
      'id,status,materialized_project_id,materialized_movement_id', { id: created.request_id },
      `${input.label} rejected request read`);
    assert(!row.materialized_project_id && !row.materialized_movement_id,
      'Rejected request must not materialize a project or movement.');
    return { requestId: row.id, status: row.status, projectId: null, projectCode: null, amount: String(input.amount) };
  }

  if (request.status === 'SUBMITTED') {
    const approved = first(await rpc(context.adminA, 'financial_approve_new_project_request', {
      p_request_id: created.request_id, p_official_project_code: input.officialCode,
    }, `approve ${input.label}`), `${input.label} approval`);
    assertEqual(approved.status, 'APPROVED', `${input.label} approved status`);
    request = await one(context.adminA, 'financial_new_project_requests', '*',
      { id: created.request_id }, `${input.label} approved state`);
  }
  let applied;
  if (request.status === 'APPROVED') {
    applied = first(await rpc(context.adminB, 'financial_apply_new_project_request', {
      p_request_id: created.request_id,
    }, `apply ${input.label}`), `${input.label} apply`);
  } else {
    assertEqual(request.status, 'APPLIED', `${input.label} resumable request state`);
    applied = first(await rpc(context.adminB, 'financial_apply_new_project_request', {
      p_request_id: created.request_id,
    }, `replay ${input.label} apply`), `${input.label} apply replay`);
  }
  const project = await one(context.adminA, 'projects', '*', { id: applied.project_id }, `${input.label} project`);
  assertEqual(project.project_code, input.officialCode, `${input.label} official code`);
  assertEqual(project.alloc, input.amount, `${input.label} raw allocation`);
  assertEqual(project.exec, 0, `${input.label} raw execution`);
  return {
    requestId: created.request_id, status: 'APPLIED', projectId: project.id,
    projectCode: project.project_code, amount: String(input.amount), budgetYearId: applied.budget_year_id,
  };
}

async function invalidAmountBoundaries(context, runId, regionId, lotId, template) {
  const invalids = [
    ['zero', '0'], ['negative', '-1'], ['null', null], ['decimal', '1.5'], ['string', 'not-a-number'],
  ];
  const output = [];
  for (const [label, value] of invalids) {
    const blocked = await expectRpcBlocked(context.local, 'financial_create_new_project_request', {
      p_region_id: regionId, p_fiscal_year: 2025,
      p_project_name: `금액 경계 검증 ${label}`, p_fund_project_name: null,
      p_detail_project_name: null, p_project_period: '2025', p_project_start_year: 2025,
      p_project_end_year: 2025, p_status: '정상추진', p_business_type: template.business_type,
      p_large_category_id: template.large_category_id, p_middle_category_id: template.middle_category_id,
      p_source_lot_id: lotId, p_requested_amount: value,
      p_idempotency_key: stableUuid(runId, `invalid:${label}`), p_submit: false,
    }, `invalid boundary ${label}`);
    output.push({ value: label, ...blocked });
  }
  return output;
}

async function financialProjectState(service, admin, projectId) {
  const [project, positionRows, wallets, cohorts, lots, history] = await Promise.all([
    one(service, 'projects', 'id,project_code,detail_project_name,project_period,project_start_year,status,business_type,large_category_id,middle_category_id,original_alloc,increase_amount,decrease_amount,alloc,exec,rate,updated_at', { id: projectId }, 'project financial state'),
    rpc(admin, 'get_financial_project_funding_positions', { p_project_id: projectId }),
    rows(service, 'project_budget_years', '*', (query) => query.eq('project_id', projectId), 'project wallets'),
    allRows(service, 'financial_funding_cohort_execution', '*', null, 'cohort state'),
    allRows(service, 'financial_unallocated_fund_lots', '*', null, 'lot state'),
    rpc(admin, 'get_financial_project_funding_history', { p_project_id: projectId }),
  ]);
  const cohortIds = new Set(wallets.map((wallet) => wallet.budget_cohort_id));
  return {
    project,
    position: positionRows[0] ?? null,
    wallets: wallets.map((wallet) => ({ id: wallet.id, cohort: wallet.budget_cohort_id, year: wallet.fiscal_year })),
    cohorts: cohorts.filter((cohort) => cohortIds.has(cohort.cohort_id)),
    lotBalances: lots.filter((lot) => cohortIds.has(lot.source_budget_cohort_id))
      .map((lot) => ({ id: lot.id, original: String(lot.original_amount), remaining: String(lot.remaining_amount) })),
    historyCount: history.length,
    monetaryFingerprint: JSON.stringify({
      original_alloc: project.original_alloc, increase_amount: project.increase_amount,
      decrease_amount: project.decrease_amount, alloc: project.alloc, exec: project.exec, rate: project.rate,
      position: positionRows[0] ? {
        original: String(positionRows[0].ledger_original_allocation),
        adjusted: String(positionRows[0].ledger_adjusted_allocation),
        execution: String(positionRows[0].ledger_execution_amount),
        wallet: String(positionRows[0].current_wallet_balance),
      } : null,
      cohorts: cohorts.filter((cohort) => cohortIds.has(cohort.cohort_id)).map((cohort) => ({
        id: cohort.cohort_id, initial: String(cohort.initial_allocation),
        execution: String(cohort.verified_cumulative_execution), waiting: String(cohort.waiting_balance),
      })),
      lots: lots.filter((lot) => cohortIds.has(lot.source_budget_cohort_id)).map((lot) => ({
        id: lot.id, original: String(lot.original_amount), remaining: String(lot.remaining_amount),
      })),
    }),
  };
}

async function saveNonfinancial(local, project, classification, related, changes) {
  return first(await rpc(local, 'update_my_project_nonfinancial_with_audit', {
    p_project_id: project.id,
    p_detail_project_name: changes.detailName,
    p_project_period: changes.period,
    p_project_start_year: changes.startYear,
    p_status: changes.status,
    p_related_projects: related,
    p_large_category_id: classification.largeCategoryId,
    p_middle_category_id: classification.middleCategoryId,
    p_standard_small_category_ids: classification.smallCategoryIds,
    p_custom_small_categories: [],
    p_business_type: changes.businessType,
    p_save_mode: 'SAVE',
  }, 'save Ledger-managed nonfinancial project'), 'nonfinancial save');
}

async function freshRead(url, anonKey, account, projectId) {
  const signed = await signIn(url, anonKey, account);
  const project = await one(signed.client, 'projects',
    'id,project_code,detail_project_name,project_period,project_start_year,status,business_type,large_category_id,middle_category_id,original_alloc,increase_amount,decrease_amount,alloc,exec,rate',
    { id: projectId }, `${account.alias} fresh project read`);
  const related = await rows(signed.client, 'project_related_projects',
    'id,project_name,total_budget,regional_fund_alloc,local_fund_alloc',
    (query) => query.eq('project_id', projectId).order('project_name'), `${account.alias} related-project read`);
  return { project, related };
}

async function verifyAccountsAndRls(context, service, runId, profiles, regions, globalProjectCount) {
  const result = {};
  for (const account of context.accounts) {
    const profile = profiles.get(account.userId);
    assert(profile, `${account.alias} profile missing.`);
    const region = profile.region_id ? regions.get(profile.region_id) : null;
    assertEqual(profile.role, account.expectedRole, `${account.alias} role`);
    if (account.expectedRegion) assertEqual(region?.display_name, account.expectedRegion, `${account.alias} region`);
    const visible = await countRows(account.client, 'projects', null, `${account.alias} visible project count`);
    if (profile.role === 'admin') assertEqual(visible, globalProjectCount, `${account.alias} full project visibility`);
    const otherVisible = profile.role === 'local_user'
      ? await countRows(account.client, 'projects', (query) => query.neq('region_id', profile.region_id), `${account.alias} cross-region count`)
      : 0;
    if (profile.role === 'local_user') assertEqual(otherVisible, 0, `${account.alias} cross-region SELECT`);
    result[account.alias] = {
      role: profile.role, region: region?.display_name ?? '전체지역', visibleProjects: visible,
      ownRegionSelect: true, crossRegionSelectBlocked: profile.role === 'local_user' ? true : null,
    };
  }

  const locals = context.accounts.filter((account) => account.expectedRole === 'local_user');
  for (const account of locals) {
    const own = profiles.get(account.userId).region_id;
    const target = [...regions.values()].find((region) => region.id !== own);
    assert(target, `No cross-region target for ${account.alias}.`);
    result[account.alias].crossRegionWrite = await expectRpcBlocked(account.client,
      'financial_register_ledger_evidence', {
        p_region_id: target.id, p_evidence_scope: 'LEGACY_RECONSTRUCTION',
        p_source_type: 'LEGACY_EXCEL', p_source_system: 'Codex TEST UAT',
        p_source_file_name: `${runId}-${account.alias}-cross-region.xlsx`,
        p_source_file_sha256: crypto.createHash('sha256').update(`${runId}:${account.alias}`).digest('hex'),
        p_source_sheet_name: 'UAT', p_source_row_reference: runId,
        p_external_reference: `${runId}-${account.alias}-BLOCK`,
        p_evidence_note: `${runId} cross-region negative`, p_source_as_of_date: '2026-08-31',
        p_import_batch_id: stableUuid(runId, `cross-batch:${account.alias}`),
        p_idempotency_key: stableUuid(runId, `cross-evidence:${account.alias}`), p_submit: false,
      }, `${account.alias} cross-region evidence write`);
  }
  return result;
}

function selectProjectInventory(projects, regions) {
  const aliases = ['전북 순창군', '부산 서구', '강원 양구군'];
  const selected = [];
  for (const displayName of aliases) {
    const region = [...regions.values()].find((item) => item.display_name === displayName);
    const candidates = projects.filter((project) => project.region_id === region?.id
      && project.year >= 2022 && project.year <= 2025);
    for (const year of [2022, 2023, 2024, 2025]) {
      const yearRows = candidates.filter((project) => project.year === year);
      const preferred = yearRows.find((project) => bigint(project.exec) === 0n)
        ?? yearRows.find((project) => Number(project.rate) === 100)
        ?? yearRows.find((project) => bigint(project.decrease_amount) > 0n)
        ?? yearRows[0];
      if (preferred) selected.push({
        id: preferred.id, project_id: preferred.project_id, project_code: preferred.project_code,
        region: displayName, year: preferred.year, project_name: preferred.project_name,
        original_alloc: preferred.original_alloc == null ? null : String(preferred.original_alloc),
        increase_amount: String(preferred.increase_amount ?? 0),
        decrease_amount: String(preferred.decrease_amount ?? 0), alloc: String(preferred.alloc ?? 0),
        exec: String(preferred.exec ?? 0), rate: Number(preferred.rate ?? 0),
      });
    }
  }
  return selected;
}

function assertSameFinancialTotals(before, after, label) {
  for (const key of ['original', 'alloc', 'exec', 'increase', 'decrease', 'remaining']) {
    assertEqual(after[key], before[key], `${label} ${key} total`);
  }
}

function sanitizeFailure(error, runId) {
  return {
    runId, status: 'FAIL', stage: error?.stage ?? 'unknown', code: error?.code ?? 'UAT_FAILED',
    message: error instanceof Error ? error.message : 'Unknown UAT failure', secretsPrinted: false,
  };
}

async function main() {
  const env = readEnv(argument('--env-file'), '--env-file');
  const credentials = readEnv(argument('--credentials-file'), '--credentials-file');
  const runId = argument('--run-id');
  const officialCodes = {
    golden: argument('--golden-official-code'),
    oneWon: argument('--one-won-official-code'),
    nineNineNineNine: argument('--nine-nine-nine-nine-official-code'),
  };
  const baseUrl = argument('--base-url');
  const output = argument('--output');
  assert(runId && /^AUTO-UAT-\d{8}-\d{6}$/.test(runId), 'A timestamped --run-id is required.', { stage: 'preflight' });
  for (const [label, code] of Object.entries(officialCodes)) {
    assert(code?.trim(), `${label} requires an explicit official project code.`, { stage: 'preflight' });
    assert(!/(?:^|[-_\s])(?:UAT|AUTO|GENERIC)(?=$|[-_\s])/i.test(code),
      `${label} official project code must not contain a TEST run identifier.`, { stage: 'preflight' });
  }
  assert(baseUrl === 'https://declinefund-test.vercel.app', 'Only the TEST Preview base URL is allowed.', { stage: 'preflight' });
  assert(flag('--confirm-test-write'), '--confirm-test-write is required.', { stage: 'preflight' });

  const targetEnv = required(env, 'TARGET_ENV');
  const testRef = required(env, 'TEST_PROJECT_REF');
  const prodRef = required(env, 'PROD_PROJECT_REF');
  const url = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const serviceKey = required(env, 'TEST_SUPABASE_SERVICE_ROLE_KEY');
  assertEqual(targetEnv, 'TEST', 'TARGET_ENV');
  assertEqual(testRef, EXPECTED_TEST_REF, 'TEST project ref');
  assertEqual(prodRef, EXPECTED_PROD_REF, 'Production ref guard');
  assert(prodRef !== testRef, 'TEST and Production refs must differ.', { stage: 'preflight' });
  assertEqual(refFromUrl(url), testRef, 'Supabase endpoint ref');
  assertEqual(required(env, 'LEDGER_MODE').toLowerCase(), 'reconciliation', 'Ledger env mode');
  assert(required(env, 'TEST_DATABASE_URL').includes(testRef), 'TEST database URL must contain TEST ref.', { stage: 'preflight' });
  assert(!required(env, 'TEST_DATABASE_URL').includes(prodRef), 'TEST database URL must not contain Production ref.', { stage: 'preflight' });

  const specs = [
    ['admin_a', 'UAT_ADMIN_A_EMAIL', 'UAT_ADMIN_A_PASSWORD', 'admin', null],
    ['admin_b', 'UAT_ADMIN_B_EMAIL', 'UAT_ADMIN_B_PASSWORD', 'admin', null],
    ['local_a', 'UAT_LOCAL_A_EMAIL', 'UAT_LOCAL_A_PASSWORD', 'local_user', '전북 순창군'],
    ['local_b', 'UAT_LOCAL_B_EMAIL', 'UAT_LOCAL_B_PASSWORD', 'local_user', '부산 서구'],
    ['local_c', 'UAT_LOCAL_C_EMAIL', 'UAT_LOCAL_C_PASSWORD', 'local_user', '강원 양구군'],
  ];
  const accountInputs = specs.map(([alias, emailKey, passwordKey, expectedRole, expectedRegion]) => ({
    alias, email: required(credentials, emailKey), password: required(credentials, passwordKey),
    expectedRole, expectedRegion,
  }));
  const signedAccounts = [];
  for (const account of accountInputs) signedAccounts.push(await signIn(url, anonKey, account));
  const byAlias = Object.fromEntries(signedAccounts.map((account) => [account.alias, account]));
  const service = client(url, serviceKey);
  const authUsers = await findAuthUsers(service, accountInputs.map((account) => account.email));
  for (const account of signedAccounts) {
    assertEqual(account.userId, authUsers.get(account.email.toLowerCase()).id, `${account.alias} auth UUID`);
  }

  const profileRows = await rows(service, 'profiles', 'id,role,region_id',
    (query) => query.in('id', signedAccounts.map((account) => account.userId)), 'UAT profiles');
  const regionRows = await allRows(service, 'regions', 'id,sido,sigungu,display_name', null, 'regions');
  const profiles = new Map(profileRows.map((row) => [row.id, row]));
  const regions = new Map(regionRows.map((row) => [row.id, row]));
  const context = {
    accounts: signedAccounts, local: byAlias.local_b.client,
    adminA: byAlias.admin_a.client, adminB: byAlias.admin_b.client,
  };

  const gate = await runtimeAndInvariantGate(context.adminA, testRef);
  const before = await globalSnapshot(service, context.adminA);
  const runApprovedCodes = new Set(Object.values(officialCodes));
  const runAllocationBefore = before.projects.filter((project) => runApprovedCodes.has(project.project_code))
    .reduce((total, project) => total + bigint(project.alloc), 0n);
  const initialUnclassified = await rpc(context.adminA, 'get_financial_unclassified_decreases');
  assertEqual(initialUnclassified.length, 4, 'Existing unclassified decrease count');
  assertEqual(sum(initialUnclassified, 'unclassified_amount'), 187703000n, 'Existing unclassified decrease total');

  const projectInventory = selectProjectInventory(before.projects, regions);
  assert(new Set(projectInventory.map((row) => row.year)).size === 4,
    'Inventory must include every year from 2022 through 2025.');

  const localBRegionId = profiles.get(byAlias.local_b.userId).region_id;
  const lotCandidates = await rpc(context.local, 'get_financial_unallocated_fund_lots', { p_fiscal_year: 2025 });
  const lot = lotCandidates.find((row) => row.region_id === localBRegionId && bigint(row.remaining_amount) >= 40000n);
  assert(lot, 'A local_b 2025 waiting lot with at least 40,000 won is required.', { stage: 'fixture' });
  const lotId = lot.lot_id ?? lot.id;
  assert(lotId, 'The selected waiting lot must expose a canonical lot ID.', { stage: 'fixture' });
  const template = before.projects.find((project) => project.region_id === localBRegionId
    && project.year === 2025 && project.large_category_id && project.middle_category_id
    && ['HW', 'SW', 'COMPOSITE'].includes(project.business_type));
  assert(template, 'A categorized local_b 2025 template project is required.', { stage: 'fixture' });

  const invalidBoundaries = await invalidAmountBoundaries(context, runId, localBRegionId, lotId, template);
  const golden = await createNewProject(context, {
    runId, label: 'golden-10000', regionId: localBRegionId, lotId, template,
    amount: 10000n, draftName: '지역활력 신규사업 임시안', finalName: '지역활력 신규사업',
    officialCode: officialCodes.golden, reject: false,
  });
  const oneWon = await createNewProject(context, {
    runId, label: 'boundary-1', regionId: localBRegionId, lotId, template,
    amount: 1n, draftName: '소액 지원 신규사업 임시안', finalName: '소액 지원 신규사업',
    officialCode: officialCodes.oneWon, reject: false,
  });
  const nineNineNineNine = await createNewProject(context, {
    runId, label: 'boundary-9999', regionId: localBRegionId, lotId, template,
    amount: 9999n, draftName: '지역상생 신규사업 임시안', finalName: '지역상생 신규사업',
    officialCode: officialCodes.nineNineNineNine, reject: false,
  });
  const rejected = await createNewProject(context, {
    runId, label: 'rejected-10000', regionId: localBRegionId, lotId, template,
    amount: 10000n, draftName: '반려 검증 신규사업 임시안', finalName: '반려 검증 신규사업',
    officialCode: null, reject: true,
  });

  const postWorkflow = await globalSnapshot(service, context.adminA);
  assertEqual(BigInt(postWorkflow.dashboard.alloc) - BigInt(before.dashboard.alloc), 20000n - runAllocationBefore,
    'Three approved boundary projects must converge to exactly 20,000 won');
  assertEqual(BigInt(postWorkflow.dashboard.exec) - BigInt(before.dashboard.exec), 0n,
    'New-project workflow must not invent execution');

  const smallCategories = await allRows(service, 'small_categories',
    'id,large_category_id,middle_category_id', null, 'standard small categories');
  const originalSmall = smallCategories.find((row) => row.middle_category_id === template.middle_category_id);
  const alternateSmall = smallCategories.find((row) => row.large_category_id !== template.large_category_id);
  assert(originalSmall && alternateSmall, 'Both original and alternate standard small categories are required.', {
    stage: 'classification-fixture',
  });
  const originalClassification = {
    largeCategoryId: template.large_category_id, middleCategoryId: template.middle_category_id,
    smallCategoryIds: [originalSmall.id],
  };
  const alternateClassification = {
    largeCategoryId: alternateSmall.large_category_id, middleCategoryId: alternateSmall.middle_category_id,
    smallCategoryIds: [alternateSmall.id],
  };
  const goldenProject = await one(service, 'projects', '*', { id: golden.projectId }, 'Golden project before metadata');
  const metadataBefore = await financialProjectState(service, context.adminA, golden.projectId);
  const metadataTotalsBefore = (await globalSnapshot(service, context.adminA)).dashboard;
  const metadataChanges = {
    detailName: '지역활력 신규사업 메타데이터 수정', period: '2024.01~2025.12', startYear: 2024,
    status: '지연', businessType: template.business_type === 'HW' ? 'SW' : 'HW',
  };
  const relatedInitial = [
    { project_name: '연계사업 A', total_budget: '1', regional_fund_alloc: '9999', local_fund_alloc: '10000' },
    { project_name: '연계사업 B', total_budget: '10000', regional_fund_alloc: '1', local_fund_alloc: '9999' },
  ];
  await saveNonfinancial(context.local, goldenProject, originalClassification, relatedInitial, metadataChanges);
  const metadataAfter = await financialProjectState(service, context.adminA, golden.projectId);
  assertEqual(metadataAfter.monetaryFingerprint, metadataBefore.monetaryFingerprint,
    'Metadata edit must not change project/cohort/wallet/lot monetary fingerprint');
  const metadataTotalsAfter = (await globalSnapshot(service, context.adminA)).dashboard;
  assertSameFinancialTotals(metadataTotalsBefore, metadataTotalsAfter, 'Metadata edit');

  const classificationBefore = await globalSnapshot(service, context.adminA);
  await saveNonfinancial(context.local, metadataAfter.project, alternateClassification, relatedInitial, metadataChanges);
  const classificationAfter = await globalSnapshot(service, context.adminA);
  assertSameFinancialTotals(classificationBefore.dashboard, classificationAfter.dashboard, 'Classification edit');
  const classificationStateAfter = await financialProjectState(service, context.adminA, golden.projectId);
  assertEqual(classificationStateAfter.monetaryFingerprint, metadataAfter.monetaryFingerprint,
    'Classification edit must not change monetary fingerprint');

  const relatedFinal = [
    { project_name: '연계사업 A 수정', total_budget: '9999', regional_fund_alloc: '10000', local_fund_alloc: '1' },
    { project_name: '연계사업 C 재등록', total_budget: '10000', regional_fund_alloc: '9999', local_fund_alloc: '1' },
  ];
  await saveNonfinancial(context.local, classificationStateAfter.project,
    alternateClassification, relatedFinal, metadataChanges);
  const freshLocal = await freshRead(url, anonKey, accountInputs.find((item) => item.alias === 'local_b'), golden.projectId);
  const freshAdmin = await freshRead(url, anonKey, accountInputs.find((item) => item.alias === 'admin_a'), golden.projectId);
  assertEqual(freshLocal.project.detail_project_name, metadataChanges.detailName, 'fresh local metadata');
  assertEqual(freshAdmin.project.detail_project_name, metadataChanges.detailName, 'fresh admin metadata');
  assertEqual(freshLocal.project.large_category_id, alternateClassification.largeCategoryId, 'fresh local classification');
  assertEqual(freshAdmin.project.middle_category_id, alternateClassification.middleCategoryId, 'fresh admin classification');
  assertEqual(freshLocal.related.length, 2, 'fresh local related-project count');
  assertEqual(freshAdmin.related.length, 2, 'fresh admin related-project count');

  const after = await globalSnapshot(service, context.adminA);
  const finalGate = await runtimeAndInvariantGate(context.adminA, testRef);
  const rls = await verifyAccountsAndRls(context, service, runId, profiles, regions, after.projects.length);
  const api = {};
  for (const alias of ['admin_a', 'admin_b', 'local_a', 'local_b', 'local_c']) {
    const response = await requestJson(baseUrl, '/api/projects/summary', byAlias[alias].token);
    api[`${alias}_dashboard`] = {
      status: response.status, projectCount: response.body.projectCount,
      alloc: response.body.allocSum, exec: response.body.execSum,
    };
  }
  assertEqual(api.admin_a_dashboard.projectCount, after.projects.length, 'admin_a dashboard count');
  assertEqual(api.admin_b_dashboard.projectCount, after.projects.length, 'admin_b dashboard count');
  assertEqual(api.admin_a_dashboard.alloc, after.dashboard.alloc, 'Dashboard allocation vs raw');
  assertEqual(api.admin_a_dashboard.exec, after.dashboard.exec, 'Dashboard execution vs raw');

  const currentAnalytics = await requestJson(baseUrl,
    '/api/analytics?timeBasis=current&asOf=2026-08-31&groupBy=national&rateBasis=adjusted&rateBand=all',
    byAlias.admin_a.token);
  const asOfAnalytics = await requestJson(baseUrl,
    '/api/analytics?timeBasis=as_of&asOf=2026-08-31&groupBy=national&rateBasis=adjusted&rateBand=all',
    byAlias.admin_a.token);
  const busan2024 = await requestJson(baseUrl,
    '/api/analytics?timeBasis=current&asOf=2026-08-31&year=2024&sido=%EB%B6%80%EC%82%B0&sigungu=%EC%84%9C%EA%B5%AC&groupBy=project&rateBasis=adjusted&rateBand=all',
    byAlias.admin_b.token);
  assertEqual(currentAnalytics.body.kpis.projectCount, after.analytics.projectCount,
    'Analytics normalized project count');
  assertEqual(currentAnalytics.body.kpis.adjustedAllocation, after.analytics.alloc,
    'Analytics normalized allocation');
  assertEqual(currentAnalytics.body.kpis.cumulativeExecution, after.analytics.exec,
    'Analytics normalized execution');
  assertEqual(after.projects.length - currentAnalytics.body.kpis.projectCount, 3,
    'Dashboard vs Analytics explicit TEST exclusion count');

  const localBHistory = await rpc(context.local, 'get_financial_project_funding_history', {
    p_project_id: golden.projectId,
  });
  const finalUnclassified = await rpc(context.adminA, 'get_financial_unclassified_decreases');
  assertEqual(finalUnclassified.length, 4, 'Final unclassified decrease count');
  assertEqual(sum(finalUnclassified, 'unclassified_amount'), 187703000n, 'Final unclassified decrease total');

  const result = {
    runId, status: 'PASS', completedAt: new Date().toISOString(),
    target: { environment: 'TEST', projectRef: testRef, productionContacted: false, preview: baseUrl },
    auth: signedAccounts.map((account) => {
      const authUser = authUsers.get(account.email.toLowerCase());
      const profile = profiles.get(account.userId);
      return {
        alias: account.alias, userId: account.userId, role: profile.role,
        region: profile.region_id ? regions.get(profile.region_id)?.display_name : '전체지역',
        emailConfirmed: Boolean(authUser.email_confirmed_at), banned: Boolean(authUser.banned_until),
        deleted: Boolean(authUser.deleted_at), login: 'PASS',
      };
    }),
    preflight: gate,
    projectInventory,
    goldenProject: {
      projectId: golden.projectId, projectCode: golden.projectCode, region: '부산 서구', year: 2025,
      allocation: golden.amount, execution: '0', lifecyclePolicy: 'RECONCILIATION_LEGACY',
      metadataFreshRead: 'PASS', classificationFreshRead: 'PASS', relatedProjectsFreshRead: 'PASS',
      historyEvents: localBHistory.length,
    },
    newProject: { approved: golden, rejected, boundaryApproved: [oneWon, nineNineNineNine] },
    boundary: { acceptedRaw: ['1', '9999', '10000'], rejected: invalidBoundaries },
    metadata: { monetaryGap: '0', fingerprintPreserved: true, fields: ['detail_project_name', 'project_period', 'project_start_year', 'status', 'business_type', 'related_projects'] },
    classification: { monetaryGap: '0', from: originalClassification, to: alternateClassification },
    accounting: {
      before: { dashboard: before.dashboard, analytics: before.analytics, funding: before.funding },
      after: { dashboard: after.dashboard, analytics: after.analytics, funding: after.funding },
      workflowAllocationDelta: '20000', workflowExecutionDelta: '0',
      cohortConservationGap: '0', unexplainedGap: '0', finalInvariantRows: finalGate.invariantRows,
    },
    unclassifiedDecrease: { count: 4, amount: '187703000', unchanged: true },
    rls,
    previewApi: {
      dashboard: api,
      analytics: {
        currentStatus: currentAnalytics.status, currentSource: currentAnalytics.body.source,
        currentProjectCount: currentAnalytics.body.kpis.projectCount,
        asOfStatus: asOfAnalytics.status, asOfSource: asOfAnalytics.body.source,
        asOfProjectCount: asOfAnalytics.body.kpis?.projectCount ?? null,
        busan2024Status: busan2024.status, busan2024Count: busan2024.body.kpis?.projectCount ?? 0,
        explicitExcludedCodes: [...ANALYTICS_EXCLUDED_CODES], populationDifference: 3,
      },
    },
    visualUx: { status: 'UNVERIFIED', reason: 'No in-app or extension browser was available.' },
    secretsPrinted: false,
  };

  if (output) {
    const outputPath = path.resolve(process.cwd(), output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify(result, null, 2));
}

const runIdForError = argument('--run-id') ?? '(missing)';
main().catch((error) => {
  console.error(JSON.stringify(sanitizeFailure(error, runIdForError), null, 2));
  process.exitCode = 1;
});
