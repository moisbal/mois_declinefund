#!/usr/bin/env node

/**
 * Fail-closed preflight for any future TEST-only Ledger command.
 *
 * Usage: node scripts/verify-ledger-test-target.cjs --env-file .env.test.local
 *
 * It intentionally prints only masked project references and never prints
 * connection strings, API keys, passwords, or service-role credentials.
 */

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function mask(value) {
  if (!value) return '(missing)';
  if (value.length <= 6) return '***';
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function projectRefFromUrl(value) {
  try {
    const url = new URL(value);
    const match = /^([a-z0-9-]+)\.supabase\.co$/i.exec(url.hostname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

const suppliedEnvFile = readArgument('--env-file');
if (!suppliedEnvFile) {
  console.error('FAIL: --env-file is required; no default environment file is loaded.');
  process.exit(1);
}

const envFile = path.resolve(process.cwd(), suppliedEnvFile);
if (!fs.existsSync(envFile)) {
  console.error('FAIL: the requested environment file does not exist.');
  process.exit(1);
}

const parsed = dotenv.parse(fs.readFileSync(envFile));
const targetEnv = (parsed.TARGET_ENV ?? '').trim();
const prodRef = (parsed.PROD_PROJECT_REF ?? '').trim();
const testRef = (parsed.TEST_PROJECT_REF ?? '').trim();
const currentRef = projectRefFromUrl((parsed.NEXT_PUBLIC_SUPABASE_URL ?? '').trim());
const ledgerMode = (parsed.LEDGER_MODE ?? '').trim().toLowerCase();
const errors = [];

if (targetEnv !== 'TEST') errors.push('TARGET_ENV must equal TEST.');
if (!prodRef) errors.push('PROD_PROJECT_REF is required.');
if (!testRef) errors.push('TEST_PROJECT_REF is required.');
if (prodRef && testRef && prodRef === testRef) errors.push('PROD_PROJECT_REF and TEST_PROJECT_REF must differ.');
if (!currentRef) errors.push('NEXT_PUBLIC_SUPABASE_URL must be a standard Supabase project URL.');
if (currentRef && testRef && currentRef !== testRef) errors.push('The configured project URL does not match TEST_PROJECT_REF.');
if (!['reconciliation', 'test'].includes(ledgerMode)) {
  errors.push('LEDGER_MODE must equal reconciliation or test.');
}

console.log(JSON.stringify({
  target_env: targetEnv || '(missing)',
  prod_project_ref: mask(prodRef),
  test_project_ref: mask(testRef),
  current_project_ref: mask(currentRef),
  refs_are_distinct: Boolean(prodRef && testRef && prodRef !== testRef),
  ledger_mode: ledgerMode || '(missing)',
  verdict: errors.length === 0 ? 'PASS' : 'FAIL',
}, null, 2));

if (errors.length > 0) {
  for (const error of errors) console.error(`FAIL: ${error}`);
  process.exit(1);
}
