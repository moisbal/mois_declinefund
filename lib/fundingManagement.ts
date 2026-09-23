import { formatSystemTerm } from './presentationLabels.ts';

export type LedgerRuntimeMode = 'DISABLED' | 'RECONCILIATION' | 'TEST';

export type FundingRuntime = {
  environment_kind: 'TEST' | 'PRODUCTION';
  mode: LedgerRuntimeMode;
  baseline_as_of: string;
  native_start_date: string;
};

export type FundingOrigin = 'LEGACY_EXCEL' | 'SYSTEM_NATIVE';

export type UnclassifiedDecrease = {
  project_id: string;
  project_code: string | null;
  project_name: string;
  region_id: string;
  sido?: string | null;
  sigungu?: string | null;
  fiscal_year: number;
  decrease_amount: string;
  classified_amount: string;
  unclassified_amount: string;
};

export type UnallocatedFundLot = {
  id: string;
  region_id: string;
  fiscal_year: number;
  budget_cohort_id: string;
  source_project_id: string;
  source_budget_year_id: string;
  source_project_code: string | null;
  source_project_name: string;
  original_amount: string;
  allocated_amount: string;
  returned_amount: string;
  remaining_amount: string;
  status: string;
  reason: string | null;
  origin: FundingOrigin;
  created_at: string;
};

export type NewProjectFundingSource = {
  pending_fund_id: string;
  source_lot_id: string;
  region_id: string;
  source_fiscal_year: number;
  target_fiscal_year: number;
  planned_project_name: string;
  amount: string;
  remaining_amount: string;
  pending_status: 'WAITING';
  source_project_id: string;
  source_project_code: string | null;
  source_project_name: string;
  claimed_request_id: string | null;
  claimed_request_status: 'DRAFT' | null;
  created_at: string;
};

export type NewProjectRequest = {
  id: string;
  region_id: string;
  fiscal_year: number;
  project_name: string;
  fund_project_name: string | null;
  detail_project_name: string | null;
  project_period: string | null;
  project_start_year: number | null;
  project_end_year: number | null;
  project_status: '정상추진' | '지연' | '완료' | '추진곤란' | null;
  execution_status_reason: string | null;
  business_type: 'HW' | 'SW' | 'COMPOSITE' | null;
  requested_amount: string;
  source_lot_id: string | null;
  source_budget_change_request_id: string | null;
  source_budget_change_line_id: string | null;
  linked_from_standalone: boolean;
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'APPLIED';
  official_project_code: string | null;
  materialized_project_id: string | null;
  resolution_note: string | null;
  created_at: string;
  submitted_at: string | null;
};

export type FundingHistoryItem = {
  event_id: string;
  event_type: string;
  effective_date: string | null;
  amount: string;
  direction: 'IN' | 'OUT' | 'INFO';
  status: string;
  origin: FundingOrigin;
  budget_cohort_id: string | null;
  counterparty_project_id: string | null;
  counterparty_project_name: string | null;
  memo: string | null;
  created_at: string;
};

export type FundingTransferReview = {
  id: string;
  source_project_name?: string;
  destination_project_name?: string;
  amount: string;
  status: string;
  effective_date: string;
  requested_by: string | null;
  created_at: string;
};

export type FundingChangeRequestReview = {
  id: string;
  request_type: string;
  project_name: string | null;
  amount?: string;
  status: string;
  origin: FundingOrigin;
  requested_by: string;
  created_at: string;
};

export type FundingReallocationRequest = {
  id: string;
  request_type:
    | 'CREATE_UNALLOCATED_LOT'
    | 'ALLOCATE_UNALLOCATED_EXISTING'
    | 'RETURN_UNALLOCATED'
    | 'REVERSE_UNALLOCATED_MOVEMENT'
    | 'CREATE_DECREASE_TRANSFER'
    | 'CREATE_DIRECT_ADJUSTMENT'
    | 'REVERSE_DECREASE_CLASSIFICATION'
    | 'CLASSIFY_EXISTING_TRANSFER'
    | 'CLASSIFY_EXISTING_ADJUSTMENT';
  region_id: string;
  payload: Record<string, unknown>;
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'APPLIED';
  requested_by: string;
  requested_at: string;
  rejection_reason: string | null;
};

export type DecreaseClassificationCandidate = {
  id: string;
  kind: 'TRANSFER' | 'ADJUSTMENT';
  subtype: string;
  amount: string;
  effective_date: string;
};

