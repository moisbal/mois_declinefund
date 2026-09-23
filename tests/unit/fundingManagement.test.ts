import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateProjectFundingSummary,
  calculateDecreaseTransition,
  canUseLegacyWorkflow,
  canUseNativeWorkflow,
  fundingRuntimeLabel,
  isOfficialProjectCode,
  overlayFundingPosition,
  sumFundingAmounts,
  unallocatedLotState,
  type FundingRuntime,
} from '../../lib/fundingManagement.ts';

const reconciliation: FundingRuntime = {
  environment_kind: 'TEST',
  mode: 'RECONCILIATION',
  baseline_as_of: '2026-08-31',
  native_start_date: '2026-09-01',
};

test('운영 상태는 과거자료 검수와 신규 TEST 거래를 분리한다', () => {
  assert.equal(canUseLegacyWorkflow(reconciliation), true);
  assert.equal(canUseNativeWorkflow(reconciliation, '2026-09-01'), false);
  assert.match(fundingRuntimeLabel(reconciliation), /과거자료 검수/);

  const native: FundingRuntime = { ...reconciliation, mode: 'TEST' };
  assert.equal(canUseLegacyWorkflow(native), false);
  assert.equal(canUseNativeWorkflow(native, '2026-08-31'), false);
  assert.equal(canUseNativeWorkflow(native, '2026-09-01'), true);
});

test('waiting-fund stock is represented independently from cumulative flows', () => {
  assert.equal(sumFundingAmounts(['6000000', '4000000']), '10000000');
  assert.equal(unallocatedLotState({ remaining_amount: '0', status: 'EXHAUSTED' }), '처리 완료');
  assert.equal(unallocatedLotState({ remaining_amount: '4000000', status: 'OPEN' }), '재배분 대기');
});

test('official project code validation checks only the approved SQL basic format', () => {
  assert.equal(isOfficialProjectCode('2026-26-140-0006'), true);
  assert.equal(isOfficialProjectCode(''), false);
  assert.equal(isOfficialProjectCode('사업 코드'), false);
  assert.equal(isOfficialProjectCode('/invalid-prefix'), false);
});

test('project amount overlay is ledger-derived only after classification is complete', () => {
  const project = { id: 'p1', alloc_text: '100', exec_text: '90', rate: 90 };
  const position = {
    project_id: 'p1', region_id: 'r1', fiscal_year: 2026,
    ledger_original_allocation: '100', ledger_adjusted_allocation: '90',
    ledger_increase_amount: '0', ledger_decrease_amount: '10',
    ledger_execution_amount: '90', ledger_execution_rate: 100,
    current_wallet_balance: '0', unclassified_decrease_amount: '0', projection_ready: true,
  };
  assert.deepEqual(overlayFundingPosition(project, [position]), {
    ...project,
    original_alloc_text: '100', increase_amount_text: '0', decrease_amount_text: '10',
    alloc_text: '90', exec_text: '90', rate: 100, projection_ready: true, ledger_managed: true,
  });
  assert.deepEqual(overlayFundingPosition(project, [{ ...position, projection_ready: false }]), {
    ...project, projection_ready: false, ledger_managed: true,
  });
});

test('dashboard summary aggregates projected bigint strings, not stale physical amounts', () => {
  const projected = overlayFundingPosition(
    { id: 'p1', total_budget_text: '200', alloc_text: '100', exec_text: '50' },
    [{
      project_id: 'p1', region_id: 'r1', fiscal_year: 2026,
      ledger_original_allocation: '100', ledger_adjusted_allocation: '80',
      ledger_increase_amount: '0', ledger_decrease_amount: '20',
      ledger_execution_amount: '40', ledger_execution_rate: 50,
      current_wallet_balance: '40', unclassified_decrease_amount: '0', projection_ready: true,
    }],
  );
  assert.deepEqual(aggregateProjectFundingSummary([projected]), {
    totalBudgetSum: '200', allocSum: '80', execSum: '40', overallRate: 50,
  });
});

test('dashboard summary treats nullable project amounts as zero', () => {
  assert.deepEqual(aggregateProjectFundingSummary([
    { total_budget_text: null, alloc_text: null, exec_text: null },
    { total_budget_text: '100', alloc_text: '80', exec_text: '40' },
  ]), {
    totalBudgetSum: '100', allocSum: '80', execSum: '40', overallRate: 50,
  });
});

test('decrease transition grows forward classifications and reduces linked reversals', () => {
  assert.deepEqual(calculateDecreaseTransition({
    currentLedgerDecreaseAmount: '0', amount: '10', reversal: false,
  }), { before: '0', after: '10' });
  assert.deepEqual(calculateDecreaseTransition({
    currentLedgerDecreaseAmount: '6', amount: '4', reversal: false,
  }), { before: '6', after: '10' });
  assert.deepEqual(calculateDecreaseTransition({
    currentLedgerDecreaseAmount: '10', amount: '2', reversal: true,
  }), { before: '10', after: '8' });
});
