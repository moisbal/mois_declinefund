#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

const TEST_REF = 'reviewtestxxxxxxxxxx';

function fail(message) { throw new Error(message); }
function load(file) {
  const resolved = path.resolve(process.cwd(), file ?? '');
  if (!file || !fs.existsSync(resolved)) fail(`Missing explicit TEST env file: ${file ?? '(none)'}`);
  return dotenv.parse(fs.readFileSync(resolved));
}
function required(values, key) {
  const value = String(values[key] ?? '').trim();
  if (!value) fail(`${key} is required.`);
  return value;
}
function refFromUrl(value) {
  try { return new URL(value).hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i)?.[1] ?? null; } catch { return null; }
}
function amount(value) {
  const text = String(value ?? '0');
  return /^-?\d+$/.test(text) ? BigInt(text) : 0n;
}
function statusCounts(rows) {
  return rows.reduce((result, row) => {
    const key = String(row.status ?? 'UNKNOWN');
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {});
}
function resultData(result, label) {
  if (result.error) fail(`${label} failed: ${result.error.code ?? ''} ${result.error.message ?? ''}`.trim());
  return result.data ?? [];
}

async function inspectAccount(alias, emailKey, passwordKey, values, url, key) {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const login = await client.auth.signInWithPassword({ email: required(values, emailKey), password: required(values, passwordKey) });
  if (login.error || !login.data.user) fail(`${alias} TEST authentication failed.`);
  const profile = resultData(await client.from('profiles').select('role,region_id,region_name').eq('id', login.data.user.id).single(), `${alias} profile`);
  if (profile.role !== 'local_user' || !profile.region_id) fail(`${alias} is not a region-scoped local user.`);
  const [projectsResult, positionsResult, assignmentsResult, relatedAssignmentsResult, proposalsResult,
    budgetResult, newProjectResult, pendingResult, linkResult, crossRegionResult] = await Promise.all([
    client.from('projects').select(`
      id,region_id,project_code,year,project_name,fund_project_name,detail_project_name,
      project_period,period,project_start_year,project_end_year,status,business_type,
      large_category_id,middle_category_id,primary_small_category_id,
      original_alloc_text:original_alloc::text,alloc_text:alloc::text,exec_text:exec::text
    `, { count: 'exact' }).eq('region_id', profile.region_id).not('project_code', 'is', null),
    client.rpc('get_financial_project_funding_positions', { p_project_id: null }),
    client.from('project_small_categories').select('project_id,small_category_id'),
    client.from('project_related_small_categories').select('project_id,small_category_id'),
    client.from('project_small_category_proposals').select('project_id,status').in('status', ['DRAFT', 'SUBMITTED', 'PENDING']),
    client.rpc('get_financial_budget_change_requests', { p_project_id: null, p_status: null, p_year: null, p_region_id: profile.region_id }),
    client.rpc('get_financial_new_project_requests', { p_status: null }),
    client.rpc('get_financial_pending_new_project_funds', { p_status: null, p_year: null, p_region_id: profile.region_id }),
    client.rpc('get_financial_pending_new_project_link_requests', { p_status: null }),
    client.from('projects').select('id', { count: 'exact', head: true }).neq('region_id', profile.region_id),
  ]);
  const projects = resultData(projectsResult, `${alias} projects`);
  const positions = resultData(positionsResult, `${alias} positions`);
  const assignments = [
    ...resultData(assignmentsResult, `${alias} small assignments`),
    ...resultData(relatedAssignmentsResult, `${alias} related small assignments`),
  ];
  const proposals = resultData(proposalsResult, `${alias} proposals`);
  const budgets = resultData(budgetResult, `${alias} budget requests`);
  const newProjects = resultData(newProjectResult, `${alias} new project requests`);
  const pending = resultData(pendingResult, `${alias} pending funds`);
  const links = resultData(linkResult, `${alias} link requests`);
  if (crossRegionResult.error) fail(`${alias} cross-region RLS check failed.`);
  if ((crossRegionResult.count ?? 0) !== 0 || projects.some((row) => row.region_id !== profile.region_id)) {
    fail(`${alias} can read another region's projects.`);
  }
  const positionMap = new Map(positions.map((row) => [String(row.project_id), row]));
  const smallByProject = new Map();
  for (const row of assignments) {
    const list = smallByProject.get(row.project_id) ?? new Set();
    list.add(row.small_category_id);
    smallByProject.set(row.project_id, list);
  }
  const proposalIds = new Set(proposals.map((row) => row.project_id));
  let original = 0n;
  let adjusted = 0n;
  let execution = 0n;
  let missing = 0;
  let rawProjectColumnsMissing = 0;
  let delayed = 0;
  let fundingMissing = 0;
  for (const project of projects) {
    const position = positionMap.get(project.id);
    const ready = position?.projection_ready === true;
    original += ready ? amount(position.ledger_original_allocation) : amount(project.original_alloc_text);
    adjusted += ready ? amount(position.ledger_adjusted_allocation) : amount(project.alloc_text);
    execution += ready ? amount(position.ledger_execution_amount) : amount(project.exec_text);
    if (!ready) fundingMissing += 1;
    if (['지연', '추진곤란'].includes(project.status)) delayed += 1;
    const name = project.detail_project_name || project.fund_project_name || project.project_name;
    const hasSmall = Boolean(project.primary_small_category_id) || (smallByProject.get(project.id)?.size ?? 0) > 0;
    const sharedInformationMissing = !name || project.year == null || !(project.project_period || project.period)
        || project.project_start_year == null || project.project_end_year == null
        || !['정상추진', '지연', '완료', '추진곤란'].includes(project.status)
        || !project.large_category_id || !project.middle_category_id || !hasSmall || !project.business_type;
    if (sharedInformationMissing
        || (!ready && (project.original_alloc_text == null || project.alloc_text == null || project.exec_text == null))) missing += 1;
    if (sharedInformationMissing
        || project.original_alloc_text == null || project.alloc_text == null || project.exec_text == null) rawProjectColumnsMissing += 1;
  }
  const pendingSource = new Map(pending.map((row) => [String(row.id), String(row.source_request_id)]));
  const rawRows = [
    ...budgets.map((row) => ({ id: row.id, group: row.id, status: row.status })),
    ...newProjects.map((row) => ({ id: row.id, group: row.source_budget_change_request_id || `new:${row.id}`, status: row.status })),
    ...links.map((row) => ({ id: row.id, group: pendingSource.get(String(row.pending_fund_id)) || `link:${row.id}`, status: row.status })),
  ];
  const groups = new Map();
  for (const row of rawRows) groups.set(row.group, [...(groups.get(row.group) ?? []), row]);
  const terminal = new Set(['APPLIED', 'LINKED', 'COMPLETED', 'CANCELLED', 'DUPLICATE']);
  const userFacing = [...groups.values()];
  const active = userFacing.filter((rows) => rows.some((row) => !terminal.has(row.status)));
  const completed = userFacing.filter((rows) => rows.every((row) => terminal.has(row.status)));
  await client.auth.signOut();
  return {
    alias,
    region: profile.region_name,
    project_count: projectsResult.count ?? projects.length,
    original_allocation: original.toString(),
    adjusted_allocation: adjusted.toString(),
    execution: execution.toString(),
    information_missing: missing,
    raw_project_columns_missing: rawProjectColumnsMissing,
    delayed_or_difficult: delayed,
    classification_review: proposalIds.size,
    funding_link_needed: fundingMissing,
    raw_request_rows: rawRows.length,
    raw_statuses: statusCounts(rawRows),
    user_facing_groups: userFacing.length,
    active_groups: active.length,
    completed_groups: completed.length,
    cross_region_projects: crossRegionResult.count ?? 0,
  };
}

async function main() {
  if (process.argv.length !== 4) fail('Usage: node scripts/audit-my-projects-workspace-test.cjs <test-env> <uat-credentials-env>');
  const values = { ...load(process.argv[2]), ...load(process.argv[3]) };
  const url = required(values, 'NEXT_PUBLIC_SUPABASE_URL');
  const key = required(values, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (String(values.TARGET_ENV).toUpperCase() !== 'TEST'
      || required(values, 'TEST_PROJECT_REF') !== TEST_REF
      || refFromUrl(url) !== TEST_REF
      || values.PROD_PROJECT_REF === TEST_REF) fail('Fail-closed TEST target gate rejected configuration.');
  const specs = [
    ['local_a', 'UAT_LOCAL_A_EMAIL', 'UAT_LOCAL_A_PASSWORD'],
    ['local_b', 'UAT_LOCAL_B_EMAIL', 'UAT_LOCAL_B_PASSWORD'],
    ['local_c', 'UAT_LOCAL_C_EMAIL', 'UAT_LOCAL_C_PASSWORD'],
  ];
  const accounts = [];
  for (const spec of specs) accounts.push(await inspectAccount(...spec, values, url, key));
  process.stdout.write(`${JSON.stringify({
    status: 'PASS', target: 'TEST', read_only: true, production_touched: false,
    credentials_printed: false, accounts,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`MY PROJECTS WORKSPACE AUDIT FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
