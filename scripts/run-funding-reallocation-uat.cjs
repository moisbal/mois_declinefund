#!/usr/bin/env node

/**
 * Destructive TEST-only funding reallocation UAT.
 *
 * This script deliberately has no default environment files and will not run
 * without --confirm-test-write.  It never connects to Production and never
 * prints credentials, tokens, passwords, or database connection strings.
 *
 * Usage:
 *   node scripts/run-funding-reallocation-uat.cjs \
 *     --env-file .env.ledger-test.local \
 *     --credentials-file .env.ledger-uat-credentials.local \
 *     --confirm-test-write
 *
 * Add --reset-uat-passwords only when a credential repair is explicitly
 * required. Without it, existing TEST auth IDs are resolved read-only and the
 * configured credentials must already authenticate successfully. Add
 * --preflight-only to stop after authenticated runtime/Scenario-11 reads.
 * Use --reset-uat-account <alias> to repair only one failing TEST account.
 *
 * The service-role client is limited to TEST user password reset, fixture
 * selection/read, and the single explicitly documented Scenario-1 fixture
 * update.  Every financial workflow is executed by authenticated local/admin
 * clients through the public maker/checker RPCs.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

const UAT_NAMESPACE = 'declinefund:funding-reallocation-uat:v1';
const TEST_YEAR = 2025;
const LEGACY_EFFECTIVE_DATE = '2025-08-01';
const LEGACY_EVIDENCE_AS_OF = '2026-08-31';
const NEW_PROJECT_CODE = '2025-26-140-9001';
const TEN_MILLION = 10_000_000n;
const TWO_MILLION = 2_000_000n;
const ONE_MILLION = 1_000_000n;

const PROJECT_CODES = Object.freeze({
  scenario1Source: '2025-26-140-0007',
  scenario2Source: '2025-26-140-0008',
  scenario3Source: '2025-26-140-0010',
  scenario4Source: '2025-26-140-0012',
  scenario5Source: '2025-26-140-0014',
  destination1: '2025-26-140-0002',
  destination2: '2025-26-140-0003',
  destination3: '2025-26-140-0004',
  carry2022: '2022-26-140-0007',
  carry2023: '2023-26-140-0007',
  carry2024: '2024-26-140-0003',
});

class UatFailure extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'UatFailure';
    this.code = details.code ?? 'UAT_ASSERTION_FAILED';
    this.stage = details.stage;
  }
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function fail(message, details) {
  throw new UatFailure(message, details);
}

function assert(condition, message, details) {
  if (!condition) fail(message, details);
}

function assertEqual(actual, expected, message) {
  if (String(actual) !== String(expected)) {
    fail(`${message} (expected=${String(expected)}, actual=${String(actual)})`);
  }
}

function asBigInt(value, label = 'amount') {
  try {
    return BigInt(value ?? 0);
  } catch {
    fail(`${label} is not a valid bigint.`);
  }
}

function amount(value) {
  return asBigInt(value).toString();
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + asBigInt(row[field], field), 0n);
}

function firstRow(data, label) {
  const row = Array.isArray(data) ? data[0] : data;
  assert(row, `${label} did not return a row.`);
  return row;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableUuid(label) {
  const bytes = Buffer.from(sha256(`${UAT_NAMESPACE}:${label}`).slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [
    bytes.subarray(0, 4).toString('hex'),
    bytes.subarray(4, 6).toString('hex'),
    bytes.subarray(6, 8).toString('hex'),
    bytes.subarray(8, 10).toString('hex'),
    bytes.subarray(10, 16).toString('hex'),
  ].join('-');
}

function projectRefFromUrl(value) {
  try {
    const url = new URL(value);
    return /^([a-z0-9-]+)\.supabase\.co$/i.exec(url.hostname)?.[1] ?? null;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function mask(value) {
  if (!value || value.length < 8) return '***';
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function loadEnvFile(fileArgument, label) {
  assert(fileArgument, `${label} is required.`);
  const resolved = path.resolve(process.cwd(), fileArgument);
  assert(fs.existsSync(resolved), `${label} does not exist.`);
  return { resolved, values: dotenv.parse(fs.readFileSync(resolved)) };
}

function requireEnv(env, name) {
  const value = String(env[name] ?? '').trim();
  assert(value, `${name} is required.`);
  return value;
}

function createSupabase(url, key) {
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { headers: { 'x-client-info': 'declinefund-funding-uat/1' } },
  });
}

async function rpc(client, functionName, args, label = functionName) {
  const { data, error } = await client.rpc(functionName, args ?? {});
  if (error) {
    throw new UatFailure(`${label} failed: ${error.message}`, {
      code: error.code ?? 'RPC_ERROR',
      stage: label,
    });
  }
  return data;
}

async function expectRpcError(client, functionName, args, label) {
  const { error } = await client.rpc(functionName, args ?? {});
  assert(error, `${label} unexpectedly succeeded.`);
  return { blocked: true, code: error.code ?? 'RPC_ERROR' };
}

async function applyFundingWithSerializationRetry(client, requestId, label) {
  let serializationRetries = 0;
  for (;;) {
    try {
      const data = await rpc(client, 'financial_apply_funding_reallocation_request', {
        p_request_id: requestId,
      }, label);
      return { data, serializationRetries };
    } catch (error) {
      if (error.code !== '40001' || serializationRetries >= 3) {
        error.serializationRetries = serializationRetries;
        throw error;
      }
      serializationRetries += 1;
      await new Promise((resolve) => setTimeout(resolve, 50 * (2 ** serializationRetries)));
    }
  }
}

async function selectOne(client, table, columns, filters, label) {
  let query = client.from(table).select(columns);
  for (const [column, value] of Object.entries(filters ?? {})) query = query.eq(column, value);
  const { data, error } = await query.maybeSingle();
  if (error) fail(`${label} failed: ${error.message}`, { code: error.code, stage: label });
  assert(data, `${label} returned no row.`);
  return data;
}

async function selectRows(client, table, columns, configure, label) {
  let query = client.from(table).select(columns);
  if (configure) query = configure(query);
  const { data, error } = await query;
  if (error) fail(`${label} failed: ${error.message}`, { code: error.code, stage: label });
  return data ?? [];
}

async function signIn(url, anonKey, email, password, alias) {
  const client = createSupabase(url, anonKey);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user || !data.session) {
    fail(`${alias} authentication failed.`, { code: error?.code ?? 'AUTH_FAILED', stage: 'auth' });
  }
  return { client, userId: data.user.id };
}

async function findAuthUsers(service, emails) {
  const wanted = new Set(emails.map((email) => email.toLowerCase()));
  const found = new Map();
  for (let page = 1; page <= 20 && found.size < wanted.size; page += 1) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) fail('TEST auth user lookup failed.', { code: error.code, stage: 'password-reset' });
    for (const user of data.users ?? []) {
      const email = String(user.email ?? '').toLowerCase();
      if (wanted.has(email)) found.set(email, user);
    }
    if ((data.users ?? []).length < 1000) break;
  }
  assertEqual(found.size, wanted.size, 'Every configured UAT auth user must already exist in TEST');
  return found;
}

async function resetPasswordsPreservingIds(service, accounts) {
  const users = await findAuthUsers(service, accounts.map((account) => account.email));
  for (const account of accounts) {
    const before = users.get(account.email.toLowerCase());
    const { data, error } = await service.auth.admin.updateUserById(before.id, {
      password: account.password,
    });
    if (error || !data.user) {
      fail(`${account.alias} TEST password reset failed.`, {
        code: error?.code ?? 'PASSWORD_RESET_FAILED',
        stage: 'password-reset',
      });
    }
    assertEqual(data.user.id, before.id, `${account.alias} auth ID must be preserved`);
    account.userId = before.id;
  }
}

async function loadProfiles(service, accounts) {
  const ids = accounts.map((account) => account.userId);
  const { data, error } = await service
    .from('profiles')
    .select('id,role,region_id')
    .in('id', ids);
  if (error) fail('UAT profile lookup failed.', { code: error.code, stage: 'profile-check' });
  const byId = new Map((data ?? []).map((row) => [row.id, row]));
  for (const account of accounts) {
    const profile = byId.get(account.userId);
    assert(profile, `${account.alias} profile is missing.`);
    account.profile = profile;
  }
}

async function assertRuntime(adminClient, testRef) {
  const runtime = await selectOne(
    adminClient,
    'financial_ledger_runtime',
    'environment_kind,mode,bound_project_ref,baseline_as_of,native_start_date',
    { singleton: true },
    'Ledger runtime read',
  );
  assertEqual(runtime.environment_kind, 'TEST', 'Ledger environment must be TEST');
  assertEqual(runtime.mode, 'RECONCILIATION', 'Ledger mode must be RECONCILIATION');
  assertEqual(runtime.bound_project_ref, testRef, 'Ledger runtime must be bound to TEST ref');
  assertEqual(runtime.baseline_as_of, '2026-08-31', 'Ledger baseline date');
  assertEqual(runtime.native_start_date, '2026-09-01', 'Ledger native start date');
  return {
    environment_kind: runtime.environment_kind,
    mode: runtime.mode,
    baseline_as_of: runtime.baseline_as_of,
    native_start_date: runtime.native_start_date,
  };
}

function physicalAllocation(project) {
  const alloc = asBigInt(project.alloc, `${project.project_code}.alloc`);
  const increase = asBigInt(project.increase_amount, `${project.project_code}.increase_amount`);
  const decrease = asBigInt(project.decrease_amount, `${project.project_code}.decrease_amount`);
  // Most imported Legacy rows intentionally preserve original_alloc=NULL.
  // `alloc` is their verified physical adjusted allocation; never coerce the
  // unknown original to zero and invent a false formula. Scenario-1 is the
  // only fixture with an explicit original allocation.
  if (project.original_alloc !== null && project.original_alloc !== undefined) {
    const original = asBigInt(project.original_alloc, `${project.project_code}.original_alloc`);
    assertEqual(alloc, original + increase - decrease, `${project.project_code} physical allocation formula`);
  }
  assert(alloc > 0n, `${project.project_code} allocation must be positive.`);
  assert(asBigInt(project.exec, `${project.project_code}.exec`) <= alloc,
    `${project.project_code} execution must not exceed allocation.`);
  return alloc;
}

async function readProjects(service, codes) {
  const { data, error } = await service
    .from('projects')
    .select('id,project_id,project_code,region_id,year,project_name,fund_project_name,detail_project_name,project_period,project_start_year,project_end_year,status,business_type,large_category_id,middle_category_id,original_alloc,increase_amount,decrease_amount,alloc,exec,rate,total_budget')
    .in('project_code', codes);
  if (error) fail('TEST project fixture read failed.', { code: error.code, stage: 'fixture-read' });
  assertEqual((data ?? []).length, codes.length, 'Every fixed UAT project code must exist exactly once');
  return new Map(data.map((row) => [row.project_code, row]));
}

async function ensureScenarioOneFixture(service, project, resume) {
  const expected = {
    original_alloc: '100000000',
    increase_amount: '0',
    decrease_amount: '0',
    alloc: '100000000',
    exec: '90000000',
    rate: 90,
  };
  const walletRows = await selectRows(
    service,
    'project_budget_years',
    'id',
    (query) => query.eq('project_id', project.id).limit(1),
    'Scenario-1 existing wallet check',
  );
  const alreadyExact = Object.entries(expected).every(([key, value]) => String(project[key]) === String(value));
  if (!alreadyExact) {
    assert(!resume, 'Scenario-1 fixture differs during a resumed UAT run; refusing to rewrite Ledger-managed data.');
    assertEqual(walletRows.length, 0, 'Scenario-1 fixture may only be set before any wallet exists');
    const { data, error } = await service
      .from('projects')
      .update(expected)
      .eq('id', project.id)
      .select('id,project_id,project_code,region_id,year,project_name,fund_project_name,detail_project_name,project_period,project_start_year,project_end_year,status,business_type,large_category_id,middle_category_id,original_alloc,increase_amount,decrease_amount,alloc,exec,rate,total_budget')
      .single();
    if (error) fail('Scenario-1 TEST fixture update failed.', { code: error.code, stage: 'fixture-update' });
    return data;
  }
  return project;
}

async function readState(client, table, id, columns = '*') {
  return selectOne(client, table, columns, { id }, `${table} state read`);
}

async function ensureEvidence(context, input) {
  const key = stableUuid(`evidence:${input.label}`);
  const evidenceId = await rpc(context.local, 'financial_register_ledger_evidence', {
    p_region_id: input.regionId,
    p_evidence_scope: input.scope,
    p_source_type: 'LEGACY_EXCEL',
    p_source_system: 'Codex TEST UAT',
    p_source_file_name: `funding-uat-${input.label}.xlsx`,
    p_source_file_sha256: sha256(`funding-uat-evidence:${input.label}`),
    p_source_sheet_name: 'UAT',
    p_source_row_reference: input.rowReference,
    p_external_reference: `TEST-UAT-${input.label}`,
    p_evidence_note: input.note,
    p_source_as_of_date: input.asOfDate,
    p_import_batch_id: stableUuid(`evidence-import-batch:${input.label}`),
    p_idempotency_key: key,
    p_submit: true,
  }, `register evidence ${input.label}`);
  let row = await readState(context.adminA, 'ledger_evidence', evidenceId);
  if (row.verification_status === 'DRAFT') {
    await rpc(context.local, 'financial_submit_ledger_evidence', { p_evidence_id: evidenceId });
    row = await readState(context.adminA, 'ledger_evidence', evidenceId);
  }
  if (row.verification_status === 'SUBMITTED') {
    await rpc(context.adminA, 'financial_verify_ledger_evidence', { p_evidence_id: evidenceId });
    row = await readState(context.adminA, 'ledger_evidence', evidenceId);
  }
  assertEqual(row.verification_status, 'VERIFIED', `${input.label} evidence state`);
  assertEqual(row.region_id, input.regionId, `${input.label} evidence region`);
  return evidenceId;
}

async function ensureLegacyEntry(context, input) {
  const entryId = await rpc(context.local, 'financial_create_legacy_reconstruction_entry', {
    p_event_type: input.eventType,
    p_project_id: input.projectId,
    p_destination_project_id: input.destinationProjectId ?? null,
    p_funding_entry_id: input.fundingEntryId ?? null,
    p_lineage_id: input.lineageId ?? null,
    p_evidence_id: input.evidenceId,
    p_origin_fiscal_year: input.originFiscalYear ?? null,
    p_fiscal_year: input.fiscalYear,
    p_destination_fiscal_year: input.destinationFiscalYear ?? null,
    p_legacy_prior_carryover_count: input.legacyPriorCarryoverCount ?? null,
    p_amount: amount(input.amount),
    p_effective_date: input.effectiveDate,
    p_carryover_sequence: input.carryoverSequence ?? null,
    p_carryover_type: input.carryoverType ?? null,
    p_adjustment_type: input.adjustmentType ?? null,
    p_reason_code: input.reasonCode ?? 'TEST_UAT',
    p_memo: input.memo,
    p_idempotency_key: stableUuid(`legacy:${input.label}`),
  }, `create Legacy entry ${input.label}`);
  let row = await readState(context.adminA, 'legacy_ledger_reconstruction_entries', entryId);
  if (row.status === 'DRAFT') {
    await rpc(context.local, 'financial_submit_legacy_reconstruction', { p_entry_id: entryId });
    row = await readState(context.adminA, 'legacy_ledger_reconstruction_entries', entryId);
  }
  if (row.status === 'SUBMITTED') {
    await rpc(context.adminA, 'financial_verify_legacy_reconstruction', { p_entry_id: entryId });
    row = await readState(context.adminA, 'legacy_ledger_reconstruction_entries', entryId);
  }
  if (row.status === 'VERIFIED') {
    await rpc(context.adminA, 'financial_apply_legacy_reconstruction', { p_entry_id: entryId });
    row = await readState(context.adminA, 'legacy_ledger_reconstruction_entries', entryId);
  }
  assertEqual(row.status, 'APPLIED', `${input.label} Legacy entry state`);
  return row;
}

async function ensureProjectBaseline(context, project, evidenceId) {
  assertEqual(project.decrease_amount ?? 0, 0, `${project.project_code} must be a clean UAT baseline source/destination`);
  assertEqual(project.increase_amount ?? 0, 0, `${project.project_code} must not carry an unreconstructed physical increase`);
  const allocation = physicalAllocation(project);
  const allocationEntry = await ensureLegacyEntry(context, {
    label: `baseline:${project.project_code}:allocation`,
    eventType: 'ALLOCATION',
    projectId: project.id,
    evidenceId,
    originFiscalYear: project.year,
    fiscalYear: project.year,
    legacyPriorCarryoverCount: 0,
    amount: allocation,
    effectiveDate: `${project.year}-01-01`,
    memo: `TEST UAT physical allocation baseline for ${project.project_code}`,
  });
  const execution = asBigInt(project.exec, `${project.project_code}.exec`);
  const stagedPosition = await projectPosition(
    context.local,
    project.id,
    `${project.project_code} position after staged ALLOCATION`,
  );
  if (!context.resume) {
    assertEqual(stagedPosition.ledger_adjusted_allocation, allocation,
      `${project.project_code} staged allocation must materialize without failure`);
    assertEqual(stagedPosition.ledger_execution_amount, 0,
      `${project.project_code} staged execution before reconstruction`);
    assertEqual(stagedPosition.projection_ready, execution === 0n,
      `${project.project_code} staged projection readiness must remain fail-closed until exact execution`);
  }
  if (execution > 0n) {
    await ensureLegacyEntry(context, {
      label: `baseline:${project.project_code}:execution`,
      eventType: 'EXECUTION',
      projectId: project.id,
      fundingEntryId: allocationEntry.id,
      evidenceId,
      fiscalYear: project.year,
      amount: execution,
      effectiveDate: `${project.year}-06-30`,
      memo: `TEST UAT physical execution baseline for ${project.project_code}`,
    });
  }
  const wallet = await selectOne(
    context.adminA,
    'project_budget_years',
    'id,project_id,budget_cohort_id,fiscal_year',
    { project_id: project.id, budget_cohort_id: allocationEntry.applied_cohort_id, fiscal_year: project.year },
    `${project.project_code} baseline wallet`,
  );
  const position = await projectPosition(
    context.local,
    project.id,
    `${project.project_code} position immediately after allocation/execution reconstruction`,
  );
  if (!context.resume) {
    assertEqual(position.ledger_adjusted_allocation, allocation,
      `${project.project_code} reconstructed adjusted allocation`);
  }
  assertEqual(position.ledger_execution_amount, execution,
    `${project.project_code} reconstructed execution`);
  assertEqual(position.projection_ready, true,
    `${project.project_code} projection must be ready after exact execution reconstruction`);
  return {
    allocationEntryId: allocationEntry.id,
    cohortId: allocationEntry.applied_cohort_id,
    walletId: wallet.id,
    allocation: allocation.toString(),
    execution: execution.toString(),
  };
}

async function assertFundingRequestVisibleToBothAdmins(context, requestId, status) {
  const [rowsA, rowsB] = await Promise.all([
    rpc(context.adminA, 'get_financial_funding_reallocation_requests', { p_status: status }),
    rpc(context.adminB, 'get_financial_funding_reallocation_requests', { p_status: status }),
  ]);
  assert(rowsA.some((row) => row.id === requestId), `admin_a must see ${status} funding request.`);
  assert(rowsB.some((row) => row.id === requestId), `admin_b must see ${status} funding request.`);
}

async function ensureApprovedFundingRequest(context, input) {
  const key = stableUuid(`funding-request:${input.label}`);
  const createArgs = {
    p_request_type: input.requestType,
    p_payload: input.payload,
    p_idempotency_key: key,
    p_submit: false,
  };
  const created = firstRow(await rpc(context.local, 'financial_create_funding_reallocation_request',
    createArgs, `create approved-only funding request ${input.label}`), input.label);
  const createReplay = firstRow(await rpc(context.local,
    'financial_create_funding_reallocation_request', createArgs,
    `replay approved-only funding create ${input.label}`), `${input.label} create replay`);
  assertEqual(createReplay.request_id, created.request_id, `${input.label} create replay request id`);
  let row = await readState(context.adminA, 'financial_funding_reallocation_requests', created.request_id);
  if (row.status === 'DRAFT') {
    await rpc(context.local, 'financial_submit_funding_reallocation_request', {
      p_request_id: row.id,
    }, `submit approved-only funding request ${input.label}`);
    row = await readState(context.adminA, 'financial_funding_reallocation_requests', row.id);
  }
  if (row.status === 'SUBMITTED') {
    await assertFundingRequestVisibleToBothAdmins(context, row.id, 'SUBMITTED');
    await rpc(context.adminA, 'financial_approve_funding_reallocation_request', {
      p_request_id: row.id,
    }, `approve approved-only funding request ${input.label}`);
    row = await readState(context.adminA, 'financial_funding_reallocation_requests', row.id);
  }
  assert(['APPROVED', 'APPLIED'].includes(row.status),
    `${input.label} must be APPROVED or already APPLIED before the concurrency gate.`);
  return { row, key, createArgs };
}

async function ensureFundingRequest(context, input) {
  const key = stableUuid(`funding-request:${input.label}`);
  const createArgs = {
    p_request_type: input.requestType,
    p_payload: input.payload,
    p_idempotency_key: key,
    p_submit: false,
  };
  const created = firstRow(await rpc(context.local, 'financial_create_funding_reallocation_request',
    createArgs, `create funding request ${input.label}`), input.label);
  const createReplay = firstRow(await rpc(context.local, 'financial_create_funding_reallocation_request',
    createArgs, `replay funding request create ${input.label}`), `${input.label} create replay`);
  assertEqual(createReplay.request_id, created.request_id, `${input.label} create replay request id`);
  assertEqual(createReplay.status, created.status, `${input.label} create replay status`);
  if (input.assertFingerprintConflict) {
    await expectRpcError(context.local, 'financial_create_funding_reallocation_request', {
      ...createArgs,
      p_payload: { ...input.payload, uat_conflict_marker: 'MUST_REJECT_DIFFERENT_FINGERPRINT' },
    }, `${input.label} idempotency fingerprint mismatch`);
  }
  let row = await readState(context.adminA, 'financial_funding_reallocation_requests', created.request_id);
  if (row.status === 'DRAFT') {
    await rpc(context.local, 'financial_submit_funding_reallocation_request', {
      p_request_id: row.id,
    }, `submit funding request ${input.label}`);
    row = await readState(context.adminA, 'financial_funding_reallocation_requests', row.id);
  }
  if (row.status === 'SUBMITTED') {
    await assertFundingRequestVisibleToBothAdmins(context, row.id, 'SUBMITTED');
    await rpc(context.adminA, 'financial_approve_funding_reallocation_request', {
      p_request_id: row.id,
    }, `approve funding request ${input.label}`);
    row = await readState(context.adminA, 'financial_funding_reallocation_requests', row.id);
  }
  if (row.status === 'APPROVED') {
    await rpc(context.adminA, 'financial_apply_funding_reallocation_request', {
      p_request_id: row.id,
    }, `apply funding request ${input.label}`);
    row = await readState(context.adminA, 'financial_funding_reallocation_requests', row.id);
  }
  assertEqual(row.status, 'APPLIED', `${input.label} funding request state`);
  assert(row.materialized_record_id, `${input.label} must have a materialized record.`);
  const applyReplay = firstRow(await rpc(context.adminA,
    'financial_apply_funding_reallocation_request', { p_request_id: row.id },
    `replay funding APPLY ${input.label}`), `${input.label} apply replay`);
  assertEqual(applyReplay.request_id, row.id, `${input.label} APPLY replay request id`);
  assertEqual(applyReplay.status, 'APPLIED', `${input.label} APPLY replay status`);
  assertEqual(applyReplay.materialized_table, row.materialized_table,
    `${input.label} APPLY replay materialized table`);
  assertEqual(applyReplay.materialized_record_id, row.materialized_record_id,
    `${input.label} APPLY replay materialized id`);
  const postApplyCreateReplay = firstRow(await rpc(context.local,
    'financial_create_funding_reallocation_request', createArgs,
    `replay funding create after APPLY ${input.label}`), `${input.label} post-APPLY create replay`);
  assertEqual(postApplyCreateReplay.request_id, row.id, `${input.label} post-APPLY create request id`);
  assertEqual(postApplyCreateReplay.status, 'APPLIED', `${input.label} post-APPLY create status`);
  return row;
}

function legacyPayload(fields) {
  return {
    ...fields,
    amount: amount(fields.amount),
    effective_date: fields.effective_date ?? LEGACY_EFFECTIVE_DATE,
    record_origin: 'LEGACY_EXCEL',
  };
}

async function createLot(context, input) {
  const request = await ensureFundingRequest(context, {
    label: input.label,
    requestType: 'CREATE_UNALLOCATED_LOT',
    payload: legacyPayload({
      source_budget_year_id: input.sourceWalletId,
      amount: input.amount,
      decrease_amount_before: amount(input.before),
      decrease_amount_after: amount(input.after),
      reason: input.reason,
      evidence_id: input.evidenceId,
    }),
    assertFingerprintConflict: input.assertFingerprintConflict,
  });
  assertEqual(request.materialized_table, 'financial_unallocated_fund_lots', `${input.label} canonical table`);
  return readState(context.adminA, 'financial_unallocated_fund_lots', request.materialized_record_id);
}

async function allocateLot(context, input) {
  const request = await ensureFundingRequest(context, {
    label: input.label,
    requestType: 'ALLOCATE_UNALLOCATED_EXISTING',
    payload: legacyPayload({
      lot_id: input.lotId,
      destination_project_id: input.destinationProjectId,
      amount: input.amount,
      evidence_id: input.evidenceId,
      memo: input.memo,
    }),
  });
  assertEqual(request.materialized_table, 'financial_unallocated_fund_movements', `${input.label} canonical table`);
  return readState(context.adminA, 'financial_unallocated_fund_movements', request.materialized_record_id);
}

async function returnLot(context, input) {
  const request = await ensureFundingRequest(context, {
    label: input.label,
    requestType: 'RETURN_UNALLOCATED',
    payload: legacyPayload({
      lot_id: input.lotId,
      amount: input.amount,
      evidence_id: input.evidenceId,
      memo: input.memo,
    }),
  });
  assertEqual(request.materialized_table, 'financial_unallocated_fund_movements', `${input.label} canonical table`);
  return readState(context.adminA, 'financial_unallocated_fund_movements', request.materialized_record_id);
}

async function reverseClassification(context, input) {
  const request = await ensureFundingRequest(context, {
    label: input.label,
    requestType: 'REVERSE_DECREASE_CLASSIFICATION',
    payload: legacyPayload({
      classification_id: input.classificationId,
      amount: input.amount,
      decrease_amount_before: amount(input.before),
      decrease_amount_after: amount(input.after),
      evidence_id: input.evidenceId,
      memo: input.memo,
    }),
  });
  const reversals = await selectRows(
    context.adminA,
    'financial_project_decrease_classification_reversals',
    '*',
    (query) => query.eq('classification_id', input.classificationId).eq('idempotency_key', stableUuid(`funding-request:${input.label}`)),
    `${input.label} linked reversal read`,
  );
  assertEqual(reversals.length, 1, `${input.label} must have exactly one immutable reversal link`);
  return { request, reversal: reversals[0] };
}

async function directDecreaseTransferProbe(context, input) {
  const transferRequest = await ensureFundingRequest(context, {
    label: `${input.label}:direct-transfer`,
    requestType: 'CREATE_DECREASE_TRANSFER',
    payload: legacyPayload({
      source_budget_year_id: input.sourceWalletId,
      destination_project_id: input.destinationProjectId,
      amount: ONE_MILLION,
      decrease_amount_before: '0',
      decrease_amount_after: amount(ONE_MILLION),
      evidence_id: input.evidenceId,
      reason_code: 'TEST_DIRECT_TRANSFER',
      memo: 'Net-zero UAT probe of direct transfer canonical source',
    }),
  });
  assertEqual(transferRequest.materialized_table, 'project_fund_transfers', 'Direct decrease canonical table');
  const classifications = await rpc(context.local, 'get_financial_decrease_classifications', {
    p_project_id: input.sourceProjectId,
  });
  const classification = classifications.find((row) => row.canonical_record_id === transferRequest.materialized_record_id);
  assert(classification, 'Direct transfer classification must reference the canonical transfer.');
  assertEqual(classification.outcome_type, 'EXISTING_PROJECT_TRANSFER', 'Direct transfer outcome type');
  const [sourceAfterTransfer, destinationAfterTransfer] = await Promise.all([
    projectPosition(context.local, input.sourceProjectId, `${input.label} source after direct 0→1 transfer`),
    projectPosition(context.local, input.destinationProjectId, `${input.label} destination after direct inbound`),
  ]);
  assertEqual(sourceAfterTransfer.projection_ready, true,
    'Direct decrease source projection must remain ready after 0→positive delta');
  assertEqual(destinationAfterTransfer.projection_ready, true,
    'Direct transfer destination projection must remain ready after inbound');
  const linked = await reverseClassification(context, {
    label: `${input.label}:direct-transfer-reversal`,
    classificationId: classification.classification_id,
    amount: ONE_MILLION,
    before: ONE_MILLION,
    after: 0n,
    evidenceId: input.evidenceId,
    memo: 'Full linked reversal of net-zero direct transfer probe',
  });
  assertEqual(linked.reversal.canonical_table, 'project_fund_transfers', 'Direct transfer reversal canonical table');
  const [sourceAfterReversal, destinationAfterReversal] = await Promise.all([
    projectPosition(context.local, input.sourceProjectId, `${input.label} source after linked reversal`),
    projectPosition(context.local, input.destinationProjectId, `${input.label} destination after linked reversal`),
  ]);
  assertEqual(sourceAfterReversal.projection_ready, true,
    'Direct decrease source projection must remain ready after linked reversal');
  assertEqual(destinationAfterReversal.projection_ready, true,
    'Direct transfer destination projection must remain ready after reversal');
  return {
    transfer_id: transferRequest.materialized_record_id,
    classification_id: classification.classification_id,
    reversal_record_id: linked.reversal.canonical_record_id,
  };
}

async function projectPosition(client, projectId, label) {
  const rows = await rpc(client, 'get_financial_project_funding_positions', {
    p_project_id: projectId,
  }, label);
  assertEqual(rows.length, 1, `${label} must return one position`);
  return rows[0];
}

async function lotBalance(client, lotId) {
  const rows = await rpc(client, 'get_financial_unallocated_fund_lots', {
    p_fiscal_year: TEST_YEAR,
  });
  const row = rows.find((candidate) => candidate.lot_id === lotId);
  assert(row, `Lot ${lotId} is missing from the balance RPC.`);
  return row;
}

async function ensureNewProject(context, input) {
  const key = stableUuid('new-project:scenario3');
  const template = input.lineageTemplate;
  assert(template?.project_name, 'Scenario-3 requires the verified 2024 lineage project as its naming template.');
  const hasCategoryPair = Boolean(template.large_category_id && template.middle_category_id);
  const businessType = ['HW', 'SW', 'COMPOSITE'].includes(template.business_type)
    ? template.business_type
    : null;
  const createArgs = {
    p_region_id: input.regionId,
    p_fiscal_year: TEST_YEAR,
    // This is the explicit human-reviewed 2025 successor of the real
    // 2022→2024 백년송도 lineage. Do not use an unrelated fixed 2025 row.
    p_project_name: template.project_name,
    p_fund_project_name: template.fund_project_name,
    p_detail_project_name: template.detail_project_name,
    p_project_period: '2025',
    p_project_start_year: 2025,
    p_project_end_year: 2025,
    p_status: template.status,
    p_business_type: businessType,
    p_large_category_id: hasCategoryPair ? template.large_category_id : null,
    p_middle_category_id: hasCategoryPair ? template.middle_category_id : null,
    p_source_lot_id: input.sourceLotId,
    p_requested_amount: amount(TEN_MILLION),
    p_idempotency_key: key,
    p_submit: false,
  };
  const created = firstRow(await rpc(context.local, 'financial_create_new_project_request',
    createArgs, 'create Scenario-3 new-project request'), 'Scenario-3 new project');
  const createReplay = firstRow(await rpc(context.local, 'financial_create_new_project_request',
    createArgs, 'replay Scenario-3 new-project create'), 'Scenario-3 new-project create replay');
  assertEqual(createReplay.request_id, created.request_id, 'Scenario-3 create replay request id');
  assertEqual(createReplay.status, created.status, 'Scenario-3 create replay status');
  let row = await readState(context.adminA, 'financial_new_project_requests', created.request_id);
  if (row.status === 'DRAFT') {
    await rpc(context.local, 'financial_submit_new_project_request', { p_request_id: row.id });
    row = await readState(context.adminA, 'financial_new_project_requests', row.id);
  }
  if (row.status === 'SUBMITTED') {
    const [listA, listB] = await Promise.all([
      rpc(context.adminA, 'get_financial_new_project_requests', { p_status: 'SUBMITTED' }),
      rpc(context.adminB, 'get_financial_new_project_requests', { p_status: 'SUBMITTED' }),
    ]);
    assert(listA.some((item) => item.id === row.id), 'admin_a must see submitted new-project request.');
    assert(listB.some((item) => item.id === row.id), 'admin_b must see submitted new-project request.');
    await rpc(context.adminA, 'financial_approve_new_project_request', {
      p_request_id: row.id,
      p_official_project_code: NEW_PROJECT_CODE,
    });
    row = await readState(context.adminA, 'financial_new_project_requests', row.id);
  }
  if (row.status === 'APPROVED') {
    await rpc(context.adminA, 'financial_apply_new_project_request', { p_request_id: row.id });
    row = await readState(context.adminA, 'financial_new_project_requests', row.id);
  }
  assertEqual(row.status, 'APPLIED', 'Scenario-3 new-project request state');
  assertEqual(row.official_project_code, NEW_PROJECT_CODE, 'Scenario-3 official project code');
  assert(row.materialized_project_id, 'Scenario-3 must materialize a project.');
  const applyReplay = firstRow(await rpc(context.adminA, 'financial_apply_new_project_request', {
    p_request_id: row.id,
  }, 'replay Scenario-3 new-project APPLY'), 'Scenario-3 new-project APPLY replay');
  assertEqual(applyReplay.request_id, row.id, 'Scenario-3 APPLY replay request id');
  assertEqual(applyReplay.project_id, row.materialized_project_id, 'Scenario-3 APPLY replay project id');
  assertEqual(applyReplay.project_code, row.official_project_code, 'Scenario-3 APPLY replay project code');
  assertEqual(applyReplay.movement_id, row.materialized_movement_id, 'Scenario-3 APPLY replay movement id');
  assert(applyReplay.budget_year_id, 'Scenario-3 APPLY replay must return the stored budget year id.');
  const postApplyCreateReplay = firstRow(await rpc(context.local,
    'financial_create_new_project_request', createArgs,
    'replay Scenario-3 create after APPLY'), 'Scenario-3 post-APPLY create replay');
  assertEqual(postApplyCreateReplay.request_id, row.id, 'Scenario-3 post-APPLY create request id');
  assertEqual(postApplyCreateReplay.status, 'APPLIED', 'Scenario-3 post-APPLY create status');
  const project = await selectOne(
    context.adminA,
    'projects',
    'id,project_id,project_code,region_id,year,project_name,fund_project_name,detail_project_name,original_alloc,increase_amount,decrease_amount,alloc,exec,rate',
    { id: row.materialized_project_id },
    'Scenario-3 materialized project',
  );
  assertEqual(project.project_id, NEW_PROJECT_CODE, 'New project_id must equal admin official code');
  assertEqual(project.project_code, NEW_PROJECT_CODE, 'New project_code must equal admin official code');
  assertEqual(project.region_id, input.regionId, 'New project region');
  assertEqual(project.project_name, template.project_name,
    'New project must use the human-reviewed 2024 lineage project name');
  assertEqual(project.fund_project_name, template.fund_project_name,
    'New project must use the human-reviewed 2024 lineage fund name');
  assertEqual(project.detail_project_name, template.detail_project_name,
    'New project must use the human-reviewed 2024 lineage detail name');
  assertEqual(project.original_alloc, 0, 'New project original allocation');
  assertEqual(project.increase_amount, TEN_MILLION, 'New project increase amount');
  assertEqual(project.decrease_amount, 0, 'New project decrease amount');
  assertEqual(project.alloc, TEN_MILLION, 'New project adjusted allocation');
  assertEqual(project.exec, 0, 'New project execution');
  const [codeProjects, codeRequests] = await Promise.all([
    selectRows(
      context.service,
      'projects',
      'id,project_id,project_code',
      (query) => query.or(`project_code.eq.${NEW_PROJECT_CODE},project_id.eq.${NEW_PROJECT_CODE}`),
      'Scenario-3 official code uniqueness read',
    ),
    selectRows(
      context.adminA,
      'financial_new_project_requests',
      'id,official_project_code,status',
      (query) => query.eq('official_project_code', NEW_PROJECT_CODE),
      'Scenario-3 request code reservation read',
    ),
  ]);
  assertEqual(codeProjects.length, 1, 'Official code/project_id must identify exactly one project');
  assertEqual(codeRequests.length, 1, 'Official code must be reserved by exactly one new-project request');
  return { request: row, project };
}

async function ensureLineage(context, input) {
  const lineageId = await rpc(context.local, 'financial_create_project_lineage', {
    p_region_id: input.regionId,
    p_reason: input.reason,
    p_project_ids: input.projectIds,
    p_member_evidence_ids: input.evidenceIds,
    p_idempotency_key: stableUuid(`lineage:${input.label}`),
    p_submit: true,
  }, `create lineage ${input.label}`);
  let row = await readState(context.adminA, 'financial_project_lineages', lineageId);
  if (row.status === 'DRAFT') {
    await rpc(context.local, 'financial_submit_project_lineage', { p_lineage_id: lineageId });
    row = await readState(context.adminA, 'financial_project_lineages', lineageId);
  }
  if (row.status === 'SUBMITTED') {
    await rpc(context.adminA, 'financial_verify_project_lineage', { p_lineage_id: lineageId });
    row = await readState(context.adminA, 'financial_project_lineages', lineageId);
  }
  assertEqual(row.status, 'VERIFIED', `${input.label} lineage state`);
  return lineageId;
}

async function chooseAlternateLineageProjects(service, adminClient, regionId, excludedIds) {
  const existingLineages = await selectRows(
    adminClient,
    'financial_project_lineages',
    'id,status',
    (query) => query.eq('idempotency_key', stableUuid('lineage:alternate-wrong-lineage')),
    'Existing alternate UAT lineage read',
  );
  if (existingLineages.length > 0) {
    assertEqual(existingLineages.length, 1, 'Alternate UAT lineage idempotency uniqueness');
    const existingMembers = await selectRows(
      adminClient,
      'financial_project_lineage_members',
      'project_id,fiscal_year',
      (query) => query.eq('lineage_id', existingLineages[0].id),
      'Existing alternate UAT lineage members read',
    );
    assertEqual(existingMembers.length, 2, 'Existing alternate UAT lineage member count');
    const { data: existingProjects, error: existingProjectsError } = await service
      .from('projects')
      .select('id,project_code,region_id,year,project_name,fund_project_name')
      .in('id', existingMembers.map((row) => row.project_id));
    if (existingProjectsError) {
      fail('Existing alternate lineage projects read failed.', {
        code: existingProjectsError.code,
        stage: 'lineage-fixture',
      });
    }
    const source = existingProjects.find((row) => row.year === 2022);
    const destination = existingProjects.find((row) => row.year === 2023);
    assert(source && destination, 'Existing alternate lineage must retain one 2022/2023 pair.');
    assertEqual(source.region_id, regionId, 'Existing alternate source region');
    assertEqual(destination.region_id, regionId, 'Existing alternate destination region');
    assertEqual(source.project_name, destination.project_name,
      'Existing alternate lineage exact project_name');
    assertEqual(source.fund_project_name, destination.fund_project_name,
      'Existing alternate lineage exact fund_project_name');
    return { source, destination };
  }
  const { data, error } = await service
    .from('projects')
    .select('id,project_code,region_id,year,project_name,fund_project_name')
    .eq('region_id', regionId)
    .in('year', [2022, 2023])
    .not('project_code', 'is', null)
    .order('project_code');
  if (error) fail('Alternate lineage candidates query failed.', { code: error.code, stage: 'lineage-fixture' });
  const candidates = (data ?? []).filter((row) => !excludedIds.has(row.id));
  const members = candidates.length
    ? await selectRows(
      adminClient,
      'financial_project_lineage_members',
      'project_id,lineage_id',
      (query) => query.in('project_id', candidates.map((row) => row.id)),
      'Alternate lineage membership read',
    )
    : [];
  const lineageIds = [...new Set(members.map((row) => row.lineage_id))];
  const verifiedLineages = lineageIds.length
    ? await selectRows(
      adminClient,
      'financial_project_lineages',
      'id,status',
      (query) => query.in('id', lineageIds).eq('status', 'VERIFIED'),
      'Verified alternate lineage read',
    )
    : [];
  const verifiedIds = new Set(verifiedLineages.map((row) => row.id));
  const blockedProjects = new Set(members.filter((row) => verifiedIds.has(row.lineage_id)).map((row) => row.project_id));
  const eligible = candidates.filter((row) => !blockedProjects.has(row.id));
  const lineageNameKey = (row) => JSON.stringify([
    row.project_name ?? null,
    row.fund_project_name ?? null,
  ]);
  const destinationByName = new Map(
    eligible.filter((row) => row.year === 2023)
      .map((row) => [lineageNameKey(row), row]),
  );
  const source = eligible.find((row) =>
    row.year === 2022 && destinationByName.has(lineageNameKey(row)));
  const destination = source ? destinationByName.get(lineageNameKey(source)) : null;
  assert(source && destination, 'Two unused same-region projects are required for the wrong-lineage negative UAT.');
  assertEqual(source.project_name, destination.project_name,
    'Alternate lineage pair must have the exact same project_name');
  assertEqual(source.fund_project_name, destination.fund_project_name,
    'Alternate lineage pair must have the exact same fund_project_name');
  return { source, destination };
}

async function assertRawProjectUnchanged(service, expected, label) {
  const row = await selectOne(
    service,
    'projects',
    'id,total_budget,original_alloc,increase_amount,decrease_amount,alloc,exec,rate',
    { id: expected.id },
    `${label} raw project read`,
  );
  for (const field of [
    'total_budget', 'original_alloc', 'increase_amount', 'decrease_amount', 'alloc', 'exec', 'rate',
  ]) {
    assertEqual(row[field], expected[field], `${label} raw projects.${field} must remain unchanged`);
  }
  return row;
}

async function main() {
  const envArgument = readArgument('--env-file');
  const credentialsArgument = readArgument('--credentials-file');
  if (!hasFlag('--confirm-test-write')) {
    fail('Refusing to run: --confirm-test-write is required.', { stage: 'preflight' });
  }
  const resetUatPasswords = hasFlag('--reset-uat-passwords');
  const resetUatAccount = readArgument('--reset-uat-account');
  const preflightOnly = hasFlag('--preflight-only');
  const testFile = loadEnvFile(envArgument, '--env-file');
  const credentialsFile = loadEnvFile(credentialsArgument, '--credentials-file');
  // Target binding is sourced exclusively from the audited TEST env file.
  // The credentials file is never allowed to override a URL/ref/key/mode.
  const env = testFile.values;
  const credentials = credentialsFile.values;

  const targetEnv = requireEnv(env, 'TARGET_ENV');
  const prodRef = requireEnv(env, 'PROD_PROJECT_REF');
  const testRef = requireEnv(env, 'TEST_PROJECT_REF');
  const ledgerMode = requireEnv(env, 'LEDGER_MODE').toLowerCase();
  const supabaseUrl = requireEnv(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = requireEnv(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const serviceKey = requireEnv(env, 'TEST_SUPABASE_SERVICE_ROLE_KEY');
  const databaseUrl = requireEnv(env, 'TEST_DATABASE_URL');
  const endpointRef = projectRefFromUrl(supabaseUrl);
  assertEqual(targetEnv, 'TEST', 'TARGET_ENV');
  assert(prodRef !== testRef, 'PROD_PROJECT_REF and TEST_PROJECT_REF must differ.');
  assertEqual(endpointRef, testRef, 'Supabase endpoint must match TEST_PROJECT_REF');
  assertEqual(ledgerMode, 'reconciliation', 'LEDGER_MODE');
  assert(databaseUrl.includes(testRef), 'TEST_DATABASE_URL must contain TEST project ref.');
  assert(!databaseUrl.includes(prodRef), 'TEST_DATABASE_URL must not contain Production project ref.');
  const serviceClaims = decodeJwtPayload(serviceKey);
  const anonClaims = decodeJwtPayload(anonKey);
  const opaqueServiceKey = serviceKey.startsWith('sb_secret_');
  const opaqueAnonKey = anonKey.startsWith('sb_publishable_');
  assert(opaqueServiceKey || serviceClaims?.role === 'service_role',
    'TEST service key must be a Supabase secret key or service_role JWT.');
  assert(opaqueAnonKey || anonClaims?.role === 'anon',
    'TEST anon key must be a Supabase publishable key or anon JWT.');
  if (serviceClaims?.ref) assertEqual(serviceClaims.ref, testRef, 'Service key project ref');
  if (anonClaims?.ref) assertEqual(anonClaims.ref, testRef, 'Anon key project ref');

  const accountSpecs = [
    ['admin_a', 'UAT_ADMIN_A_EMAIL', 'UAT_ADMIN_A_PASSWORD', 'admin'],
    ['admin_b', 'UAT_ADMIN_B_EMAIL', 'UAT_ADMIN_B_PASSWORD', 'admin'],
    ['local_a', 'UAT_LOCAL_A_EMAIL', 'UAT_LOCAL_A_PASSWORD', 'local_user'],
    ['local_b', 'UAT_LOCAL_B_EMAIL', 'UAT_LOCAL_B_PASSWORD', 'local_user'],
    ['local_c', 'UAT_LOCAL_C_EMAIL', 'UAT_LOCAL_C_PASSWORD', 'local_user'],
  ];
  const accounts = accountSpecs.map(([alias, emailName, passwordName, expectedRole]) => ({
    alias,
    email: requireEnv(credentials, emailName),
    password: requireEnv(credentials, passwordName),
    expectedRole,
  }));
  assertEqual(new Set(accounts.map((account) => account.email.toLowerCase())).size, accounts.length,
    'UAT account emails must be distinct');

  const service = createSupabase(supabaseUrl, serviceKey);
  const users = await findAuthUsers(service, accounts.map((account) => account.email));
  for (const account of accounts) {
    account.userId = users.get(account.email.toLowerCase()).id;
  }
  if (resetUatPasswords) {
    await resetPasswordsPreservingIds(service, accounts);
  } else if (resetUatAccount) {
    const targetAccount = accounts.find((account) => account.alias === resetUatAccount);
    assert(targetAccount, `Unknown --reset-uat-account alias: ${resetUatAccount}`, {
      stage: 'preflight',
    });
    await resetPasswordsPreservingIds(service, [targetAccount]);
  }
  await loadProfiles(service, accounts);
  for (const account of accounts) {
    assertEqual(account.profile.role, account.expectedRole, `${account.alias} profile role`);
    const signedIn = await signIn(supabaseUrl, anonKey, account.email, account.password, account.alias);
    assertEqual(signedIn.userId, account.userId, `${account.alias} sign-in must preserve auth ID`);
    account.client = signedIn.client;
  }

  const byAlias = Object.fromEntries(accounts.map((account) => [account.alias, account]));
  const context = {
    service,
    local: byAlias.local_b.client,
    adminA: byAlias.admin_a.client,
    adminB: byAlias.admin_b.client,
  };

  const report = {
    status: 'RUNNING',
    mode: preflightOnly ? 'PREFLIGHT_ONLY' : 'FULL_UAT',
    started_at: new Date().toISOString(),
    target: {
      environment: 'TEST',
      project_ref: mask(testRef),
      endpoint_ref_matches: true,
      production_ref_distinct: true,
      service_key_server_only: true,
    },
    runtime: await assertRuntime(context.adminA, testRef),
    auth: {
      password_reset_preserved_ids: resetUatPasswords || resetUatAccount ? true : null,
      passwords_changed: resetUatPasswords || Boolean(resetUatAccount),
      password_reset_scope: resetUatPasswords ? 'all' : (resetUatAccount ?? null),
      authenticated_aliases: accounts.map((account) => account.alias),
      secrets_printed: false,
    },
    scenarios: {},
  };

  let projectsByCode = await readProjects(service, Object.values(PROJECT_CODES));
  const initialS1 = projectsByCode.get(PROJECT_CODES.scenario1Source);
  const targetRegionId = initialS1.region_id;
  for (const project of projectsByCode.values()) {
    assertEqual(project.region_id, targetRegionId, `${project.project_code} target region`);
  }
  assertEqual(byAlias.local_b.profile.region_id, targetRegionId, 'local_b must own the 부산 서구 UAT region');
  const crossLocal = [byAlias.local_a, byAlias.local_c]
    .find((account) => account.profile.region_id && account.profile.region_id !== targetRegionId);
  assert(crossLocal, 'At least one local UAT account must belong to another region.');
  const region = await selectOne(service, 'regions', 'id,sido,sigungu,display_name', {
    id: targetRegionId,
  }, 'Target region read');

  const markerKey = stableUuid('funding-request:scenario1:lot10');
  const markerRows = await selectRows(
    context.adminA,
    'financial_funding_reallocation_requests',
    'id,status',
    (query) => query.eq('idempotency_key', markerKey),
    'UAT resume marker read',
  );
  const evidenceMarkerRows = await selectRows(
    context.adminA,
    'ledger_evidence',
    'id,verification_status',
    (query) => query.eq('idempotency_key', stableUuid('evidence:legacy-reconstruction-main')),
    'UAT evidence resume marker read',
  );
  const resume = markerRows.length > 0 || evidenceMarkerRows.length > 0;
  context.resume = resume;

  const initialUnclassified = await rpc(context.adminA, 'get_financial_unclassified_decreases');
  assertEqual(initialUnclassified.length, 4, 'Scenario 11 existing unclassified decrease count');
  const preexistingProjectIds = initialUnclassified.map((row) => row.project_id);
  const [preexistingLots, preexistingClassifications] = await Promise.all([
    selectRows(context.adminA, 'financial_unallocated_fund_lots', 'id,source_project_id',
      (query) => query.in('source_project_id', preexistingProjectIds), 'Pre-existing decrease lot check'),
    selectRows(context.adminA, 'financial_project_decrease_classifications', 'id,source_project_id',
      (query) => query.in('source_project_id', preexistingProjectIds), 'Pre-existing decrease classification check'),
  ]);
  assertEqual(preexistingLots.length, 0, 'Existing four decreases must not be auto-materialized into lots');
  assertEqual(preexistingClassifications.length, 0, 'Existing four decreases must not be auto-classified');
  const freshDeltaCounts = {};
  if (!resume) {
    const deltaTables = [
      ['financial_unallocated_fund_lots', 'id'],
      ['financial_unallocated_fund_movements', 'id'],
      ['financial_project_decrease_classifications', 'id'],
      ['financial_project_decrease_classification_reversals', 'id'],
      ['financial_project_baseline_attestations', 'project_id'],
      ['financial_funding_reallocation_requests', 'id'],
      ['financial_new_project_requests', 'id'],
    ];
    const rowsByTable = await Promise.all(deltaTables.map(([table, key]) =>
      selectRows(context.adminA, table, key, null, `Fresh ${table} check`)));
    for (let index = 0; index < deltaTables.length; index += 1) {
      const [table] = deltaTables[index];
      freshDeltaCounts[table] = rowsByTable[index].length;
      assertEqual(rowsByTable[index].length, 0,
        `Fresh migration must contain zero ${table} rows before UAT`);
    }
  }
  report.scenarios.scenario_11 = {
    pass: true,
    unclassified_count: 4,
    unclassified_amount: sum(initialUnclassified, 'unclassified_amount').toString(),
    auto_lots: 0,
    auto_classifications: 0,
    fresh_migration_empty_transaction_tables_checked: !resume,
    fresh_delta_table_counts: freshDeltaCounts,
  };

  if (preflightOnly) {
    assert(!resume,
      'Preflight-only fresh-state proof cannot be captured after this deterministic UAT has already started.');
    report.status = 'PASS';
    report.completed_at = new Date().toISOString();
    report.financial_writes_performed = false;
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const scenarioOneProject = await ensureScenarioOneFixture(service, initialS1, resume);
  projectsByCode.set(PROJECT_CODES.scenario1Source, scenarioOneProject);
  const rawSnapshots = new Map([...projectsByCode.values()].map((project) => [project.id, { ...project }]));

  const legacyEvidenceId = await ensureEvidence(context, {
    label: 'legacy-reconstruction-main',
    regionId: targetRegionId,
    scope: 'LEGACY_RECONSTRUCTION',
    rowReference: 'Funding delta UAT scenarios 1-11',
    note: 'Verified TEST-only physical baseline and reallocation UAT evidence',
    asOfDate: LEGACY_EVIDENCE_AS_OF,
  });

  const baselineCodes = [
    PROJECT_CODES.scenario1Source,
    PROJECT_CODES.scenario2Source,
    PROJECT_CODES.scenario3Source,
    PROJECT_CODES.scenario4Source,
    PROJECT_CODES.scenario5Source,
    PROJECT_CODES.destination1,
    PROJECT_CODES.destination2,
    PROJECT_CODES.destination3,
    PROJECT_CODES.carry2022,
    PROJECT_CODES.carry2023,
    PROJECT_CODES.carry2024,
  ];
  const baselines = new Map();
  for (const code of baselineCodes) {
    const project = projectsByCode.get(code);
    baselines.set(code, await ensureProjectBaseline(context, project, legacyEvidenceId));
  }

  const s1 = projectsByCode.get(PROJECT_CODES.scenario1Source);
  const s1Baseline = baselines.get(PROJECT_CODES.scenario1Source);
  const s1Lot10 = await createLot(context, {
    label: 'scenario1:lot10',
    sourceWalletId: s1Baseline.walletId,
    amount: TEN_MILLION,
    before: 0n,
    after: TEN_MILLION,
    reason: 'Scenario 1 재배분 대기',
    evidenceId: legacyEvidenceId,
    assertFingerprintConflict: true,
  });
  let s1Position = await projectPosition(context.local, s1.id, 'Scenario-1 local position after 0→10');
  assertEqual(s1Position.ledger_original_allocation, 100_000_000n, 'Scenario-1 original allocation');
  assertEqual(s1Position.ledger_adjusted_allocation, 90_000_000n, 'Scenario-1 adjusted allocation');
  assertEqual(s1Position.ledger_execution_amount, 90_000_000n, 'Scenario-1 execution');
  assertEqual(s1Position.ledger_decrease_amount, TEN_MILLION, 'Scenario-1 decrease');
  assertEqual(Number(s1Position.ledger_execution_rate), 100, 'Scenario-1 current execution rate');
  assertEqual(s1Position.projection_ready, true, 'Scenario-1 source projection after 0→10');
  const s1Classifications = await rpc(context.local, 'get_financial_decrease_classifications', {
    p_project_id: s1.id,
  });
  const originalS1Classification = s1Classifications.find((row) => row.canonical_record_id === s1Lot10.id);
  assert(originalS1Classification, 'Scenario-1 lot classification must be readable.');
  await reverseClassification(context, {
    label: 'scenario1:linked-correction-2',
    classificationId: originalS1Classification.classification_id,
    amount: TWO_MILLION,
    before: TEN_MILLION,
    after: 8_000_000n,
    evidenceId: legacyEvidenceId,
    memo: 'Scenario 1 linked 10→8 correction',
  });
  const correctedPosition = await projectPosition(context.local, s1.id, 'Scenario-1 local position after 10→8');
  if (!resume) {
    assertEqual(correctedPosition.ledger_decrease_amount, 8_000_000n,
      'Scenario-1 linked correction current decrease');
  }
  assertEqual(correctedPosition.projection_ready, true, 'Scenario-1 projection after linked correction');
  await assertRawProjectUnchanged(service, rawSnapshots.get(s1.id), 'Scenario-1 after linked correction');
  const s1Lot2 = await createLot(context, {
    label: 'scenario1:lot2-after-correction',
    sourceWalletId: s1Baseline.walletId,
    amount: TWO_MILLION,
    before: 8_000_000n,
    after: TEN_MILLION,
    reason: 'Scenario 1 정정 후 재분류',
    evidenceId: legacyEvidenceId,
  });
  const [s1Lot10Balance, s1Lot2Balance] = await Promise.all([
    lotBalance(context.local, s1Lot10.id),
    lotBalance(context.local, s1Lot2.id),
  ]);
  assertEqual(s1Lot10Balance.remaining_amount, 8_000_000n, 'Scenario-1 corrected first lot stock');
  assertEqual(s1Lot2Balance.remaining_amount, TWO_MILLION, 'Scenario-1 second lot stock');
  s1Position = await projectPosition(context.local, s1.id, 'Scenario-1 final local position');
  assertEqual(s1Position.ledger_decrease_amount, TEN_MILLION, 'Scenario-1 final decrease');
  assertEqual(s1Position.projection_ready, true, 'Scenario-1 final projection');
  const s1Cohort = await selectOne(service, 'financial_funding_cohort_execution', '*', {
    cohort_id: s1Baseline.cohortId,
  }, 'Scenario-1 cohort summary');
  assertEqual(s1Cohort.initial_allocation, 100_000_000n, 'Scenario-1 cohort initial allocation');
  assertEqual(s1Cohort.verified_cumulative_execution, 90_000_000n, 'Scenario-1 cohort execution');
  assertEqual(Number(s1Cohort.execution_rate), 90, 'Scenario-1 cohort execution rate');
  assertEqual(s1Cohort.waiting_balance, TEN_MILLION, 'Scenario-1 cohort waiting stock');
  report.scenarios.scenario_1 = {
    pass: true,
    current_project_rate: '100.00',
    cohort_rate: '90.00',
    waiting_stock: amount(TEN_MILLION),
    linked_correction: '10000000→8000000→10000000',
    raw_project_unchanged: true,
  };

  const s2 = projectsByCode.get(PROJECT_CODES.scenario2Source);
  const d1 = projectsByCode.get(PROJECT_CODES.destination1);
  const s2Probe = await directDecreaseTransferProbe(context, {
    label: 'scenario2',
    sourceWalletId: baselines.get(PROJECT_CODES.scenario2Source).walletId,
    sourceProjectId: s2.id,
    destinationProjectId: d1.id,
    evidenceId: legacyEvidenceId,
  });
  const s2Lot = await createLot(context, {
    label: 'scenario2:lot10',
    sourceWalletId: baselines.get(PROJECT_CODES.scenario2Source).walletId,
    amount: TEN_MILLION,
    before: 0n,
    after: TEN_MILLION,
    reason: 'Scenario 2 기존사업 재배분 대기',
    evidenceId: legacyEvidenceId,
  });
  const s2Movement = await allocateLot(context, {
    label: 'scenario2:allocate-existing-10',
    lotId: s2Lot.id,
    destinationProjectId: d1.id,
    amount: TEN_MILLION,
    evidenceId: legacyEvidenceId,
    memo: 'Scenario 2 pool→existing project',
  });
  assertEqual(s2Movement.movement_type, 'ALLOCATE_EXISTING_PROJECT', 'Scenario-2 movement type');
  assertEqual((await lotBalance(context.local, s2Lot.id)).remaining_amount, 0, 'Scenario-2 lot remaining');
  const d1History = await rpc(context.local, 'get_financial_project_funding_history', { p_project_id: d1.id });
  assert(d1History.some((row) => row.event_id === s2Movement.id
      && row.event_type === 'UNALLOCATED_TO_EXISTING_PROJECT'
      && row.direction === 'IN'
      && row.budget_cohort_id === baselines.get(PROJECT_CODES.scenario2Source).cohortId),
  'Scenario-2 destination history must trace the source cohort.');
  const s2History = await rpc(context.local, 'get_financial_project_funding_history', { p_project_id: s2.id });
  assert(s2History.some((row) => row.event_id === s2Probe.transfer_id
      && row.event_type === 'TRANSFER_OUT' && row.direction === 'OUT'
      && row.related_project_id === d1.id),
  'Direct transfer history must show source OUT to destination.');
  assert(d1History.some((row) => row.event_id === s2Probe.transfer_id
      && row.event_type === 'TRANSFER_IN' && row.direction === 'IN'
      && row.related_project_id === s2.id),
  'Direct transfer history must show destination IN from source.');
  assert(d1History.some((row) => row.event_id === s2Probe.reversal_record_id
      && row.event_type === 'TRANSFER_REVERSAL_OUT' && row.direction === 'OUT'
      && row.related_project_id === s2.id),
  'Reversal history must show the canonical reversed source as OUT.');
  assert(s2History.some((row) => row.event_id === s2Probe.reversal_record_id
      && row.event_type === 'TRANSFER_REVERSAL_IN' && row.direction === 'IN'
      && row.related_project_id === d1.id),
  'Reversal history must show the canonical reversed destination as IN.');
  report.scenarios.scenario_2 = {
    pass: true,
    pool_original: amount(TEN_MILLION),
    allocated_existing: amount(TEN_MILLION),
    remaining: '0',
    source_cohort_traced: true,
    direct_transfer_canonical_probe: s2Probe,
  };

  const s3 = projectsByCode.get(PROJECT_CODES.scenario3Source);
  const s3Lot = await createLot(context, {
    label: 'scenario3:lot10',
    sourceWalletId: baselines.get(PROJECT_CODES.scenario3Source).walletId,
    amount: TEN_MILLION,
    before: 0n,
    after: TEN_MILLION,
    reason: 'Scenario 3 신규사업 재배분 대기',
    evidenceId: legacyEvidenceId,
  });
  const newProject = await ensureNewProject(context, {
    regionId: targetRegionId,
    sourceLotId: s3Lot.id,
    lineageTemplate: projectsByCode.get(PROJECT_CODES.carry2024),
  });
  assertEqual((await lotBalance(context.local, s3Lot.id)).remaining_amount, 0, 'Scenario-3 lot remaining');
  const newPosition = await projectPosition(context.local, newProject.project.id, 'Scenario-3 new project position');
  assertEqual(newPosition.ledger_increase_amount, TEN_MILLION, 'Scenario-3 Ledger increase');
  assertEqual(newPosition.ledger_adjusted_allocation, TEN_MILLION, 'Scenario-3 Ledger allocation');
  assertEqual(newPosition.projection_ready, true, 'Scenario-3 new-project projection');
  const newHistory = await rpc(context.local, 'get_financial_project_funding_history', {
    p_project_id: newProject.project.id,
  });
  assert(newHistory.some((row) => row.event_type === 'UNALLOCATED_TO_NEW_PROJECT'
      && row.budget_cohort_id === baselines.get(PROJECT_CODES.scenario3Source).cohortId),
  'Scenario-3 new project history must trace the source cohort.');
  report.scenarios.scenario_3 = {
    pass: true,
    official_project_code: NEW_PROJECT_CODE,
    allocation: amount(TEN_MILLION),
    source_cohort_traced: true,
    atomic_request_state: 'APPLIED',
  };

  const s4Lot = await createLot(context, {
    label: 'scenario4:lot10',
    sourceWalletId: baselines.get(PROJECT_CODES.scenario4Source).walletId,
    amount: TEN_MILLION,
    before: 0n,
    after: TEN_MILLION,
    reason: 'Scenario 4 partial allocation',
    evidenceId: legacyEvidenceId,
  });
  const scenario4DestinationB = projectsByCode.get(PROJECT_CODES.destination2);
  const scenario4RacePayload = legacyPayload({
    lot_id: s4Lot.id,
    destination_project_id: scenario4DestinationB.id,
    amount: 6_000_000n,
    evidence_id: legacyEvidenceId,
    memo: 'Scenario 4 concurrent B 600만원 allocation',
  });
  const [raceA, raceB] = await Promise.all([
    ensureApprovedFundingRequest(context, {
      label: 'scenario4:race-b-6:a',
      requestType: 'ALLOCATE_UNALLOCATED_EXISTING',
      payload: scenario4RacePayload,
    }),
    ensureApprovedFundingRequest(context, {
      label: 'scenario4:race-b-6:b',
      requestType: 'ALLOCATE_UNALLOCATED_EXISTING',
      payload: scenario4RacePayload,
    }),
  ]);
  const raceResults = await Promise.allSettled([
    applyFundingWithSerializationRetry(
      context.adminA, raceA.row.id, 'Scenario-4 concurrent APPLY admin_a'),
    applyFundingWithSerializationRetry(
      context.adminB, raceB.row.id, 'Scenario-4 concurrent APPLY admin_b'),
  ]);
  const fulfilledRace = raceResults.filter((result) => result.status === 'fulfilled');
  const rejectedRace = raceResults.filter((result) => result.status === 'rejected');
  assertEqual(fulfilledRace.length, 1,
    'Scenario-4 row lock must allow exactly one concurrent 600만원 APPLY');
  assertEqual(rejectedRace.length, 1,
    'Scenario-4 row lock must reject exactly one concurrent 600만원 APPLY');
  assertEqual(rejectedRace[0].reason.code, '23514',
    'Scenario-4 losing APPLY must fail the locked remaining-balance invariant');
  const [raceAState, raceBState] = await Promise.all([
    readState(context.adminA, 'financial_funding_reallocation_requests', raceA.row.id),
    readState(context.adminA, 'financial_funding_reallocation_requests', raceB.row.id),
  ]);
  const raceStates = [raceAState, raceBState];
  assertEqual(raceStates.filter((row) => row.status === 'APPLIED').length, 1,
    'Scenario-4 must persist exactly one APPLIED race request');
  assertEqual(raceStates.filter((row) => row.status === 'APPROVED').length, 1,
    'Scenario-4 losing race request must remain APPROVED as concurrency evidence');
  const raceWinner = raceStates.find((row) => row.status === 'APPLIED');
  const raceLoser = raceStates.find((row) => row.status === 'APPROVED');
  const raceMovement = await readState(
    context.adminA,
    'financial_unallocated_fund_movements',
    raceWinner.materialized_record_id,
  );
  assertEqual(raceMovement.movement_type, 'ALLOCATE_EXISTING_PROJECT',
    'Scenario-4 winning race movement type');
  assertEqual(raceMovement.destination_project_id, scenario4DestinationB.id,
    'Scenario-4 winning race destination');
  assertEqual(raceMovement.amount, 6_000_000n, 'Scenario-4 winning race amount');
  const raceApplyReplay = firstRow(await rpc(context.adminA,
    'financial_apply_funding_reallocation_request', { p_request_id: raceWinner.id },
    'Scenario-4 winning APPLY replay'), 'Scenario-4 winning APPLY replay');
  assertEqual(raceApplyReplay.materialized_record_id, raceWinner.materialized_record_id,
    'Scenario-4 winning APPLY replay materialized id');
  const remainingAfterRace = await lotBalance(context.local, s4Lot.id);
  if (!resume) {
    assertEqual(remainingAfterRace.remaining_amount, 4_000_000n,
      'Scenario-4 lot remaining immediately after the concurrent race');
  }
  await allocateLot(context, {
    label: 'scenario4:allocate-c-4', lotId: s4Lot.id,
    destinationProjectId: projectsByCode.get(PROJECT_CODES.destination3).id,
    amount: 4_000_000n, evidenceId: legacyEvidenceId, memo: 'Scenario 4 C 400만원',
  });
  assertEqual((await lotBalance(context.local, s4Lot.id)).remaining_amount, 0, 'Scenario-4 lot remaining');
  report.scenarios.scenario_4 = {
    pass: true,
    allocated_b: '6000000',
    allocated_c: '4000000',
    remaining: '0',
    concurrent_apply: {
      fulfilled: 1,
      rejected: 1,
      rejected_code: rejectedRace[0].reason.code,
      serialization_retries: fulfilledRace.reduce(
        (total, result) => total + result.value.serializationRetries, 0)
        + rejectedRace.reduce(
          (total, result) => total + (result.reason.serializationRetries ?? 0), 0),
      winner_status: raceWinner.status,
      loser_status: raceLoser.status,
      loser_request_id: raceLoser.id,
      remaining_after_race_on_fresh_run: resume ? 'resume-not-reobserved' : '4000000',
    },
  };

  const s5 = projectsByCode.get(PROJECT_CODES.scenario5Source);
  const s5AttestationBefore = await selectRows(
    context.adminA,
    'financial_project_baseline_attestations',
    'project_id,physical_adjusted_allocation,ledger_adjusted_allocation',
    (query) => query.eq('project_id', s5.id),
    'Scenario-5 source attestation before first decrease',
  );
  assertEqual(s5AttestationBefore.length, 1,
    'Scenario-5 exec=0 final-exact baseline must have one attestation');
  const s5Lot = await createLot(context, {
    label: 'scenario5:lot10',
    sourceWalletId: baselines.get(PROJECT_CODES.scenario5Source).walletId,
    amount: TEN_MILLION,
    before: 0n,
    after: TEN_MILLION,
    reason: 'Scenario 5 partial allocation and return',
    evidenceId: legacyEvidenceId,
  });
  const s5AttestationAfter = await selectRows(
    context.adminA,
    'financial_project_baseline_attestations',
    'project_id,physical_adjusted_allocation,ledger_adjusted_allocation',
    (query) => query.eq('project_id', s5.id),
    'Scenario-5 source attestation after first decrease',
  );
  assertEqual(s5AttestationAfter.length, 1,
    'Scenario-5 first decrease must preserve one source baseline attestation');
  assertEqual(s5AttestationAfter[0].project_id, s5AttestationBefore[0].project_id,
    'Scenario-5 baseline attestation identity must remain immutable');
  assertEqual(s5AttestationAfter[0].ledger_adjusted_allocation,
    s5AttestationBefore[0].ledger_adjusted_allocation,
    'Scenario-5 baseline attestation facts must remain immutable');
  const s5PositionAfterDecrease = await projectPosition(
    context.local,
    s5.id,
    'Scenario-5 source position after explicit pre-attestation and 0→10',
  );
  assertEqual(s5PositionAfterDecrease.ledger_decrease_amount, TEN_MILLION,
    'Scenario-5 source Ledger decrease after 0→10');
  assertEqual(s5PositionAfterDecrease.projection_ready, true,
    'Scenario-5 source projection after 0→10');
  await allocateLot(context, {
    label: 'scenario5:allocate-b-6', lotId: s5Lot.id,
    destinationProjectId: d1.id, amount: 6_000_000n,
    evidenceId: legacyEvidenceId, memo: 'Scenario 5 B 600만원',
  });
  const returnMovement = await returnLot(context, {
    label: 'scenario5:return-4', lotId: s5Lot.id,
    amount: 4_000_000n, evidenceId: legacyEvidenceId,
    memo: 'Scenario 5 기금 외부 반납 400만원',
  });
  assertEqual(returnMovement.movement_type, 'RETURN', 'Scenario-5 return canonical movement');
  assertEqual((await lotBalance(context.local, s5Lot.id)).remaining_amount, 0, 'Scenario-5 lot remaining');
  const duplicateAdjustment = await selectRows(
    context.adminA, 'project_budget_adjustments', 'id',
    (query) => query.eq('idempotency_key', stableUuid('funding-request:scenario5:return-4')),
    'Scenario-5 duplicate adjustment check',
  );
  assertEqual(duplicateAdjustment.length, 0, 'Pool return must not create a duplicate project adjustment');
  report.scenarios.scenario_5 = {
    pass: true,
    allocated_existing: '6000000',
    returned: '4000000',
    remaining: '0',
    duplicate_adjustment_count: 0,
    source_attestation: 'final-exact baseline row1 preserved immutably through 0→10',
    source_projection_ready: true,
  };

  for (const project of [s1, s2, s3,
    projectsByCode.get(PROJECT_CODES.scenario4Source),
    projectsByCode.get(PROJECT_CODES.scenario5Source)]) {
    await assertRawProjectUnchanged(service, rawSnapshots.get(project.id), `${project.project_code} post-delta`);
  }

  const carryProjects = [
    projectsByCode.get(PROJECT_CODES.carry2022),
    projectsByCode.get(PROJECT_CODES.carry2023),
    projectsByCode.get(PROJECT_CODES.carry2024),
    newProject.project,
  ];
  const trueLineageEvidence = [];
  for (const project of carryProjects) {
    trueLineageEvidence.push(await ensureEvidence(context, {
      label: `lineage:true:${project.project_code}`,
      regionId: targetRegionId,
      scope: 'PROJECT_LINEAGE',
      rowReference: project.project_code,
      note: `Human-verified TEST lineage member ${project.project_code}`,
      asOfDate: `${project.year}-12-31`,
    }));
  }
  const trueLineageId = await ensureLineage(context, {
    label: 'carryover-2022-2025',
    regionId: targetRegionId,
    reason: 'TEST UAT verified 2022→2025 project funding lineage',
    projectIds: carryProjects.map((project) => project.id),
    evidenceIds: trueLineageEvidence,
  });

  const altProjects = await chooseAlternateLineageProjects(
    service,
    context.adminA,
    targetRegionId,
    new Set(carryProjects.map((project) => project.id)),
  );
  const altEvidence = [];
  for (const project of [altProjects.source, altProjects.destination]) {
    altEvidence.push(await ensureEvidence(context, {
      label: `lineage:alternate:${project.project_code}`,
      regionId: targetRegionId,
      scope: 'PROJECT_LINEAGE',
      rowReference: project.project_code,
      note: `Separate TEST lineage member ${project.project_code}`,
      asOfDate: `${project.year}-12-31`,
    }));
  }
  const alternateLineageId = await ensureLineage(context, {
    label: 'alternate-wrong-lineage',
    regionId: targetRegionId,
    reason: 'TEST UAT deliberately separate lineage for negative authorization test',
    projectIds: [altProjects.source.id, altProjects.destination.id],
    evidenceIds: altEvidence,
  });

  const carry2022 = projectsByCode.get(PROJECT_CODES.carry2022);
  const carry2023 = projectsByCode.get(PROJECT_CODES.carry2023);
  const carry2024 = projectsByCode.get(PROJECT_CODES.carry2024);
  const carryFundingEntryId = baselines.get(PROJECT_CODES.carry2022).allocationEntryId;
  const carryCohortId = baselines.get(PROJECT_CODES.carry2022).cohortId;
  const carrySourceWallet2022 = baselines.get(PROJECT_CODES.carry2022).walletId;
  const firstCandidates = await rpc(context.local, 'get_financial_carryover_destinations', {
    p_source_budget_year_id: carrySourceWallet2022,
  });
  const firstCandidate = firstCandidates.find((row) => row.destination_project_id === carry2023.id);
  assert(firstCandidate, 'Scenario-6 verified lineage destination must be listed.');
  assertEqual(firstCandidate.expected_sequence, 1, 'Scenario-6 expected sequence');
  assertEqual(firstCandidate.expected_type, 'MYEONGSI', 'Scenario-6 expected carryover type');
  assertEqual(firstCandidate.available, true, 'Scenario-6 candidate availability');
  const carry1 = await ensureLegacyEntry(context, {
    label: 'carryover:2022-to-2023:30m',
    eventType: 'CARRYOVER', projectId: carry2022.id,
    destinationProjectId: carry2023.id, fundingEntryId: carryFundingEntryId,
    lineageId: trueLineageId, evidenceId: legacyEvidenceId,
    fiscalYear: 2022, destinationFiscalYear: 2023,
    amount: 30_000_000n, effectiveDate: '2022-12-31',
    carryoverSequence: 1, carryoverType: 'MYEONGSI',
    memo: 'Scenario 6 명시이월 3천만원',
  });
  assertEqual(carry1.materialized_table, 'project_carryovers', 'Scenario-6 canonical table');
  const carry1Row = await readState(context.adminA, 'project_carryovers', carry1.materialized_record_id);
  report.scenarios.scenario_6 = {
    pass: true,
    type: 'MYEONGSI',
    sequence: 1,
    amount: '30000000',
    verified_lineage: true,
  };

  const secondCandidates = await rpc(context.local, 'get_financial_carryover_destinations', {
    p_source_budget_year_id: carry1Row.destination_budget_year_id,
  });
  const secondCandidate = secondCandidates.find((row) => row.destination_project_id === carry2024.id);
  assert(secondCandidate, 'Scenario-7 verified lineage destination must be listed.');
  assertEqual(secondCandidate.expected_sequence, 2, 'Scenario-7 expected sequence');
  assertEqual(secondCandidate.expected_type, 'SAGO', 'Scenario-7 expected carryover type');
  assertEqual(secondCandidate.available, true, 'Scenario-7 candidate availability');
  const carry2 = await ensureLegacyEntry(context, {
    label: 'carryover:2023-to-2024:20m',
    eventType: 'CARRYOVER', projectId: carry2023.id,
    destinationProjectId: carry2024.id, fundingEntryId: carryFundingEntryId,
    lineageId: trueLineageId, evidenceId: legacyEvidenceId,
    fiscalYear: 2023, destinationFiscalYear: 2024,
    amount: 20_000_000n, effectiveDate: '2023-12-31',
    carryoverSequence: 2, carryoverType: 'SAGO',
    memo: 'Scenario 7 사고이월 2천만원',
  });
  assertEqual(carry2.materialized_table, 'project_carryovers', 'Scenario-7 canonical table');
  const carry2Row = await readState(context.adminA, 'project_carryovers', carry2.materialized_record_id);
  report.scenarios.scenario_7 = {
    pass: true,
    type: 'SAGO',
    sequence: 2,
    amount: '20000000',
    prior_carryover_applied: true,
  };

  const thirdCandidates = await rpc(context.local, 'get_financial_carryover_destinations', {
    p_source_budget_year_id: carry2Row.destination_budget_year_id,
  });
  const thirdCandidate = thirdCandidates.find((row) => row.destination_project_id === newProject.project.id);
  assert(thirdCandidate, 'Scenario-8 third-year lineage candidate must remain auditable.');
  assertEqual(thirdCandidate.expected_sequence, 3, 'Scenario-8 expected sequence');
  assertEqual(thirdCandidate.available, false, 'Scenario-8 third carryover must be unavailable');
  const thirdBlocked = await expectRpcError(context.local, 'financial_create_legacy_reconstruction_entry', {
    p_event_type: 'CARRYOVER', p_project_id: carry2024.id,
    p_destination_project_id: newProject.project.id, p_funding_entry_id: carryFundingEntryId,
    p_lineage_id: trueLineageId, p_evidence_id: legacyEvidenceId,
    p_origin_fiscal_year: null, p_fiscal_year: 2024, p_destination_fiscal_year: 2025,
    p_legacy_prior_carryover_count: null, p_amount: amount(ONE_MILLION),
    p_effective_date: '2024-12-31', p_carryover_sequence: 2,
    p_carryover_type: 'SAGO', p_adjustment_type: null,
    p_reason_code: 'TEST_THIRD_BLOCK', p_memo: 'Expected third carryover rejection',
    p_idempotency_key: stableUuid('negative:third-carryover'),
  }, 'Scenario-8 third carryover guard');
  report.scenarios.scenario_8 = {
    pass: true,
    expected_sequence: 3,
    candidate_available: false,
    rpc_blocked: thirdBlocked,
  };

  const wrongLineageBlocked = await expectRpcError(context.local, 'financial_create_legacy_reconstruction_entry', {
    p_event_type: 'CARRYOVER', p_project_id: carry2022.id,
    p_destination_project_id: altProjects.destination.id,
    p_funding_entry_id: carryFundingEntryId,
    p_lineage_id: alternateLineageId, p_evidence_id: legacyEvidenceId,
    p_origin_fiscal_year: null, p_fiscal_year: 2022, p_destination_fiscal_year: 2023,
    p_legacy_prior_carryover_count: null, p_amount: amount(ONE_MILLION),
    p_effective_date: '2022-12-31', p_carryover_sequence: 1,
    p_carryover_type: 'MYEONGSI', p_adjustment_type: null,
    p_reason_code: 'TEST_WRONG_LINEAGE', p_memo: 'Expected wrong-lineage rejection',
    p_idempotency_key: stableUuid('negative:wrong-lineage'),
  }, 'Scenario-9 different lineage guard');
  report.scenarios.scenario_9 = {
    pass: true,
    true_lineage_id: trueLineageId,
    different_lineage_id: alternateLineageId,
    rpc_blocked: wrongLineageBlocked,
  };

  const carryAnalytics = await rpc(context.adminA, 'get_financial_funding_analytics', {
    p_fiscal_year: 2022,
    p_sido: region.sido ?? null,
    p_sigungu: region.sigungu ?? null,
  });
  const carryAnalyticsRow = carryAnalytics.find((row) => row.budget_cohort_id === carryCohortId);
  assert(carryAnalyticsRow, 'Scenario-10 source cohort analytics row is missing.');
  assertEqual(carryAnalyticsRow.myeongsi_flow_amount, 30_000_000n, 'Scenario-10 MYEONGSI flow');
  assertEqual(carryAnalyticsRow.sago_flow_amount, 20_000_000n, 'Scenario-10 SAGO flow');
  assertEqual(carryAnalyticsRow.second_sequence_amount, 20_000_000n, 'Scenario-10 second sequence amount');
  assertEqual(carryAnalyticsRow.current_carryover_stock, 30_000_000n, 'Scenario-10 deduplicated carryover stock');
  assert(asBigInt(carryAnalyticsRow.current_carryover_stock) !==
      asBigInt(carryAnalyticsRow.myeongsi_flow_amount) + asBigInt(carryAnalyticsRow.sago_flow_amount),
  'Scenario-10 stock must not be represented as duplicated flow total.');
  report.scenarios.scenario_10 = {
    pass: true,
    myeongsi_flow: '30000000',
    sago_flow: '20000000',
    flow_sum_not_used_as_stock: '50000000',
    current_deduplicated_stock: '30000000',
    second_sequence_amount: '20000000',
  };

  for (const project of projectsByCode.values()) {
    await assertRawProjectUnchanged(
      service,
      rawSnapshots.get(project.id),
      `${project.project_code} final compatibility row`,
    );
  }
  report.raw_compatibility_columns = {
    pass: true,
    unchanged_existing_projects: projectsByCode.size,
    includes_destinations_and_carryover_projects: true,
  };

  const sourceCohortIds = [
    PROJECT_CODES.scenario1Source,
    PROJECT_CODES.scenario2Source,
    PROJECT_CODES.scenario3Source,
    PROJECT_CODES.scenario4Source,
    PROJECT_CODES.scenario5Source,
  ].map((code) => baselines.get(code).cohortId);
  const analytics2025 = await rpc(context.adminA, 'get_financial_funding_analytics', {
    p_fiscal_year: TEST_YEAR,
    p_sido: region.sido ?? null,
    p_sigungu: region.sigungu ?? null,
  });
  const sourceAnalytics = analytics2025.filter((row) => sourceCohortIds.includes(row.budget_cohort_id));
  assertEqual(sourceAnalytics.length, 5, 'All five source cohorts must appear in 2025 analytics');
  assertEqual(sum(sourceAnalytics, 'decrease_flow_amount'), 50_000_000n, 'UAT decrease flow total');
  assertEqual(sum(sourceAnalytics, 'reallocated_amount'), 36_000_000n, 'UAT reallocated total');
  assertEqual(sum(sourceAnalytics, 'returned_amount'), 4_000_000n, 'UAT returned total');
  assertEqual(sum(sourceAnalytics, 'waiting_stock_amount'), 10_000_000n, 'UAT waiting stock total');
  assertEqual(
    sum(sourceAnalytics, 'decrease_flow_amount'),
    sum(sourceAnalytics, 'reallocated_amount')
      + sum(sourceAnalytics, 'returned_amount')
      + sum(sourceAnalytics, 'waiting_stock_amount'),
    'Decrease conservation invariant',
  );

  const allInvariantRows = await rpc(context.adminA, 'get_financial_funding_invariant_check', {
    p_budget_cohort_id: null,
  }, 'Admin funding invariant RPC');
  const requiredInvariantIds = new Set([...sourceCohortIds, carryCohortId]);
  const invariantRows = allInvariantRows.filter((row) => requiredInvariantIds.has(row.cohort_id));
  assertEqual(invariantRows.length, 6, 'Invariant view must cover source and carryover cohorts');
  for (const row of invariantRows) {
    assertEqual(row.cohort_conservation_gap, 0, `Cohort ${row.cohort_id} conservation gap`);
    assertEqual(row.decrease_resolution_gap, 0, `Cohort ${row.cohort_id} decrease resolution gap`);
  }
  report.accounting = {
    decrease_flow: '50000000',
    reallocated: '36000000',
    returned: '4000000',
    waiting_stock: '10000000',
    decrease_resolution_gap: '0',
    cohort_conservation_gap: '0',
  };

  const targetLotIds = [s1Lot10.id, s1Lot2.id, s2Lot.id, s3Lot.id, s4Lot.id, s5Lot.id];
  const crossRegionLots = await selectRows(
    crossLocal.client,
    'financial_unallocated_fund_lots',
    'id',
    (query) => query.in('id', targetLotIds),
    'Cross-region lot RLS read',
  );
  assertEqual(crossRegionLots.length, 0, 'Other-region local user must see zero target lots');
  const [ownRegionInvariant, crossRegionInvariant] = await Promise.all([
    rpc(context.local, 'get_financial_funding_invariant_check', {
      p_budget_cohort_id: s1Baseline.cohortId,
    }, 'Own-region local invariant RPC'),
    rpc(crossLocal.client, 'get_financial_funding_invariant_check', {
      p_budget_cohort_id: s1Baseline.cohortId,
    }, 'Cross-region local invariant RPC'),
  ]);
  assertEqual(ownRegionInvariant.length, 1, 'Own-region local must read its cohort invariant');
  assertEqual(crossRegionInvariant.length, 0, 'Other-region local must not read target cohort invariant');
  const crossHistory = await expectRpcError(crossLocal.client, 'get_financial_project_funding_history', {
    p_project_id: s1.id,
  }, 'Cross-region funding history RLS');
  const crossWrite = await expectRpcError(crossLocal.client, 'financial_create_funding_reallocation_request', {
    p_request_type: 'RETURN_UNALLOCATED',
    p_payload: legacyPayload({
      lot_id: s1Lot10.id, amount: 1n, evidence_id: legacyEvidenceId,
      memo: 'Must be rejected before insert',
    }),
    p_idempotency_key: stableUuid('negative:cross-region-write'),
    p_submit: false,
  }, 'Cross-region funding request RLS');
  const { error: adminDirectDmlError } = await context.adminA
    .from('financial_unallocated_fund_lots')
    // Same-value probe avoids corrupting TEST even if a privilege regression
    // unexpectedly lets the statement reach the immutable-row trigger.
    .update({ reason: s1Lot10.reason })
    .eq('id', s1Lot10.id)
    .select('id');
  assert(adminDirectDmlError, 'Authenticated admin direct lot UPDATE must be blocked.');
  assertEqual(adminDirectDmlError.code, '42501', 'Authenticated admin direct DML privilege error');
  const [servicePositions, serviceCohorts, serviceInvariants] = await Promise.all([
    selectRows(
      service,
      'financial_project_funding_positions',
      'project_id,ledger_adjusted_allocation,ledger_decrease_amount,ledger_execution_amount,ledger_execution_rate,projection_ready',
      (query) => query.eq('project_id', s1.id),
      'Service-role funding position projection read',
    ),
    selectRows(
      service,
      'financial_funding_cohort_execution',
      'cohort_id,initial_allocation,verified_cumulative_execution,execution_rate,waiting_balance',
      (query) => query.eq('cohort_id', s1Baseline.cohortId),
      'Service-role cohort summary read',
    ),
    selectRows(
      service,
      'financial_funding_invariant_check',
      'cohort_id,cohort_conservation_gap,decrease_resolution_gap',
      (query) => query.eq('cohort_id', s1Baseline.cohortId),
      'Service-role invariant view read',
    ),
  ]);
  assertEqual(servicePositions.length, 1, 'Service summary path must read one S1 position');
  assertEqual(servicePositions[0].ledger_decrease_amount, TEN_MILLION,
    'Service summary path latest S1 decrease');
  assertEqual(servicePositions[0].projection_ready, true,
    'Service summary path S1 projection readiness');
  assertEqual(serviceCohorts.length, 1, 'Service analytics path must read one S1 cohort');
  assertEqual(serviceCohorts[0].waiting_balance, TEN_MILLION,
    'Service analytics path S1 waiting stock');
  assertEqual(serviceInvariants.length, 1, 'Service invariant path must read one S1 cohort');
  assertEqual(serviceInvariants[0].cohort_conservation_gap, 0,
    'Service invariant path cohort gap');
  assertEqual(serviceInvariants[0].decrease_resolution_gap, 0,
    'Service invariant path decrease gap');
  const { error: serviceDirectUpdateError } = await service
    .from('financial_unallocated_fund_lots')
    .update({ reason: s1Lot10.reason })
    .eq('id', s1Lot10.id)
    .select('id');
  assert(serviceDirectUpdateError, 'Service-role direct lot UPDATE must be blocked.');
  assertEqual(serviceDirectUpdateError.code, '42501', 'Service-role direct UPDATE privilege error');
  const { error: serviceDirectInsertError } = await service
    .from('financial_unallocated_fund_lots')
    .insert({ id: stableUuid('negative:service-direct-insert') })
    .select('id');
  assert(serviceDirectInsertError, 'Service-role direct lot INSERT must be blocked.');
  assertEqual(serviceDirectInsertError.code, '42501', 'Service-role direct INSERT privilege error');
  const anon = createSupabase(supabaseUrl, anonKey);
  const anonRead = await expectRpcError(anon, 'get_financial_funding_analytics', {
    p_fiscal_year: TEST_YEAR, p_sido: null, p_sigungu: null,
  }, 'Anon analytics RPC');
  report.rls = {
    pass: true,
    local_own_region_select: true,
    local_other_region_rows: 0,
    local_other_region_invariant_rows: 0,
    local_other_region_history_blocked: crossHistory,
    local_other_region_write_blocked: crossWrite,
    admin_a_select_all: true,
    admin_b_select_all: true,
    authenticated_direct_dml_blocked: { blocked: true, code: adminDirectDmlError.code ?? 'DML_ERROR' },
    service_select_summary_and_analytics: true,
    service_direct_update_blocked: { blocked: true, code: serviceDirectUpdateError.code },
    service_direct_insert_blocked: { blocked: true, code: serviceDirectInsertError.code },
    anon_rpc_blocked: anonRead,
  };

  const [localPosition, adminAPosition, adminBPosition] = await Promise.all([
    projectPosition(context.local, s1.id, 'local_b Scenario-1 final position'),
    projectPosition(context.adminA, s1.id, 'admin_a Scenario-1 final position'),
    projectPosition(context.adminB, s1.id, 'admin_b Scenario-1 final position'),
  ]);
  for (const field of [
    'ledger_original_allocation', 'ledger_adjusted_allocation', 'ledger_increase_amount',
    'ledger_decrease_amount', 'ledger_execution_amount', 'ledger_execution_rate',
    'current_wallet_balance', 'unclassified_decrease_amount', 'projection_ready',
  ]) {
    assertEqual(adminAPosition[field], localPosition[field], `local/admin_a ${field}`);
    assertEqual(adminBPosition[field], localPosition[field], `local/admin_b ${field}`);
  }

  const freshLocal = await signIn(supabaseUrl, anonKey, byAlias.local_b.email, byAlias.local_b.password, 'fresh local_b');
  const freshAdminA = await signIn(supabaseUrl, anonKey, byAlias.admin_a.email, byAlias.admin_a.password, 'fresh admin_a');
  const freshAdminB = await signIn(supabaseUrl, anonKey, byAlias.admin_b.email, byAlias.admin_b.password, 'fresh admin_b');
  const [freshLocalPosition, freshAdminAPosition, freshAdminBPosition] = await Promise.all([
    projectPosition(freshLocal.client, s1.id, 'fresh local_b position'),
    projectPosition(freshAdminA.client, s1.id, 'fresh admin_a position'),
    projectPosition(freshAdminB.client, s1.id, 'fresh admin_b position'),
  ]);
  assertEqual(freshLocalPosition.ledger_decrease_amount, TEN_MILLION, 'Fresh local re-entry decrease');
  assertEqual(freshAdminAPosition.ledger_decrease_amount, TEN_MILLION, 'Fresh admin_a re-entry decrease');
  assertEqual(freshAdminBPosition.ledger_decrease_amount, TEN_MILLION, 'Fresh admin_b re-entry decrease');
  assertEqual(freshLocalPosition.projection_ready, true, 'Fresh local projection');
  assertEqual(freshAdminAPosition.projection_ready, true, 'Fresh admin_a projection');
  assertEqual(freshAdminBPosition.projection_ready, true, 'Fresh admin_b projection');
  const freshLots = await rpc(freshAdminA.client, 'get_financial_unallocated_fund_lots', {
    p_fiscal_year: TEST_YEAR,
  });
  assert(freshLots.some((row) => row.lot_id === s1Lot10.id && String(row.remaining_amount) === '8000000'),
    'Fresh re-entry must reload latest lot state.');
  report.reentry = {
    pass: true,
    local_b_latest_value: amount(TEN_MILLION),
    admin_a_latest_value: amount(TEN_MILLION),
    admin_b_latest_value: amount(TEN_MILLION),
    fresh_clients_used: true,
    query_cache_bypassed: true,
  };

  const finalUnclassified = await rpc(freshAdminA.client, 'get_financial_unclassified_decreases');
  assertEqual(finalUnclassified.length, 4, 'Existing unclassified decrease count after all UAT flows');
  assertEqual(
    sum(finalUnclassified, 'unclassified_amount'),
    sum(initialUnclassified, 'unclassified_amount'),
    'Existing unclassified decrease amount must remain unchanged',
  );
  report.scenarios.scenario_11.post_uat_unclassified_count = 4;
  report.scenarios.scenario_11.post_uat_amount_unchanged = true;

  report.status = 'PASS';
  report.completed_at = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
}

const redactions = [];
for (const argument of ['--env-file', '--credentials-file']) {
  const file = readArgument(argument);
  if (file && fs.existsSync(path.resolve(process.cwd(), file))) {
    const parsed = dotenv.parse(fs.readFileSync(path.resolve(process.cwd(), file)));
    redactions.push(...Object.values(parsed).filter(Boolean));
  }
}

function sanitizedError(error) {
  let message = String(error?.message ?? error ?? 'Unknown UAT failure');
  for (const value of redactions.sort((a, b) => b.length - a.length)) {
    if (value.length >= 4) message = message.split(value).join('[REDACTED]');
  }
  message = message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DATABASE_URL]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]');
  return {
    status: 'FAIL',
    stage: error?.stage ?? 'unknown',
    code: error?.code ?? 'UAT_FAILED',
    message,
    secrets_printed: false,
  };
}

main().catch((error) => {
  console.error(JSON.stringify(sanitizedError(error), null, 2));
  process.exitCode = 1;
});
