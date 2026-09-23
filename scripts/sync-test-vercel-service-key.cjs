#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

const EXPECTED_REF = 'reviewtestxxxxxxxxxx';
const TEAM = 'regional-budget-mngt';
const PROJECT = 'declinefund-test-server';

(async () => {
  if (!process.argv.includes('--confirm-test-write')) throw new Error('TEST Vercel environment update requires --confirm-test-write.');
  const envPath = path.resolve(process.cwd(), '.env.ledger-test.local');
  const env = dotenv.parse(fs.readFileSync(envPath));
  const url = String(env.NEXT_PUBLIC_SUPABASE_URL ?? '');
  const serviceKey = String(env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? '');
  const ref = new URL(url).hostname.split('.')[0];
  if (String(env.TARGET_ENV).toUpperCase() !== 'TEST' || ref !== EXPECTED_REF || env.TEST_PROJECT_REF !== EXPECTED_REF || !serviceKey) {
    throw new Error('Fail-closed TEST Supabase gate rejected the local configuration.');
  }

  const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: runtime, error } = await client.from('financial_ledger_runtime')
    .select('environment_kind, mode, bound_project_ref')
    .eq('singleton', true)
    .maybeSingle();
  if (error || `${runtime?.environment_kind}:${runtime?.mode}:${runtime?.bound_project_ref}` !== `TEST:TEST:${EXPECTED_REF}`) {
    throw new Error('The replacement key did not pass the TEST runtime verification.');
  }

  const command = spawnSync('cmd.exe', [
    '/d', '/s', '/c',
    `npx vercel env add SUPABASE_SERVICE_ROLE_KEY production --force --sensitive --yes --scope ${TEAM} --project ${PROJECT}`,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    input: `${serviceKey}\n`,
    windowsHide: true,
  });
  if (command.status !== 0) {
    const detail = `${command.stdout ?? ''}\n${command.stderr ?? ''}`.replaceAll(serviceKey, '[REDACTED]').trim();
    throw new Error(`Vercel TEST service key update failed: ${detail || command.error?.message || `exit ${command.status}`}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    target: 'TEST',
    project: PROJECT,
    scope: TEAM,
    supabase_ref: EXPECTED_REF,
    variable: 'SUPABASE_SERVICE_ROLE_KEY',
    secret_value_printed: false,
    redeploy_required: true,
  }, null, 2)}\n`);
})().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
