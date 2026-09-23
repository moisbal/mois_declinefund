import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  getPageCount,
  getVisiblePageNumbers,
  paginateItems,
  PAGE_SIZE_OPTIONS,
} from '../../lib/pagination.ts';

test('처리 이력은 10·30·50건 단위와 정확한 마지막 페이지를 제공한다', () => {
  assert.deepEqual(PAGE_SIZE_OPTIONS, [10, 30, 50]);
  assert.equal(getPageCount(86, 10), 9);
  assert.equal(getPageCount(86, 30), 3);
  assert.equal(getPageCount(86, 50), 2);

  const items = Array.from({ length: 86 }, (_, index) => index + 1);
  assert.deepEqual(paginateItems(items, 1, 10), {
    items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    page: 1,
    pageCount: 9,
    firstItemNumber: 1,
    lastItemNumber: 10,
  });
  assert.deepEqual(paginateItems(items, 9, 10).items, [81, 82, 83, 84, 85, 86]);
});

test('페이지 번호는 현재 위치 주변에서 최대 7개만 표시한다', () => {
  assert.deepEqual(getVisiblePageNumbers(1, 9), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(getVisiblePageNumbers(5, 9), [2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(getVisiblePageNumbers(9, 9), [3, 4, 5, 6, 7, 8, 9]);
});

test('관리자 처리 이력 화면은 필터 결과 전체가 아닌 현재 페이지만 렌더링한다', () => {
  const source = readFileSync(resolve(process.cwd(), 'components/admin/FundingManagementShell.tsx'), 'utf8');
  assert.match(source, /historyPagination\.items\.map/);
  assert.match(source, /PAGE_SIZE_OPTIONS\.map/);
  assert.match(source, /aria-current=\{page === historyPagination\.page \? 'page'/);
  assert.match(source, /처리 이력 페이지 이동/);
  assert.doesNotMatch(source, /filteredHistory\.map/);
});
