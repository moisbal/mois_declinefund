"use server";

import { createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { isPublicDemoMode, PUBLIC_DEMO_DISABLED_MESSAGE } from '../../lib/demo-mode';
import { assertLedgerTestTarget } from '../../lib/ledgerRuntime';
import { formatUserFacingError } from '../../lib/presentationLabels';
import {
  isFundingAmount,
  isFundingUuid,
  type FundingActionResult,
  type FundingChangeRequestReview,
  type DecreaseClassificationCandidate,
  type CarryoverDestination,
  type FundingDashboard,
  type FundingHistoryItem,
  type FundingRuntime,
  type FundingReallocationRequest,
  type LegacyReconstructionReview,
  type VerifiedLegacyEvidence,
  type DecreaseReversalCandidate,
  type ProjectFundingPosition,
  type FundingCohortSummary,
  type FundingTransferReview,
  type NewProjectRequest,
  type NewProjectFundingSource,
  type UnallocatedFundLot,
  type UnclassifiedDecrease,
} from '../../lib/fundingManagement';
import { isProjectStatus, validateExecutionStatusReason } from '../../lib/myProjectEdit';

type AuthenticatedInput = { accessToken: string };

const RPC = {
  unclassifiedDecreases: 'get_financial_unclassified_decreases',
  unallocatedLots: 'get_financial_unallocated_fund_lots',
  newProjectFundingSources: 'get_financial_new_project_funding_sources',
  createReallocationRequest: 'financial_create_funding_reallocation_request',
  submitReallocationRequest: 'financial_submit_funding_reallocation_request',
  approveReallocationRequest: 'financial_approve_funding_reallocation_request',
  rejectReallocationRequest: 'financial_reject_funding_reallocation_request',
  applyReallocationRequest: 'financial_apply_funding_reallocation_request',
  saveNewProjectRequestDraft: 'financial_save_new_project_request_draft_v2',
  submitNewProjectRequest: 'financial_submit_new_project_request_v2',
  newProjectRequests: 'get_financial_new_project_requests',
  projectHistory: 'get_financial_project_funding_history',
  carryoverDestinations: 'get_financial_carryover_destinations',
  createChangeRequest: 'financial_create_ledger_change_request',
  approveChangeRequest: 'financial_approve_ledger_change_request',
  rejectChangeRequest: 'financial_reject_ledger_change_request',
  applyChangeRequest: 'financial_apply_ledger_change_request',
} as const;

function createFundingClient(accessToken: string) {
  if (isPublicDemoMode) throw new Error(PUBLIC_DEMO_DISABLED_MESSAGE);
  if (!accessToken || accessToken.length > 8_000) throw new Error('로그인 세션을 다시 확인해 주세요.');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Supabase 환경변수가 설정되지 않았습니다.');

  // The signed-in user's JWT is intentionally forwarded. RLS and every
  // SECURITY DEFINER RPC continue to derive auth.uid(); no service role is used.
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

function errorMessage(error: unknown) {
  return formatUserFacingError(error, '재원관리 처리 중 오류가 발생했습니다.');
}

async function read<T>(work: () => Promise<T>): Promise<FundingActionResult<T>> {
  try {
    return { data: await work() };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

async function mutate<T>(work: () => Promise<T>): Promise<FundingActionResult<T>> {
  return read(async () => {
    // Legacy UAT writes are allowed only against the verified TEST target.
    // This does not relax the existing SYSTEM_NATIVE LEDGER_MODE guard.
    assertLedgerTestTarget();
    const result = await work();
    revalidatePath('/my-projects');
    revalidatePath('/admin/funding');
    revalidatePath('/analytics');
    return result;
  });
}

function assertUuid(value: string, label: string) {
  if (!isFundingUuid(value)) throw new Error(`${label}이(가) 올바르지 않습니다.`);
}

function assertAmount(value: string, label = '금액') {
  if (!isFundingAmount(value)) throw new Error(`${label}은(는) 양의 원 단위 정수여야 합니다.`);
}

function requiredText(value: string, max: number, label: string) {
  const text = value.trim();
  if (!text) throw new Error(`${label}을(를) 입력하세요.`);
  if (text.length > max) throw new Error(`${label}은(는) ${max}자 이하여야 합니다.`);
  return text;
}

function optionalText(value: string, max: number, label: string) {
  const text = value.trim();
  if (text.length > max) throw new Error(`${label}은(는) ${max}자 이하여야 합니다.`);
  return text || null;
}

function assertNewProjectSchedule(
  projectPeriod: string,
  projectStartYear: number | null,
  projectEndYear: number | null,
) {
  if (projectStartYear === null || projectEndYear === null) {
    throw new Error('사업 시작연도와 종료연도를 모두 입력해 주세요.');
  }
  if (!Number.isInteger(projectStartYear) || !Number.isInteger(projectEndYear)
      || projectStartYear < 2000 || projectStartYear > 2200
      || projectEndYear < 2000 || projectEndYear > 2200) {
    throw new Error('사업 시작연도와 종료연도는 2000년부터 2200년 사이여야 합니다.');
  }
  if (projectStartYear > projectEndYear) {
    throw new Error('사업 시작연도는 종료연도보다 늦을 수 없습니다.');
  }
  const periodYears = projectPeriod.match(/(?:19|20|21|22)\d{2}/g)?.map(Number) ?? [];
  if (periodYears.length > 0
      && (periodYears[0] !== projectStartYear
        || periodYears[periodYears.length - 1] !== projectEndYear)) {
    throw new Error('사업기간에 표시된 연도와 시작·종료연도가 일치해야 합니다.');
  }
  return { projectStartYear, projectEndYear };
}

function normalizeLot(row: Record<string, unknown>): UnallocatedFundLot {
  const allocatedExisting = String(row.allocated_existing_amount ?? '0');
  const allocatedNew = String(row.allocated_new_amount ?? '0');
  return {
    id: String(row.lot_id),
    region_id: String(row.region_id),
    fiscal_year: Number(row.fiscal_year),
    budget_cohort_id: String(row.budget_cohort_id),
    source_project_id: String(row.source_project_id),
    source_budget_year_id: String(row.source_budget_year_id),
    source_project_code: row.source_project_code ? String(row.source_project_code) : null,
    source_project_name: String(row.source_project_name ?? '-'),
    original_amount: String(row.original_amount ?? '0'),
    allocated_amount: (BigInt(allocatedExisting) + BigInt(allocatedNew)).toString(),
    returned_amount: String(row.returned_amount ?? '0'),
    remaining_amount: String(row.remaining_amount ?? '0'),
    status: String(row.balance_status ?? 'OPEN'),
    reason: row.reason ? String(row.reason) : null,
    origin: row.record_origin as UnallocatedFundLot['origin'],
    created_at: String(row.created_at),
  };
}

function normalizeNewProjectRequest(row: Record<string, unknown>): NewProjectRequest {
  return {
    ...(row as unknown as NewProjectRequest),
    id: String(row.id),
    region_id: String(row.region_id),
    fiscal_year: Number(row.fiscal_year),
    project_name: String(row.project_name ?? '-'),
    fund_project_name: row.fund_project_name ? String(row.fund_project_name) : null,
    detail_project_name: row.detail_project_name ? String(row.detail_project_name) : null,
    project_period: row.project_period ? String(row.project_period) : null,
    project_start_year: row.project_start_year == null ? null : Number(row.project_start_year),
    project_end_year: row.project_end_year == null ? null : Number(row.project_end_year),
    project_status: isProjectStatus(row.project_status ? String(row.project_status) : null)
      ? String(row.project_status) as NewProjectRequest['project_status']
      : null,
    execution_status_reason: row.execution_status_reason ? String(row.execution_status_reason) : null,
    business_type: (row.business_type as NewProjectRequest['business_type']) ?? null,
    requested_amount: String(row.requested_amount ?? '0'),
    source_lot_id: row.source_lot_id ? String(row.source_lot_id) : null,
    source_budget_change_request_id: row.source_budget_change_request_id
      ? String(row.source_budget_change_request_id)
      : null,
    source_budget_change_line_id: row.source_budget_change_line_id
      ? String(row.source_budget_change_line_id)
      : null,
    linked_from_standalone: row.linked_from_standalone === true,
    status: row.status as NewProjectRequest['status'],
    official_project_code: row.official_project_code ? String(row.official_project_code) : null,
    materialized_project_id: row.materialized_project_id ? String(row.materialized_project_id) : null,
    resolution_note: row.rejection_reason ? String(row.rejection_reason) : null,
    created_at: String(row.requested_at ?? ''),
    submitted_at: row.submitted_at ? String(row.submitted_at) : null,
  };
}

function normalizeNewProjectFundingSource(row: Record<string, unknown>): NewProjectFundingSource {
  return {
    pending_fund_id: String(row.pending_fund_id),
    source_lot_id: String(row.source_lot_id),
    region_id: String(row.region_id),
    source_fiscal_year: Number(row.source_fiscal_year),
    target_fiscal_year: Number(row.target_fiscal_year),
    planned_project_name: String(row.planned_project_name ?? '신규사업 예정'),
    amount: String(row.amount ?? '0'),
    remaining_amount: String(row.remaining_amount ?? '0'),
    pending_status: 'WAITING',
    source_project_id: String(row.source_project_id),
    source_project_code: row.source_project_code ? String(row.source_project_code) : null,
    source_project_name: String(row.source_project_name ?? '사업명 확인 필요'),
    claimed_request_id: row.claimed_request_id ? String(row.claimed_request_id) : null,
    claimed_request_status: row.claimed_request_status === 'DRAFT' ? 'DRAFT' : null,
    created_at: String(row.created_at),
  };
}

function normalizeHistory(row: Record<string, unknown>): FundingHistoryItem {
  return {
    event_id: String(row.event_id),
    event_type: String(row.event_type),
    effective_date: row.event_date ? String(row.event_date) : null,
    amount: String(row.amount ?? '0'),
    direction: row.direction as FundingHistoryItem['direction'],
    status: 'CONFIRMED',
    origin: row.record_origin as FundingHistoryItem['origin'],
    budget_cohort_id: row.budget_cohort_id ? String(row.budget_cohort_id) : null,
    counterparty_project_id: row.related_project_id ? String(row.related_project_id) : null,
    counterparty_project_name: null,
    memo: row.memo ? String(row.memo) : null,
    created_at: String(row.created_at),
  };
}

function normalizeUnclassified(row: Record<string, unknown>): UnclassifiedDecrease {
  return {
    project_id: String(row.project_id),
    project_code: row.project_code ? String(row.project_code) : null,
    project_name: String(row.project_name ?? '-'),
    region_id: String(row.region_id),
    fiscal_year: Number(row.fiscal_year),
    decrease_amount: String(row.decrease_amount ?? '0'),
    classified_amount: String(row.classified_amount ?? '0'),
    unclassified_amount: String(row.unclassified_amount ?? '0'),
  };
}

function normalizePosition(row: Record<string, unknown>): ProjectFundingPosition {
  return {
    project_id: String(row.project_id),
    region_id: String(row.region_id),
    fiscal_year: Number(row.fiscal_year),
    ledger_original_allocation: String(row.ledger_original_allocation ?? '0'),
    ledger_adjusted_allocation: String(row.ledger_adjusted_allocation ?? '0'),
    ledger_increase_amount: String(row.ledger_increase_amount ?? '0'),
    ledger_decrease_amount: String(row.ledger_decrease_amount ?? '0'),
    ledger_execution_amount: String(row.ledger_execution_amount ?? '0'),
    ledger_execution_rate: Number(row.ledger_execution_rate ?? 0),
    current_wallet_balance: String(row.current_wallet_balance ?? '0'),
    unclassified_decrease_amount: String(row.unclassified_decrease_amount ?? '0'),
    projection_ready: Boolean(row.projection_ready),
  };
}

function normalizeCohort(row: Record<string, unknown>): FundingCohortSummary {
  return {
    cohort_id: row.cohort_id ? String(row.cohort_id) : null,
    funding_reference_id: String(row.funding_reference_id),
    region_id: String(row.region_id),
    project_id: String(row.project_id),
    origin_fiscal_year: Number(row.origin_fiscal_year),
    initial_allocation: String(row.initial_allocation ?? '0'),
    verified_cumulative_execution: row.verified_cumulative_execution == null ? null : String(row.verified_cumulative_execution),
    execution_rate: row.execution_rate == null ? null : Number(row.execution_rate),
    current_wallet_balance: row.current_wallet_balance == null ? null : String(row.current_wallet_balance),
    waiting_balance: row.waiting_balance == null ? null : String(row.waiting_balance),
    external_return_amount: row.external_return_amount == null ? null : String(row.external_return_amount),
    ledger_state: String(row.ledger_state),
  };
}

function normalizeTransferReview(row: Record<string, unknown>): FundingTransferReview {
  return {
    id: String(row.id),
    source_project_name: row.source_project_name ? String(row.source_project_name) : String(row.source_budget_year_id ?? '원천사업'),
    destination_project_name: row.destination_project_name ? String(row.destination_project_name) : String(row.destination_budget_year_id ?? '수신사업'),
    amount: String(row.amount ?? '0'),
    status: String(row.status),
    effective_date: String(row.effective_date ?? ''),
    requested_by: row.created_by ? String(row.created_by) : null,
    created_at: String(row.created_at ?? row.submitted_at ?? ''),
  };
}

function normalizeChangeRequest(row: Record<string, unknown>): FundingChangeRequestReview {
  const payload = (row.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<string, unknown>;
  return {
    id: String(row.id),
    request_type: String(row.request_type),
    project_name: payload.project_name ? String(payload.project_name) : null,
    amount: payload.amount == null ? undefined : String(payload.amount),
    status: String(row.status),
    origin: (payload.record_origin ?? 'SYSTEM_NATIVE') as FundingChangeRequestReview['origin'],
    requested_by: String(row.requested_by),
    created_at: String(row.requested_at ?? ''),
  };
}

function normalizeLegacyReview(row: Record<string, unknown>): LegacyReconstructionReview {
  return {
    id: String(row.id),
    event_type: String(row.event_type),
    project_id: String(row.project_id),
    destination_project_id: row.destination_project_id ? String(row.destination_project_id) : null,
    amount: String(row.amount ?? '0'),
    effective_date: String(row.effective_date ?? ''),
    carryover_sequence: row.carryover_sequence == null ? null : Number(row.carryover_sequence),
    carryover_type: row.carryover_type ? String(row.carryover_type) : null,
    status: String(row.status),
    created_at: String(row.created_at ?? ''),
    rejection_reason: row.rejection_reason ? String(row.rejection_reason) : null,
  };
}

export async function getFundingRuntimeAction(input: AuthenticatedInput): Promise<FundingActionResult<FundingRuntime | null>> {
  return read(async () => {
    const client = createFundingClient(input.accessToken);
    const { data, error } = await client
      .from('financial_ledger_runtime')
      .select('environment_kind, mode, baseline_as_of, native_start_date')
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as FundingRuntime | null) ?? null;
  });
}

export async function getProjectFundingPositionAction(input: AuthenticatedInput & {
  projectId: string;
}): Promise<FundingActionResult<{ position: ProjectFundingPosition | null; cohorts: FundingCohortSummary[] }>> {
  return read(async () => {
    assertUuid(input.projectId, '사업');
    const client = createFundingClient(input.accessToken);
    const [positions, wallets, cohorts] = await Promise.all([
      client.rpc('get_financial_project_funding_positions', { p_project_id: input.projectId }),
      client.rpc('get_financial_budget_years', {}),
      client.rpc('get_financial_funding_cohort_execution', {}),
    ]);
    if (positions.error) throw positions.error;
    if (wallets.error) throw wallets.error;
    if (cohorts.error) throw cohorts.error;
    const projectWallets = ((wallets.data ?? []) as Array<Record<string, unknown>>)
      .filter((row) => String(row.project_id) === input.projectId);
    const cohortIds = new Set(projectWallets.map((row) => String(row.budget_cohort_id)));
    return {
      position: ((positions.data ?? []) as Array<Record<string, unknown>>).map(normalizePosition)[0] ?? null,
      cohorts: ((cohorts.data ?? []) as Array<Record<string, unknown>>).map(normalizeCohort)
        .filter((cohort) => cohort.cohort_id && cohortIds.has(cohort.cohort_id)),
    };
  });
}

export async function getDecreaseClassificationCandidatesAction(input: AuthenticatedInput & {
  sourceBudgetYearIds: string[];
}): Promise<FundingActionResult<DecreaseClassificationCandidate[]>> {
  return read(async () => {
    input.sourceBudgetYearIds.forEach((id) => assertUuid(id, '원천 재원'));
    if (input.sourceBudgetYearIds.length === 0) return [];
    const client = createFundingClient(input.accessToken);
    const [transfers, adjustments] = await Promise.all([
      client.from('project_fund_transfers')
        .select('id, amount, effective_date, status, transaction_kind, source_budget_year_id')
        .in('source_budget_year_id', input.sourceBudgetYearIds)
        .eq('status', 'CONFIRMED')
        .eq('transaction_kind', 'NORMAL'),
      client.from('project_budget_adjustments')
        .select('id, amount, effective_date, adjustment_type, status, transaction_kind, budget_year_id')
        .in('budget_year_id', input.sourceBudgetYearIds)
        .eq('status', 'CONFIRMED')
        .eq('transaction_kind', 'NORMAL'),
    ]);
    if (transfers.error) throw transfers.error;
    if (adjustments.error) throw adjustments.error;
    return [
      ...((transfers.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
        id: String(row.id), kind: 'TRANSFER' as const, subtype: '기존사업 재배분',
        amount: String(row.amount), effective_date: String(row.effective_date),
      })),
      ...((adjustments.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
        id: String(row.id), kind: 'ADJUSTMENT' as const, subtype: String(row.adjustment_type),
        amount: String(row.amount), effective_date: String(row.effective_date),
      })),
    ];
  });
}

export async function getVerifiedLegacyEvidenceAction(
  input: AuthenticatedInput,
): Promise<FundingActionResult<VerifiedLegacyEvidence[]>> {
  return read(async () => {
    const client = createFundingClient(input.accessToken);
    const { data, error } = await client.rpc('get_financial_verified_legacy_evidence', { p_region_id: null });
    if (error) throw error;
    return (data ?? []) as VerifiedLegacyEvidence[];
  });
}

export async function getDecreaseReversalCandidatesAction(input: AuthenticatedInput & {
  projectId: string;
}): Promise<FundingActionResult<DecreaseReversalCandidate[]>> {
  return read(async () => {
    assertUuid(input.projectId, '사업');
    const client = createFundingClient(input.accessToken);
    const { data, error } = await client.rpc('get_financial_decrease_classifications', {
      p_project_id: input.projectId,
    });
    if (error) throw error;
    return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      classification_id: String(row.classification_id),
      outcome_type: String(row.outcome_type),
      original_amount: String(row.original_amount ?? '0'),
      reversed_amount: String(row.reversed_amount ?? '0'),
      reversible_amount: String(row.reversible_amount ?? '0'),
      canonical_table: String(row.canonical_table),
      canonical_record_id: String(row.canonical_record_id),
      source_budget_year_id: String(row.source_budget_year_id),
      created_at: String(row.created_at),
    }));
  });
}

