#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

function arg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function fail(message) { throw new Error(message); }
function load(file) {
  const resolved = path.resolve(process.cwd(), file ?? '');
  if (!file || !fs.existsSync(resolved)) fail(`Missing file: ${file ?? '(none)'}`);
  return dotenv.parse(fs.readFileSync(resolved));
}
function required(env, name) { const value = String(env[name] ?? '').trim(); if (!value) fail(`${name} is required.`); return value; }
function client(url, key) { return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }); }

async function main() {
  if (!process.argv.includes('--confirm-test-write')) fail('--confirm-test-write is required.');
  const env = load(arg('--env-file'));
  const credentials = load(arg('--credentials-file'));
  const projectCode = arg('--project-code');
  const testRef = required(env, 'TEST_PROJECT_REF');
  const prodRef = required(env, 'PROD_PROJECT_REF');
  const url = required(env, 'NEXT_PUBLIC_SUPABASE_URL');
  if (String(env.TARGET_ENV).toUpperCase() !== 'TEST' || testRef !== 'reviewtestxxxxxxxxxx'
      || testRef === prodRef || !url.includes(`${testRef}.supabase.co`) || !projectCode) {
    fail('Fail-closed TEST recovery gate rejected configuration.');
  }
  const local = client(url, required(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY'));
  const service = client(url, required(env, 'TEST_SUPABASE_SERVICE_ROLE_KEY'));
  const auth = await local.auth.signInWithPassword({ email: required(credentials, 'UAT_LOCAL_A_EMAIL'), password: required(credentials, 'UAT_LOCAL_A_PASSWORD') });
  if (auth.error || !auth.data.user) fail('local_a TEST authentication failed.');
  const projectResult = await service.from('projects').select('*').eq('project_code', projectCode).single();
  if (projectResult.error || !projectResult.data) fail('Recovery project was not found.');
  const project = projectResult.data;
  const eventResult = await service.from('project_change_events')
    .select('old_name,old_classification,changed_at')
    .eq('project_id', project.id)
    .eq('change_kind', 'CLASSIFICATION')
    .order('changed_at', { ascending: false })
    .limit(50);
  const sourceEvent = (eventResult.data ?? []).find((event) => event.old_classification?.primary_small_category_id);
  if (eventResult.error || !sourceEvent) fail('Original classification snapshot is missing.');
  const original = sourceEvent.old_classification;
  const relatedResult = await service.from('project_related_projects')
    .select('project_name,total_budget,regional_fund_alloc,local_fund_alloc')
    .eq('project_id', project.id);
  if (relatedResult.error) fail('Related-project recovery read failed.');
  const relatedProjects = (relatedResult.data ?? []).map((row) => ({
    project_name: row.project_name,
    total_budget: String(row.total_budget),
    regional_fund_alloc: String(row.regional_fund_alloc),
    local_fund_alloc: String(row.local_fund_alloc),
  }));
  const relatedIds = Array.isArray(original.related_small_categories)
    ? original.related_small_categories.map((item) => item.id)
    : [];
  const { error } = await local.rpc('update_my_project_metadata_v2', {
    p_project_id: project.id,
    p_detail_project_name: project.detail_project_name,
    p_project_period: project.project_period,
    p_project_start_year: project.project_start_year,
    p_status: project.status,
    p_related_projects: relatedProjects,
    p_primary_small_category_id: original.primary_small_category_id,
    p_related_small_category_ids: relatedIds,
    p_business_type: original.business_type,
    p_change_basis_code: null,
    p_other_basis: null,
    p_change_reason_codes: [],
    p_other_reason: null,
    p_change_detail: 'TEST UAT 중단 원상복구',
    p_similarity_candidate: false,
    p_save_mode: 'SAVE',
  });
  if (error) fail(`Recovery RPC failed: ${error.message}`);
  const restored = await service.from('projects').select('primary_small_category_id,business_type').eq('id', project.id).single();
  if (restored.error || restored.data.primary_small_category_id !== original.primary_small_category_id
      || restored.data.business_type !== original.business_type) fail('Recovery verification failed.');
  process.stdout.write(`${JSON.stringify({ ok: true, target: 'TEST', project_code: projectCode, classification_restored: true, monetary_columns_written: false }, null, 2)}\n`);
}

main().catch((error) => {
  let message = String(error?.message ?? error);
  for (const file of [arg('--env-file'), arg('--credentials-file')]) {
    try {
      for (const secret of Object.values(load(file))) if (String(secret).length >= 4) message = message.split(String(secret)).join('[redacted]');
    } catch { /* best effort */ }
  }
  process.stderr.write(`${JSON.stringify({ ok: false, target: 'TEST', message, secrets_printed: false }, null, 2)}\n`);
  process.exitCode = 1;
});
