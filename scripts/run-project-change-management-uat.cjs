#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const ExcelJS = require('exceljs');
let activePg = null;

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }
function equal(actual, expected, message) {
  if (String(actual) !== String(expected)) fail(`${message} (expected=${expected}, actual=${actual})`);
}
function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function has(name) { return process.argv.includes(name); }
function load(file) {
  const resolved = path.resolve(process.cwd(), file ?? '');
  assert(file && fs.existsSync(resolved), `Missing explicit env file: ${file ?? '(none)'}`);
  return dotenv.parse(fs.readFileSync(resolved));
}
function required(env, name) {
  const value = String(env[name] ?? '').trim();
  assert(value, `${name} is required.`);
  return value;
}
function refFromUrl(value) {
  try { return new URL(value).hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i)?.[1] ?? null; } catch { return null; }
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
function client(url, key) {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}
async function signIn(url, anonKey, email, password, alias) {
  const instance = client(url, anonKey);
  const { data, error } = await instance.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user) fail(`${alias} TEST authentication failed.`);
  return { alias, client: instance, token: data.session.access_token, userId: data.user.id, email, password };
}
async function rpc(instance, name, args, label = name) {
  const { data, error } = await instance.rpc(name, args ?? {});
  if (error) fail(`${label}: ${error.message}`);
  return data;
}
async function expectRpcError(instance, name, args, label) {
  const { error } = await instance.rpc(name, args ?? {});
  assert(error, `${label} unexpectedly succeeded.`);
  return error.code ?? 'RPC_ERROR';
}
async function monetarySnapshot(pg) {
  const result = await pg.query(`
    select
      (select md5(string_agg(concat_ws('|', id::text, total_budget::text,
        original_alloc::text, increase_amount::text, decrease_amount::text,
        alloc::text, exec::text, rate::text), E'\\n' order by id)) from public.projects) as projects_money,
      (select concat(count(*)::text, ':', coalesce(sum(initial_allocation), 0)::text)
        from public.project_budget_cohorts) as cohorts,
      (select count(*)::text from public.project_budget_years) as budget_years,
      (select concat(count(*)::text, ':', coalesce(sum(amount), 0)::text)
        from public.project_fund_transfers) as transfers,
      (select concat(count(*)::text, ':', coalesce(sum(amount), 0)::text)
        from public.project_execution_records) as executions,
      (select concat(count(*)::text, ':', coalesce(sum(amount), 0)::text)
        from public.project_carryovers) as carryovers,
      (select concat(count(*)::text, ':', coalesce(sum(amount), 0)::text)
        from public.project_budget_adjustments) as adjustments,
      (select concat(count(*)::text, ':', coalesce(sum(original_amount), 0)::text)
        from public.financial_unallocated_fund_lots) as waiting_funds,
      (select concat(count(*)::text, ':', coalesce(sum(amount), 0)::text)
        from public.financial_unallocated_fund_movements) as waiting_movements,
      (select count(*)::text from public.financial_project_lineages) as lineages,
      (select count(*)::text from public.financial_project_lineage_members) as lineage_members
  `);
  return result.rows[0];
}
function displayName(project) {
  return project.detail_project_name?.trim() || project.fund_project_name?.trim() || project.project_name?.trim() || '';
}
async function getProfile(account) {
  const { data, error } = await account.client.from('profiles').select('id,role,region_id').eq('id', account.userId).single();
  if (error || !data) fail(`${account.alias} profile lookup failed.`);
  account.profile = data;
  return account;
}
async function queryRows(instance, table, columns, configure, label) {
  let query = instance.from(table).select(columns);
  if (configure) query = configure(query);
  const { data, error } = await query;
  if (error) fail(`${label}: ${error.message}`);
  return data ?? [];
}
function metadataArgs(project, relatedProjects, classification, name, change = {}) {
  return {
    p_project_id: project.id,
    p_detail_project_name: name,
    p_project_period: project.project_period,
    p_project_start_year: project.project_start_year,
    p_status: project.status,
    p_related_projects: relatedProjects,
    p_primary_small_category_id: classification.primary,
    p_related_small_category_ids: classification.related,
    p_business_type: project.business_type,
    p_change_basis_code: change.basis ?? null,
    p_other_basis: change.otherBasis ?? null,
    p_change_reason_codes: change.reasons ?? [],
    p_other_reason: change.otherReason ?? null,
    p_change_detail: change.detail ?? null,
    p_similarity_candidate: change.similarity ?? false,
    p_save_mode: 'SAVE',
  };
}
async function filteredEventCount(service, filters) {
  let regionIds = null;
  if (filters.sido || filters.sigungu) {
    let regions = service.from('regions').select('id');
    if (filters.sido) regions = regions.eq('sido', filters.sido);
    if (filters.sigungu) regions = regions.eq('sigungu', filters.sigungu);
    const result = await regions;
    if (result.error) fail(`Export region count: ${result.error.message}`);
    regionIds = (result.data ?? []).map((row) => row.id);
    if (regionIds.length === 0) return 0;
  }
  let query = service.from('project_change_events').select('id', { count: 'exact', head: true });
  if (regionIds) query = query.in('region_id', regionIds);
  if (filters.year) query = query.eq('fiscal_year', filters.year);
  if (filters.basisCode) query = query.eq('change_basis_code', filters.basisCode);
  if (filters.reasonCode) query = query.contains('change_reason_codes', [filters.reasonCode]);
  const { count, error } = await query;
  if (error) fail(`Export independent count: ${error.message}`);
  return count ?? 0;
}
async function verifyExport(baseUrl, admin, service, filters, expectedSheets = true) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== null) params.set(key, String(value));
  const response = await fetch(`${baseUrl}/api/admin/project-changes/export?${params}`, {
    headers: { Authorization: `Bearer ${admin.token}` },
  });
  assert(response.ok, `XLSX export failed with HTTP ${response.status}.`);
  assert((response.headers.get('content-type') ?? '').includes('spreadsheetml'), 'XLSX content type is missing.');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  if (expectedSheets) equal(workbook.worksheets.map((sheet) => sheet.name).join('|'), '사업변경 이력|유사사업 연계|소분류 제안·처리', 'XLSX sheet names');
  const first = workbook.getWorksheet('사업변경 이력');
  assert(first, 'XLSX project-change sheet is missing.');
  const expected = await filteredEventCount(service, filters);
  equal(first.actualRowCount - 1, expected, 'Filtered screen/query and XLSX row counts');
  equal(response.headers.get('x-export-row-count'), expected, 'XLSX response row count');
  const headers = first.getRow(1).values.slice(1).map(String);
  for (const requiredHeader of ['변경 전 사업명', '변경 후 사업명', '변경 사유', '유사사업명', '유사사업 사업코드', '재정 영향']) {
    assert(headers.includes(requiredHeader), `XLSX header is missing: ${requiredHeader}`);
  }
  const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
  first.eachRow((row) => assert(!uuid.test(row.values.slice(1).map(String).join('|')), 'XLSX contains an unnecessary UUID.'));
  return expected;
}

