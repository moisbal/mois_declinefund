import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sourcePolicy = readFileSync(new URL('../../lib/analytics/sourcePolicy.ts', import.meta.url), 'utf8');
const analyticsRoute = readFileSync(new URL('../../app/api/analytics/route.ts', import.meta.url), 'utf8');

test('통계 안내와 내려받기에는 내부 영문 용어를 노출하지 않는다', () => {
  for (const forbidden of ['DB projects', 'Ledger Cutover', 'snapshot/거래', "? 'N/A'"]) {
    assert.equal(sourcePolicy.includes(forbidden) || analyticsRoute.includes(forbidden), false, forbidden);
  }
  assert.match(sourcePolicy, /사업 테이블의 최신 확정 저장값/);
  assert.match(analyticsRoute, /자료 없음/);
});
