import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAppNavigationGroups,
  getPrimaryAppNavigation,
  isAppNavigationItemActive,
} from '../../lib/appNavigation.ts';

test('지자체 우측 메뉴는 본인 사업과 공통 조회·확인요청만 노출한다', () => {
  const groups = getAppNavigationGroups('local_user', true);
  const items = groups.flatMap((group) => group.items);

  assert.deepEqual(getPrimaryAppNavigation('local_user', true).map((item) => item.href), [
    '/dashboard',
    '/my-projects',
    '/confirmations',
    '/analytics',
  ]);
  assert.equal(items.some((item) => item.href.startsWith('/admin')), false);
});

test('관리자 우측 메뉴는 현재 업무 경로와 확인요청을 빠짐없이 보존한다', () => {
  const enabled = getAppNavigationGroups('admin', true).flatMap((group) => group.items);
  const disabled = getAppNavigationGroups('admin', false).flatMap((group) => group.items);

  assert.equal(enabled.some((item) => item.href === '/admin/funding'), true);
  assert.equal(disabled.some((item) => item.href === '/admin/funding'), false);
  assert.deepEqual(enabled.map((item) => item.href), [
    '/dashboard',
    '/analytics',
    '/confirmations',
    '/admin/funding',
    '/admin/project-changes',
    '/admin/small-category-proposals',
    '/admin',
    '/admin/ledger-cutover',
  ]);
});

test('상위 경로와 하위 업무 경로의 현재 메뉴 표시가 겹치지 않는다', () => {
  const items = getAppNavigationGroups('admin', true).flatMap((group) => group.items);
  const admin = items.find((item) => item.href === '/admin');
  const funding = items.find((item) => item.href === '/admin/funding');
  const confirmations = items.find((item) => item.href === '/confirmations');

  assert.ok(admin && funding && confirmations);
  assert.equal(isAppNavigationItemActive('/admin', admin), true);
  assert.equal(isAppNavigationItemActive('/admin/funding', admin), false);
  assert.equal(isAppNavigationItemActive('/admin/funding', funding), true);
  assert.equal(isAppNavigationItemActive('/confirmations/123', confirmations), true);
});