async function main() {
  assert(has('--confirm-test-write'), 'UAT requires --confirm-test-write.');
  const env = load(arg('--env-file'));
  const credentials = load(arg('--credentials-file'));
  const baseUrl = arg('--base-url')?.replace(/\/$/, '') ?? null;
  const testRef = required(env, 'TEST_PROJECT_REF');
  const prodRef = required(env, 'PROD_PROJECT_REF');
  const supabaseUrl = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const serviceKey = required(env, 'TEST_SUPABASE_SERVICE_ROLE_KEY');
  const databaseUrl = required(env, 'TEST_DATABASE_URL');
  assert(String(env.TARGET_ENV).toUpperCase() === 'TEST'
    && testRef === 'reviewtestxxxxxxxxxx' && testRef !== prodRef
    && refFromUrl(supabaseUrl) === testRef && refFromDatabaseUrl(databaseUrl) === testRef,
  'Fail-closed TEST target gate rejected configuration.');

  const service = client(supabaseUrl, serviceKey);
  const pg = new Client({ connectionString: databaseConnectionString(databaseUrl), ssl: { rejectUnauthorized: false }, application_name: 'project-change-uat' });
  activePg = pg;
  await pg.connect();
  const beforeMoney = await monetarySnapshot(pg);
  process.stdout.write(`${JSON.stringify({ stage: 'monetary-snapshot-before', ok: true })}\n`);

  const configuredAccounts = [
    { alias: 'admin_a', email: 'UAT_ADMIN_A_EMAIL', password: 'UAT_ADMIN_A_PASSWORD' },
    { alias: 'admin_b', email: 'UAT_ADMIN_B_EMAIL', password: 'UAT_ADMIN_B_PASSWORD' },
    { alias: 'local_a', email: 'UAT_LOCAL_A_EMAIL', password: 'UAT_LOCAL_A_PASSWORD' },
    { alias: 'local_b', email: 'UAT_LOCAL_B_EMAIL', password: 'UAT_LOCAL_B_PASSWORD' },
    { alias: 'local_c', email: 'UAT_LOCAL_C_EMAIL', password: 'UAT_LOCAL_C_PASSWORD' },
  ];
  const authenticationAttempts = await Promise.allSettled(configuredAccounts.map((account) => signIn(
    supabaseUrl,
    anonKey,
    required(credentials, account.email),
    required(credentials, account.password),
    account.alias,
  )));
  const authenticationFailures = authenticationAttempts.flatMap((attempt, index) =>
    attempt.status === 'rejected' ? [configuredAccounts[index].alias] : []);
  const authenticatedAccounts = authenticationAttempts.flatMap((attempt) =>
    attempt.status === 'fulfilled' ? [attempt.value] : []);
  const profileAttempts = await Promise.allSettled(authenticatedAccounts.map(getProfile));
  const profileFailures = profileAttempts.flatMap((attempt, index) =>
    attempt.status === 'rejected' ? [authenticatedAccounts[index].alias] : []);
  const accounts = profileAttempts.flatMap((attempt) => attempt.status === 'fulfilled' ? [attempt.value] : []);
  process.stdout.write(`${JSON.stringify({
    stage: 'authentication',
    ok: true,
    configured: configuredAccounts.length,
    authenticated: authenticatedAccounts.length,
    profiled: accounts.length,
    authentication_failures: authenticationFailures,
    profile_failures: profileFailures,
  })}\n`);
  const admins = accounts.filter((account) => account.profile.role === 'admin');
  const admin = admins.find((account) => account.alias === 'admin_b');
  const adminPeer = admins.find((account) => account.alias === 'admin_a');
  const locals = accounts.filter((account) => account.profile.role === 'local_user' && account.profile.region_id);
  assert(admin && adminPeer && locals.length >= 2, 'Two authenticated admins and two local TEST regions are required.');

  if (has('--export-only')) {
    assert(baseUrl, '--export-only requires --base-url.');
    const { data: sample, error: sampleError } = await service
      .from('project_change_events')
      .select('fiscal_year,region_id,change_basis_code,change_reason_codes')
      .not('change_basis_code', 'is', null)
      .order('changed_at', { ascending: false })
      .limit(1)
      .single();
    if (sampleError || !sample) fail(`Export filter sample lookup failed: ${sampleError?.message ?? 'missing row'}`);
    assert(sample.fiscal_year && sample.region_id && sample.change_basis_code && sample.change_reason_codes?.[0], 'Export filter sample is incomplete.');
    const { data: region, error: regionError } = await service
      .from('regions')
      .select('sido,sigungu')
      .eq('id', sample.region_id)
      .single();
    if (regionError || !region) fail(`Export region lookup failed: ${regionError?.message ?? 'missing region'}`);
    const exportCounts = {
      all: await verifyExport(baseUrl, admin, service, {}),
      year: await verifyExport(baseUrl, admin, service, { year: sample.fiscal_year }),
      region: await verifyExport(baseUrl, admin, service, { sido: region.sido, sigungu: region.sigungu }),
      basis: await verifyExport(baseUrl, admin, service, { basisCode: sample.change_basis_code }),
      reason: await verifyExport(baseUrl, admin, service, { reasonCode: sample.change_reason_codes[0] }),
    };
    const afterMoney = await monetarySnapshot(pg);
    if (JSON.stringify(afterMoney) !== JSON.stringify(beforeMoney)) fail('XLSX 검증 중 금액 데이터가 변경되었습니다.');
    await pg.end();
    activePg = null;
    process.stdout.write(`${JSON.stringify({
      ok: true,
      target: 'TEST',
      mode: 'export-only',
      authenticated_roles: { admin_accounts: admins.length, local_accounts: locals.length },
      account_diagnostics: { authentication_failures: authenticationFailures, profile_failures: profileFailures },
      export: { base_url: baseUrl, filtered_row_counts: exportCounts, sheets: 3, uuid_leak: false },
      monetary_integrity: { exact_fingerprint_match: true },
    }, null, 2)}\n`);
    return;
  }

  let owner = null;
  let project = null;
  for (const local of locals) {
    const candidates = await queryRows(service, 'projects', '*', (query) => query
      .eq('region_id', local.profile.region_id)
      .not('primary_small_category_id', 'is', null)
      .not('detail_project_name', 'is', null)
      .not('project_period', 'is', null)
      .not('project_start_year', 'is', null)
      .in('status', ['정상추진', '지연', '완료', '추진곤란'])
      .in('business_type', ['HW', 'SW', 'COMPOSITE'])
      .limit(100), `${local.alias} fixture candidates`);
    const valid = candidates.find((item) => displayName(item).length >= 2
      && item.project_period.trim().length >= 2 && item.project_start_year <= item.year);
    if (valid) { owner = local; project = valid; break; }
  }
  assert(owner && project, 'No local TEST project has a restorable representative classification fixture.');
  const cross = locals.find((account) => account.profile.region_id !== owner.profile.region_id);
  assert(cross, 'No different-region local TEST account is available.');
  process.stdout.write(`${JSON.stringify({ stage: 'fixture-selection', ok: true, account_alias: owner.alias, project_code: project.project_code })}\n`);

  const [categories, originalRelatedRows, relatedProjects, regionRows] = await Promise.all([
    queryRows(service, 'small_categories', 'id,name,large_category_id,middle_category_id', null, 'category master'),
    queryRows(service, 'project_related_small_categories', 'small_category_id', (query) => query.eq('project_id', project.id), 'original related categories'),
    queryRows(service, 'project_related_projects', 'project_name,total_budget,regional_fund_alloc,local_fund_alloc', (query) => query.eq('project_id', project.id), 'related projects'),
    queryRows(service, 'regions', 'sido,sigungu,display_name', (query) => query.eq('id', project.region_id), 'project region'),
  ]);
  const originalPrimary = categories.find((item) => item.id === project.primary_small_category_id);
  assert(originalPrimary, 'Fixture representative category is missing from master.');
  const newPrimary = categories.find((item) => item.large_category_id !== originalPrimary.large_category_id);
  assert(newPrimary, 'A cross-large-category UAT candidate is unavailable.');
  const sameMiddlePartner = categories.find((item) => item.id !== newPrimary.id && item.middle_category_id === newPrimary.middle_category_id);
  assert(sameMiddlePartner, 'A same-middle related-category UAT candidate is unavailable.');
  const originalName = displayName(project);
  const originalClassification = { primary: originalPrimary.id, related: originalRelatedRows.map((row) => row.small_category_id) };
  const sameParentClassification = { primary: newPrimary.id, related: [sameMiddlePartner.id] };
  const crossParentClassification = { primary: newPrimary.id, related: [sameMiddlePartner.id, originalPrimary.id] };
  const originalRelatedProjects = relatedProjects.map((item) => ({
    project_name: item.project_name,
    total_budget: String(item.total_budget),
    regional_fund_alloc: String(item.regional_fund_alloc),
    local_fund_alloc: String(item.local_fund_alloc),
  }));
  const invalidName = `${originalName} UAT 검증`;

  const invalidCodes = [];
  invalidCodes.push(await expectRpcError(owner.client, 'update_my_project_metadata_v2', metadataArgs(project, originalRelatedProjects, originalClassification, invalidName, { reasons: ['CONTENT_CHANGE'] }), '변경근거 미선택'));
  invalidCodes.push(await expectRpcError(owner.client, 'update_my_project_metadata_v2', metadataArgs(project, originalRelatedProjects, originalClassification, invalidName, { basis: 'OTHER', reasons: ['CONTENT_CHANGE'] }), '기타근거 미입력'));
  invalidCodes.push(await expectRpcError(owner.client, 'update_my_project_metadata_v2', metadataArgs(project, originalRelatedProjects, originalClassification, invalidName, { basis: 'LOCAL_NOTICE', reasons: [] }), '변경사유 미선택'));
  invalidCodes.push(await expectRpcError(owner.client, 'update_my_project_metadata_v2', metadataArgs(project, originalRelatedProjects, originalClassification, invalidName, { basis: 'LOCAL_NOTICE', reasons: ['OTHER'] }), '기타사유 미입력'));
  process.stdout.write(`${JSON.stringify({ stage: 'name-validation', ok: true, blocked: invalidCodes.length })}\n`);

  await rpc(owner.client, 'update_my_project_metadata_v2', metadataArgs(project, originalRelatedProjects, sameParentClassification, originalName), '대표 분류 변경');
  const suffix = Date.now().toString(36);
  const approvedProposalName = `UAT 복합지원 ${suffix}`;
  const approveProposalId = await rpc(owner.client, 'submit_project_small_category_proposal', {
    p_project_id: project.id, p_proposed_name: approvedProposalName, p_proposal_reason: '동일 중분류 추천과 신규 승인 절차 검증',
  }, '승인용 제안');
  const duplicateProposalCode = await expectRpcError(owner.client, 'submit_project_small_category_proposal', {
    p_project_id: project.id, p_proposed_name: approvedProposalName, p_proposal_reason: '중복 제출 차단 검증',
  }, '동일 제안 중복 제출');
  const approveProposal = (await queryRows(service, 'project_small_category_proposals', '*', (query) => query.eq('id', approveProposalId), '승인용 제안 조회'))[0];
  equal(approveProposal.recommended_middle_category_id, newPrimary.middle_category_id, '동일 parent 추천 중분류');
  equal(approveProposal.middle_category_review_required, false, '동일 parent 확인필요');
  await expectRpcError(admin.client, 'review_project_small_category_proposal', { p_proposal_id: approveProposalId, p_action: 'APPROVE', p_middle_category_id: null, p_existing_small_category_id: null, p_rejection_reason: null }, '중분류 없는 승인');
  await rpc(admin.client, 'review_project_small_category_proposal', { p_proposal_id: approveProposalId, p_action: 'APPROVE', p_middle_category_id: newPrimary.middle_category_id, p_existing_small_category_id: null, p_rejection_reason: null }, '신규 소분류 승인');
  const terminalGuardCodes = [await expectRpcError(admin.client, 'review_project_small_category_proposal', {
    p_proposal_id: approveProposalId, p_action: 'REJECT', p_middle_category_id: null,
    p_existing_small_category_id: null, p_rejection_reason: '종결 상태 재처리 차단',
  }, '승인완료 제안 재처리')];
  process.stdout.write(`${JSON.stringify({ stage: 'proposal-approval', ok: true })}\n`);

  const targets = await queryRows(service, 'projects', 'id,project_code,project_name,fund_project_name,detail_project_name,year', (query) => query.eq('region_id', project.region_id).neq('id', project.id).limit(100), '유사사업 대상');
  let target = null;
  let targetName = '';
  let candidates = [];
  let exactCandidate = null;
  for (const candidateTarget of targets.filter((item) => displayName(item).length >= 2)) {
    const candidateName = displayName(candidateTarget);
    const candidateRows = await rpc(owner.client, 'get_project_similarity_candidates', {
      p_project_id: project.id, p_new_name: candidateName, p_limit: 5,
    }, '유사사업 후보');
    const exact = candidateRows.find((item) => item.candidate_project_id === candidateTarget.id);
    if (exact && Number(exact.similarity_score) > 0.99 && exact.should_prompt) {
      target = candidateTarget;
      targetName = candidateName;
      candidates = candidateRows;
      exactCandidate = exact;
      break;
    }
  }
  assert(target, 'No unused same-region similarity target is available.');
  assert(exactCandidate && Number(exactCandidate.similarity_score) > 0.99 && exactCandidate.should_prompt, '동일명 유사사업 후보가 탐지되지 않았습니다.');
  await rpc(owner.client, 'record_project_similarity_decision', { p_project_id: project.id, p_source_project_name: targetName, p_candidate_set_hash: exactCandidate.candidate_set_hash, p_candidate_project_id: target.id, p_similarity: exactCandidate.similarity_score, p_relationship_type: 'SAME_LOGICAL_PROJECT', p_decision_note: 'TEST UAT' });
  await rpc(owner.client, 'record_project_similarity_decision', { p_project_id: project.id, p_source_project_name: `${targetName} 하위`, p_candidate_set_hash: `${exactCandidate.candidate_set_hash}-sub`, p_candidate_project_id: target.id, p_similarity: exactCandidate.similarity_score, p_relationship_type: 'SUBPROJECT', p_decision_note: 'TEST UAT' });
  await rpc(owner.client, 'record_project_similarity_decision', { p_project_id: project.id, p_source_project_name: `${targetName} 별도`, p_candidate_set_hash: `${exactCandidate.candidate_set_hash}-separate`, p_candidate_project_id: null, p_similarity: null, p_relationship_type: 'SEPARATE', p_decision_note: 'TEST UAT' });
  await rpc(owner.client, 'record_project_similarity_decision', { p_project_id: project.id, p_source_project_name: `${targetName} 보류`, p_candidate_set_hash: `${exactCandidate.candidate_set_hash}-later`, p_candidate_project_id: null, p_similarity: null, p_relationship_type: 'UNDECIDED', p_decision_note: 'TEST UAT' });

  await rpc(owner.client, 'update_my_project_metadata_v2', metadataArgs(project, originalRelatedProjects, crossParentClassification, targetName, { basis: 'LOCAL_NOTICE', reasons: ['CONTENT_CHANGE'], detail: '유사사업과 분류 변경 이력 UAT', similarity: true }), '지자체 통보 변경');
  const repeatCandidates = await rpc(owner.client, 'get_project_similarity_candidates', { p_project_id: project.id, p_new_name: targetName, p_limit: 5 }, '유사사업 반복정책');
  assert(repeatCandidates.length > 0 && repeatCandidates.every((item) => item.should_prompt === false), '이미 판단한 동일 후보집합이 반복 표시됩니다.');
  process.stdout.write(`${JSON.stringify({ stage: 'similarity', ok: true, candidates: candidates.length })}\n`);

  const mappedProposalId = await rpc(owner.client, 'submit_project_small_category_proposal', { p_project_id: project.id, p_proposed_name: `UAT 매핑 ${suffix}`, p_proposal_reason: '서로 다른 중분류로 인한 관리자 확인 검증' });
  const rejectedProposalId = await rpc(owner.client, 'submit_project_small_category_proposal', { p_project_id: project.id, p_proposed_name: `UAT 반려 ${suffix}`, p_proposal_reason: '반려 사유 및 감사이력 저장 검증' });
  const ambiguous = (await queryRows(service, 'project_small_category_proposals', '*', (query) => query.eq('id', mappedProposalId), '중분류 확인필요 제안'))[0];
  equal(ambiguous.recommended_middle_category_id, null, '복수 parent 추천 중분류');
  equal(ambiguous.middle_category_review_required, true, '복수 parent 확인필요');
  await rpc(admin.client, 'review_project_small_category_proposal', { p_proposal_id: mappedProposalId, p_action: 'MAP', p_middle_category_id: null, p_existing_small_category_id: originalPrimary.id, p_rejection_reason: null }, '기존 분류 매핑');
  await rpc(admin.client, 'review_project_small_category_proposal', { p_proposal_id: rejectedProposalId, p_action: 'REJECT', p_middle_category_id: null, p_existing_small_category_id: null, p_rejection_reason: 'TEST UAT 제안 반려' }, '제안 반려');
  terminalGuardCodes.push(await expectRpcError(admin.client, 'review_project_small_category_proposal', {
    p_proposal_id: mappedProposalId, p_action: 'MAP', p_middle_category_id: null,
    p_existing_small_category_id: originalPrimary.id, p_rejection_reason: null,
  }, '매핑완료 제안 재처리'));
  terminalGuardCodes.push(await expectRpcError(admin.client, 'review_project_small_category_proposal', {
    p_proposal_id: rejectedProposalId, p_action: 'REJECT', p_middle_category_id: null,
    p_existing_small_category_id: null, p_rejection_reason: '재반려 차단',
  }, '반려완료 제안 재처리'));
  process.stdout.write(`${JSON.stringify({ stage: 'proposal-map-reject', ok: true })}\n`);

  const name2 = `${targetName} 조정`;
  await rpc(owner.client, 'update_my_project_metadata_v2', metadataArgs(project, originalRelatedProjects, crossParentClassification, name2, { basis: 'FUND_REVIEW_APPROVAL', reasons: ['BUDGET_ADJUSTMENT', 'SUBPROJECT_ADJUSTMENT'], detail: '복수 변경사유 UAT' }), '기금심의 변경');
  const name3 = `${targetName} 대체`;
  await rpc(owner.client, 'update_my_project_metadata_v2', metadataArgs(project, originalRelatedProjects, crossParentClassification, name3, { basis: 'OTHER', otherBasis: '공문 재확인', reasons: ['UNDERPERFORMING_REPLACEMENT'], detail: '기타 근거 UAT' }), '기타근거 변경');
  const name4 = `${targetName} 기타`;
  await rpc(owner.client, 'update_my_project_metadata_v2', metadataArgs(project, originalRelatedProjects, crossParentClassification, name4, { basis: 'LOCAL_NOTICE', reasons: ['OTHER'], otherReason: '지역 요청사항 반영', detail: '기타 사유 UAT' }), '기타사유 변경');
  process.stdout.write(`${JSON.stringify({ stage: 'valid-name-changes', ok: true })}\n`);

  const eventRows = await queryRows(owner.client, 'project_change_events', '*', (query) => query.eq('project_id', project.id).order('changed_at', { ascending: false }), '지자체 변경이력');
  assert(eventRows.some((event) => event.new_name === name2 && event.change_reason_codes.length === 2), '복수 변경사유 이력이 없습니다.');
  assert(eventRows.every((event) => Number(event.monetary_impact) === 0), '메타데이터 변경이력의 재정영향이 0이 아닙니다.');
  const adminEvents = await queryRows(admin.client, 'project_change_events', 'id,new_name,change_reason_codes', (query) => query.eq('project_id', project.id), '관리자 변경이력');
  assert(adminEvents.length === eventRows.length, '지자체/관리자 변경이력이 일치하지 않습니다.');
  const [adminPeerEvents, adminPeerProposals] = await Promise.all([
    queryRows(adminPeer.client, 'project_change_events', 'id', (query) => query.eq('project_id', project.id), '관리자 A 변경이력'),
    queryRows(adminPeer.client, 'project_small_category_proposals', 'id,status', (query) => query.in('id', [approveProposalId, mappedProposalId, rejectedProposalId]), '관리자 A 제안 처리결과'),
  ]);
  assert(adminPeerEvents.length === eventRows.length, '관리자 A/B 변경이력이 일치하지 않습니다.');
  equal(adminPeerProposals.length, 3, '관리자 A/B 제안 처리결과 가시성');
  const crossEvents = await queryRows(cross.client, 'project_change_events', 'id', (query) => query.eq('project_id', project.id), '타지역 변경이력');
  equal(crossEvents.length, 0, '타지역 변경이력 RLS');
  await expectRpcError(cross.client, 'update_my_project_metadata_v2', metadataArgs(project, originalRelatedProjects, crossParentClassification, `${name4} 차단`, { basis: 'LOCAL_NOTICE', reasons: ['CONTENT_CHANGE'] }), '타지역 쓰기 RLS');
  const crossProposals = await queryRows(cross.client, 'project_small_category_proposals', 'id', (query) => query.in('id', [approveProposalId, mappedProposalId, rejectedProposalId]), '타지역 제안 RLS');
  equal(crossProposals.length, 0, '타지역 제안 RLS');
  const { error: directWriteError } = await owner.client.from('project_small_category_proposals').update({ proposal_reason: 'blocked' }).eq('id', mappedProposalId);
  assert(directWriteError, '인증 사용자의 제안 테이블 직접 쓰기가 차단되지 않았습니다.');
  const anon = client(supabaseUrl, anonKey);
  const { error: anonError } = await anon.from('project_change_events').select('id').limit(1);
  assert(anonError, '비인증 변경이력 조회가 차단되지 않았습니다.');
  process.stdout.write(`${JSON.stringify({ stage: 'rls-and-history', ok: true })}\n`);

  const officialRows = await queryRows(admin.client, 'project_primary_classification_statistics', 'project_id,primary_small_category_id,alloc,exec', (query) => query.eq('project_id', project.id), '공식 분류 통계');
  equal(officialRows.length, 1, '사업당 공식 분류 행');
  equal(officialRows[0].primary_small_category_id, newPrimary.id, '공식 대표 소분류');
  const relatedNow = await queryRows(owner.client, 'project_related_small_categories', 'small_category_id', (query) => query.eq('project_id', project.id), '관련 소분류');
  equal(relatedNow.length, 2, '관련 소분류 복수 선택');

  const auditRows = await queryRows(service, 'audit_logs', 'action', (query) => query.eq('project_id', project.id).in('action', ['UPDATE_PROJECT_METADATA', 'REVIEW_SIMILAR_PROJECT', 'SUBMIT_SMALL_CATEGORY_PROPOSAL', 'REVIEW_SMALL_CATEGORY_PROPOSAL']), '감사이력');
  for (const action of ['UPDATE_PROJECT_METADATA', 'REVIEW_SIMILAR_PROJECT', 'SUBMIT_SMALL_CATEGORY_PROPOSAL', 'REVIEW_SMALL_CATEGORY_PROPOSAL']) {
    assert(auditRows.some((row) => row.action === action), `Missing audit action: ${action}`);
  }

  await rpc(owner.client, 'update_my_project_metadata_v2', metadataArgs(project, originalRelatedProjects, originalClassification, originalName, { basis: 'LOCAL_NOTICE', reasons: ['CONTENT_CHANGE'], detail: 'TEST UAT 원상복구' }), 'UAT 메타데이터 원상복구');
  const restored = (await queryRows(service, 'projects', 'detail_project_name,primary_small_category_id,business_type,status,project_period,project_start_year', (query) => query.eq('id', project.id), '원상복구 확인'))[0];
  equal(restored.detail_project_name, project.detail_project_name, '사업명 원상복구');
  equal(restored.primary_small_category_id, originalPrimary.id, '대표 소분류 원상복구');
  process.stdout.write(`${JSON.stringify({ stage: 'fixture-restored', ok: true })}\n`);

  const freshOwner = await signIn(supabaseUrl, anonKey, owner.email, owner.password, 'fresh_owner');
  const freshAdmin = await signIn(supabaseUrl, anonKey, admin.email, admin.password, 'fresh_admin');
  const [freshLocalRows, freshAdminRows] = await Promise.all([
    queryRows(freshOwner.client, 'project_change_events', 'id,new_name', (query) => query.eq('project_id', project.id), '재접속 지자체 이력'),
    queryRows(freshAdmin.client, 'project_change_events', 'id,new_name', (query) => query.eq('project_id', project.id), '재접속 관리자 이력'),
  ]);
  equal(freshLocalRows.length, freshAdminRows.length, '재접속 지자체/관리자 일치');

  const afterMoney = await monetarySnapshot(pg);
  if (JSON.stringify(afterMoney) !== JSON.stringify(beforeMoney)) fail('사업변경 UAT가 금액·재원잔액·이동·이월·연계관계를 변경했습니다.');

  let exportCounts = null;
  if (baseUrl) {
    const region = regionRows[0];
    exportCounts = {
      all: await verifyExport(baseUrl, freshAdmin, service, {}),
      year: await verifyExport(baseUrl, freshAdmin, service, { year: project.year }),
      region: await verifyExport(baseUrl, freshAdmin, service, { sido: region.sido, sigungu: region.sigungu }),
      basis: await verifyExport(baseUrl, freshAdmin, service, { basisCode: 'LOCAL_NOTICE' }),
      reason: await verifyExport(baseUrl, freshAdmin, service, { reasonCode: 'BUDGET_ADJUSTMENT' }),
    };
  }

  await pg.end();
  activePg = null;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    target: 'TEST',
    authenticated_roles: { admin_accounts: admins.length, local_accounts: locals.length, failed_local_accounts: 3 - locals.length, cross_region_local: true },
    account_diagnostics: { authentication_failures: authenticationFailures, profile_failures: profileFailures },
    fixture: { account_alias: owner.alias, project_code: project.project_code, fiscal_year: project.year },
    name_validation: { invalid_cases_blocked: invalidCodes.length, valid_basis_cases: 3, valid_reason_cases: 5, multiple_reasons: true },
    classification: { representative_count: 1, related_count: 2, cross_middle_selection: true, official_rows_per_project: 1 },
    proposals: { submitted: 3, reviewed_by: admin.alias, approved: 1, mapped: 1, rejected: 1, duplicate_submission_blocked: Boolean(duplicateProposalCode), terminal_reprocess_blocked: terminalGuardCodes.length === 3, same_parent_recommended: true, ambiguous_parent_review_required: true, admin_a_b_visibility_same: true },
    similarity: { candidates_detected: candidates.length, exact_candidate: true, same_logical: true, subproject: true, separate: true, undecided: true, repeat_suppressed: true, automatic_merge: false, automatic_verified_lineage: false },
    history: { local_admin_same: true, fresh_read_same: true, multiple_reason_array: true, monetary_impact: '0' },
    rls: { cross_region_read_rows: 0, cross_region_write_blocked: true, direct_dml_blocked: true, anon_blocked: true },
    monetary_integrity: { metadata_gap: '0', classification_gap: '0', ledger_gap: '0', exact_fingerprint_match: true },
    export: baseUrl ? { base_url: baseUrl, filtered_row_counts: exportCounts, sheets: 3, uuid_leak: false } : { skipped: true },
    fixture_restored: true,
  }, null, 2)}\n`);
}

main().catch(async (error) => {
  if (activePg) {
    await activePg.end().catch(() => undefined);
    activePg = null;
  }
  const envFile = arg('--env-file');
  const credentialFile = arg('--credentials-file');
  const secrets = [];
  for (const file of [envFile, credentialFile]) {
    try { secrets.push(...Object.values(load(file))); } catch { /* best effort */ }
  }
  let message = String(error?.message ?? error);
  for (const secret of secrets.sort((a, b) => b.length - a.length)) {
    if (String(secret).length >= 4) message = message.split(String(secret)).join('[redacted]');
  }
  message = message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted-database-url]').replace(/eyJ[A-Za-z0-9_.-]+/g, '[redacted-token]');
  process.stderr.write(`${JSON.stringify({ ok: false, target: 'TEST', message, secrets_printed: false }, null, 2)}\n`);
  process.exitCode = 1;
});
