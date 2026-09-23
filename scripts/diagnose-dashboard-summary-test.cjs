#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const TEST_ALIAS = 'https://declinefund-test.vercel.app';

function load(file) {
  const resolved = path.resolve(process.cwd(), file ?? '');
  if (!file || !fs.existsSync(resolved)) throw new Error(`Missing TEST env file: ${file ?? '(none)'}`);
  return dotenv.parse(fs.readFileSync(resolved));
}

function required(values, key) {
  const value = String(values[key] ?? '').trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function refFromUrl(value) {
  return new URL(value).hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i)?.[1] ?? null;
}

function publicError(error) {
  if (!error) return null;
  return {
    code: error.code ?? null,
    message: error.message ?? null,
    details: error.details ?? null,
    hint: error.hint ?? null,
  };
}

async function databaseSummary(client, regionId, projectCount) {
  let totalBudget = 0n;
  let allocation = 0n;
  let execution = 0n;
  for (let from = 0; from < projectCount; from += 200) {
    let projectQuery = client.from('projects')
      .select('id,total_budget_text:total_budget::text,alloc_text:alloc::text,exec_text:exec::text')
      .not('project_code', 'is', null)
      .order('project_code', { ascending: true }).order('id', { ascending: true })
      .range(from, from + 199);
    if (regionId) projectQuery = projectQuery.eq('region_id', regionId);
    const projects = await projectQuery;
    if (projects.error) throw projects.error;
    const ids = (projects.data ?? []).map((row) => row.id);
    const positions = ids.length === 0
      ? { data: [], error: null }
      : await client.from('financial_project_funding_positions')
        .select('project_id,ledger_adjusted_allocation,ledger_execution_amount,projection_ready')
        .in('project_id', ids);
    if (positions.error) throw positions.error;
    const positionMap = new Map((positions.data ?? []).map((row) => [row.project_id, row]));
    for (const project of projects.data ?? []) {
      const position = positionMap.get(project.id);
      totalBudget += BigInt(String(project.total_budget_text ?? 0));
      allocation += BigInt(String(position?.projection_ready ? position.ledger_adjusted_allocation : project.alloc_text ?? 0));
      execution += BigInt(String(position?.projection_ready ? position.ledger_execution_amount : project.exec_text ?? 0));
    }
  }
  return {
    projectCount,
    totalBudgetSum: totalBudget.toString(),
    allocSum: allocation.toString(),
    execSum: execution.toString(),
    overallRate: allocation === 0n ? 0 : Number(execution) / Number(allocation) * 100,
  };
}

