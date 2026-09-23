import { formatAuditAmount } from './amountFormat.ts';
import {
  BUSINESS_TYPE_LABELS,
  isBusinessType,
  type ProjectCategoryMaster,
} from './projectClassification.ts';
import {
  PROJECT_NAME_CHANGE_BASIS_LABELS,
  PROJECT_NAME_CHANGE_REASON_LABELS,
  SIMILARITY_RELATIONSHIP_LABELS,
} from './projectChange.ts';
import {
  formatStoredUserText,
  sanitizeClassificationNameForDisplay,
  sanitizeProjectNameForDisplay,
} from './presentationLabels.ts';

export type AuditDisplayItem = {
  label: string;
  value: string;
  isAmount?: boolean;
};

type AuditJsonRecord = Record<string, unknown>;

const FIELD_LABELS: Record<string, string> = {
  project_classification: '사업 분류',
  my_project_details: '사업 정보',
  custom_small_category: '사용자 입력 소분류',
  project_budget_cohorts: '예산 회차',
  project_budget_years: '연도별 예산',
  project_fund_transfers: '사업간 예산조정',
  project_execution_records: '집행 기록',
  project_carryovers: '이월',
  project_budget_adjustments: '예산 조정',
  financial_funding_reallocation_requests: '감액·재배분 요청',
  financial_ledger_runtime: '재정원장 운영 모드',
  financial_new_project_requests: '신규사업 요청',
  financial_project_decrease_classification_reversals: '감액 분류 취소',
  financial_project_lineages: '사업 연계관계',
  financial_unallocated_fund_lots: '대기재원',
  financial_unallocated_fund_movements: '대기재원 이동',
  ledger_evidence: '재정원장 근거자료',
  legacy_ledger_reconstruction_entries: '과거거래 복원',
  my_project_nonfinancial_details: '사업 비재정 정보',
  project_metadata: '사업 기본·분류 정보',
  delay_reason: '지연 사유',
  execution_status_reason: '집행상태 사유',
  project_similarity: '유사사업 판단',
  small_category_proposal: '소분류 제안',
  business_type: '사업유형',
  large_category_id: '대분류',
  middle_category_id: '중분류',
  standard_small_category_ids: '표준 소분류',
  custom_small_categories: '사용자 입력 소분류',
  detail_project_name: '세부 사업명',
  fund_project_name: '기금 사업명',
  project_name: '원자료 사업명',
  old_name: '변경 전 사업명',
  new_name: '변경 후 사업명',
  source_project_name: '출처 사업명',
  destination_project_name: '목적지 사업명',
  planned_project_name: '예정 사업명',
  project_period: '사업기간',
  project_start_year: '시작연도',
  original_alloc: '당초 배분액',
  increase_amount: '증액액',
  decrease_amount: '감액액',
  alloc: '조정 후 배분액',
  exec: '집행액',
  rate: '집행률',
  related_projects: '연계 사업',
  amount: '금액',
  budget_year_id: '재원 위치',
  destination_budget_year_id: '수신 재원 위치',
  origin_fiscal_year: '최초 재원연도',
  allocation_type: '배분 유형',
  carryover_type: '이월 유형',
  carryover_sequence: '이월 차수',
  adjustment_type: '조정 유형',
  execution_date: '집행일',
  status: '상태',
  idempotency_key: '요청 식별키',
  resolution_note: '처리 메모',
  name: '사업명',
  classification: '사업 분류',
  save_mode: '저장 구분',
  change_basis_code: '변경 근거',
  change_reason_codes: '변경 사유',
  candidate_project_id: '후보 사업',
  relationship_type: '관계 유형',
  candidate_set_hash: '후보군 식별값',
  proposal_id: '제안 식별값',
  proposed_name: '제안 소분류명',
  proposal_reason: '제안 사유',
  recommended_middle_category_id: '추천 중분류',
  action: '처리',
  resolved_small_category_id: '처리된 소분류',
  rejection_reason: '반려 사유',
  request_type: '요청 유형',
  evidence_scope: '근거 범위',
  import_batch_id: '가져오기 묶음',
  source_as_of_date: '자료 기준일',
  member_project_ids: '연계 사업',
  member_evidence_count: '근거자료 수',
  next_mode: '변경 후 운영 모드',
  previous_mode: '변경 전 운영 모드',
  event_type: '거래 유형',
  materialized_record_id: '생성된 기록',
  materialized_table: '생성된 자료',
  request_fingerprint: '요청 식별값',
  budget_cohort_id: '예산 회차',
  movement_id: '재원 이동 기록',
  project_code: '사업코드',
  source_lot_id: '출처 대기재원',
  destination_project_id: '배분 대상 사업',
  lot_id: '대기재원',
  remaining_amount: '남은 금액',
  classification_id: '감액 분류',
  decrease_amount_before: '변경 전 감액액',
  decrease_amount_after: '변경 후 감액액',
  canonical_record_id: '기준 기록',
  canonical_table: '기준 자료',
  financial_budget_change_requests: '예산 조정 요청',
  financial_pending_new_project_link_requests: '신규사업 예정재원 연결 요청',
  financial_pending_new_project_funds: '신규사업 예정재원',
  destination_count: '목적지 수',
  gap_amount: '차액',
  pending_fund_id: '신규사업 예정재원',
  source_request_id: '출처 예산 조정',
};

