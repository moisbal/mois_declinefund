import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FUNDING_ANALYTICS_RPC,
  buildFundingAnalyticsResult,
  calculateCohortExecutionRate,
  mapFundingAnalyticsRows,
  queryFundingAnalytics,
  type FundingAnalyticsRpcRow,
} from '../../lib/fundingAnalytics.ts';

function row(overrides: Partial<FundingAnalyticsRpcRow> = {}): FundingAnalyticsRpcRow {
  return {
    scope_key: 'region-a',
    label: '전라북도 순창군',
    region_id: 'region-a',
    sido: '전라북도',
    sigungu: '순창군',
    fiscal_year: 2026,
    budget_cohort_id: 'cohort-a',
    initial_allocation_amount: '1000',
    confirmed_execution_amount: '250',
    current_wallet_balance: '300',
    unclassified_decrease_amount: '0',
    unclassified_decrease_count: 0,
    decrease_flow_amount: '400',
    reallocated_amount: '150',
    returned_amount: '50',
    waiting_stock_amount: '200',
    waiting_stock_count: 1,
    myeongsi_flow_amount: '100',
    myeongsi_flow_count: 1,
    sago_flow_amount: '40',
    sago_flow_count: 1,
    current_carryover_stock: '60',
    second_sequence_amount: '40',
    ...overrides,
  };
}

test('funding RPC rows are mapped at unique region/year/cohort grain', () => {
  const buckets = mapFundingAnalyticsRows([
    row(),
    row({
      budget_cohort_id: null,
      initial_allocation_amount: '0',
      confirmed_execution_amount: '0',
      current_wallet_balance: '0',
      unclassified_decrease_amount: '75',
      unclassified_decrease_count: 2,
      decrease_flow_amount: '0',
      reallocated_amount: '0',
      returned_amount: '0',
      waiting_stock_amount: '0',
      waiting_stock_count: 0,
      myeongsi_flow_amount: '0',
      myeongsi_flow_count: 0,
      sago_flow_amount: '0',
      sago_flow_count: 0,
      current_carryover_stock: '0',
      second_sequence_amount: '0',
    }),
  ]);

  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].cohortExecutionRate, 25);
  assert.equal(buckets[1].budgetCohortId, null);
  assert.equal(buckets[1].unclassifiedDecreaseAmount, '75');
  assert.equal(buckets[1].unclassifiedDecreaseCount, 2);
});

test('flow, stock, and cohort totals remain separate and are never added to each other', () => {
  const result = buildFundingAnalyticsResult([
    row(),
    row({
      scope_key: 'region-b',
      label: '전라남도 담양군',
      region_id: 'region-b',
      sigungu: '담양군',
      budget_cohort_id: 'cohort-b',
      initial_allocation_amount: '500',
      confirmed_execution_amount: '250',
      current_wallet_balance: '125',
      decrease_flow_amount: '100',
      reallocated_amount: '60',
      returned_amount: '10',
      waiting_stock_amount: '30',
      current_carryover_stock: '20',
    }),
  ]);

  assert.equal(result.totals.decreaseFlowAmount, '500');
  assert.equal(result.totals.reallocatedAmount, '210');
  assert.equal(result.totals.returnedAmount, '60');
  assert.equal(result.totals.waitingStockAmount, '230');
  assert.equal(result.totals.currentCarryoverStock, '80');
  assert.equal(result.totals.initialAllocationAmount, '1500');
  assert.equal(result.totals.confirmedExecutionAmount, '500');
  assert.equal(result.totals.cohortExecutionRate, 33.3333);
  assert.equal(result.totals.cohortCount, 2);
});

test('duplicate accounting buckets are rejected instead of silently double-counted', () => {
  assert.throws(
    () => mapFundingAnalyticsRows([row(), row()]),
    /duplicate accounting bucket/,
  );
});

test('cohort rate keeps bigint precision and returns N/A for a zero denominator', () => {
  assert.equal(calculateCohortExecutionRate('333333333333333333', '999999999999999999'), 33.3333);
  assert.equal(calculateCohortExecutionRate('10', '0'), null);
});

test('authenticated query passes only approved filters and maps the RPC result', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const result = await queryFundingAnalytics('local-user-jwt', {
    year: 2026,
    sido: '전라북도',
    sigungu: '순창군',
  }, async (name, args) => {
    calls.push({ name, args });
    return { data: [row()], error: null };
  });

  assert.deepEqual(calls, [{
    name: FUNDING_ANALYTICS_RPC,
    args: { p_fiscal_year: 2026, p_sido: '전라북도', p_sigungu: '순창군' },
  }]);
  assert.equal(result.source, 'confirmed_financial_ledger');
  assert.equal(result.totals.waitingStockAmount, '200');
  assert.equal(result.totals.cohortExecutionRate, 25);
});
