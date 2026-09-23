import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAuditAction,
  formatAuditFieldName,
  getAuditDisplayItems,
} from '../../lib/auditLogFormat.ts';
import type { ProjectCategoryMaster } from '../../lib/projectClassification.ts';

const master: ProjectCategoryMaster = {
  largeCategories: [{ id: 'large-a', code: 'A', name: '문화관광' }],
  middleCategories: [{ id: 'middle-a', code: 'A1', name: '문화', large_category_id: 'large-a' }],
  smallCategories: [{
    id: 'small-a',
    code: 'A1-1',
    name: '문화공간',
    large_category_id: 'large-a',
    middle_category_id: 'middle-a',
  }],
};

function displayValues(fieldName: string, rawValue: string) {
  return getAuditDisplayItems(fieldName, rawValue, master).map((item) => item.value);
}

test('기존 변경이력의 단순 영문 코드를 한글로 표시한다', () => {
  assert.deepEqual(displayValues('status', 'planned'), ['계획']);
  assert.deepEqual(displayValues('status', 'PENDING_REVIEW'), ['검토 대기']);
  assert.deepEqual(displayValues('business_type', 'COMPOSITE'), ['복합형(시설+서비스)']);
  assert.deepEqual(displayValues('exec', '10000'), ['10,000원']);
});

test('신규 사업변경 감사이력의 근거·사유·분류를 한글로 풀어쓴다', () => {
  const values = displayValues('project_metadata', JSON.stringify({
    name: '문화공간 조성',
    classification: {
      large_category_name: '문화관광',
      middle_category_name: '문화',
      primary_small_category_name: '문화공간',
      business_type: 'COMPOSITE',
    },
    change_basis_code: 'LOCAL_NOTICE',
    change_reason_codes: ['CONTENT_CHANGE', 'SUBPROJECT_ADJUSTMENT'],
    save_mode: 'SAVE',
  }));

  assert.deepEqual(values, [
    '문화공간 조성',
    '문화관광 > 문화 > 문화공간 · 복합형(시설+서비스)',
    '지자체 → 조합 통보',
    '사업내용 변경, 기금사업 내 세부사업 조정',
    '저장',
  ]);
});

test('재정원장 payload의 요청 유형과 테이블명을 한글로 표시한다', () => {
  const items = getAuditDisplayItems('financial_funding_reallocation_requests', JSON.stringify({
    record_id: '11111111-1111-1111-1111-111111111111',
    payload: {
      request_type: 'ALLOCATE_UNALLOCATED_EXISTING',
      amount: 10000,
      canonical_table: 'project_fund_transfers',
    },
  }), master);

  assert.deepEqual(items.map((item) => item.label), ['요청 유형', '금액', '기준 자료']);
  assert.deepEqual(items.map((item) => item.value), ['기존사업 재배분', '10,000원', '사업간 예산조정 기록']);
});

test('현재 TEST 감사이력에서 사용하는 유형과 필드명을 한글로 표시한다', () => {
  assert.equal(formatAuditAction('UPDATE_PROJECT_METADATA'), '사업 기본·분류 정보 수정');
  assert.equal(formatAuditAction('UPDATE_PROJECT_DELAY_REASON'), '사업 지연 사유 수정');
  assert.equal(formatAuditFieldName('delay_reason'), '지연 사유');
  assert.equal(formatAuditFieldName('execution_status_reason'), '집행상태 사유');
  assert.equal(formatAuditAction('LEDGER_RUNTIME_MODE_CHANGED'), '재정원장 운영 모드 변경');
  assert.equal(formatAuditFieldName('project_similarity'), '유사사업 판단');
  assert.equal(formatAuditFieldName('financial_unallocated_fund_movements'), '대기재원 이동');
});

test('예산 조정·신규사업 예정재원 감사이력을 국문으로 표시한다', () => {
  assert.equal(formatAuditAction('BUDGET_REALLOCATION_SUBMITTED'), '예산 조정 승인요청');
  assert.equal(formatAuditAction('BUDGET_REALLOCATION_APPLIED'), '예산 조정 적용');
  assert.equal(formatAuditAction('PENDING_NEW_PROJECT_FUND_LINKED'), '신규사업 예정재원 연결완료');
  assert.equal(formatAuditFieldName('financial_budget_change_requests'), '예산 조정 요청');
  assert.equal(formatAuditFieldName('financial_pending_new_project_funds'), '신규사업 예정재원');
  const items = getAuditDisplayItems('financial_budget_change_requests', JSON.stringify({
    payload: { amount: 10000000, destination_count: 2, gap_amount: 0 },
  }), master);
  assert.deepEqual(items.map((item) => item.value), ['10,000,000원', '2', '0원']);
});

test('감사이력의 내부 UUID와 미등록 영문 enum을 사용자에게 그대로 노출하지 않는다', () => {
  assert.deepEqual(displayValues('candidate_project_id', '11111111-1111-4111-8111-111111111111'), ['내부 식별값']);
  assert.deepEqual(displayValues('status', 'UNREGISTERED_RAW_STATUS'), ['확인 필요']);
});

test('감사 원문은 보존하되 확인된 시험 사업명과 반려 사유는 한글로 표시한다', () => {
  const items = getAuditDisplayItems('financial_new_project_requests', JSON.stringify({
    project_name: 'AUTO-UAT-20260826-180000 REJECTED',
    rejection_reason: 'AUTO-UAT-20260826-180000 autonomous UAT rejection',
  }), master);
  assert.deepEqual(items.map((item) => item.value), [
    '자동 사용자 검증 · 20260826-180000 · 반려 확인',
    '자동 사용자 검증 · 20260826-180000 · 자동 사용자 검증 반려',
  ]);
});
