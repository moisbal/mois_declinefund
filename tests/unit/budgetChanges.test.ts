import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateBudgetChangeGap,
  calculateBudgetDestinationMaximum,
  calculateOfficialBudgetPosition,
  calculatePendingBudgetChangeAmounts,
  calculateUnexecutedAmount,
  getBudgetDestinationAddDisabledReason,
  getNextBudgetChangeFiscalYear,
  replaceBudgetDestination,
  validateBudgetChangeDestinations,
  validateBudgetChangeMaximumDecrease,
} from '../../lib/budgetChanges.ts';

test('차년도 목적지 연도는 API 숫자 문자열도 정수로 정규화한다', () => {
  assert.equal(getNextBudgetChangeFiscalYear(2026), 2027);
  assert.equal(getNextBudgetChangeFiscalYear('2026'), 2027);
  assert.equal(getNextBudgetChangeFiscalYear(undefined, 2030), 2031);
});
import {
  formatProjectOption,
  formatProjectReference,
  formatSystemTerm,
  getProjectPresentation,
  sanitizeProjectNameForDisplay,
} from '../../lib/presentationLabels.ts';

test('복수 목적지 합계와 차액을 raw 원 단위 bigint로 계산한다', () => {
  assert.deepEqual(calculateBudgetChangeGap('10000000', [
    { amount: '6000000' },
    { amount: '4000000' },
  ]), {
    total: '10000000', allocated: '10000000', gap: '0', balanced: true,
  });
  assert.deepEqual(calculateBudgetChangeGap('10000000', [
    { amount: '6000000' },
    { amount: '3900000' },
  ]).gap, '100000');
});

test('목적지 연결 방식 변경은 안정적인 key의 해당 행만 교체하고 다른 행을 유지한다', () => {
  const existing = { key: 'existing-a', destination_type: 'EXISTING_PROJECT' as const, amount: '40000000' };
  const pending = { key: 'pending-b', destination_type: 'PENDING_NEW_PROJECT' as const, amount: '60000000' };
  const replacement = { ...pending, amount: '50000000' };
  assert.deepEqual(replaceBudgetDestination([existing, pending], pending.key, replacement), [existing, replacement]);
});

test('각 목적지 최대액은 자기 기존 금액을 제외하여 계산한다', () => {
  const destinations = [
    { key: 'a', amount: '60000000' },
    { key: 'b', amount: '40000000' },
  ];
  assert.equal(calculateBudgetDestinationMaximum('100000000', destinations, 'a'), '60000000');
  assert.equal(calculateBudgetDestinationMaximum('100000000', destinations, 'b'), '40000000');
  assert.equal(calculateBudgetDestinationMaximum('100000000', [{ key: 'a', amount: '60000000' }], 'a'), '100000000');
});

test('미배분액 4천만원이 남으면 기존·신규 목적지 추가 조건이 활성 상태다', () => {
  assert.equal(getBudgetDestinationAddDisabledReason({
    totalAmount: '100000000',
    destinations: [{ amount: '60000000' }],
    destinationCount: 1,
    editable: true,
    hasFatalDestinationError: false,
  }), null);
  assert.equal(getBudgetDestinationAddDisabledReason({
    totalAmount: '100000000',
    destinations: [{ amount: '100000000' }],
    destinationCount: 1,
    editable: true,
    hasFatalDestinationError: false,
  }), '배분할 금액이 없습니다.');
});

test('목적지 없는 감액과 출처 없는 증액에 해당하는 불완전 요청을 거부한다', () => {
  assert.match(validateBudgetChangeDestinations('10000000', [])!, /목적지/);
  assert.match(validateBudgetChangeDestinations('10000000', [{
    destination_type: 'EXISTING_PROJECT', amount: '10000000',
  }])!, /기존사업/);
  assert.match(validateBudgetChangeDestinations('10000000', [{
    destination_type: 'PENDING_NEW_PROJECT', amount: '10000000',
  }])!, /예정명/);
  assert.equal(validateBudgetChangeDestinations('10000000', [
    { destination_type: 'EXISTING_PROJECT', destination_project_id: 'destination', amount: '6000000' },
    { destination_type: 'PENDING_NEW_PROJECT', planned_project_name: '신규 C', planned_project_year: 2026, planned_project_status: '정상추진', amount: '4000000' },
  ]), null);
});

test('신규사업 목적지의 지연·추진곤란 사유를 필수 검증한다', () => {
  assert.equal(validateBudgetChangeDestinations('100', [{
    destination_type: 'PENDING_NEW_PROJECT', planned_project_name: '차년도 사업',
    planned_project_year: 2026, planned_project_status: '지연', amount: '100',
  }]), '지연 사유를 입력해 주세요.');
  assert.equal(validateBudgetChangeDestinations('100', [{
    destination_type: 'PENDING_NEW_PROJECT', planned_project_name: '차년도 사업',
    planned_project_year: 2026, planned_project_status: '추진곤란', amount: '100',
  }]), '추진곤란 사유를 입력해 주세요.');
});