export async function createDecreaseClassificationReversalRequestAction(input: AuthenticatedInput & {
  classificationId: string;
  amount: string;
  decreaseAmountBefore: string;
  decreaseAmountAfter: string;
  effectiveDate: string;
  evidenceId: string;
  memo: string;
  idempotencyKey: string;
}): Promise<FundingActionResult<{ request_id: string; status: string }>> {
  return mutate(async () => {
    assertUuid(input.classificationId, '원 감액처리');
    assertUuid(input.evidenceId, '검증완료 증빙');
    assertUuid(input.idempotencyKey, '요청 식별키');
    assertAmount(input.amount, '정정액');
    const client = createFundingClient(input.accessToken);
    const { data, error } = await client.rpc(RPC.createReallocationRequest, {
      p_request_type: 'REVERSE_DECREASE_CLASSIFICATION',
      p_payload: {
        classification_id: input.classificationId,
        amount: input.amount,
        decrease_amount_before: input.decreaseAmountBefore,
        decrease_amount_after: input.decreaseAmountAfter,
        effective_date: input.effectiveDate,
        record_origin: 'LEGACY_EXCEL',
        evidence_id: input.evidenceId,
        memo: optionalText(input.memo, 1000, '메모'),
      },
      p_idempotency_key: input.idempotencyKey,
      p_submit: true,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.request_id) throw new Error('감액 linked reversal 요청 결과를 반환받지 못했습니다.');
    return row as { request_id: string; status: string };
  });
}

export async function createDirectDecreaseDispositionRequestAction(input: AuthenticatedInput & {
  disposition: 'TRANSFER' | 'RETURN';
  sourceBudgetYearId: string;
  destinationProjectId?: string;
  amount: string;
  decreaseAmountBefore: string;
  decreaseAmountAfter: string;
  effectiveDate: string;
  evidenceId: string;
  reasonCode: string;
  memo: string;
  idempotencyKey: string;
}): Promise<FundingActionResult<{ request_id: string; status: string }>> {
  return mutate(async () => {
    assertUuid(input.sourceBudgetYearId, '원천 재원');
    assertUuid(input.idempotencyKey, '요청 식별키');
    assertUuid(input.evidenceId, '검증완료 증빙');
    assertAmount(input.amount, '처리 금액');
    if (input.disposition === 'TRANSFER') {
      if (!input.destinationProjectId) throw new Error('수신 기존사업을 선택하세요.');
      assertUuid(input.destinationProjectId, '수신 기존사업');
    }
    const client = createFundingClient(input.accessToken);
    const payload = {
      source_budget_year_id: input.sourceBudgetYearId,
      amount: input.amount,
      decrease_amount_before: input.decreaseAmountBefore,
      decrease_amount_after: input.decreaseAmountAfter,
      effective_date: input.effectiveDate,
      record_origin: 'LEGACY_EXCEL',
      evidence_id: input.evidenceId,
      reason_code: optionalText(input.reasonCode, 100, '사유 코드'),
      memo: optionalText(input.memo, 1000, '메모'),
      ...(input.disposition === 'TRANSFER'
        ? { destination_project_id: input.destinationProjectId }
        : { adjustment_type: 'RETURN' }),
    };
    const { data, error } = await client.rpc(RPC.createReallocationRequest, {
      p_request_type: input.disposition === 'TRANSFER' ? 'CREATE_DECREASE_TRANSFER' : 'CREATE_DIRECT_ADJUSTMENT',
      p_payload: payload,
      p_idempotency_key: input.idempotencyKey,
      p_submit: true,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.request_id) throw new Error('감액 재원처리 요청 결과를 반환받지 못했습니다.');
    return row as { request_id: string; status: string };
  });
}

export async function classifyExistingLedgerRecordAction(input: AuthenticatedInput & {
  recordKind: 'TRANSFER' | 'ADJUSTMENT';
  materializedRecordId: string;
  amount: string;
  decreaseAmountBefore: string;
  decreaseAmountAfter: string;
  idempotencyKey: string;
}): Promise<FundingActionResult<{ request_id: string; status: string }>> {
  return mutate(async () => {
    assertUuid(input.materializedRecordId, '원장 거래');
    assertUuid(input.idempotencyKey, '요청 식별키');
    assertAmount(input.amount, '분류 금액');
    const client = createFundingClient(input.accessToken);
    const { data, error } = await client.rpc(RPC.createReallocationRequest, {
      p_request_type: input.recordKind === 'TRANSFER' ? 'CLASSIFY_EXISTING_TRANSFER' : 'CLASSIFY_EXISTING_ADJUSTMENT',
      p_payload: {
        materialized_record_id: input.materializedRecordId,
        amount: input.amount,
        decrease_amount_before: input.decreaseAmountBefore,
        decrease_amount_after: input.decreaseAmountAfter,
      },
      p_idempotency_key: input.idempotencyKey,
      p_submit: true,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.request_id) throw new Error('기존 원장거래 분류요청 결과를 반환받지 못했습니다.');
    return row as { request_id: string; status: string };
  });
}

export async function getLocalFundingSnapshotAction(
  input: AuthenticatedInput & { projectId?: string; newProjectRequestId?: string },
): Promise<FundingActionResult<FundingDashboard & { history: FundingHistoryItem[] }>> {
  return read(async () => {
    if (input.projectId) assertUuid(input.projectId, '사업');
    if (input.newProjectRequestId) assertUuid(input.newProjectRequestId, '신규사업 요청');
    const client = createFundingClient(input.accessToken);
    const runtimeQuery = client.from('financial_ledger_runtime')
      .select('environment_kind, mode, baseline_as_of, native_start_date').limit(1).maybeSingle();
    const unclassifiedQuery = client.rpc(RPC.unclassifiedDecreases, {});
    const lotsQuery = client.rpc(RPC.unallocatedLots, { p_fiscal_year: null });
    const newProjectSourcesQuery = client.rpc(RPC.newProjectFundingSources, {
      p_year: null,
      p_request_id: input.newProjectRequestId ?? null,
    });
    const requestsQuery = client.rpc(RPC.newProjectRequests, { p_status: null });
    const [runtimeResult, unclassifiedResult, lotsResult, newProjectSourcesResult, requestsResult, positionsResult, cohortsResult] = await Promise.all([
      runtimeQuery,
      unclassifiedQuery,
      lotsQuery,
      newProjectSourcesQuery,
      requestsQuery,
      client.rpc('get_financial_project_funding_positions', { p_project_id: input.projectId ?? null }),
      client.rpc('get_financial_funding_cohort_execution', {}),
    ]);
    const firstError = runtimeResult.error || unclassifiedResult.error || lotsResult.error
      || newProjectSourcesResult.error || requestsResult.error
      || positionsResult.error || cohortsResult.error;
    if (firstError) throw firstError;

    let history: FundingHistoryItem[] = [];
    if (input.projectId) {
      const { data, error } = await client.rpc(RPC.projectHistory, { p_project_id: input.projectId });
      if (error) throw error;
      history = ((data ?? []) as Array<Record<string, unknown>>).map(normalizeHistory);
    }

    return {
      runtime: (runtimeResult.data as FundingRuntime | null) ?? null,
      unclassifiedDecreases: ((unclassifiedResult.data ?? []) as Array<Record<string, unknown>>).map(normalizeUnclassified),
      lots: ((lotsResult.data ?? []) as Array<Record<string, unknown>>).map(normalizeLot),
      newProjectFundingSources: ((newProjectSourcesResult.data ?? []) as Array<Record<string, unknown>>)
        .map(normalizeNewProjectFundingSource),
      newProjectRequests: ((requestsResult.data ?? []) as Array<Record<string, unknown>>).map(normalizeNewProjectRequest),
      transfers: [],
      changeRequests: [],
      reallocationRequests: [],
      legacyReconstructions: [],
      positions: ((positionsResult.data ?? []) as Array<Record<string, unknown>>).map(normalizePosition),
      cohortSummaries: ((cohortsResult.data ?? []) as Array<Record<string, unknown>>).map(normalizeCohort),
      history,
    };
  });
}

export async function getAdminFundingSnapshotAction(input: AuthenticatedInput): Promise<FundingActionResult<FundingDashboard>> {
  return read(async () => {
    const client = createFundingClient(input.accessToken);
    const [runtimeResult, unclassifiedResult, lotsResult, requestsResult, transfersResult, changesResult, reallocationsResult, legacyResult, positionsResult, cohortsResult] = await Promise.all([
      client.from('financial_ledger_runtime').select('environment_kind, mode, baseline_as_of, native_start_date').limit(1).maybeSingle(),
      client.rpc(RPC.unclassifiedDecreases, {}),
      client.rpc(RPC.unallocatedLots, { p_fiscal_year: null }),
      client.rpc(RPC.newProjectRequests, { p_status: null }),
      client.from('project_fund_transfers').select('*').order('created_at', { ascending: false }),
      client.from('financial_ledger_change_requests').select('*').order('requested_at', { ascending: false }),
      client.rpc('get_financial_funding_reallocation_requests', { p_status: null }),
      client.from('legacy_ledger_reconstruction_entries').select('*').order('created_at', { ascending: false }),
      client.rpc('get_financial_project_funding_positions', { p_project_id: null }),
      client.rpc('get_financial_funding_cohort_execution', {}),
    ]);
    const firstError = runtimeResult.error || unclassifiedResult.error || lotsResult.error
      || requestsResult.error || transfersResult.error || changesResult.error || reallocationsResult.error || legacyResult.error
      || positionsResult.error || cohortsResult.error;
    if (firstError) throw firstError;
    return {
      runtime: (runtimeResult.data as FundingRuntime | null) ?? null,
      unclassifiedDecreases: ((unclassifiedResult.data ?? []) as Array<Record<string, unknown>>).map(normalizeUnclassified),
      lots: ((lotsResult.data ?? []) as Array<Record<string, unknown>>).map(normalizeLot),
      newProjectFundingSources: [],
      newProjectRequests: ((requestsResult.data ?? []) as Array<Record<string, unknown>>).map(normalizeNewProjectRequest),
      transfers: ((transfersResult.data ?? []) as Array<Record<string, unknown>>).map(normalizeTransferReview),
      changeRequests: ((changesResult.data ?? []) as Array<Record<string, unknown>>).map(normalizeChangeRequest),
      reallocationRequests: (reallocationsResult.data ?? []) as FundingReallocationRequest[],
      legacyReconstructions: ((legacyResult.data ?? []) as Array<Record<string, unknown>>).map(normalizeLegacyReview),
      positions: ((positionsResult.data ?? []) as Array<Record<string, unknown>>).map(normalizePosition),
      cohortSummaries: ((cohortsResult.data ?? []) as Array<Record<string, unknown>>).map(normalizeCohort),
    };
  });
}

export async function getCarryoverDestinationsAction(input: AuthenticatedInput & {
  sourceBudgetYearId: string;
}): Promise<FundingActionResult<CarryoverDestination[]>> {
  return read(async () => {
    assertUuid(input.sourceBudgetYearId, '원천 재원');
    const client = createFundingClient(input.accessToken);
    const { data, error } = await client.rpc(RPC.carryoverDestinations, {
      p_source_budget_year_id: input.sourceBudgetYearId,
    });
    if (error) throw error;
    return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      destination_project_id: String(row.destination_project_id),
      destination_project_code: row.project_code ? String(row.project_code) : null,
      destination_project_name: String(row.project_name ?? '-'),
      destination_fiscal_year: Number(row.destination_fiscal_year),
      source_project_id: '',
      source_fiscal_year: Number(row.source_fiscal_year),
      funding_entry_id: row.funding_entry_id ? String(row.funding_entry_id) : null,
      lineage_id: String(row.lineage_id),
      evidence_id: null,
      expected_sequence: Number(row.expected_sequence) as 1 | 2,
      expected_carryover_type: row.expected_type as 'MYEONGSI' | 'SAGO',
      eligible: Boolean(row.available),
      blocked_reason: row.blocked_reason ? String(row.blocked_reason) : null,
    }));
  });
}

