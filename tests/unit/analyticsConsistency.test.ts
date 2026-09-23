import assert from 'node:assert/strict';
import test from 'node:test';

import { formatWonAsManwon, formatWonAsManwonWithUnit, formatWonWithUnit } from '../../lib/amountFormat.ts';
import { calculateKpis, getProjectRate } from '../../lib/analytics/calculations.ts';
import {
  analyticsFiltersToSearchParams,
  DEFAULT_ANALYTICS_FILTERS,
  parseAnalyticsFilters,
} from '../../lib/analytics/filters.ts';
import { resolveAnalyticsSourcePolicy } from '../../lib/analytics/sourcePolicy.ts';
import { resolveAnalyticsRegionLabels } from '../../lib/analytics/regions.ts';
import { overlayAnalyticsFundingPosition } from '../../lib/fundingManagement.ts';
import {
  chunkPostgrestInValues,
  POSTGREST_IN_FILTER_CHUNK_SIZE,
} from '../../lib/postgrest.ts';

test('만원 표시는 1만원 미만을 절사하고 원 단위 원본은 계산에 유지한다', () => {
  assert.equal(formatWonAsManwon('67537999'), '6,753');
  assert.equal(formatWonAsManwonWithUnit('67537999'), '6,753만원');
  assert.equal(formatWonAsManwon('9999'), '0');
  assert.equal(formatWonAsManwonWithUnit('9999'), '0만원');
  assert.equal(formatWonAsManwon('-19999'), '-1');
  assert.equal(formatWonAsManwonWithUnit('-19999'), '-1만원');
  assert.equal(formatWonWithUnit('98030000'), '98,030,000원');
  assert.equal(formatWonWithUnit('133490000'), '133,490,000원');
  assert.equal(formatWonWithUnit('133495175'), '133,495,175원');
  assert.equal(formatWonWithUnit('10000000'), '10,000,000원');
  assert.equal(formatWonWithUnit('0'), '0원');
  assert.equal(formatWonWithUnit('-19999'), '-19,999원');

  const kpis = calculateKpis([
    { allocText: '67537999', execText: '33768999', originalAllocText: '100000000' },
  ], 'adjusted');
  assert.equal(kpis.adjustedAllocation, '67537999');
  assert.equal(kpis.cumulativeExecution, '33768999');
  assert.equal(kpis.unexecutedAmount, '33769000');
});

test('집계 집행률은 raw 합계 기준이고 사업별 집행률도 같은 raw 금액을 사용한다', () => {
  const projects = [
    { allocText: '100', execText: '50', originalAllocText: '200' },
    { allocText: '300', execText: '225', originalAllocText: '300' },
  ];
  const kpis = calculateKpis(projects, 'adjusted');

  assert.equal(kpis.executionRate, 68.75);
  assert.equal(getProjectRate(projects[0], 'adjusted'), 50);
  assert.equal(getProjectRate(projects[1], 'adjusted'), 75);
});

test('기존 analytics URL도 현재 최신값을 기본 source of truth로 사용한다', () => {
  const filters = parseAnalyticsFilters(new URLSearchParams('asOf=2026-08-31&groupBy=project'));
  assert.equal(filters.timeBasis, 'current');
  assert.equal(resolveAnalyticsSourcePolicy(filters, null).source, 'current_projects');
  assert.equal(analyticsFiltersToSearchParams(filters).get('timeBasis'), 'current');
});

test('과거 기준 데이터가 없으면 현재 projects 값을 과거 snapshot으로 위장하지 않는다', () => {
  const filters = { ...DEFAULT_ANALYTICS_FILTERS, timeBasis: 'as_of' as const };
  assert.equal(resolveAnalyticsSourcePolicy(filters, null).source, 'historical_unavailable');
  assert.equal(resolveAnalyticsSourcePolicy(filters, '2026-08-01').source, 'ledger_not_implemented');
});

test('현재 Analytics는 확정 projection 금액을 사용하고 미확정 행은 raw fallback한다', () => {
  const raw = { id: 'p1', originalAllocText: '100', allocText: '100', execText: '50' };
  const position = {
    project_id: 'p1', region_id: 'r1', fiscal_year: 2026,
    ledger_original_allocation: '100', ledger_adjusted_allocation: '80',
    ledger_increase_amount: '0', ledger_decrease_amount: '20',
    ledger_execution_amount: '40', ledger_execution_rate: 50,
    current_wallet_balance: '40', unclassified_decrease_amount: '0', projection_ready: true,
  };
  assert.deepEqual(overlayAnalyticsFundingPosition(raw, [position]), {
    ...raw, originalAllocText: '100', allocText: '80', execText: '40',
  });
  assert.equal(overlayAnalyticsFundingPosition(raw, [{ ...position, projection_ready: false }]), raw);
});

test('funding position UUID 조회는 upstream request-line 한도 아래로 chunk한다', () => {
  const ids = Array.from({ length: 1_001 }, (_, index) => `project-${index}`);
  const chunks = chunkPostgrestInValues(ids);

  assert.deepEqual(chunks.map((chunk) => chunk.length), [200, 200, 200, 200, 200, 1]);
  assert.ok(chunks.every((chunk) => chunk.length <= POSTGREST_IN_FILTER_CHUNK_SIZE));
  assert.deepEqual(chunks.flat(), ids);
});

test('신규사업의 denormalized 지역명이 비어 있으면 region_id 기준 지역명을 사용한다', () => {
  assert.deepEqual(resolveAnalyticsRegionLabels(
    { sido: null, sigungu: null },
    { sido: '부산', sigungu: '서구' },
  ), { sido: '부산', sigungu: '서구' });
  assert.deepEqual(resolveAnalyticsRegionLabels(
    { sido: '전남', sigungu: 'B군' },
    { sido: '전라남도', sigungu: '다른군' },
  ), { sido: '전남', sigungu: 'B군' });
});
