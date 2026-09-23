#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const TEST_ALIAS = 'https://declinefund-test.vercel.app';

function fail(message) {
  throw new Error(message);
}

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
  try {
    return new URL(value).hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i)?.[1] ?? null;
  } catch {
    return null;
  }
}

function assertResult(result, label) {
  if (result.error) {
    const detail = result.error.message || result.error.details || result.error.hint || 'unknown error';
    fail(`${label} failed: ${result.error.code ?? 'unknown error'} (${detail})`);
  }
  return result.data ?? [];
}

async function checkDashboard(instance, accessToken, baseUrl) {
  const [
    projectResult,
    positionResult,
    filterResult,
    reasonRequiredResult,
    executionReasonResult,
    walletResult,
    summaryResponse,
  ] = await Promise.all([
    instance
      .from('projects')
      .select('id, status, execution_status_reason, regions(sido, sigungu, display_name)', { count: 'exact' })
      .is('deleted_at', null)
      .not('project_code', 'is', null)
      .order('year', { ascending: true })
      .order('project_code', { ascending: true })
      .range(0, 49),
    instance.rpc('get_financial_project_funding_positions', { p_project_id: null }),
    instance.rpc('get_dashboard_filter_options'),
    instance.from('projects').select('id', { count: 'exact', head: true })
      .is('deleted_at', null)
      .in('status', ['지연', '추진곤란']),
    instance.from('projects').select('id', { count: 'exact', head: true })
      .is('deleted_at', null)
      .in('status', ['지연', '추진곤란']).not('execution_status_reason', 'is', null),
    instance.rpc('get_financial_budget_years'),
    fetch(`${baseUrl}/api/projects/summary`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    }),
  ]);

  assertResult(projectResult, 'dashboard project list');
  assertResult(positionResult, 'dashboard funding projection');
  assertResult(filterResult, 'dashboard filter options');
  assertResult(reasonRequiredResult, 'execution-reason-required project count');
  assertResult(executionReasonResult, 'execution-status-reason count');
  const wallets = assertResult(walletResult, 'ledger execution inputs');
  if (!summaryResponse.ok) fail(`dashboard summary API failed: HTTP ${summaryResponse.status}`);
  const summary = await summaryResponse.json();
  if (!Number.isInteger(summary.projectCount)) fail('dashboard summary API returned an invalid project count');
  if ((projectResult.count ?? 0) !== summary.projectCount) {
    fail('dashboard project list and summary project counts do not match');
  }

  return {
    project_rows: projectResult.data?.length ?? 0,
    project_count: projectResult.count ?? 0,
    funding_positions: positionResult.data?.length ?? 0,
    ledger_execution_sources: wallets.length,
    execution_reason_required_projects: reasonRequiredResult.count ?? 0,
    execution_reasons_entered: executionReasonResult.count ?? 0,
    summary_project_count: summary.projectCount,
  };
}

async function checkSmallCategoryManagement(instance) {
  const [largeResult, middleResult, smallResult, proposalResult] = await Promise.all([
    instance.from('large_categories').select('id, code, name').order('code'),
    instance.from('middle_categories').select('id, code, name, large_category_id').order('code'),
    instance.from('small_categories').select('id, code, name, large_category_id, middle_category_id').order('code'),
    instance
      .from('project_small_category_proposals')
      .select(`
        *,
        projects(project_name, fund_project_name, detail_project_name, year, primary_small_category_id),
        regions(display_name)
      `)
      .order('created_at', { ascending: false }),
  ]);

  const large = assertResult(largeResult, 'large category master');
  const middle = assertResult(middleResult, 'middle category master');
  const small = assertResult(smallResult, 'small category master');
  const proposals = assertResult(proposalResult, 'small category proposals');
  const projectIds = [...new Set(proposals.map((item) => item.project_id).filter(Boolean))];
  if (projectIds.length > 0) {
    assertResult(
      await instance
        .from('project_related_small_categories')
        .select('project_id, small_category_id')
        .in('project_id', projectIds),
      'related small categories',
    );
  }

  return {
    large_categories: large.length,
    middle_categories: middle.length,
    small_categories: small.length,
    proposals: proposals.length,
  };
}

async function main() {
  if (process.argv.length !== 5) {
    fail('Usage: node scripts/audit-test-screen-loads.cjs <explicit-test-env> <explicit-uat-credentials-env> <test-base-url>');
  }
  const values = { ...load(process.argv[2]), ...load(process.argv[3]) };
  const baseUrl = String(process.argv[4] ?? '').replace(/\/$/, '');
  const url = required(values, 'NEXT_PUBLIC_SUPABASE_URL');
  const key = required(values, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (String(values.TARGET_ENV).toUpperCase() !== 'TEST'
      || required(values, 'TEST_PROJECT_REF') !== TEST_REF
      || refFromUrl(url) !== TEST_REF
      || baseUrl !== TEST_ALIAS) {
    fail('Fail-closed TEST target gate rejected configuration.');
  }

  const specs = [
    ['admin_a', 'UAT_ADMIN_A_EMAIL', 'UAT_ADMIN_A_PASSWORD'],
    ['admin_b', 'UAT_ADMIN_B_EMAIL', 'UAT_ADMIN_B_PASSWORD'],
    ['local_a', 'UAT_LOCAL_A_EMAIL', 'UAT_LOCAL_A_PASSWORD'],
    ['local_b', 'UAT_LOCAL_B_EMAIL', 'UAT_LOCAL_B_PASSWORD'],
    ['local_c', 'UAT_LOCAL_C_EMAIL', 'UAT_LOCAL_C_PASSWORD'],
  ];
  const accounts = [];
  for (const [alias, emailKey, passwordKey] of specs) {
    const instance = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await instance.auth.signInWithPassword({
      email: required(values, emailKey),
      password: required(values, passwordKey),
    });
    if (error || !data.session || !data.user) fail(`${alias} TEST authentication failed.`);
    const profile = assertResult(
      await instance.from('profiles').select('role, region_id, regions(display_name)').eq('id', data.user.id).single(),
      `${alias} profile`,
    );
    const dashboard = await checkDashboard(instance, data.session.access_token, baseUrl);
    const smallCategoryManagement = profile.role === 'admin'
      ? await checkSmallCategoryManagement(instance)
      : null;
    accounts.push({
      alias,
      role: profile.role,
      region: profile.regions?.display_name ?? '전체 지역',
      dashboard,
      small_category_management: smallCategoryManagement,
    });
    await instance.auth.signOut();
  }

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    target: 'TEST',
    production_touched: false,
    credentials_printed: false,
    accounts,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`TEST SCREEN LOAD AUDIT FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