test('동일 목적지 중복 지정과 신규사업 기간 역전을 공통 검증에서 차단한다', () => {
  assert.match(validateBudgetChangeDestinations('100', [
    { destination_type: 'EXISTING_PROJECT', destination_project_id: 'B', amount: '40' },
    { destination_type: 'EXISTING_PROJECT', destination_project_id: 'B', amount: '60' },
  ])!, /중복/);
  assert.match(validateBudgetChangeDestinations('100', [
    {
      destination_type: 'PENDING_NEW_PROJECT', planned_project_name: '차년도 B',
      planned_project_year: 2025, planned_project_start_year: 2026,
      planned_project_end_year: 2025, amount: '100',
    },
  ])!, /시작연도/);
});

test('공식금액은 승인대기 요청과 분리하며 APPLY 산식만으로 계산한다', () => {
  assert.deepEqual(calculateOfficialBudgetPosition({
    originalAllocation: '480000000', increaseAmount: '0',
    decreaseAmount: '80000000', executionAmount: '400000000',
  }), {
    originalAllocation: '480000000', increaseAmount: '0', decreaseAmount: '80000000',
    adjustedAllocation: '400000000', executionAmount: '400000000',
    unexecutedAmount: '0', valid: true,
  });
  const request = {
    id: 'R', region_id: 'REGION', fiscal_year: 2024, source_project_id: 'A',
    source_project_code: null, source_project_name: 'A', total_amount: '80000000',
    decrease_amount_before: '0', decrease_amount_after: '80000000',
    effective_date: '2026-09-01', reason: '공통 회귀', status: 'SUBMITTED' as const,
    requested_by: 'USER', requested_at: '2026-09-01T00:00:00Z', rejection_reason: null,
    destinations: [{
      line_id: 'L', line_no: 1, destination_type: 'EXISTING_PROJECT' as const,
      destination_project_id: 'B', amount: '80000000', destination_project_code: null,
      destination_project_name: 'B', pending_fund_id: null, new_project_request_id: null,
      new_project_request_status: null, official_project_code: null,
      materialized_project_id: null, materialized_project_code: null,
      materialized_project_name: null,
    }],
  };
  assert.deepEqual(calculatePendingBudgetChangeAmounts('A', [request]), {
    requestedDecrease: '80000000', requestedIncrease: '0',
  });
  assert.deepEqual(calculatePendingBudgetChangeAmounts('B', [request]), {
    requestedDecrease: '0', requestedIncrease: '80000000',
  });
  assert.deepEqual(calculatePendingBudgetChangeAmounts('A', [{ ...request, status: 'APPLIED' }]), {
    requestedDecrease: '0', requestedIncrease: '0',
  });
});

test('지역·연도·금액에 무관하게 다중 사업 재배분 총량은 항상 0원이다', () => {
  const fixtures = [
    { region: 'R1', year: 2024, source: 'A', destinations: ['B', 'C'], amounts: ['50', '30'] },
    { region: 'R2', year: 2027, source: 'D', destinations: ['E', 'F'], amounts: ['11', '12'] },
  ];
  for (const fixture of fixtures) {
    const total = fixture.amounts.reduce((sum, amount) => sum + BigInt(amount), BigInt(0)).toString();
    const result = calculateBudgetChangeGap(total, fixture.amounts.map((amount) => ({ amount })));
    assert.equal(result.gap, '0', `${fixture.region}/${fixture.year}/${fixture.source}`);
    assert.equal(result.balanced, true);
  }
});

test('미집행액은 조정 후 배분액 - 집행액이며 초과 집행은 검증 대상이다', () => {
  assert.deepEqual(calculateUnexecutedAmount('100000000', '0'), { unexecutedAmount: '100000000', valid: true });
  assert.deepEqual(calculateUnexecutedAmount('100000000', '30000000'), { unexecutedAmount: '70000000', valid: true });
  assert.deepEqual(calculateUnexecutedAmount('90000000', '90000000'), { unexecutedAmount: '0', valid: true });
  assert.deepEqual(calculateUnexecutedAmount('90000000', '90000001'), { unexecutedAmount: '-1', valid: false });
});

