import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertLedgerTestTarget,
  assertLedgerTestWriteEnabled,
  projectRefFromSupabaseUrl,
} from '../../lib/ledgerRuntime.ts';

const safeTestEnvironment = {
  TARGET_ENV: 'TEST',
  PROD_PROJECT_REF: 'prod-project-ref',
  TEST_PROJECT_REF: 'test-project-ref',
  NEXT_PUBLIC_SUPABASE_URL: 'https://test-project-ref.supabase.co',
  LEDGER_MODE: 'test',
};

test('extracts a ref only from a standard Supabase project URL', () => {
  assert.equal(projectRefFromSupabaseUrl('https://project-ref.supabase.co'), 'project-ref');
  assert.equal(projectRefFromSupabaseUrl('https://example.com'), null);
  assert.equal(projectRefFromSupabaseUrl('not a url'), null);
});

test('permits only a clearly separated TEST target', () => {
  assert.doesNotThrow(() => assertLedgerTestTarget(safeTestEnvironment));
  assert.throws(
    () => assertLedgerTestTarget({ ...safeTestEnvironment, TARGET_ENV: 'PRODUCTION' }),
    /TEST 환경/,
  );
  assert.throws(
    () => assertLedgerTestTarget({ ...safeTestEnvironment, TEST_PROJECT_REF: 'prod-project-ref' }),
    /분리/,
  );
  assert.throws(
    () => assertLedgerTestTarget({ ...safeTestEnvironment, NEXT_PUBLIC_SUPABASE_URL: 'https://other.supabase.co' }),
    /일치/,
  );
});

test('requires an explicit TEST ledger mode for System Native monetary writes', () => {
  assert.doesNotThrow(() => assertLedgerTestWriteEnabled(safeTestEnvironment));
  assert.throws(
    () => assertLedgerTestWriteEnabled({ ...safeTestEnvironment, LEDGER_MODE: 'reconciliation' }),
    /TEST 모드/,
  );
  assert.throws(
    () => assertLedgerTestWriteEnabled({ ...safeTestEnvironment, LEDGER_MODE: 'disabled' }),
    /TEST 모드/,
  );
});

function runTargetPreflight(ledgerMode: string) {
  const tempDirectory = mkdtempSync(path.join(tmpdir(), 'ledger-target-preflight-'));
  const envFile = path.join(tempDirectory, '.env.test');
  const script = path.resolve(process.cwd(), 'scripts/verify-ledger-test-target.cjs');

  try {
    writeFileSync(envFile, [
      'TARGET_ENV=TEST',
      'PROD_PROJECT_REF=prod-project-ref',
      'TEST_PROJECT_REF=test-project-ref',
      'NEXT_PUBLIC_SUPABASE_URL=https://test-project-ref.supabase.co',
      `LEDGER_MODE=${ledgerMode}`,
    ].join('\n'));

    return spawnSync(process.execPath, [script, '--env-file', envFile], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

test('Preview preflight permits reconciliation and test but rejects disabled', () => {
  assert.equal(runTargetPreflight('reconciliation').status, 0);
  assert.equal(runTargetPreflight('RECONCILIATION').status, 0);
  assert.equal(runTargetPreflight('test').status, 0);

  const disabled = runTargetPreflight('disabled');
  assert.equal(disabled.status, 1);
  assert.match(disabled.stderr, /LEDGER_MODE must equal reconciliation or test/);
});
