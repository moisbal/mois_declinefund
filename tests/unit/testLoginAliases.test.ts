import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getTestAccountDisplayName,
  isTestLoginAliasEnabled,
  resolveTestLoginIdentifier,
  TEST_LOGIN_ALIASES,
} from '../../lib/testLoginAliases.ts';

const TEST_URL = 'https://reviewtestxxxxxxxxxx.supabase.co';
const NON_TEST_URL = 'https://different-project.supabase.co';

test('five convenience ids resolve only for the explicit TEST project', () => {
  assert.equal(Object.keys(TEST_LOGIN_ALIASES).length, 5);
  assert.equal(isTestLoginAliasEnabled(TEST_URL), true);
  for (const [alias, email] of Object.entries(TEST_LOGIN_ALIASES)) {
    assert.equal(resolveTestLoginIdentifier(alias, TEST_URL), email);
    assert.equal(resolveTestLoginIdentifier(alias.toUpperCase(), TEST_URL), email);
    assert.equal(resolveTestLoginIdentifier(alias, NON_TEST_URL), alias);
  }
});

test('email login stays intact and unknown identifiers never grant an account', () => {
  assert.equal(
    resolveTestLoginIdentifier(' review-user-4@example.invalid ', TEST_URL),
    'review-user-4@example.invalid',
  );
  assert.equal(resolveTestLoginIdentifier('administrator', TEST_URL), 'administrator');
});

test('friendly account labels are presentation-only and TEST-gated', () => {
  assert.equal(getTestAccountDisplayName('review-user-1@example.invalid', '관리자', TEST_URL), '테스트 관리자 A');
  assert.equal(getTestAccountDisplayName('review-user-4@example.invalid', '부산 서구', TEST_URL), '부산 서구 담당자');
  assert.equal(getTestAccountDisplayName('review-user-1@example.invalid', '관리자', NON_TEST_URL), '관리자');
});