const ACTION_LABELS: Record<string, string> = {
  UPDATE_CLASSIFICATION: '사업 분류 수정',
  UPDATE_EXEC: '집행액 수정',
  SAVE_MY_PROJECT: '사업 정보 저장',
  SAVE_MY_PROJECT_DRAFT: '사업 정보 임시저장',
  REVIEW_CUSTOM_SMALL_CATEGORY: '사용자 입력 소분류 검토',
  PROMOTE_CUSTOM_SMALL_CATEGORY: '사용자 입력 소분류 표준 등록',
  CREATE_BUDGET_COHORT: '예산 회차 생성',
  TRANSFER_DRAFTED: '사업간 예산조정 임시저장',
  TRANSFER_SUBMITTED: '사업간 예산조정 신청',
  TRANSFER_CONFIRMED: '사업간 예산조정 승인',
  TRANSFER_REJECTED: '사업간 예산조정 반려',
  TRANSFER_WITHDRAWN: '사업간 예산조정 철회',
  TRANSFER_REVERSAL_SUBMITTED: '사업간 예산조정 취소 신청',
  EXECUTION_CONFIRMED: '집행 확정',
  EXECUTION_REVERSED: '집행 취소',
  CARRYOVER_CONFIRMED: '이월 확정',
  CARRYOVER_REVERSED: '이월 취소',
  BUDGET_ADJUSTMENT_CONFIRMED: '예산 조정 확정',
  BUDGET_ADJUSTMENT_REVERSED: '예산 조정 취소',
  UPDATE_PROJECT_METADATA: '사업 기본·분류 정보 수정',
  UPDATE_PROJECT_DELAY_REASON: '사업 지연 사유 수정',
  REVIEW_SIMILAR_PROJECT: '유사사업 관계 검토',
  SUBMIT_SMALL_CATEGORY_PROPOSAL: '소분류 제안 제출',
  REVIEW_SMALL_CATEGORY_PROPOSAL: '소분류 제안 검토',
  FUNDING_REALLOCATION_DRAFTED: '감액·재배분 요청 작성',
  LEDGER_EVIDENCE_VERIFIED: '재정원장 근거자료 검증',
  LEDGER_LINEAGE_CREATED: '사업 연계관계 생성',
  LEDGER_LINEAGE_VERIFIED: '사업 연계관계 검증',
  LEDGER_RUNTIME_MODE_CHANGED: '재정원장 운영 모드 변경',
  LEGACY_RECONSTRUCTION_SUBMITTED: '과거거래 복원 제출',
  LEGACY_RECONSTRUCTION_VERIFIED: '과거거래 복원 검증',
  LEGACY_RECONSTRUCTION_APPLIED: '과거거래 복원 적용',
  DECREASE_DELTA_MATERIALIZED: '감액 변동 반영',
  DECREASE_CLASSIFICATION_REVERSED: '감액 분류 취소',
  NEW_PROJECT_APPLIED: '신규사업 배분 적용',
  UNALLOCATED_FUND_LOT_CONFIRMED: '대기재원 확정',
  UNALLOCATED_FUND_ALLOCATED: '대기재원 배분',
  UNALLOCATED_FUND_RETURNED: '대기재원 반환',
  BUDGET_REALLOCATION_DRAFTED: '예산 조정 작성',
  BUDGET_REALLOCATION_SUBMITTED: '예산 조정 승인요청',
  BUDGET_REALLOCATION_APPLIED: '예산 조정 적용',
  BUDGET_REALLOCATION_REJECTED: '예산 조정 반려',
  TEST_UAT_BOOTSTRAP: '기준재원 자동 연결',
  PENDING_NEW_PROJECT_LINK_SUBMITTED: '신규사업 예정재원 연결 승인요청',
  PENDING_NEW_PROJECT_FUND_LINKED: '신규사업 예정재원 연결완료',
};

