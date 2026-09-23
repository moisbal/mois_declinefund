import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chunkPostgrestInValues,
  POSTGREST_IN_FILTER_CHUNK_SIZE,
} from '../../lib/postgrest.ts';

test('통계의 사업 UUID 조회는 요청 길이 한도 아래로 분할한다', () => {
  const ids = Array.from({ length: 1_001 }, (_, index) => `project-${index}`);
  const chunks = chunkPostgrestInValues(ids);

  assert.deepEqual(chunks.map((chunk) => chunk.length), [200, 200, 200, 200, 200, 1]);
  assert.ok(chunks.every((chunk) => chunk.length <= POSTGREST_IN_FILTER_CHUNK_SIZE));
  assert.deepEqual(chunks.flat(), ids);
});