test('감액액은 raw 원 단위 현재 미집행액을 넘을 수 없고 정확한 최대액을 안내한다', () => {
  assert.equal(validateBudgetChangeMaximumDecrease('4842320', '4842320'), null);
  assert.equal(validateBudgetChangeMaximumDecrease('98030000', '98030000'), null);
  assert.equal(validateBudgetChangeMaximumDecrease('133495175', '133495175'), null);
  assert.equal(
    validateBudgetChangeMaximumDecrease('133495176', '133495175'),
    '현재 미집행액을 초과하여 감액할 수 없습니다. 최대 감액 가능액은 133,495,175원입니다.',
  );
  assert.equal(
    validateBudgetChangeMaximumDecrease('98030001', '98030000'),
    '현재 미집행액을 초과하여 감액할 수 없습니다. 최대 감액 가능액은 98,030,000원입니다.',
  );
  assert.equal(
    validateBudgetChangeMaximumDecrease('80000000', '4842320'),
    '현재 미집행액을 초과하여 감액할 수 없습니다. 최대 감액 가능액은 4,842,320원입니다.',
  );
  assert.equal(
    validateBudgetChangeMaximumDecrease('1', '-100'),
    '현재 미집행액을 초과하여 감액할 수 없습니다. 최대 감액 가능액은 0원입니다.',
  );
});

test('사업 표시 formatter는 연도·사업명을 우선하고 UUID fallback을 노출하지 않는다', () => {
  const uuid = '11111111-1111-4111-8111-111111111111';
  assert.equal(formatProjectOption({ fiscal_year: 2024, project_name: '청년창업 지원사업', project_code: '2024-26-140-0001' }),
    '2024 · 청년창업 지원사업');
  assert.equal(formatProjectReference({ id: uuid, project_code: '2024-26-140-0002' }),
    '사업명 확인 필요');
  assert.equal(formatProjectReference({ id: uuid }), '사업명 확인 필요');
  assert.equal(formatProjectReference({ id: uuid }).includes(uuid), false);
});

test('TEST RUN 식별자는 구분값을 보존한 한글 표시명·공식코드와 분리한다', () => {
  assert.equal(sanitizeProjectNameForDisplay('AUTO-BUDGET-UAT 2025 양구 신규사업', 2025), '자동 예산 사용자 검증 · 양구 신규사업');
  assert.equal(sanitizeProjectNameForDisplay('GENERIC-BUDGET-UAT 2025 양구 신규사업', 2025), '일반 예산 사용자 검증 · 양구 신규사업');
  assert.equal(sanitizeProjectNameForDisplay('UAT 2025 신규사업 연계 검증', 2025), '사용자 검증 · 신규사업 연계 검증');
  assert.equal(sanitizeProjectNameForDisplay('UAT 순창 2027 혼합 신규사업 C', 2027), '사용자 검증 · 순창 혼합 신규사업 시나리오 다');
  assert.equal(sanitizeProjectNameForDisplay('UAT 신규사업 D 예정재원', 2025), '사용자 검증 · 신규사업 시나리오 라 예정재원');
  assert.equal(sanitizeProjectNameForDisplay('AUTO-UAT-20260826-180000 RAW 1W', 2027), '자동 사용자 검증 · 20260826-180000 · 1원 경계값');
  assert.equal(getProjectPresentation({ project_name: 'GOLDEN', status: 'APPLIED' }).isTestProject, true);
  assert.deepEqual(getProjectPresentation({
    fiscal_year: 2027,
    project_name: 'UAT 순창 2027 신규사업 B',
    project_code: '2027-52-770-UAT-0831-B',
    status: 'APPLIED',
  }), {
    year: 2027,
    name: '사용자 검증 · 순창 신규사업 시나리오 나',
    officialCode: null,
    codeLabel: '사업코드 미부여',
    isTestProject: true,
    badgeLabel: '테스트',
    searchText: '2027 사용자 검증 · 순창 신규사업 시나리오 나 UAT 순창 2027 신규사업 B 2027-52-770-UAT-0831-B',
  });
  assert.equal(formatProjectOption({
    fiscal_year: 2027,
    project_name: 'UAT 순창 2027 신규사업 B',
    project_code: '2027-52-770-UAT-0831-B',
    status: 'SUBMITTED',
  }), '2027 · 사용자 검증 · 순창 신규사업 시나리오 나');
});

test('사업변경 상태와 목적지 유형은 공통 국문 formatter를 사용한다', () => {
  assert.equal(formatSystemTerm('APPLIED'), '적용완료');
  assert.equal(formatSystemTerm('BUDGET_REALLOCATION'), '예산 조정');
  assert.equal(formatSystemTerm('PENDING_NEW_PROJECT'), '신규사업 예정');
  assert.equal(formatSystemTerm('WAITING'), '연결 대기');
  assert.equal(formatSystemTerm('DRAFT'), '임시저장');
  assert.equal(formatSystemTerm('SUBMITTED'), '승인대기');
  assert.equal(formatSystemTerm('MONETARY GAP'), '금액 차이');
  assert.equal(formatSystemTerm('group'), '요청 묶음');
  assert.equal(formatSystemTerm('RAW'), '원시 시험자료');
  assert.equal(formatSystemTerm('GOLDEN'), '기준 시험자료');
  assert.equal(formatSystemTerm('UNKNOWN_RAW_ENUM'), '확인 필요');
});