const CODE_LABELS: Record<string, string> = {
  PENDING_APPROVAL: '승인 대기',
  PENDING_REVIEW: '검토 대기',
  CONFIRMED: '확정',
  REJECTED: '반려',
  WITHDRAWN: '철회',
  REVERSED: '취소',
  CORRECTION_INCREASE: '정정 증액',
  CORRECTION_DECREASE: '정정 감액',
  EXTERNAL_INCREASE: '외부 증액',
  EXTERNAL_DECREASE: '외부 감액',
  PLANNED: '계획',
  ACTIVE: '진행 중',
  SAVE: '저장',
  DRAFT: '임시저장',
  APPROVE: '승인',
  MAP: '기존 분류에 연결',
  REJECT: '반려',
  DISABLED: '비활성',
  RECONCILIATION: '과거자료 검수',
  LEGACY_RECONSTRUCTION: '과거거래 복원',
  PROJECT_LINEAGE: '사업 연계관계',
  ALLOCATION: '배분',
  EXECUTION: '집행',
  CARRYOVER: '이월',
  CREATE_UNALLOCATED_LOT: '대기재원 생성',
  CREATE_DECREASE_TRANSFER: '감액 재배분',
  ALLOCATE_UNALLOCATED_EXISTING: '기존사업 재배분',
  RETURN_UNALLOCATED: '대기재원 반환',
  REVERSE_DECREASE_CLASSIFICATION: '감액 분류 취소',
  SIMILAR_NAME: '유사한 사업명',
  COMPLETED: '변경완료',
  REVIEW_REQUIRED: '확인 필요',
  SUBMITTED: '승인요청',
  VERIFIED: '검증완료',
  APPLIED: '적용완료',
  EXISTING_PROJECT: '기존사업',
  PENDING_NEW_PROJECT: '신규사업 예정',
  WAITING: '연결 대기',
  LINKED: '사업 연결완료',
  BUDGET_REALLOCATION: '예산 조정',
  ...PROJECT_NAME_CHANGE_BASIS_LABELS,
  ...PROJECT_NAME_CHANGE_REASON_LABELS,
  ...SIMILARITY_RELATIONSHIP_LABELS,
};

const TABLE_LABELS: Record<string, string> = {
  project_budget_cohorts: '예산 회차',
  project_carryovers: '이월 기록',
  project_execution_records: '집행 기록',
  project_fund_transfers: '사업간 예산조정 기록',
  financial_unallocated_fund_movements: '대기재원 이동 기록',
  financial_budget_change_requests: '예산 조정 요청',
  financial_pending_new_project_link_requests: '신규사업 예정재원 연결 요청',
  financial_pending_new_project_funds: '신규사업 예정재원',
};

const AMOUNT_KEYS = new Set([
  'original_alloc',
  'increase_amount',
  'decrease_amount',
  'alloc',
  'exec',
  'amount',
  'initial_allocation',
  'remaining_amount',
  'decrease_amount_before',
  'decrease_amount_after',
  'gap_amount',
]);

