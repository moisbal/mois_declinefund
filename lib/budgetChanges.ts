import { isProjectStatus, validateExecutionStatusReason, type ProjectStatus } from './myProjectEdit.ts';
import { formatWonWithUnit } from './amountFormat.ts';

export type BudgetChangeStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'APPLIED' | 'DUPLICATE';
export type PendingFundStatus = 'WAITING' | 'LINKED';
export type BudgetChangeDestinationType = 'EXISTING_PROJECT' | 'PENDING_NEW_PROJECT';

export type RequestReviewMetadata = {
  database_status?: Exclude<BudgetChangeStatus, 'DUPLICATE'> | null;
  requested_by_name?: string | null;
  approved_by_name?: string | null;
  approved_at?: string | null;
  rejected_by_name?: string | null;
  rejected_at?: string | null;
  applied_by_name?: string | null;
  applied_at?: string | null;
};

export type BudgetChangeCandidate = {
  project_id: string;
  fiscal_year: number;
  project_code: string | null;
  project_name: string;
  source_budget_year_id: string | null;
  available_amount: string;
};

export type BudgetChangeDestinationInput = {
  destination_type: BudgetChangeDestinationType;
  amount: string;
  create_unlinked_funding?: boolean;
  destination_project_id?: string;
  existing_new_project_request_id?: string;
  planned_project_name?: string;
  planned_project_year?: number;
  planned_fund_project_name?: string;
  planned_detail_project_name?: string;
  planned_project_period?: string;
  planned_project_start_year?: number;
  planned_project_end_year?: number;
  planned_project_status?: ProjectStatus;
  planned_execution_status_reason?: string;
  planned_business_type?: 'HW' | 'SW' | 'COMPOSITE';
  planned_large_category_id?: string;
  planned_middle_category_id?: string;
  note?: string;
};

export type AttachableNewProjectDraft = {
  id: string;
  region_id: string;
  fiscal_year: number;
  project_name: string;
  fund_project_name: string | null;
  detail_project_name: string | null;
  project_period: string | null;
  project_start_year: number | null;
  project_end_year: number | null;
  project_status: ProjectStatus | null;
  execution_status_reason: string | null;
  business_type: 'HW' | 'SW' | 'COMPOSITE' | null;
  large_category_id: string | null;
  middle_category_id: string | null;
  requested_amount: string;
  status: 'DRAFT';
  created_at: string;
};

export type BudgetChangeDestination = BudgetChangeDestinationInput & {
  line_id: string;
  line_no: number;
  destination_project_code: string | null;
  destination_project_name: string | null;
  pending_fund_id: string | null;
  new_project_request_id: string | null;
  new_project_request_status: BudgetChangeStatus | null;
  official_project_code: string | null;
  materialized_project_id: string | null;
  materialized_project_code: string | null;
  materialized_project_name: string | null;
  current_destination_project_id?: string | null;
  current_destination_project_code?: string | null;
  current_destination_project_name?: string | null;
  correction_count?: number;
  correction_allowed?: boolean;
  correction_block_reason?: string | null;
  last_correction_reason?: string | null;
  last_corrected_at?: string | null;
};

export type BudgetChangeDestinationState = {
  request_id: string;
  line_id: string;
  current_destination_project_id: string | null;
  current_destination_project_code: string | null;
  current_destination_project_name: string | null;
  correction_count: number;
  correction_allowed: boolean;
  correction_block_reason: string | null;
  last_correction_reason: string | null;
  last_corrected_at: string | null;
};

export type BudgetAmountSnapshot = {
  original_allocation: string;
  increase_amount: string;
  decrease_amount: string;
  adjusted_allocation: string;
  execution_amount: string;
  unexecuted_amount: string;
};

export type BudgetWorkflowAmountChange = {
  event_type: 'BUDGET_CHANGE' | 'PENDING_LINK';
  event_id: string;
  project_id: string;
  fiscal_year: number;
  project_code: string | null;
  project_name: string;
  role: 'SOURCE' | 'DESTINATION';
  amount: string;
  capture_kind: 'EXACT_AT_APPLY' | 'DERIVED_CURRENT' | 'PROPOSED';
  before: BudgetAmountSnapshot;
  after: BudgetAmountSnapshot;
};

