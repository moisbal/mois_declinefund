import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateProjectBudget,
  countMyProjectDraftChanges,
  validateMyProjectEditDraft,
  type MyProjectEditDraft,
} from '../../lib/myProjectEdit.ts';

function validDraft(overrides: Partial<MyProjectEditDraft> = {}): MyProjectEditDraft {
  return {
    detailProjectName: '지역 활력 회복 사업',
    nameChange: {
      basisCode: null,
      otherBasis: '',
      reasonCodes: [],
      otherReason: '',
      detail: '',
    },
    projectPeriod: '2025. 1. ~ 2025. 12.',
    projectStartYear: 2025,
    status: '정상추진',
    executionStatusReason: '',
    originalAlloc: '150000000',
    increaseAmount: '0',
    decreaseAmount: '0',
    exec: '0',
    classification: {
      largeCategoryId: null,
      middleCategoryId: null,
      primarySmallCategoryId: null,
      smallCategoryIds: [],
      customSmallCategories: [],
      businessType: null,
    },
    relatedProjects: [],
    ...overrides,
  };
}

test('지연과 추진곤란 상태는 각각 한글 사유를 요구한다', () => {
  assert.equal(
    validateMyProjectEditDraft(validDraft({ status: '지연', executionStatusReason: '' }), 2025),
    '지연 사유를 입력해 주세요.',
  );
  assert.equal(
    validateMyProjectEditDraft(validDraft({ status: '추진곤란', executionStatusReason: '' }), 2025),
    '추진곤란 사유를 입력해 주세요.',
  );
  assert.equal(
    validateMyProjectEditDraft(validDraft({ status: '지연', executionStatusReason: '인허가 협의 지연' }), 2025),
    null,
  );
});

test('예산 자동 계산은 원 단위 정수 값을 보존한다', () => {
  const result = calculateProjectBudget(validDraft({
    originalAlloc: '150000000',
    increaseAmount: '110000',
    decreaseAmount: '10000',
    exec: '50000000',
  }));
  assert.equal(result.adjustedAlloc, BigInt('150100000'));
  assert.equal(result.balance, BigInt('100100000'));
});

test('원장 관리 사업의 계산 금액 갱신은 미저장 편집으로 세지 않는다', () => {
  const saved = validDraft();
  const ledgerRefreshed = validDraft({
    increaseAmount: '1234567',
    decreaseAmount: '1',
    exec: '100',
  });

  assert.equal(countMyProjectDraftChanges(ledgerRefreshed, saved, true), 0);
  assert.equal(countMyProjectDraftChanges(ledgerRefreshed, saved, false), 3);
  assert.equal(countMyProjectDraftChanges(
    { ...ledgerRefreshed, detailProjectName: '변경된 사업명' },
    saved,
    true,
  ), 1);
});