export type CarryoverDestination = {
  destination_project_id: string;
  destination_project_code: string | null;
  destination_project_name: string;
  destination_fiscal_year: number;
  source_project_id: string;
  source_fiscal_year: number;
  funding_entry_id: string | null;
  lineage_id: string;
  evidence_id: string | null;
  expected_sequence: 1 | 2;
  expected_carryover_type: 'MYEONGSI' | 'SAGO';
  eligible: boolean;
  blocked_reason: string | null;
};

export type LegacyReconstructionReview = {
  id: string;
  event_type: string;
  project_id: string;
  destination_project_id: string | null;
  amount: string;
  effective_date: string;
  carryover_sequence: number | null;
  carryover_type: string | null;
  status: string;
  created_at: string;
  rejection_reason: string | null;
};

export type VerifiedLegacyEvidence = {
  evidence_id: string;
  region_id: string;
  source_file_name: string;
  source_sheet_name: string | null;
  source_row_reference: string | null;
  source_as_of_date: string | null;
  evidence_note: string | null;
};

export type DecreaseReversalCandidate = {
  classification_id: string;
  outcome_type: string;
  original_amount: string;
  reversed_amount: string;
  reversible_amount: string;
  canonical_table: string;
  canonical_record_id: string;
  source_budget_year_id: string;
  created_at: string;
};

export type ProjectFundingPosition = {
  project_id: string;
  region_id: string;
  fiscal_year: number;
  ledger_original_allocation: string;
  ledger_adjusted_allocation: string;
  ledger_increase_amount: string;
  ledger_decrease_amount: string;
  ledger_execution_amount: string;
  ledger_execution_rate: number;
  current_wallet_balance: string;
  unclassified_decrease_amount: string;
  projection_ready: boolean;
};

export type FundingCohortSummary = {
  cohort_id: string | null;
  funding_reference_id: string;
  region_id: string;
  project_id: string;
  origin_fiscal_year: number;
  initial_allocation: string;
  verified_cumulative_execution: string | null;
  execution_rate: number | null;
  current_wallet_balance: string | null;
  waiting_balance: string | null;
  external_return_amount: string | null;
  ledger_state: string;
};

export type FundingDashboard = {
  runtime: FundingRuntime | null;
  unclassifiedDecreases: UnclassifiedDecrease[];
  lots: UnallocatedFundLot[];
  newProjectFundingSources: NewProjectFundingSource[];
  newProjectRequests: NewProjectRequest[];
  transfers: FundingTransferReview[];
  changeRequests: FundingChangeRequestReview[];
  reallocationRequests: FundingReallocationRequest[];
  legacyReconstructions: LegacyReconstructionReview[];
  positions: ProjectFundingPosition[];
  cohortSummaries: FundingCohortSummary[];
};

export type FundingActionResult<T> =
  | { data: T; error?: never }
  | { data?: never; error: string };

export type DecreaseDisposition =
  | 'ALLOCATE_EXISTING_PROJECT'
  | 'ALLOCATE_NEW_PROJECT'
  | 'UNALLOCATED'
  | 'RETURN'
  | 'CORRECTION';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,99}$/;
const POSITIVE_AMOUNT_PATTERN = /^[1-9]\d*$/;
const MAX_BIGINT = BigInt('9223372036854775807');

export function isFundingUuid(value: string) {
  return UUID_PATTERN.test(value);
}

export function isFundingAmount(value: string) {
  return POSITIVE_AMOUNT_PATTERN.test(value) && BigInt(value) <= MAX_BIGINT;
}

export function isOfficialProjectCode(value: string) {
  return PROJECT_CODE_PATTERN.test(value.trim());
}

export function fundingRuntimeLabel(runtime: FundingRuntime | null) {
  if (!runtime) return '운영 상태 확인 불가';
  if (runtime.mode === 'RECONCILIATION') return `과거자료 검수 · ${runtime.baseline_as_of} 이전`;
  if (runtime.mode === 'TEST') return `신규 운영거래 시험 · ${runtime.native_start_date} 이후`;
  return '재정원장 쓰기 비활성';
}

export function canUseLegacyWorkflow(runtime: FundingRuntime | null) {
  return runtime?.environment_kind === 'TEST' && runtime.mode === 'RECONCILIATION';
}

export function canUseNativeWorkflow(runtime: FundingRuntime | null, effectiveDate: string) {
  return runtime?.environment_kind === 'TEST'
    && runtime.mode === 'TEST'
    && effectiveDate >= runtime.native_start_date;
}

export function unallocatedLotState(lot: Pick<UnallocatedFundLot, 'remaining_amount' | 'status'>) {
  if (lot.status === 'REVERSED') return '취소';
  if (BigInt(lot.remaining_amount) === BigInt(0)) return '처리 완료';
  return '재배분 대기';
}

