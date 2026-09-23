import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isIsoDate,
  isPositiveBigIntString,
  isUuid,
  normalizeLedgerAmount,
  toOptionalTrimmedText,
} from '../../lib/financialLedger.ts';

test('validates UUIDs without accepting malformed identifiers', () => {
  assert.equal(isUuid('7c0b7231-f50d-44b8-9f93-e5b5e3d58236'), true);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid('00000000-0000-0000-0000-000000000000'), false);
});

test('normalizes and validates Ledger bigint amounts', () => {
  assert.equal(normalizeLedgerAmount('001,250원'), '1250');
  assert.equal(normalizeLedgerAmount('98,030,000원'), '98030000');
  assert.equal(normalizeLedgerAmount('0'), '0');
  assert.equal(isPositiveBigIntString('1'), true);
  assert.equal(isPositiveBigIntString('0'), false);
  assert.equal(isPositiveBigIntString('-1'), false);
  assert.equal(isPositiveBigIntString('9223372036854775808'), false);
});

test('accepts only real ISO calendar dates', () => {
  assert.equal(isIsoDate('2026-09-01'), true);
  assert.equal(isIsoDate('2026-02-29'), false);
  assert.equal(isIsoDate('2026/09/01'), false);
});

test('trims optional text and enforces the supplied length bound', () => {
  assert.equal(toOptionalTrimmedText('  review note  ', 20, '메모'), 'review note');
  assert.equal(toOptionalTrimmedText('   ', 20, '메모'), null);
  assert.throws(() => toOptionalTrimmedText('toolong', 3, '메모'), /3자 이하/);
});