async function main() {
  const values = { ...load(process.argv[2]), ...load(process.argv[3]) };
  const baseUrl = String(process.argv[4] ?? '').replace(/\/$/, '');
  const url = required(values, 'NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = required(values, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (String(values.TARGET_ENV).toUpperCase() !== 'TEST'
      || required(values, 'TEST_PROJECT_REF') !== TEST_REF
      || refFromUrl(url) !== TEST_REF
      || baseUrl !== TEST_ALIAS) {
    throw new Error('Fail-closed TEST target gate rejected configuration.');
  }
  const serviceRoleKey = required(values, 'TEST_SUPABASE_SERVICE_ROLE_KEY');
  const serviceClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const summaryCache = new Map();

  const specs = [
    ['admin_a', 'UAT_ADMIN_A_EMAIL', 'UAT_ADMIN_A_PASSWORD'],
    ['admin_b', 'UAT_ADMIN_B_EMAIL', 'UAT_ADMIN_B_PASSWORD'],
    ['local_a', 'UAT_LOCAL_A_EMAIL', 'UAT_LOCAL_A_PASSWORD'],
    ['local_b', 'UAT_LOCAL_B_EMAIL', 'UAT_LOCAL_B_PASSWORD'],
    ['local_c', 'UAT_LOCAL_C_EMAIL', 'UAT_LOCAL_C_PASSWORD'],
  ];
  const accounts = [];
  for (const [alias, emailKey, passwordKey] of specs) {
    const client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const auth = await client.auth.signInWithPassword({
      email: required(values, emailKey),
      password: required(values, passwordKey),
    });
    if (auth.error || !auth.data.session || !auth.data.user) throw new Error(`${alias} TEST authentication failed.`);
    const profile = await client.from('profiles').select('role,region_id,name,regions(display_name)').eq('id', auth.data.user.id).single();
    if (profile.error || !profile.data) throw profile.error ?? new Error(`${alias} profile missing.`);

    const summaryResponse = await fetch(`${baseUrl}/api/projects/summary`, {
      headers: { Authorization: `Bearer ${auth.data.session.access_token}` },
      cache: 'no-store',
    });
    let summaryBody = null;
    try { summaryBody = await summaryResponse.json(); } catch { summaryBody = null; }

    const regionId = profile.data.role === 'local_user' ? profile.data.region_id : null;
    let countQuery = client.from('projects').select('project_code', { count: 'exact', head: true }).not('project_code', 'is', null);
    let idQuery = serviceClient.from('projects').select('id').not('project_code', 'is', null)
      .order('project_code', { ascending: true }).range(0, 999);
    if (regionId) {
      countQuery = countQuery.eq('region_id', regionId);
      idQuery = idQuery.eq('region_id', regionId);
    }
    let allCountQuery = client.from('projects').select('id', { count: 'exact', head: true });
    if (regionId) allCountQuery = allCountQuery.eq('region_id', regionId);
    const draftQuery = client.from('financial_new_project_requests').select('id', { count: 'exact', head: true }).eq('status', 'DRAFT');
    const [countResult, allCountResult, idResult, draftResult] = await Promise.all([countQuery, allCountQuery, idQuery, draftQuery]);
    if (countResult.error || allCountResult.error || idResult.error || draftResult.error) {
      throw countResult.error ?? allCountResult.error ?? idResult.error ?? draftResult.error;
    }
    const ids = (idResult.data ?? []).map((row) => row.id);
    const summaryKey = regionId ?? 'ALL';
    if (!summaryCache.has(summaryKey)) {
      summaryCache.set(summaryKey, await databaseSummary(serviceClient, regionId, countResult.count ?? 0));
    }
    const expectedSummary = summaryCache.get(summaryKey);
    const originalFilter = ids.length === 0
      ? { data: [], error: null }
      : await serviceClient.from('financial_project_funding_positions').select('project_id').in('project_id', ids);
    const chunkErrors = [];
    let chunkRows = 0;
    for (let index = 0; index < ids.length; index += 200) {
      const chunkResult = await serviceClient.from('financial_project_funding_positions')
        .select('project_id').in('project_id', ids.slice(index, index + 200));
      if (chunkResult.error) chunkErrors.push(publicError(chunkResult.error));
      else chunkRows += chunkResult.data?.length ?? 0;
    }

    accounts.push({
      alias,
      role: profile.data.role,
      region: profile.data.regions?.display_name ?? '전체 지역',
      profile_name: profile.data.name ?? null,
      official_project_count: countResult.count ?? 0,
      all_project_row_count: allCountResult.count ?? 0,
      draft_count: draftResult.count ?? 0,
      deployed_summary: {
        status: summaryResponse.status,
        body: summaryResponse.ok ? summaryBody : { message: summaryBody?.message ?? null },
        matches_database: summaryResponse.ok
          && summaryBody?.projectCount === expectedSummary.projectCount
          && summaryBody?.totalBudgetSum === expectedSummary.totalBudgetSum
          && summaryBody?.allocSum === expectedSummary.allocSum
          && summaryBody?.execSum === expectedSummary.execSum,
      },
      database_summary: expectedSummary,
      original_1000_id_filter: {
        id_count: ids.length,
        error: publicError(originalFilter.error),
        row_count: originalFilter.data?.length ?? 0,
      },
      chunked_200_id_filter: {
        chunk_count: Math.ceil(ids.length / 200),
        errors: chunkErrors,
        row_count: chunkRows,
      },
    });
    await client.auth.signOut();
  }

  process.stdout.write(`${JSON.stringify({
    target: 'TEST',
    project_ref: TEST_REF,
    alias: baseUrl,
    production_touched: false,
    credentials_printed: false,
    accounts,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`TEST DASHBOARD DIAGNOSTIC FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