export async function resolveFundingReallocationRequestAction(input: AuthenticatedInput & {
  requestId: string;
  decision: 'APPROVE' | 'REJECT' | 'APPLY';
  resolutionNote: string;
}): Promise<FundingActionResult<{ request_id: string; status: string; materialized_table?: string; materialized_record_id?: string }>> {
  return mutate(async () => {
    assertUuid(input.requestId, '재원처리 요청');
    if (input.decision === 'REJECT' && !input.resolutionNote.trim()) throw new Error('반려 사유를 입력하세요.');
    const functionName = input.decision === 'APPROVE'
      ? RPC.approveReallocationRequest
      : input.decision === 'REJECT'
        ? RPC.rejectReallocationRequest
        : RPC.applyReallocationRequest;
    const client = createFundingClient(input.accessToken);
    const { data, error } = await client.rpc(functionName, {
      p_request_id: input.requestId,
      ...(input.decision === 'REJECT' ? { p_reason: requiredText(input.resolutionNote, 1000, '반려 사유') } : {}),
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return (row ?? {
      request_id: input.requestId,
      status: input.decision === 'REJECT' ? 'REJECTED' : 'APPROVED',
    }) as { request_id: string; status: string; materialized_table?: string; materialized_record_id?: string };
  });
}

export async function createUnallocatedLotRequestAction(input: AuthenticatedInput & {
  sourceBudgetYearId: string;
  amount: string;
  decreaseAmountBefore: string;
  decreaseAmountAfter: string;
  reason: string;
  effectiveDate: string;
  evidenceId?: string;
  idempotencyKey: string;
}): Promise<FundingActionResult<{ request_id: string; status: string }>> {
  return mutate(async () => {
    assertUuid(input.sourceBudgetYearId, '원천 재원');
    assertUuid(input.idempotencyKey, '요청 식별키');
    assertAmount(input.amount, '분류 금액');
    if (input.evidenceId) assertUuid(input.evidenceId, '증빙');
    const client = createFundingClient(input.accessToken);
    const { data, error } = await client.rpc(RPC.createReallocationRequest, {
      p_request_type: 'CREATE_UNALLOCATED_LOT',
      p_payload: {
        source_budget_year_id: input.sourceBudgetYearId,
        amount: input.amount,
        decrease_amount_before: input.decreaseAmountBefore,
        decrease_amount_after: input.decreaseAmountAfter,
        reason: requiredText(input.reason, 1000, '처리 사유'),
        effective_date: input.effectiveDate,
        record_origin: 'LEGACY_EXCEL',
        evidence_id: input.evidenceId || null,
      },
      p_idempotency_key: input.idempotencyKey,
      p_submit: true,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.request_id) throw new Error('감액 분류요청 결과를 반환받지 못했습니다.');
    return row as { request_id: string; status: string };
  });
}

export async function allocateUnallocatedFundAction(input: AuthenticatedInput & {
  lotId: string;
  destinationProjectId: string;
  amount: string;
  effectiveDate: string;
  evidenceId?: string;
  memo: string;
  idempotencyKey: string;
}): Promise<FundingActionResult<{ request_id: string; status: string }>> {
  return mutate(async () => {
    assertUuid(input.lotId, '대기재원');
    assertUuid(input.destinationProjectId, '대상 사업');
    assertUuid(input.idempotencyKey, '요청 식별키');
    assertAmount(input.amount);
    const client = createFundingClient(input.accessToken);
    const { data, error } = await client.rpc(RPC.createReallocationRequest, {
      p_request_type: 'ALLOCATE_UNALLOCATED_EXISTING',
      p_payload: {
        lot_id: input.lotId,
        destination_project_id: input.destinationProjectId,
        amount: input.amount,
        effective_date: input.effectiveDate,
        record_origin: 'LEGACY_EXCEL',
        evidence_id: input.evidenceId || null,
        memo: optionalText(input.memo, 1000, '메모'),
      },
      p_idempotency_key: input.idempotencyKey,
      p_submit: true,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.request_id) throw new Error('대기재원 배분요청 결과를 반환받지 못했습니다.');
    return row as { request_id: string; status: string };
  });
}

export async function returnUnallocatedFundAction(input: AuthenticatedInput & {
  lotId: string;
  amount: string;
  effectiveDate: string;
  evidenceId?: string;
  memo: string;
  idempotencyKey: string;
}): Promise<FundingActionResult<{ request_id: string; status: string }>> {
  return mutate(async () => {
    assertUuid(input.lotId, '대기재원');
    assertUuid(input.idempotencyKey, '요청 식별키');
    assertAmount(input.amount);
    const client = createFundingClient(input.accessToken);
    const { data, error } = await client.rpc(RPC.createReallocationRequest, {
      p_request_type: 'RETURN_UNALLOCATED',
      p_payload: {
        lot_id: input.lotId,
        amount: input.amount,
        effective_date: input.effectiveDate,
        record_origin: 'LEGACY_EXCEL',
        evidence_id: input.evidenceId || null,
        memo: requiredText(input.memo, 1000, '반납 사유'),
      },
      p_idempotency_key: input.idempotencyKey,
      p_submit: true,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.request_id) throw new Error('반납 요청 결과를 반환받지 못했습니다.');
    return row as { request_id: string; status: string };
  });
}

export async function saveNewProjectRequestAction(input: AuthenticatedInput & {
  requestId?: string;
  regionId: string;
  sourceLotId?: string;
  fiscalYear: number;
  projectName: string;
  projectPeriod: string;
  projectStartYear: number | null;
  projectEndYear: number | null;
  businessType: 'HW' | 'SW' | 'COMPOSITE';
  fundProjectName: string;
  detailProjectName: string;
  status: string;
  executionStatusReason: string;
  largeCategoryId?: string;
  middleCategoryId?: string;
  requestedAmount: string;
  idempotencyKey: string;
  submit: boolean;
}): Promise<FundingActionResult<{ request_id: string; status: string }>> {
  return mutate(async () => {
    if (input.sourceLotId) assertUuid(input.sourceLotId, '연결할 예산');
    assertUuid(input.regionId, '지역');
    assertUuid(input.idempotencyKey, '요청 식별키');
    if (input.sourceLotId) {
      assertAmount(input.requestedAmount, '요청액');
    } else if (!/^\d+$/.test(input.requestedAmount)) {
      throw new Error('요청액은 0 이상의 원 단위 정수여야 합니다.');
    }
    if (input.submit && !input.sourceLotId) throw new Error('등록을 완료하려면 연결할 대기재원을 선택해 주세요.');
    if (input.requestId) assertUuid(input.requestId, '신규사업 요청');
    if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 2000 || input.fiscalYear > 2200) throw new Error('사업연도가 올바르지 않습니다.');
    const schedule = assertNewProjectSchedule(input.projectPeriod, input.projectStartYear, input.projectEndYear);
    if (!isProjectStatus(input.status)) throw new Error('집행상태를 선택해 주세요.');
    const statusReasonError = validateExecutionStatusReason(input.status, input.executionStatusReason);
    if (statusReasonError) throw new Error(statusReasonError);
    const client = createFundingClient(input.accessToken);
    const payload = {
      p_request_id: input.requestId ?? null,
      p_region_id: input.regionId,
      p_fiscal_year: input.fiscalYear,
      p_source_lot_id: input.sourceLotId || null,
      p_project_name: requiredText(input.projectName, 500, '사업명'),
      p_fund_project_name: optionalText(input.fundProjectName, 500, '기금사업명'),
      p_detail_project_name: optionalText(input.detailProjectName, 500, '세부사업명'),
      p_project_period: optionalText(input.projectPeriod, 200, '사업기간'),
      p_project_start_year: schedule.projectStartYear,
      p_project_end_year: schedule.projectEndYear,
      p_business_type: input.businessType,
      p_status: requiredText(input.status, 100, '사업상태'),
      p_execution_status_reason: input.executionStatusReason.trim() || null,
      p_large_category_id: input.largeCategoryId || null,
      p_middle_category_id: input.middleCategoryId || null,
      p_requested_amount: input.requestedAmount,
      p_idempotency_key: input.idempotencyKey,
    };
    const { data, error } = await client.rpc(RPC.saveNewProjectRequestDraft, payload);
    if (error) throw error;
    let row = Array.isArray(data) ? data[0] : data;
    if (!row?.request_id) throw new Error('신규사업 요청 저장 결과를 반환받지 못했습니다.');
    if (input.submit) {
      const submitResult = await client.rpc(RPC.submitNewProjectRequest, { p_request_id: row.request_id });
      if (submitResult.error) throw submitResult.error;
      row = Array.isArray(submitResult.data) ? submitResult.data[0] : submitResult.data;
    }
    return row as { request_id: string; status: string };
  });
}

export async function createCarryoverReviewRequestAction(input: AuthenticatedInput & {
  runtimeMode: FundingRuntime['mode'];
  sourceBudgetYearId: string;
  sourceProjectId: string;
  destinationProjectId: string;
  fundingEntryId?: string;
  lineageId?: string;
  evidenceId?: string;
  sourceFiscalYear: number;
  destinationFiscalYear: number;
  carryoverSequence: 1 | 2;
  carryoverType: 'MYEONGSI' | 'SAGO';
  amount: string;
  effectiveDate: string;
  memo: string;
  idempotencyKey: string;
}): Promise<FundingActionResult<{ request_id: string; status: string; expected_carryover_type: string }>> {
  return mutate(async () => {
    assertUuid(input.sourceBudgetYearId, '원천 재원');
    assertUuid(input.sourceProjectId, '원천 사업');
    assertUuid(input.destinationProjectId, '다음연도 사업');
    assertUuid(input.idempotencyKey, '요청 식별키');
    assertAmount(input.amount, '이월액');
    const client = createFundingClient(input.accessToken);
    if (input.runtimeMode === 'RECONCILIATION') {
      if (!input.fundingEntryId || !input.lineageId || !input.evidenceId) {
        throw new Error('과거자료 이월에는 적용된 최초배분, 검증완료 사업 연계관계와 증빙이 필요합니다.');
      }
      assertUuid(input.fundingEntryId, '과거자료 최초배분');
      assertUuid(input.lineageId, '검증완료 사업 연계관계');
      assertUuid(input.evidenceId, '검증완료 증빙');
      const { data: entryId, error } = await client.rpc('financial_create_legacy_reconstruction_entry', {
        p_event_type: 'CARRYOVER',
        p_project_id: input.sourceProjectId,
        p_destination_project_id: input.destinationProjectId,
        p_funding_entry_id: input.fundingEntryId,
        p_lineage_id: input.lineageId,
        p_evidence_id: input.evidenceId,
        p_origin_fiscal_year: null,
        p_fiscal_year: input.sourceFiscalYear,
        p_destination_fiscal_year: input.destinationFiscalYear,
        p_legacy_prior_carryover_count: null,
        p_amount: input.amount,
        p_effective_date: input.effectiveDate,
        p_carryover_sequence: input.carryoverSequence,
        p_carryover_type: input.carryoverType,
        p_adjustment_type: null,
        p_reason_code: null,
        p_memo: optionalText(input.memo, 1000, '메모'),
        p_idempotency_key: input.idempotencyKey,
      });
      if (error) throw error;
      if (typeof entryId !== 'string') throw new Error('과거자료 이월 초안 식별값을 반환받지 못했습니다.');
      const submitted = await client.rpc('financial_submit_legacy_reconstruction', { p_entry_id: entryId });
      if (submitted.error) throw submitted.error;
      return { request_id: entryId, status: 'SUBMITTED', expected_carryover_type: input.carryoverType };
    }
    const { data, error } = await client.rpc(RPC.createChangeRequest, {
      p_request_type: 'CARRYOVER',
      p_payload: {
        source_budget_year_id: input.sourceBudgetYearId,
        destination_project_id: input.destinationProjectId,
        amount: input.amount,
        effective_date: input.effectiveDate,
        memo: optionalText(input.memo, 1000, '메모'),
      },
      p_idempotency_key: input.idempotencyKey,
      p_submit: true,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.request_id) throw new Error('이월 검수요청 결과를 반환받지 못했습니다.');
    return row as { request_id: string; status: string; expected_carryover_type: string };
  });
}

export async function resolveLegacyReconstructionAction(input: AuthenticatedInput & {
  entryId: string;
  decision: 'VERIFY' | 'REJECT' | 'APPLY';
  resolutionNote: string;
}): Promise<FundingActionResult<{ entry_id: string; status: string }>> {
  return mutate(async () => {
    assertUuid(input.entryId, '과거거래 복원');
    const client = createFundingClient(input.accessToken);
    const functionName = input.decision === 'VERIFY'
      ? 'financial_verify_legacy_reconstruction'
      : input.decision === 'REJECT'
        ? 'financial_reject_legacy_reconstruction'
        : 'financial_apply_legacy_reconstruction';
    const { error } = await client.rpc(functionName, {
      p_entry_id: input.entryId,
      ...(input.decision === 'REJECT' ? { p_reason: requiredText(input.resolutionNote, 1000, '반려 사유') } : {}),
    });
    if (error) throw error;
    return { entry_id: input.entryId, status: input.decision === 'VERIFY' ? 'VERIFIED' : input.decision === 'REJECT' ? 'REJECTED' : 'APPLIED' };
  });
}

export async function resolveChangeRequestAction(input: AuthenticatedInput & {
  requestId: string;
  decision: 'APPROVE' | 'REJECT' | 'APPLY';
  resolutionNote: string;
}): Promise<FundingActionResult<{ request_id: string; status: string }>> {
  return mutate(async () => {
    assertUuid(input.requestId, '검수 요청');
    if (input.decision === 'REJECT' && !input.resolutionNote.trim()) throw new Error('반려 사유를 입력하세요.');
    const client = createFundingClient(input.accessToken);
    const functionName = input.decision === 'APPROVE'
      ? RPC.approveChangeRequest
      : input.decision === 'REJECT'
        ? RPC.rejectChangeRequest
        : RPC.applyChangeRequest;
    const { data, error } = await client.rpc(functionName, {
      p_request_id: input.requestId,
      p_resolution_note: optionalText(input.resolutionNote, 1000, '검토 의견'),
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return (row?.request_id ? row : {
      request_id: input.requestId,
      status: input.decision === 'APPROVE' ? 'APPROVED' : input.decision === 'REJECT' ? 'REJECTED' : 'APPLIED',
    }) as { request_id: string; status: string };
  });
}
