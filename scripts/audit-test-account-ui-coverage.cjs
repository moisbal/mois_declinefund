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
  if (!file || !fs.existsSync(resolved)) fail(`Missing explicit env file: ${file ?? '(none)'}`);
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
function client(url, key) {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
async function rows(instance, table, columns) {
  const { data, error } = await instance.from(table).select(columns);
  if (error) fail(`${table} read failed.`);
  return data ?? [];
}
async function countRows(instance, table, configure) {
  let query = instance.from(table).select('id', { count: 'exact', head: true });
  if (configure) query = configure(query);
  const { count, error } = await query;
  if (error) fail(`${table} count failed.`);
  return count ?? 0;
}
function statusCounts(items) {
  return items.reduce((counts, item) => {
    const status = String(item.status ?? 'UNKNOWN');
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
}

async function main() {
  if (process.argv.length !== 4) {
    fail('Usage: node scripts/audit-test-account-ui-coverage.cjs <explicit-test-env> <explicit-uat-credentials-env>');
  }
  const values = { ...load(process.argv[2]), ...load(process.argv[3]) };
  const url = required(values, 'NEXT_PUBLIC_SUPABASE_URL');
  const key = required(values, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  const serviceKey = required(values, 'TEST_SUPABASE_SERVICE_ROLE_KEY');
  if (String(values.TARGET_ENV).toUpperCase() !== 'TEST'
      || required(values, 'TEST_PROJECT_REF') !== TEST_REF
      || refFromUrl(url) !== TEST_REF
      || values.PROD_PROJECT_REF === TEST_REF) {
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
    const instance = client(url, key);
    const { data, error } = await instance.auth.signInWithPassword({
      email: required(values, emailKey), password: required(values, passwordKey),
    });
    if (error || !data.user) fail(`${alias} TEST authentication failed.`);
    const { data: profile, error: profileError } = await instance.from('profiles')
      .select('role,region_id,regions(display_name)').eq('id', data.user.id).single();
    if (profileError || !profile) fail(`${alias} profile lookup failed.`);
    accounts.push({ alias, instance, profile, userId: data.user.id });
  }

  const adminInstance = client(url, serviceKey);
  const { data: authInventory, error: authInventoryError } = await adminInstance.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (authInventoryError) fail('TEST authentication inventory lookup failed.');
  const configuredUserIds = new Set(accounts.map((account) => account.userId));
  const unconfiguredAuthUsers = authInventory.users.filter((user) => !configuredUserIds.has(user.id));
  if (unconfiguredAuthUsers.length > 0 || authInventory.users.length !== accounts.length) {
    fail('One or more TEST authentication accounts are missing from the configured UI coverage set.');
  }

  const report = [];
  for (const account of accounts) {
    const [projects, projectCount, proposals, pendingFunds, linkRequests] = await Promise.all([
      rows(account.instance, 'projects', 'id,region_id,project_name,fund_project_name,detail_project_name'),
      countRows(account.instance, 'projects'),
      rows(account.instance, 'project_small_category_proposals', 'id,status'),
      rows(account.instance, 'financial_pending_new_project_funds', 'id,status'),
      rows(account.instance, 'financial_pending_new_project_link_requests', 'id,status'),
    ]);
    const missingProjectNames = projects.filter((project) => ![
      project.detail_project_name, project.fund_project_name, project.project_name,
    ].some((name) => typeof name === 'string' && name.trim())).length;
    const crossRegionProjectCount = account.profile.role === 'local_user'
      ? await countRows(account.instance, 'projects', (query) => query.neq('region_id', account.profile.region_id))
      : 0;
    report.push({
      alias: account.alias,
      role: account.profile.role,
      region: account.profile.regions?.display_name ?? '전체 지역',
      projects: projectCount,
      project_rows_sampled: projects.length,
      missing_project_names_in_sample: missingProjectNames,
      proposals: statusCounts(proposals),
      pending_funds: statusCounts(pendingFunds),
      pending_link_requests: statusCounts(linkRequests),
      cross_region_project_rows: crossRegionProjectCount,
    });
  }

  const adminA = accounts.find((account) => account.alias === 'admin_a');
  const allProfiles = await rows(adminA.instance, 'profiles', 'role');
  const discoveredRoles = allProfiles.reduce((counts, profile) => {
    counts[profile.role] = (counts[profile.role] ?? 0) + 1;
    return counts;
  }, {});
  const adminReports = report.filter((item) => item.role === 'admin');
  if (adminReports.length !== 2
      || adminReports[0].projects !== adminReports[1].projects
      || report.some((item) => item.role === 'local_user' && item.cross_region_project_rows !== 0)) {
    fail('Account coverage or RLS comparison failed.');
  }

  await Promise.allSettled(accounts.map((account) => account.instance.auth.signOut()));
  process.stdout.write(`${JSON.stringify({
    status: 'PASS', target: 'TEST', production_touched: false,
    authentication_inventory: {
      total_login_accounts: authInventory.users.length,
      configured_and_authenticated: accounts.length,
      unconfigured_login_accounts: unconfiguredAuthUsers.length,
    },
    configured_accounts: report,
    discovered_profile_roles: discoveredRoles,
    credentials_printed: false,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`TEST ACCOUNT UI COVERAGE AUDIT FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