export type BudgetWorkflowStep = {
  line_id: string;
  workflow_group_id: string;
  pending_fund_id: string | null;
  pending_status: PendingFundStatus | null;
  new_project_request_id: string | null;
  new_project_request_status: BudgetChangeStatus | null;
  link_request_id: string | null;
  link_request_status: BudgetChangeStatus | null;
  materialized_project_id: string | null;
  materialized_project_code: string | null;
  materialized_project_name: string | null;
};

export type BudgetChangeRequest = RequestReviewMetadata & {
  id: string;
  region_id: string;
  fiscal_year: number;
  source_project_id: string;
  source_project_code: string | null;
  source_project_name: string;
  total_amount: string;
  decrease_amount_before: string;
  decrease_amount_after: string;
  effective_date: string;
  reason: string;
  status: BudgetChangeStatus;
  requested_by: string;
  requested_at: string;
  rejection_reason: string | null;
  destinations: BudgetChangeDestination[];
  sido?: string | null;
  sigungu?: string | null;
  region_name?: string | null;
  amount_changes?: BudgetWorkflowAmountChange[];
  workflow_steps?: BudgetWorkflowStep[];
};

export type PendingNewProjectFund = {
  id: string;
  source_lot_id: string;
  region_id: string;
  fiscal_year: number;
  planned_project_name: string;
  planned_project_year: number;
  amount: string;
  status: PendingFundStatus;
  source_project_id: string;
  source_project_code: string | null;
  source_project_name: string;
  source_request_id: string;
  new_project_request_id: string | null;
  linked_project_id: string | null;
  linked_project_code: string | null;
  linked_project_name: string | null;
  created_at: string;
  linked_at: string | null;
  sido?: string | null;
  sigungu?: string | null;
  region_name?: string | null;
};

export type PendingNewProjectLinkRequest = RequestReviewMetadata & {
  id: string;
  pending_fund_id: string;
  region_id: string;
  destination_project_id: string;
  destination_project_code: string | null;
  destination_project_name: string;
  planned_project_name: string;
  planned_project_year: number;
  amount: string;
  status: BudgetChangeStatus;
  requested_by: string;
  requested_at: string;
  rejection_reason: string | null;
  sido?: string | null;
  sigungu?: string | null;
  region_name?: string | null;
};

export type BudgetChangeNewProjectRequest = RequestReviewMetadata & {
  id: string;
  region_id: string;
  fiscal_year: number;
  project_name: string;
  project_status: ProjectStatus | null;
  execution_status_reason: string | null;
  requested_amount: string;
  source_lot_id: string | null;
  source_budget_change_request_id: string | null;
  source_budget_change_line_id: string | null;
  status: BudgetChangeStatus;
  official_project_code: string | null;
  requested_at: string;
  rejection_reason: string | null;
  materialized_project_id: string | null;
  materialized_project_code: string | null;
  materialized_project_name: string | null;
  pending_fund_id: string | null;
  pending_status: PendingFundStatus | null;
  source_request_id: string | null;
  source_project_id: string | null;
  source_project_code: string | null;
  source_project_name: string | null;
  source_fiscal_year: number | null;
  link_request_id: string | null;
  link_request_status: BudgetChangeStatus | null;
  workflow_group_id: string;
  sido?: string | null;
  sigungu?: string | null;
  region_name?: string | null;
};

export type BudgetChangeProjectPosition = {
  project_id: string;
  original_allocation: string;
  increase_amount: string;
  decrease_amount: string;
  adjusted_allocation: string;
  execution_amount: string;
  unexecuted_amount: string;
  execution_rate: number;
  valid_execution: boolean;
};

export type BudgetChangeStatistics = {
  transfer_amount: string;
  transfer_count: string;
  new_project_allocated_amount: string;
  new_project_allocated_count: string;
  pending_new_project_amount: string;
  pending_new_project_count: string;
  applied_request_count: string;
  transaction_gap_amount: string;
};

