#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const GROUPS = [
  { case: 'A', id: '00000000-0000-4000-8000-000000000104', local: 'local_a', expected: ['40000000', '60000000'] },
  { case: 'D', id: '00000000-0000-4000-8000-000000000105', local: 'local_b', expected: ['40000000', '60000000'], reusedRequestId: '00000000-0000-4000-8000-000000000106' },
  { case: 'B', id: '00000000-0000-4000-8000-000000000107', local: 'local_c', expected: ['60000000', '20000000', '10000000', '10000000'] },
];

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

async function signIn(url, key, email, password) {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const result = await client.auth.signInWithPassword({ email, password });
  if (result.error || !result.data.user) throw new Error('TEST authentication failed.');
  return client;
}

async function rpcRows(client, name, args) {
  const result = await client.rpc(name, args);
  if (result.error) throw result.error;
  return result.data ?? [];
}

async function main() {
  const values = { ...load(process.argv[2]), ...load(process.argv[3]) };
  const url = required(values, 'NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = required(values, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (String(values.TARGET_ENV).toUpperCase() !== 'TEST'
      || required(values, 'TEST_PROJECT_REF') !== TEST_REF
      || refFromUrl(url) !== TEST_REF) throw new Error('Fail-closed TEST target gate rejected configuration.');
  const service = createClient(url, required(values, 'TEST_SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const accounts = {
    admin_a: await signIn(url, anonKey, required(values, 'UAT_ADMIN_A_EMAIL'), required(values, 'UAT_ADMIN_A_PASSWORD')),
    admin_b: await signIn(url, anonKey, required(values, 'UAT_ADMIN_B_EMAIL'), required(values, 'UAT_ADMIN_B_PASSWORD')),
    local_a: await signIn(url, anonKey, required(values, 'UAT_LOCAL_A_EMAIL'), required(values, 'UAT_LOCAL_A_PASSWORD')),
    local_b: await signIn(url, anonKey, required(values, 'UAT_LOCAL_B_EMAIL'), required(values, 'UAT_LOCAL_B_PASSWORD')),
    local_c: await signIn(url, anonKey, required(values, 'UAT_LOCAL_C_EMAIL'), required(values, 'UAT_LOCAL_C_PASSWORD')),
  };
  const queues = {};
  for (const [name, client] of Object.entries(accounts)) {
    queues[name] = await rpcRows(client, 'get_financial_budget_change_requests', {
      p_project_id: null, p_status: null, p_year: null, p_region_id: null,
    });
  }

  const results = [];
  for (const spec of GROUPS) {
    const requestResult = await service.from('financial_budget_change_requests')
      .select('id,status,total_amount').eq('id', spec.id).single();
    const linesResult = await service.from('financial_budget_change_request_lines')
      .select('id,line_no,destination_type,amount,new_project_request_id,materialized_transfer_id,materialized_lot_id,pending_fund_id')
      .eq('request_id', spec.id).order('line_no');
    if (requestResult.error || linesResult.error) throw requestResult.error ?? linesResult.error;
    const lines = linesResult.data ?? [];
    const lotIds = lines.map((line) => line.materialized_lot_id).filter(Boolean);
    const childIds = lines.map((line) => line.new_project_request_id).filter(Boolean);
    const pendingIds = lines.map((line) => line.pending_fund_id).filter(Boolean);
    const [lotsResult, movementsResult, childrenResult, pendingResult] = await Promise.all([
      lotIds.length ? service.from('financial_unallocated_fund_lots').select('id,original_amount').in('id', lotIds) : { data: [], error: null },
      lotIds.length ? service.from('financial_unallocated_fund_movements').select('id,lot_id,amount,destination_project_id,new_project_request_id').in('lot_id', lotIds) : { data: [], error: null },
      childIds.length ? service.from('financial_new_project_requests').select('id,status,requested_amount,materialized_project_id').in('id', childIds) : { data: [], error: null },
      pendingIds.length ? service.from('financial_pending_new_project_funds').select('id,status,amount').in('id', pendingIds) : { data: [], error: null },
    ]);
    const dataResults = [lotsResult, movementsResult, childrenResult, pendingResult];
    const firstError = dataResults.find((result) => result.error)?.error;
    if (firstError) throw firstError;
    const total = BigInt(String(requestResult.data.total_amount));
    const destinationSum = lines.reduce((sum, line) => sum + BigInt(String(line.amount)), 0n);
    const existingSum = lines.filter((line) => line.destination_type === 'EXISTING_PROJECT')
      .reduce((sum, line) => sum + BigInt(String(line.amount)), 0n);
    const pendingSum = lines.filter((line) => line.destination_type === 'PENDING_NEW_PROJECT')
      .reduce((sum, line) => sum + BigInt(String(line.amount)), 0n);
    const allocatedFromLots = (movementsResult.data ?? []).reduce((sum, row) => sum + BigInt(String(row.amount)), 0n);
    const lotTotal = (lotsResult.data ?? []).reduce((sum, row) => sum + BigInt(String(row.original_amount)), 0n);
    const waiting = lotTotal - allocatedFromLots;
    const childIdCounts = new Map();
    for (const row of childrenResult.data ?? []) childIdCounts.set(row.id, (childIdCounts.get(row.id) ?? 0) + 1);
    results.push({
      case: spec.case,
      group_id: spec.id,
      status: requestResult.data.status,
      destination_amounts: lines.map((line) => String(line.amount)),
      expected_destination_amounts: spec.expected,
      local_visible: queues[spec.local].some((row) => row.id === spec.id),
      admin_a_visible: queues.admin_a.some((row) => row.id === spec.id),
      admin_b_visible: queues.admin_b.some((row) => row.id === spec.id),
      relationship: {
        line_count: lines.length,
        new_project_request_ids: childIds,
        reused_request_id_preserved: spec.reusedRequestId ? childIds.includes(spec.reusedRequestId) : true,
        child_row_count: childrenResult.data?.length ?? 0,
        pending_row_count: pendingResult.data?.length ?? 0,
        movement_row_count: movementsResult.data?.length ?? 0,
        duplicate_child_ids: [...childIdCounts.values()].some((count) => count > 1),
      },
      integrity: {
        request_minus_destinations: (total - destinationSum).toString(),
        after_budget_apply: (total - existingSum - pendingSum).toString(),
        after_new_project_link: (total - existingSum - allocatedFromLots - waiting).toString(),
        source_decrease: total.toString(),
        existing_destination: existingSum.toString(),
        new_project_destination: pendingSum.toString(),
        linked_new_project_amount: allocatedFromLots.toString(),
        unlinked_pending_amount: waiting.toString(),
      },
    });
  }

  const pass = results.every((row) => row.status === 'APPLIED'
    && JSON.stringify(row.destination_amounts) === JSON.stringify(row.expected_destination_amounts)
    && row.local_visible && row.admin_a_visible && row.admin_b_visible
    && !row.relationship.duplicate_child_ids
    && Object.values(row.integrity).slice(0, 3).every((value) => value === '0'));
  process.stdout.write(`${JSON.stringify({
    status: pass ? 'PASS' : 'FAIL', target: 'TEST', read_only: true,
    project_ref: TEST_REF, production_touched: false, credentials_printed: false, results,
  }, null, 2)}\n`);
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`TEST MULTI-DESTINATION AUDIT FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