export function fundingEventLabel(eventType: string) {
  const labels: Record<string, string> = {
    INITIAL_ALLOCATION: '최초배분',
    EXECUTION: '집행',
    EXECUTION_REVERSAL: '집행 정정',
    UNCLASSIFIED_DECREASE: '미분류 감액',
    UNALLOCATED_DEPOSIT: '대기재원 이동',
    ALLOCATE_EXISTING_PROJECT: '기존사업 재배분',
    ALLOCATE_NEW_PROJECT: '신규사업 재배분',
    TRANSFER_OUT: '타 사업 재배분',
    TRANSFER_IN: '대기재원 유입',
    RETURN: '반납/회수',
    MYEONGSI: '명시이월',
    SAGO: '사고이월',
    REVERSAL: '취소/정정',
  };
  return labels[eventType] ?? formatSystemTerm(eventType, '기타 재원 변동');
}

export function sumFundingAmounts(values: string[]) {
  return values.reduce((total, value) => total + BigInt(value || '0'), BigInt(0)).toString();
}

export function aggregateProjectFundingSummary(rows: Array<{
  total_budget_text?: string | null;
  alloc_text?: string | null;
  exec_text?: string | null;
}>) {
  const totalBudgetSum = rows.reduce(
    (total, row) => total + BigInt(row.total_budget_text ?? '0'),
    BigInt(0),
  );
  const allocSum = rows.reduce(
    (total, row) => total + BigInt(row.alloc_text ?? '0'),
    BigInt(0),
  );
  const execSum = rows.reduce(
    (total, row) => total + BigInt(row.exec_text ?? '0'),
    BigInt(0),
  );
  return {
    totalBudgetSum: totalBudgetSum.toString(),
    allocSum: allocSum.toString(),
    execSum: execSum.toString(),
    overallRate: allocSum > BigInt(0) ? (Number(execSum) / Number(allocSum)) * 100 : 0,
  };
}

/**
 * Returns the logical project decrease transition asserted by the atomic SQL
 * apply helper. Forward classification grows the classified delta; a linked
 * reversal reduces the currently confirmed Ledger delta.
 */
export function calculateDecreaseTransition(input: {
  currentLedgerDecreaseAmount: string;
  amount: string;
  reversal: boolean;
}) {
  const current = BigInt(input.currentLedgerDecreaseAmount || '0');
  const amount = BigInt(input.amount || '0');
  if (amount <= BigInt(0)) throw new Error('처리액은 0보다 커야 합니다.');
  if (input.reversal) {
    if (amount > current) throw new Error('정정액이 현재 감액액을 초과합니다.');
    return { before: current.toString(), after: (current - amount).toString() };
  }
  return { before: current.toString(), after: (current + amount).toString() };
}

type FundingProjectAmounts = {
  id: string;
  original_alloc_text?: string | null;
  increase_amount_text?: string | null;
  decrease_amount_text?: string | null;
  alloc_text?: string | null;
  exec_text?: string | null;
  rate?: number | null;
  projection_ready?: boolean;
  ledger_managed?: boolean;
};

/**
 * Applies the Ledger compatibility projection only after all decrease deltas
 * are classified. Pre-existing unclassified projects deliberately retain the
 * projects-table values and their visible warning.
 */
export function overlayFundingPosition<T extends FundingProjectAmounts>(
  project: T,
  positions: ProjectFundingPosition[],
): T {
  const position = positions.find((item) => item.project_id === project.id);
  if (!position) return project;
  if (!position.projection_ready) {
    return { ...project, ledger_managed: true, projection_ready: false };
  }
  return {
    ...project,
    original_alloc_text: String(position.ledger_original_allocation),
    increase_amount_text: String(position.ledger_increase_amount),
    decrease_amount_text: String(position.ledger_decrease_amount),
    alloc_text: String(position.ledger_adjusted_allocation),
    exec_text: String(position.ledger_execution_amount),
    rate: Number(position.ledger_execution_rate),
    projection_ready: true,
    ledger_managed: true,
  };
}

export function overlayAnalyticsFundingPosition<T extends {
  id: string;
  originalAllocText: string | null;
  allocText: string | null;
  execText: string | null;
}>(project: T, positions: ProjectFundingPosition[]): T {
  const position = positions.find((item) => item.project_id === project.id);
  if (!position?.projection_ready) return project;
  return {
    ...project,
    originalAllocText: String(position.ledger_original_allocation),
    allocText: String(position.ledger_adjusted_allocation),
    execText: String(position.ledger_execution_amount),
  };
}