export function calculateBudgetChangeGap(totalAmount: string, destinations: Array<Pick<BudgetChangeDestinationInput, 'amount'>>) {
  const total = /^\d+$/.test(totalAmount) ? BigInt(totalAmount) : BigInt(0);
  const allocated = destinations.reduce(
    (sum, destination) => sum + (/^\d+$/.test(destination.amount) ? BigInt(destination.amount) : BigInt(0)),
    BigInt(0),
  );
  return {
    total: total.toString(),
    allocated: allocated.toString(),
    gap: (total - allocated).toString(),
    balanced: total > BigInt(0) && total === allocated,
  };
}

function parsedNonNegativeAmount(value: string) {
  return /^\d+$/.test(value) ? BigInt(value) : BigInt(0);
}

export function getNextBudgetChangeFiscalYear(
  currentFiscalYear: number | string | null | undefined,
  fallbackFiscalYear = new Date().getFullYear(),
) {
  const normalized = Number(currentFiscalYear);
  return (Number.isInteger(normalized) ? normalized : fallbackFiscalYear) + 1;
}

export function calculateBudgetDestinationMaximum<T extends { key: string; amount: string }>(
  totalAmount: string,
  destinations: T[],
  currentKey: string,
) {
  const total = parsedNonNegativeAmount(totalAmount);
  const otherAllocated = destinations.reduce(
    (sum, destination) => destination.key === currentKey
      ? sum
      : sum + parsedNonNegativeAmount(destination.amount),
    BigInt(0),
  );
  return (total > otherAllocated ? total - otherAllocated : BigInt(0)).toString();
}

export function replaceBudgetDestination<T extends { key: string }>(
  destinations: T[],
  currentKey: string,
  replacement: T,
) {
  return destinations.map((destination) => destination.key === currentKey ? replacement : destination);
}

export function getBudgetDestinationAddDisabledReason(input: {
  totalAmount: string;
  destinations: Array<Pick<BudgetChangeDestinationInput, 'amount'>>;
  destinationCount: number;
  editable: boolean;
  hasFatalDestinationError: boolean;
}) {
  if (!input.editable) return '제출되었거나 현재 권한으로 수정할 수 없는 요청입니다.';
  if (parsedNonNegativeAmount(input.totalAmount) <= BigInt(0)) return '먼저 감액 요청액을 입력해 주세요.';
  if (input.destinationCount >= 20) return '목적지는 최대 20개까지 추가할 수 있습니다.';
  if (input.hasFatalDestinationError) return '현재 목적지의 필수값과 배분액을 먼저 확인해 주세요.';
  const gap = BigInt(calculateBudgetChangeGap(input.totalAmount, input.destinations).gap);
  if (gap <= BigInt(0)) return gap === BigInt(0)
    ? '배분할 금액이 없습니다.'
    : '목적지 배분액 합계가 감액 요청액을 초과했습니다.';
  return null;
}

export function calculateUnexecutedAmount(adjustedAllocation: string, executionAmount: string) {
  const adjusted = BigInt(adjustedAllocation || '0');
  const execution = BigInt(executionAmount || '0');
  return {
    unexecutedAmount: (adjusted - execution).toString(),
    valid: execution <= adjusted,
  };
}

export function calculateOfficialBudgetPosition(input: {
  originalAllocation: string;
  increaseAmount: string;
  decreaseAmount: string;
  executionAmount: string;
}) {
  const originalAllocation = BigInt(input.originalAllocation || '0');
  const increaseAmount = BigInt(input.increaseAmount || '0');
  const decreaseAmount = BigInt(input.decreaseAmount || '0');
  const executionAmount = BigInt(input.executionAmount || '0');
  const adjustedAllocation = originalAllocation + increaseAmount - decreaseAmount;
  const unexecutedAmount = adjustedAllocation - executionAmount;
  return {
    originalAllocation: originalAllocation.toString(),
    increaseAmount: increaseAmount.toString(),
    decreaseAmount: decreaseAmount.toString(),
    adjustedAllocation: adjustedAllocation.toString(),
    executionAmount: executionAmount.toString(),
    unexecutedAmount: unexecutedAmount.toString(),
    valid: adjustedAllocation >= BigInt(0) && executionAmount <= adjustedAllocation,
  };
}