const CLASSIFICATION_KEYS = [
  'business_type',
  'large_category_id',
  'middle_category_id',
  'standard_small_category_ids',
  'custom_small_categories',
];

const MY_PROJECT_DETAIL_KEYS = [
  'detail_project_name',
  'project_period',
  'project_start_year',
  'status',
  'original_alloc',
  'increase_amount',
  'decrease_amount',
  'alloc',
  'exec',
  'rate',
  'related_projects',
];

function asRecord(value: unknown): AuditJsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as AuditJsonRecord
    : null;
}

function parseAuditJson(value: string | null) {
  if (!value || !/^[\[{]/.test(value.trim())) {
    return null;
  }
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function exactJsonInteger(rawValue: string, key: string) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matched = rawValue.match(new RegExp(`"${escapedKey}"\\s*:\\s*(-?\\d+)(?:\\s*[,}])`));
  return matched?.[1] ?? null;
}

function findCategoryName(id: string, master: ProjectCategoryMaster | null, category: 'large' | 'middle' | 'small') {
  if (!master) return '분류명 확인 필요';
  const rows = category === 'large'
    ? master.largeCategories
    : category === 'middle'
      ? master.middleCategories
      : master.smallCategories;
  return rows.find((row) => row.id === id)?.name ?? '삭제되었거나 알 수 없는 분류';
}

function formatArray(value: unknown, emptyText = '없음') {
  if (!Array.isArray(value)) return emptyText;
  return value.length ? `${value.length.toLocaleString('ko-KR')}건` : emptyText;
}

function formatCustomSmallCategories(value: unknown, master: ProjectCategoryMaster | null) {
  if (!Array.isArray(value) || value.length === 0) return '없음';
  const labels = value.flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const inputValue = record.input_value ?? record.inputValue;
    if (typeof inputValue === 'string' && inputValue.trim()) {
      return [sanitizeClassificationNameForDisplay(inputValue.trim())];
    }
    const suggestedId = record.suggested_small_category_id ?? record.suggestedSmallCategoryId;
    return typeof suggestedId === 'string'
      ? [findCategoryName(suggestedId, master, 'small')]
      : [];
  });
  return labels.length ? labels.join(', ') : `${value.length.toLocaleString('ko-KR')}건`;
}

function formatKnownCode(value: string) {
  const known = CODE_LABELS[value.toUpperCase()] ?? TABLE_LABELS[value];
  if (known) return known;
  return /^[A-Z][A-Z0-9_]*$/.test(value) ? '확인 필요' : value;
}

function formatClassificationSnapshot(value: unknown, master: ProjectCategoryMaster | null) {
  const record = asRecord(value);
  if (!record) return '세부 내역 있음';

  const largeName = typeof record.large_category_name === 'string' && record.large_category_name.trim()
    ? record.large_category_name.trim()
    : typeof record.large_category_id === 'string'
      ? findCategoryName(record.large_category_id, master, 'large')
      : null;
  const middleName = typeof record.middle_category_name === 'string' && record.middle_category_name.trim()
    ? record.middle_category_name.trim()
    : typeof record.middle_category_id === 'string'
      ? findCategoryName(record.middle_category_id, master, 'middle')
      : null;
  const smallName = typeof record.primary_small_category_name === 'string'
    && record.primary_small_category_name.trim()
    ? record.primary_small_category_name.trim()
    : typeof record.primary_small_category_id === 'string'
      ? findCategoryName(record.primary_small_category_id, master, 'small')
      : null;
  const hierarchy = [largeName, middleName, smallName].filter(Boolean).join(' > ');
  const businessType = typeof record.business_type === 'string'
    ? isBusinessType(record.business_type)
      ? BUSINESS_TYPE_LABELS[record.business_type]
      : formatKnownCode(record.business_type)
    : null;
  return [hierarchy || '분류 미설정', businessType].filter(Boolean).join(' · ');
}

