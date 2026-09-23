#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import {
  isTestLoginAliasEnabled,
  resolveTestLoginIdentifier,
  TEST_LOGIN_ALIASES,
} from '../lib/testLoginAliases.ts';

const TEST_REF = 'reviewtestxxxxxxxxxx';

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

async function authenticate(url, anonKey, email, password) {
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const result = await client.auth.signInWithPassword({ email, password });
  if (result.error || !result.data.user || !result.data.session) throw new Error('TEST authentication failed.');
  return { client, user: result.data.user };
}

async function main() {
  const values = { ...load(process.argv[2]), ...load(process.argv[3]) };
  const url = required(values, 'NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = required(values, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (String(values.TARGET_ENV).toUpperCase() !== 'TEST'
      || required(values, 'TEST_PROJECT_REF') !== TEST_REF
      || refFromUrl(url) !== TEST_REF
      || !isTestLoginAliasEnabled(url)) {
    throw new Error('Fail-closed TEST target gate rejected configuration.');
  }

  const specs = [
    ['review_user_1', 'UAT_ADMIN_A_EMAIL', 'UAT_ADMIN_A_PASSWORD'],
    ['review_user_2', 'UAT_ADMIN_B_EMAIL', 'UAT_ADMIN_B_PASSWORD'],
    ['review_user_3', 'UAT_LOCAL_A_EMAIL', 'UAT_LOCAL_A_PASSWORD'],
    ['review_user_4', 'UAT_LOCAL_B_EMAIL', 'UAT_LOCAL_B_PASSWORD'],
    ['review_user_5', 'UAT_LOCAL_C_EMAIL', 'UAT_LOCAL_C_PASSWORD'],
  ];
  const accounts = [];
  for (const [alias, emailKey, passwordKey] of specs) {
    const expectedEmail = required(values, emailKey);
    const password = required(values, passwordKey);
    const resolvedEmail = resolveTestLoginIdentifier(alias, url);
    if (resolvedEmail !== expectedEmail || TEST_LOGIN_ALIASES[alias] !== expectedEmail) {
      throw new Error(`${alias} mapping does not match the existing TEST account.`);
    }

    const aliasLogin = await authenticate(url, anonKey, resolvedEmail, password);
    const aliasUserId = aliasLogin.user.id;
    await aliasLogin.client.auth.signOut();
    const emailLogin = await authenticate(url, anonKey, expectedEmail, password);
    const profileResult = await emailLogin.client.from('profiles')
      .select('role,region_id,region_name').eq('id', emailLogin.user.id).single();
    if (profileResult.error || !profileResult.data) throw profileResult.error ?? new Error('Profile missing.');
    const ownProjects = await emailLogin.client.from('projects').select('id', { count: 'exact', head: true });
    if (ownProjects.error) throw ownProjects.error;
    let crossRegionRows = null;
    if (profileResult.data.role === 'local_user' && profileResult.data.region_id) {
      const crossRegion = await emailLogin.client.from('projects').select('id', { count: 'exact', head: true })
        .neq('region_id', profileResult.data.region_id);
      if (crossRegion.error) throw crossRegion.error;
      crossRegionRows = crossRegion.count ?? 0;
    }
    accounts.push({
      alias,
      mapped_to_existing_email: true,
      alias_and_email_same_user_id: aliasUserId === emailLogin.user.id,
      role: profileResult.data.role,
      region: profileResult.data.region_name ?? '전체 지역',
      visible_project_count: ownProjects.count ?? 0,
      cross_region_project_count: crossRegionRows,
    });
    await emailLogin.client.auth.signOut();
  }

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    target: 'TEST',
    project_ref: TEST_REF,
    production_touched: false,
    credentials_printed: false,
    accounts,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`TEST LOGIN ALIAS AUDIT FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