export function calculatePendingBudgetChangeAmounts(
  projectId: string,
  requests: BudgetChangeRequest[],
) {
  let requestedDecrease = BigInt(0);
  let requestedIncrease = BigInt(0);
  for (const request of requests) {
    if (!['DRAFT', 'SUBMITTED', 'APPROVED'].includes(request.status)) continue;
    if (request.source_project_id === projectId) requestedDecrease += BigInt(request.total_amount);
    for (const destination of request.destinations) {
      const destinationId = destination.destination_project_id ?? destination.materialized_project_id;
      if (destinationId === projectId) requestedIncrease += BigInt(destination.amount);
    }
  }
  return {
    requestedDecrease: requestedDecrease.toString(),
    requestedIncrease: requestedIncrease.toString(),
  };
}

export function validateBudgetChangeMaximumDecrease(requestedAmount: string, unexecutedAmount: string) {
  if (!/^[1-9]\d*$/.test(requestedAmount)) return null;
  const parsedMaximum = /^-?\d+$/.test(unexecutedAmount) ? BigInt(unexecutedAmount) : BigInt(0);
  const maximum = parsedMaximum > BigInt(0) ? parsedMaximum : BigInt(0);
  if (BigInt(requestedAmount) <= maximum) return null;
  return `현재 미집행액을 초과하여 감액할 수 없습니다. 최대 감액 가능액은 ${formatWonWithUnit(maximum.toString())}입니다.`;
}

export function validateBudgetChangeDestinations(
  totalAmount: string,
  destinations: BudgetChangeDestinationInput[],
) {
  if (!/^[1-9]\d*$/.test(totalAmount)) return '조정 금액은 0보다 큰 원 단위 정수여야 합니다.';
  if (destinations.length === 0 || destinations.length > 20) return '목적지를 1개 이상 20개 이하로 추가해 주세요.';
  const destinationKeys = new Set<string>();
  for (const destination of destinations) {
    if (!/^[1-9]\d*$/.test(destination.amount)) return '모든 목적지 금액은 0보다 커야 합니다.';
    if (destination.destination_type === 'EXISTING_PROJECT' && !destination.destination_project_id) {
      return '배분할 기존사업을 선택해 주세요.';
    }
    if (destination.destination_type === 'PENDING_NEW_PROJECT'
        && (!destination.planned_project_name?.trim() || !destination.planned_project_year)) {
      return '신규사업 예정명과 예정연도를 입력해 주세요.';
    }
    if (destination.destination_type === 'PENDING_NEW_PROJECT'
        && destination.planned_project_start_year != null
        && destination.planned_project_end_year != null
        && destination.planned_project_start_year > destination.planned_project_end_year) {
      return '신규사업의 시작연도는 종료연도보다 늦을 수 없습니다.';
    }
    const registeredPrefix = 'REGISTERED_NEXT_YEAR_PROJECT:';
    if (destination.destination_type === 'PENDING_NEW_PROJECT'
        && !destination.create_unlinked_funding
        && !destination.note?.startsWith(registeredPrefix)) {
      if (!isProjectStatus(destination.planned_project_status)) return '신규사업의 집행상태를 선택해 주세요.';
      const reasonError = validateExecutionStatusReason(
        destination.planned_project_status,
        destination.planned_execution_status_reason ?? '',
      );
      if (reasonError) return reasonError;
    }
    const destinationKey = destination.destination_type === 'EXISTING_PROJECT'
      ? `EXISTING:${destination.destination_project_id}`
      : destination.create_unlinked_funding
        ? `UNLINKED:${destination.planned_project_year}:${destination.planned_project_name?.trim().toLocaleLowerCase('ko-KR')}`
      : destination.existing_new_project_request_id
        ? `DRAFT:${destination.existing_new_project_request_id}`
      : destination.note?.startsWith(registeredPrefix)
        ? `REGISTERED:${destination.note.slice(registeredPrefix.length)}`
        : `PLANNED:${destination.planned_project_year}:${destination.planned_project_name?.trim().toLocaleLowerCase('ko-KR')}`;
    if (destinationKeys.has(destinationKey)) return '같은 목적지를 중복하여 선택할 수 없습니다.';
    destinationKeys.add(destinationKey);
  }
  return calculateBudgetChangeGap(totalAmount, destinations).balanced
    ? null
    : '감액액과 목적지 배분 합계의 차액은 0원이어야 합니다.';
}