function formatValue(
  key: string,
  value: unknown,
  master: ProjectCategoryMaster | null,
  rawValue: string,
) {
  if (value === null || value === undefined || value === '') return '미설정';
  if (['name', 'detail_project_name', 'fund_project_name', 'project_name', 'old_name', 'new_name',
    'source_project_name', 'destination_project_name', 'planned_project_name'].includes(key)
      && typeof value === 'string') {
    return sanitizeProjectNameForDisplay(value);
  }
  if (key === 'proposed_name' && typeof value === 'string') {
    return sanitizeClassificationNameForDisplay(value);
  }
  if (['proposal_reason', 'rejection_reason', 'resolution_note', 'execution_status_reason', 'delay_reason', 'detail']
    .includes(key) && typeof value === 'string') {
    return formatStoredUserText(value, '내용 확인 필요');
  }
  if (AMOUNT_KEYS.has(key)) {
    const preciseValue = exactJsonInteger(rawValue, key) ?? String(value);
    return `${formatAuditAmount(preciseValue) ?? preciseValue}원`;
  }
  if (key === 'business_type' && typeof value === 'string') {
    return isBusinessType(value) ? BUSINESS_TYPE_LABELS[value] : value;
  }
  if (key === 'large_category_id' && typeof value === 'string') return findCategoryName(value, master, 'large');
  if (key === 'middle_category_id' && typeof value === 'string') return findCategoryName(value, master, 'middle');
  if (key === 'standard_small_category_ids') {
    if (!Array.isArray(value) || value.length === 0) return '없음';
    return value.map((id) => typeof id === 'string' ? findCategoryName(id, master, 'small') : '-').join(', ');
  }
  if (key === 'custom_small_categories') return formatCustomSmallCategories(value, master);
  if (key === 'related_projects') return formatArray(value);
  if (key === 'classification') return formatClassificationSnapshot(value, master);
  if (key === 'change_reason_codes' && Array.isArray(value)) {
    const labels = value
      .filter((item): item is string => typeof item === 'string')
      .map(formatKnownCode);
    return labels.length ? labels.join(', ') : '없음';
  }
  if (key === 'rate' && typeof value === 'number') return `${value.toFixed(2)}%`;
  if (Array.isArray(value)) return formatArray(value);
  if (typeof value === 'object') return '세부 내역 있음';
  if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return '내부 식별값';
  }
  return typeof value === 'string' ? formatKnownCode(value) : String(value);
}

export function formatAuditFieldName(fieldName: string | null) {
  if (!fieldName) return '변경 항목';
  return FIELD_LABELS[fieldName] ?? '기타 변경 항목';
}

export function formatAuditAction(action: string | null) {
  if (!action) return '변경';
  return ACTION_LABELS[action] ?? '기타 변경';
}

function preferredKeys(fieldName: string | null, record: AuditJsonRecord) {
  const preferred = fieldName === 'project_classification'
    ? CLASSIFICATION_KEYS
    : fieldName === 'my_project_details' || fieldName === 'my_project_nonfinancial_details'
      ? MY_PROJECT_DETAIL_KEYS
      : Object.keys(record);
  return preferred.filter((key) => Object.prototype.hasOwnProperty.call(record, key));
}

export function getAuditDisplayItems(
  fieldName: string | null,
  rawValue: string | null,
  master: ProjectCategoryMaster | null,
): AuditDisplayItem[] {
  if (rawValue === null || rawValue.trim() === '') {
    return [{ label: '', value: '-' }];
  }

  const record = parseAuditJson(rawValue);
  if (!record) {
    const isAmount = AMOUNT_KEYS.has(fieldName ?? '') && /^-?\d+$/.test(rawValue);
    return [{
      label: '',
      value: isAmount
        ? `${formatAuditAmount(rawValue) ?? rawValue}원`
        : formatValue(fieldName ?? '', rawValue, master, rawValue),
      isAmount,
    }];
  }

  const payload = asRecord(record.payload);
  const displayRecord = payload ?? record;
  return preferredKeys(fieldName, displayRecord).map((key) => ({
    label: FIELD_LABELS[key] ?? '기타 항목',
    value: formatValue(key, displayRecord[key], master, rawValue),
    isAmount: AMOUNT_KEYS.has(key),
  }));
}
