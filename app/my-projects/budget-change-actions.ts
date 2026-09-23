"use server";

import { createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import type {
  BudgetChangeCandidate,
  BudgetChangeNewProjectRequest,
  BudgetChangeDestination,
  BudgetChangeDestinationState,
  BudgetChangeDestinationInput,
  BudgetChangeProjectPosition,
  BudgetChangeRequest,
  BudgetChangeStatistics,
  PendingNewProjectFund,
  PendingNewProjectLinkRequest,
  BudgetAmountSnapshot,
  BudgetWorkflowAmountChange,
  RequestReviewMetadata,
  AttachableNewProjectDraft,
} from '../../lib/budgetChanges';
import {
  validateBudgetChangeDestinations,
  validateBudgetChangeMaximumDecrease,
} from '../../lib/budgetChanges';
import { isPublicDemoMode, PUBLIC_DEMO_DISABLED_MESSAGE } from '../../lib/demo-mode';
import { assertLedgerTestTarget } from '../../lib/ledgerRuntime';
import { isProjectStatus } from '../../lib/myProjectEdit';
import { formatUserFacingError, getRawProjectSearchTokens } from '../../lib/presentationLabels';

type ActionResult<T> = { data: T; error?: never } | { data?: never; error: string };
type AuthenticatedInput = { accessToken: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function clientFor(accessToken: string) {
  if (isPublicDemoMode) throw new Error(PUBLIC_DEMO_DISABLED_MESSAGE);
  if (!accessToken || accessToken.length > 8_000) throw new Error('로그인 세션을 다시 확인해 주세요.');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('시험 데이터 연결 설정을 확인해 주세요.');
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

function assertUuid(value: string, label: string) {
  if (!UUID_PATTERN.test(value)) throw new Error(`${label}을(를) 다시 선택해 주세요.`);
}

function errorText(error: unknown) {
  const value = error as { code?: string; message?: string } | null;
  if (value?.code === '40001') {
    return formatUserFacingError(error, '금액이 변경되었습니다. 새로고침 후 다시 요청해 주세요.');
  }
  return formatUserFacingError(error, '예산 조정 처리 중 오류가 발생했습니다.');
}

async function read<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { data: await work() };
  } catch (error) {
    return { error: errorText(error) };
  }
}

async function mutate<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  return read(async () => {
    assertLedgerTestTarget();
    const result = await work();
    revalidatePath('/my-projects');
    revalidatePath('/admin/funding');
    revalidatePath('/admin/project-changes');
    revalidatePath('/dashboard');
    revalidatePath('/analytics');
    return result;
  });
}

function first<T>(data: T | T[] | null): T | null {
  return Array.isArray(data) ? data[0] ?? null : data;
}

async function searchCandidateRows(
  client: ReturnType<typeof clientFor>,
  functionName: 'get_financial_budget_change_candidates' | 'get_financial_budget_change_next_year_candidates',
  parameters: Record<string, unknown>,
  displaySearch?: string,
) {
  const query = displaySearch?.trim() || null;
  const direct = await client.rpc(functionName, { ...parameters, p_search: query });
  if (direct.error) throw direct.error;
  const directRows = (direct.data ?? []) as Record<string, unknown>[];
  if (!query || directRows.length > 0) return directRows;

  const tokenGroups = getRawProjectSearchTokens(query);
  if (tokenGroups.length === 0) return directRows;
  const groupedRows = await Promise.all(tokenGroups.map(async (alternatives) => {
    const responses = await Promise.all(alternatives.map((token) =>
      client.rpc(functionName, { ...parameters, p_search: token })));
    const error = responses.find((response) => response.error)?.error;
    if (error) throw error;
    const byProject = new Map<string, Record<string, unknown>>();
    responses.forEach((response) => {
      ((response.data ?? []) as Record<string, unknown>[]).forEach((row) => {
        byProject.set(String(row.project_id), row);
      });
    });
    return byProject;
  }));
  const [firstGroup, ...remainingGroups] = groupedRows;
  return [...(firstGroup?.values() ?? [])].filter((row) =>
    remainingGroups.every((group) => group.has(String(row.project_id))));
}

function normalizeDestination(row: Record<string, unknown>): BudgetChangeDestination {
  return {
    line_id: String(row.line_id),
    line_no: Number(row.line_no),
    destination_type: row.destination_type as BudgetChangeDestination['destination_type'],
    destination_project_id: row.destination_project_id ? String(row.destination_project_id) : undefined,
    destination_project_code: row.destination_project_code ? String(row.destination_project_code) : null,
    destination_project_name: row.destination_project_name ? String(row.destination_project_name) : null,
    planned_project_name: row.planned_project_name ? String(row.planned_project_name) : undefined,
    planned_project_year: row.planned_project_year == null ? undefined : Number(row.planned_project_year),
    planned_fund_project_name: row.planned_fund_project_name ? String(row.planned_fund_project_name) : undefined,
    planned_detail_project_name: row.planned_detail_project_name ? String(row.planned_detail_project_name) : undefined,
    planned_project_period: row.planned_project_period ? String(row.planned_project_period) : undefined,
    planned_project_start_year: row.planned_project_start_year == null ? undefined : Number(row.planned_project_start_year),
    planned_project_end_year: row.planned_project_end_year == null ? undefined : Number(row.planned_project_end_year),
    planned_project_status: isProjectStatus(row.planned_project_status ? String(row.planned_project_status) : null)
      ? String(row.planned_project_status) as BudgetChangeDestination['planned_project_status']
      : undefined,
    planned_execution_status_reason: row.execution_status_reason
      ? String(row.execution_status_reason)
      : undefined,
    planned_business_type: row.planned_business_type as BudgetChangeDestination['planned_business_type'],
    planned_large_category_id: row.planned_large_category_id ? String(row.planned_large_category_id) : undefined,
    planned_middle_category_id: row.planned_middle_category_id ? String(row.planned_middle_category_id) : undefined,
    amount: String(row.amount ?? '0'),
    note: row.note ? String(row.note) : undefined,
    pending_fund_id: row.pending_fund_id ? String(row.pending_fund_id) : null,
    new_project_request_id: row.new_project_request_id ? String(row.new_project_request_id) : null,
    new_project_request_status: row.new_project_request_status
      ? String(row.new_project_request_status) as BudgetChangeDestination['new_project_request_status'] : null,
    official_project_code: row.official_project_code ? String(row.official_project_code) : null,
    materialized_project_id: row.materialized_project_id ? String(row.materialized_project_id) : null,
    materialized_project_code: row.materialized_project_code ? String(row.materialized_project_code) : null,
    materialized_project_name: row.materialized_project_name ? String(row.materialized_project_name) : null,
    current_destination_project_id: row.current_destination_project_id
      ? String(row.current_destination_project_id)
      : row.materialized_project_id
        ? String(row.materialized_project_id)
        : row.destination_project_id
          ? String(row.destination_project_id)
          : null,
    current_destination_project_code: row.current_destination_project_code
      ? String(row.current_destination_project_code)
      : row.materialized_project_code
        ? String(row.materialized_project_code)
        : row.destination_project_code
          ? String(row.destination_project_code)
          : null,
    current_destination_project_name: row.current_destination_project_name
      ? String(row.current_destination_project_name)
      : row.materialized_project_name
        ? String(row.materialized_project_name)
        : row.destination_project_name
          ? String(row.destination_project_name)
          : null,
    correction_count: Number(row.correction_count ?? 0),
    correction_allowed: row.correction_allowed === true,
    correction_block_reason: row.correction_block_reason ? String(row.correction_block_reason) : null,
    last_correction_reason: row.last_correction_reason ? String(row.last_correction_reason) : null,
    last_corrected_at: row.last_corrected_at ? String(row.last_corrected_at) : null,
  };
}

function normalizeDestinationState(row: Record<string, unknown>): BudgetChangeDestinationState {
  return {
    request_id: String(row.request_id),
    line_id: String(row.line_id),
    current_destination_project_id: row.current_destination_project_id
      ? String(row.current_destination_project_id) : null,
    current_destination_project_code: row.current_destination_project_code
      ? String(row.current_destination_project_code) : null,
    current_destination_project_name: row.current_destination_project_name
      ? String(row.current_destination_project_name) : null,
    correction_count: Number(row.correction_count ?? 0),
    correction_allowed: row.correction_allowed === true,
    correction_block_reason: row.correction_block_reason ? String(row.correction_block_reason) : null,
    last_correction_reason: row.last_correction_reason ? String(row.last_correction_reason) : null,
    last_corrected_at: row.last_corrected_at ? String(row.last_corrected_at) : null,
  };
}

function applyDestinationStates(
  request: BudgetChangeRequest,
  states: Map<string, BudgetChangeDestinationState>,
): BudgetChangeRequest {
  return {
    ...request,
    destinations: request.destinations.map((destination) => {
      const state = states.get(destination.line_id);
      return state ? { ...destination, ...state } : destination;
    }),
  };
}

function normalizeRequest(row: Record<string, unknown>): BudgetChangeRequest {
  return {
    id: String(row.id),
    region_id: String(row.region_id),
    fiscal_year: Number(row.fiscal_year),
    source_project_id: String(row.source_project_id),
    source_project_code: row.source_project_code ? String(row.source_project_code) : null,
    source_project_name: String(row.source_project_name ?? '사업명 확인 필요'),
    total_amount: String(row.total_amount ?? '0'),
    decrease_amount_before: String(row.decrease_amount_before ?? '0'),
    decrease_amount_after: String(row.decrease_amount_after ?? '0'),
    effective_date: String(row.effective_date ?? ''),
    reason: String(row.reason ?? ''),
    status: row.status as BudgetChangeRequest['status'],
    requested_by: String(row.requested_by),
    requested_at: String(row.requested_at),
    rejection_reason: row.rejection_reason ? String(row.rejection_reason) : null,
    destinations: Array.isArray(row.destinations)
      ? (row.destinations as Record<string, unknown>[]).map(normalizeDestination)
      : [],
    database_status: null,
    requested_by_name: null,
    approved_by_name: null,
    approved_at: null,
    rejected_by_name: null,
    rejected_at: null,
    applied_by_name: null,
    applied_at: null,
  };
}

function amountSnapshot(input: {
  original: string; increase: string; decrease: string; execution: string;
}): BudgetAmountSnapshot {
  const adjusted = BigInt(input.original) + BigInt(input.increase) - BigInt(input.decrease);
  return {
    original_allocation: input.original,
    increase_amount: input.increase,
    decrease_amount: input.decrease,
    adjusted_allocation: adjusted.toString(),
    execution_amount: input.execution,
    unexecuted_amount: (adjusted - BigInt(input.execution)).toString(),
  };
}

function normalizeAmountChange(row: Record<string, unknown>): BudgetWorkflowAmountChange {
  return {
    event_type: row.event_type as BudgetWorkflowAmountChange['event_type'],
    event_id: String(row.event_id),
    project_id: String(row.project_id),
    fiscal_year: Number(row.fiscal_year),
    project_code: row.project_code ? String(row.project_code) : null,
    project_name: String(row.project_name ?? '사업명 확인 필요'),
    role: row.project_role as BudgetWorkflowAmountChange['role'],
    amount: String(row.amount ?? '0'),
    capture_kind: row.capture_kind as BudgetWorkflowAmountChange['capture_kind'],
    before: {
      original_allocation: String(row.original_before ?? '0'),
      increase_amount: String(row.increase_before ?? '0'),
      decrease_amount: String(row.decrease_before ?? '0'),
      adjusted_allocation: String(row.adjusted_before ?? '0'),
      execution_amount: String(row.execution_before ?? '0'),
      unexecuted_amount: String(row.unexecuted_before ?? '0'),
    },
    after: {
      original_allocation: String(row.original_after ?? '0'),
      increase_amount: String(row.increase_after ?? '0'),
      decrease_amount: String(row.decrease_after ?? '0'),
      adjusted_allocation: String(row.adjusted_after ?? '0'),
      execution_amount: String(row.execution_after ?? '0'),
      unexecuted_amount: String(row.unexecuted_after ?? '0'),
    },
  };
}

export async function getBudgetChangeSnapshotAction(input: AuthenticatedInput & { projectId: string }) {
  return read(async () => {
    assertUuid(input.projectId, '사업');
    const client = clientFor(input.accessToken);
    const [
      positionResult,
      requestsResult,
      pendingResult,
      pendingLotsResult,
      draftProjectsResult,
      runtimeResult,
      workflowModeResult,
      destinationStatesResult,
    ] = await Promise.all([
      client.rpc('get_financial_budget_change_project_position', { p_project_id: input.projectId }),
      client.rpc('get_financial_budget_change_requests', {
        p_project_id: input.projectId, p_status: null, p_year: null, p_region_id: null,
      }),
      client.rpc('get_financial_pending_new_project_funds', {
        p_status: 'WAITING', p_year: null, p_region_id: null,
      }),
      client.from('financial_pending_new_project_funds').select('id,lot_id,source_line_id').eq('status', 'WAITING'),
      client.rpc('get_financial_attachable_new_project_drafts_v2', { p_source_project_id: input.projectId }),
      client.from('financial_ledger_runtime').select('environment_kind,mode,baseline_as_of,native_start_date').single(),
      client.rpc('get_financial_budget_change_workflow_mode'),
      client.rpc('get_financial_budget_change_destination_states', { p_project_id: input.projectId }),
    ]);
    if (positionResult.error) throw positionResult.error;
    if (requestsResult.error) throw requestsResult.error;
    if (pendingResult.error) throw pendingResult.error;
    if (pendingLotsResult.error) throw pendingLotsResult.error;
    if (draftProjectsResult.error) throw draftProjectsResult.error;
    if (runtimeResult.error) throw runtimeResult.error;
    if (workflowModeResult.error) throw workflowModeResult.error;
    if (destinationStatesResult.error) throw destinationStatesResult.error;
    const destinationStates = ((destinationStatesResult.data ?? []) as Record<string, unknown>[])
      .map(normalizeDestinationState);
    const destinationStateMap = new Map(destinationStates.map((state) => [state.line_id, state]));
    const requestRows = [...((requestsResult.data ?? []) as Record<string, unknown>[])];
    const loadedRequestIds = new Set(requestRows.map((row) => String(row.id)));
    const missingRequestIds = [...new Set(destinationStates
      .map((state) => state.request_id)
      .filter((requestId) => !loadedRequestIds.has(requestId)))];
    if (missingRequestIds.length > 0) {
      const { data: regionRequests, error: regionRequestsError } = await client.rpc(
        'get_financial_budget_change_requests',
        { p_project_id: null, p_status: null, p_year: null, p_region_id: null },
      );
      if (regionRequestsError) throw regionRequestsError;
      const missingSet = new Set(missingRequestIds);
      requestRows.push(...((regionRequests ?? []) as Record<string, unknown>[])
        .filter((row) => missingSet.has(String(row.id))));
    }
    const sourceLineIds = (pendingLotsResult.data ?? [])
      .map((row) => row.source_line_id ? String(row.source_line_id) : '')
      .filter(Boolean);
    const pendingLineResult = sourceLineIds.length > 0
      ? await client.from('financial_budget_change_request_lines')
        .select('id,new_project_request_id')
        .in('id', sourceLineIds)
      : { data: [], error: null };
    if (pendingLineResult.error) throw pendingLineResult.error;
    const positionRow = first(positionResult.data as Record<string, unknown>[] | null);
    if (!positionRow) throw new Error('예산 및 집행 금액을 불러오지 못했습니다.');
    const pendingLotMap = new Map((pendingLotsResult.data ?? []).map((row) => [row.id, row.lot_id]));
    const pendingRequestMap = new Map((pendingLineResult.data ?? [])
      .map((row) => [String(row.id), row.new_project_request_id ? String(row.new_project_request_id) : null]));
    const pendingSourceLineMap = new Map((pendingLotsResult.data ?? [])
      .map((row) => [String(row.id), row.source_line_id ? String(row.source_line_id) : '']));
    const pending = ((pendingResult.data ?? []) as Record<string, unknown>[]).map((row): PendingNewProjectFund => ({
      ...row,
      id: String(row.id),
      source_lot_id: String(pendingLotMap.get(String(row.id)) ?? ''),
      region_id: String(row.region_id),
      fiscal_year: Number(row.fiscal_year),
      planned_project_name: String(row.planned_project_name),
      planned_project_year: Number(row.planned_project_year),
      amount: String(row.amount ?? '0'),
      status: row.status as PendingNewProjectFund['status'],
      source_project_id: String(row.source_project_id),
      source_project_code: row.source_project_code ? String(row.source_project_code) : null,
      source_project_name: String(row.source_project_name ?? '사업명 확인 필요'),
      source_request_id: String(row.source_request_id),
      new_project_request_id: pendingRequestMap.get(pendingSourceLineMap.get(String(row.id)) ?? '') ?? null,
      linked_project_id: row.linked_project_id ? String(row.linked_project_id) : null,
      linked_project_code: row.linked_project_code ? String(row.linked_project_code) : null,
      linked_project_name: row.linked_project_name ? String(row.linked_project_name) : null,
      created_at: String(row.created_at),
      linked_at: row.linked_at ? String(row.linked_at) : null,
    }));
    return {
      position: {
        ...positionRow,
        project_id: String(positionRow.project_id),
        original_allocation: String(positionRow.original_allocation ?? '0'),
        increase_amount: String(positionRow.increase_amount ?? '0'),
        decrease_amount: String(positionRow.decrease_amount ?? '0'),
        adjusted_allocation: String(positionRow.adjusted_allocation ?? '0'),
        execution_amount: String(positionRow.execution_amount ?? '0'),
        unexecuted_amount: String(positionRow.unexecuted_amount ?? '0'),
        execution_rate: Number(positionRow.execution_rate ?? 0),
        valid_execution: positionRow.valid_execution === true,
      } as BudgetChangeProjectPosition,
      requests: requestRows.map(normalizeRequest)
        .map((request) => applyDestinationStates(request, destinationStateMap)),
      pending,
      draftNewProjectRequests: ((draftProjectsResult.data ?? []) as Record<string, unknown>[])
        .map((row): AttachableNewProjectDraft => ({
          id: String(row.id),
          region_id: String(row.region_id),
          fiscal_year: Number(row.fiscal_year),
          project_name: String(row.project_name ?? '사업명 확인 필요'),
          fund_project_name: row.fund_project_name ? String(row.fund_project_name) : null,
          detail_project_name: row.detail_project_name ? String(row.detail_project_name) : null,
          project_period: row.project_period ? String(row.project_period) : null,
          project_start_year: row.project_start_year == null ? null : Number(row.project_start_year),
          project_end_year: row.project_end_year == null ? null : Number(row.project_end_year),
          project_status: isProjectStatus(row.project_status ? String(row.project_status) : null)
            ? String(row.project_status) as AttachableNewProjectDraft['project_status']
            : null,
          execution_status_reason: row.execution_status_reason ? String(row.execution_status_reason) : null,
          business_type: row.business_type as AttachableNewProjectDraft['business_type'],
          large_category_id: row.large_category_id ? String(row.large_category_id) : null,
          middle_category_id: row.middle_category_id ? String(row.middle_category_id) : null,
          requested_amount: String(row.requested_amount ?? '0'),
          status: 'DRAFT',
          created_at: String(row.created_at),
        })),
      runtime: runtimeResult.data as {
        environment_kind: 'TEST'; mode: 'DISABLED' | 'RECONCILIATION' | 'TEST';
        baseline_as_of: string; native_start_date: string;
      },
      autoApprovalEnabled: Boolean((first(workflowModeResult.data as Record<string, unknown>[] | null)
        ?? {}).auto_approval_enabled),
    };
  });
}

export async function searchBudgetChangeCandidatesAction(input: AuthenticatedInput & {
  anchorProjectId: string;
  search?: string;
  year?: number;
  requireAvailable?: boolean;
}): Promise<ActionResult<BudgetChangeCandidate[]>> {
  return read(async () => {
    assertUuid(input.anchorProjectId, '기준 사업');
    if (input.year !== undefined && (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2200)) {
      throw new Error('검색 연도를 확인해 주세요.');
    }
    const client = clientFor(input.accessToken);
    const data = await searchCandidateRows(client, 'get_financial_budget_change_candidates', {
      p_anchor_project_id: input.anchorProjectId,
      p_year: input.year ?? null,
      p_require_available: input.requireAvailable ?? false,
    }, input.search);
    return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      project_id: String(row.project_id),
      fiscal_year: Number(row.fiscal_year),
      project_code: row.project_code ? String(row.project_code) : null,
      project_name: String(row.project_name ?? '사업명 확인 필요'),
      source_budget_year_id: row.source_budget_year_id ? String(row.source_budget_year_id) : null,
      available_amount: String(row.available_amount ?? '0'),
    }));
  });
}

export async function searchBudgetChangeNextYearCandidatesAction(input: AuthenticatedInput & {
  anchorProjectId: string;
  search?: string;
}): Promise<ActionResult<BudgetChangeCandidate[]>> {
  return read(async () => {
    assertUuid(input.anchorProjectId, '기준 사업');
    const client = clientFor(input.accessToken);
    const data = await searchCandidateRows(client, 'get_financial_budget_change_next_year_candidates', {
      p_anchor_project_id: input.anchorProjectId,
    }, input.search);
    return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      project_id: String(row.project_id),
      fiscal_year: Number(row.fiscal_year),
      project_code: row.project_code ? String(row.project_code) : null,
      project_name: String(row.project_name ?? '사업명 확인 필요'),
      source_budget_year_id: null,
      available_amount: '0',
    }));
  });
}

export async function createBudgetChangeRequestAction(input: AuthenticatedInput & {
  sourceProjectId: string;
  sourceBudgetYearId?: string | null;
  totalAmount: string;
  destinations: BudgetChangeDestinationInput[];
  effectiveDate: string;
  reason: string;
  idempotencyKey: string;
}): Promise<ActionResult<{ request_id: string; status: string; gap_amount: string }>> {
  return mutate(async () => {
    assertUuid(input.sourceProjectId, '출처 사업');
    if (input.sourceBudgetYearId) assertUuid(input.sourceBudgetYearId, '출처 재원');
    assertUuid(input.idempotencyKey, '요청 식별키');
    if (!DATE_PATTERN.test(input.effectiveDate)) throw new Error('예산 조정일을 확인해 주세요.');
    const validation = validateBudgetChangeDestinations(input.totalAmount, input.destinations);
    if (validation) throw new Error(validation);
    const reason = input.reason.trim();
    if (!reason || reason.length > 1000) throw new Error('조정 사유를 1,000자 이내로 입력해 주세요.');
    const client = clientFor(input.accessToken);
    const { data: positionData, error: positionError } = await client.rpc(
      'get_financial_budget_change_project_position',
      { p_project_id: input.sourceProjectId },
    );
    if (positionError) throw positionError;
    const sourcePosition = first(positionData as Record<string, unknown>[] | null);
    if (!sourcePosition) throw new Error('출처 사업의 현재 예산을 확인하지 못했습니다.');
    const maximumError = validateBudgetChangeMaximumDecrease(
      input.totalAmount,
      String(sourcePosition.unexecuted_amount ?? '0'),
    );
    if (maximumError) throw new Error(maximumError);
    const { data, error } = await client.rpc('financial_test_uat_save_budget_change_request_complete_v2', {
      p_source_project_id: input.sourceProjectId,
      p_source_budget_year_id: input.sourceBudgetYearId ?? null,
      p_destinations: input.destinations,
      p_effective_date: input.effectiveDate,
      p_reason: reason,
      p_idempotency_key: input.idempotencyKey,
      p_submit: true,
    });
    if (error) throw error;
    const row = first(data as Record<string, unknown>[] | null);
    if (!row?.request_id) throw new Error('예산 조정 요청 결과를 받지 못했습니다.');
    return {
      request_id: String(row.request_id),
      status: String(row.status),
      gap_amount: String(row.gap_amount ?? '0'),
    };
  });
}

export async function saveBudgetChangeDraftAction(input: AuthenticatedInput & {
  sourceProjectId: string;
  sourceBudgetYearId?: string | null;
  totalAmount: string;
  destinations: BudgetChangeDestinationInput[];
  effectiveDate: string;
  reason: string;
  idempotencyKey: string;
}): Promise<ActionResult<{ request_id: string; status: string; gap_amount: string }>> {
  return mutate(async () => {
    assertUuid(input.sourceProjectId, '출처 사업');
    if (input.sourceBudgetYearId) assertUuid(input.sourceBudgetYearId, '출처 재원');
    assertUuid(input.idempotencyKey, '요청 식별키');
    if (!DATE_PATTERN.test(input.effectiveDate)) throw new Error('예산 조정일을 확인해 주세요.');
    const validation = validateBudgetChangeDestinations(input.totalAmount, input.destinations);
    if (validation) throw new Error(validation);
    const reason = input.reason.trim();
    if (!reason || reason.length > 1000) throw new Error('조정 사유를 1,000자 이내로 입력해 주세요.');
    const client = clientFor(input.accessToken);
    const { data: positionData, error: positionError } = await client.rpc(
      'get_financial_budget_change_project_position',
      { p_project_id: input.sourceProjectId },
    );
    if (positionError) throw positionError;
    const sourcePosition = first(positionData as Record<string, unknown>[] | null);
    if (!sourcePosition) throw new Error('출처 사업의 현재 예산을 확인하지 못했습니다.');
    const maximumError = validateBudgetChangeMaximumDecrease(
      input.totalAmount,
      String(sourcePosition.unexecuted_amount ?? '0'),
    );
    if (maximumError) throw new Error(maximumError);
    const { data, error } = await client.rpc('financial_test_uat_save_budget_change_request_complete_v2', {
      p_source_project_id: input.sourceProjectId,
      p_source_budget_year_id: input.sourceBudgetYearId ?? null,
      p_destinations: input.destinations,
      p_effective_date: input.effectiveDate,
      p_reason: reason,
      p_idempotency_key: input.idempotencyKey,
      p_submit: false,
    });
    if (error) throw error;
    const row = first(data as Record<string, unknown>[] | null);
    if (!row?.request_id) throw new Error('예산조정 작성본 저장 결과를 받지 못했습니다.');
    return {
      request_id: String(row.request_id),
      status: String(row.status),
      gap_amount: String(row.gap_amount ?? '0'),
    };
  });
}

export async function correctBudgetChangeDestinationAction(input: AuthenticatedInput & {
  lineId: string;
  replacementProjectId: string;
  reason: string;
  effectiveDate: string;
  idempotencyKey: string;
}): Promise<ActionResult<{
  correction_id: string;
  request_id: string;
  line_id: string;
  destination_project_id: string;
  status: string;
}>> {
  return mutate(async () => {
    assertUuid(input.lineId, '예산이관 목적지');
    assertUuid(input.replacementProjectId, '변경할 사업');
    assertUuid(input.idempotencyKey, '요청 식별키');
    if (!DATE_PATTERN.test(input.effectiveDate)) throw new Error('변경일을 확인해 주세요.');
    const reason = input.reason.trim();
    if (!reason || reason.length > 1000) {
      throw new Error('변경 사유를 1,000자 이내로 입력해 주세요.');
    }
    const client = clientFor(input.accessToken);
    const { data, error } = await client.rpc('financial_correct_budget_change_destination', {
      p_line_id: input.lineId,
      p_replacement_project_id: input.replacementProjectId,
      p_reason: reason,
      p_effective_date: input.effectiveDate,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) throw error;
    const row = first(data as Record<string, unknown>[] | null);
    if (!row?.correction_id) throw new Error('예산이관 목적지 변경 결과를 받지 못했습니다.');
    return {
      correction_id: String(row.correction_id),
      request_id: String(row.request_id),
      line_id: String(row.line_id),
      destination_project_id: String(row.destination_project_id),
      status: String(row.status),
    };
  });
}

export async function requestPendingNewProjectLinkAction(input: AuthenticatedInput & {
  pendingFundId: string;
  destinationProjectId: string;
  idempotencyKey: string;
}): Promise<ActionResult<{ request_id: string; status: string }>> {
  return mutate(async () => {
    assertUuid(input.pendingFundId, '신규사업 예정재원');
    assertUuid(input.destinationProjectId, '연결할 사업');
    assertUuid(input.idempotencyKey, '요청 식별키');
    const client = clientFor(input.accessToken);
    const { data, error } = await client.rpc('financial_request_pending_new_project_link', {
      p_pending_fund_id: input.pendingFundId,
      p_destination_project_id: input.destinationProjectId,
      p_idempotency_key: input.idempotencyKey,
    });
    if (error) throw error;
    const row = first(data as Record<string, unknown>[] | null);
    if (!row?.request_id) throw new Error('예정재원 연결 요청 결과를 받지 못했습니다.');
    return { request_id: String(row.request_id), status: String(row.status) };
  });
}

export async function getAdminBudgetChangeDashboardAction(input: AuthenticatedInput) {
  return read(async () => {
    const client = clientFor(input.accessToken);
    const [requests, pending, links, statistics, newProjects, pendingKeys, positions, snapshots,
      requestReviews, linkReviews] = await Promise.all([
      client.rpc('get_financial_budget_change_requests', {
        p_project_id: null, p_status: null, p_year: null, p_region_id: null,
      }),
      client.rpc('get_financial_pending_new_project_funds', {
        p_status: null, p_year: null, p_region_id: null,
      }),
      client.rpc('get_financial_pending_new_project_link_requests', { p_status: null }),
      client.rpc('get_financial_budget_change_statistics', { p_year: null, p_region_id: null }),
      client.rpc('get_financial_new_project_requests', { p_status: null }),
      client.from('financial_pending_new_project_funds')
        .select('id,lot_id,source_request_id,source_line_id,status,linked_project_id'),
      client.rpc('get_financial_project_funding_positions', { p_project_id: null }),
      client.rpc('get_financial_budget_workflow_amount_snapshots', { p_region_id: null }),
      client.from('financial_budget_change_requests')
        .select('id,status,requested_by,approved_by,approved_at,rejected_by,rejected_at,applied_by,applied_at'),
      client.from('financial_pending_new_project_link_requests')
        .select('id,status,requested_by,approved_by,approved_at,rejected_by,rejected_at,applied_by,applied_at'),
    ]);
    for (const result of [requests, pending, links, statistics, newProjects, pendingKeys, positions, snapshots,
      requestReviews, linkReviews]) {
      if (result.error) throw result.error;
    }
    const stats = first(statistics.data as Record<string, unknown>[] | null) ?? {};
    const requestRows = (requests.data ?? []) as Record<string, unknown>[];
    const newProjectRows = (newProjects.data ?? []) as Record<string, unknown>[];
    const pendingRowsFromRpc = (pending.data ?? []) as Record<string, unknown>[];
    const linkRows = (links.data ?? []) as Record<string, unknown>[];
    const pendingKeyRows = (pendingKeys.data ?? []) as Record<string, unknown>[];
    const requestReviewRows = (requestReviews.data ?? []) as Record<string, unknown>[];
    const linkReviewRows = (linkReviews.data ?? []) as Record<string, unknown>[];
    const materializedProjectIds = [...new Set(newProjectRows
      .map((row) => row.materialized_project_id ? String(row.materialized_project_id) : '')
      .filter(Boolean))];
    const regionIds = [...new Set([...requestRows, ...newProjectRows, ...pendingRowsFromRpc, ...linkRows]
      .map((row) => String(row.region_id)).filter(Boolean))];
    const profileIds = [...new Set([
      ...requestRows.map((row) => row.requested_by),
      ...newProjectRows.flatMap((row) => [row.requested_by, row.approved_by, row.rejected_by, row.applied_by]),
      ...linkRows.map((row) => row.requested_by),
      ...requestReviewRows.flatMap((row) => [row.requested_by, row.approved_by, row.rejected_by, row.applied_by]),
      ...linkReviewRows.flatMap((row) => [row.requested_by, row.approved_by, row.rejected_by, row.applied_by]),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0))];
    const regionResult = regionIds.length > 0
      ? await client.from('regions').select('id,sido,sigungu,display_name').in('id', regionIds)
      : { data: [], error: null };
    const materializedProjectsResult = materializedProjectIds.length > 0
      ? await client.from('projects')
        .select('id,year,project_code,project_name,fund_project_name,detail_project_name')
        .in('id', materializedProjectIds)
      : { data: [], error: null };
    const profileResult = profileIds.length > 0
      ? await client.from('profiles').select('id,name,login_id,email').in('id', profileIds)
      : { data: [], error: null };
    if (regionResult.error) throw regionResult.error;
    if (materializedProjectsResult.error) throw materializedProjectsResult.error;
    if (profileResult.error) throw profileResult.error;
    const regionMap = new Map((regionResult.data ?? []).map((region) => [region.id, region]));
    const materializedProjectMap = new Map((materializedProjectsResult.data ?? []).map((project) => [project.id, project]));
    const profileNameMap = new Map((profileResult.data ?? []).map((profile) => [
      profile.id,
      profile.name && !/[A-Za-z@]/.test(profile.name) ? profile.name : '사용자',
    ]));
    const reviewMetadata = (row: Record<string, unknown> | undefined): RequestReviewMetadata => ({
      database_status: row?.status
        ? String(row.status) as RequestReviewMetadata['database_status']
        : null,
      requested_by_name: row?.requested_by ? profileNameMap.get(String(row.requested_by)) ?? null : null,
      approved_by_name: row?.approved_by ? profileNameMap.get(String(row.approved_by)) ?? null : null,
      approved_at: row?.approved_at ? String(row.approved_at) : null,
      rejected_by_name: row?.rejected_by ? profileNameMap.get(String(row.rejected_by)) ?? null : null,
      rejected_at: row?.rejected_at ? String(row.rejected_at) : null,
      applied_by_name: row?.applied_by ? profileNameMap.get(String(row.applied_by)) ?? null : null,
      applied_at: row?.applied_at ? String(row.applied_at) : null,
    });
    const requestReviewMap = new Map(requestReviewRows.map((row) => [String(row.id), row]));
    const linkReviewMap = new Map(linkReviewRows.map((row) => [String(row.id), row]));
    const pendingKeyMap = new Map(pendingKeyRows.map((row) => [String(row.id), row]));
    const pendingByLot = new Map(pendingKeyRows.map((row) => [String(row.lot_id), row]));
    const linkByPending = new Map(linkRows.map((row) => [String(row.pending_fund_id), row]));
    const newProjectByLot = new Map(newProjectRows.map((row) => [String(row.source_lot_id), row]));
    const positionMap = new Map(((positions.data ?? []) as Record<string, unknown>[])
      .map((row) => [String(row.project_id), row]));
    const exactChangesByRequest = new Map<string, BudgetWorkflowAmountChange[]>();
    for (const row of (snapshots.data ?? []) as Record<string, unknown>[]) {
      const requestId = String(row.budget_request_id);
      const list = exactChangesByRequest.get(requestId) ?? [];
      list.push(normalizeAmountChange(row));
      exactChangesByRequest.set(requestId, list);
    }

    const normalizedRequests = requestRows.map((row) => {
      const request = normalizeRequest(row);
      request.destinations = request.destinations.map((line) => {
        const newProject = line.new_project_request_id
          ? newProjectRows.find((candidate) => String(candidate.id) === line.new_project_request_id)
          : undefined;
        if (!newProject) return line;
        return {
          ...line,
          planned_project_status: isProjectStatus(newProject.project_status ? String(newProject.project_status) : null)
            ? String(newProject.project_status) as BudgetChangeDestination['planned_project_status']
            : line.planned_project_status,
          planned_execution_status_reason: newProject.execution_status_reason
            ? String(newProject.execution_status_reason)
            : undefined,
        };
      });
      const exactChanges = exactChangesByRequest.get(request.id) ?? [];
      const exactKeys = new Set(exactChanges.map((change) => `${change.event_type}:${change.event_id}:${change.project_id}:${change.role}`));
      const changes = [...exactChanges];
      const sourcePosition = positionMap.get(request.source_project_id);
      if (sourcePosition && !exactKeys.has(`BUDGET_CHANGE:${request.id}:${request.source_project_id}:SOURCE`)) {
        const original = String(sourcePosition.ledger_original_allocation ?? '0');
        const increase = String(sourcePosition.ledger_increase_amount ?? '0');
        const execution = String(sourcePosition.ledger_execution_amount ?? '0');
        changes.push({
          event_type: 'BUDGET_CHANGE', event_id: request.id,
          project_id: request.source_project_id, fiscal_year: request.fiscal_year,
          project_code: request.source_project_code, project_name: request.source_project_name,
          role: 'SOURCE', amount: request.total_amount,
          capture_kind: request.status === 'APPLIED' ? 'DERIVED_CURRENT' : 'PROPOSED',
          before: amountSnapshot({ original, increase, decrease: request.decrease_amount_before, execution }),
          after: amountSnapshot({ original, increase, decrease: request.decrease_amount_after, execution }),
        });
      }
      for (const line of request.destinations) {
        if (line.destination_type !== 'EXISTING_PROJECT' || !line.destination_project_id) continue;
        if (exactKeys.has(`BUDGET_CHANGE:${request.id}:${line.destination_project_id}:DESTINATION`)) continue;
        const destinationPosition = positionMap.get(line.destination_project_id);
        if (!destinationPosition) continue;
        const original = String(destinationPosition.ledger_original_allocation ?? '0');
        const currentIncrease = BigInt(String(destinationPosition.ledger_increase_amount ?? '0'));
        const decrease = String(destinationPosition.ledger_decrease_amount ?? '0');
        const execution = String(destinationPosition.ledger_execution_amount ?? '0');
        const delta = BigInt(line.amount);
        const applied = request.status === 'APPLIED';
        const beforeIncrease = applied ? currentIncrease - delta : currentIncrease;
        const afterIncrease = applied ? currentIncrease : currentIncrease + delta;
        changes.push({
          event_type: 'BUDGET_CHANGE', event_id: request.id,
          project_id: line.destination_project_id,
          fiscal_year: Number(destinationPosition.fiscal_year ?? request.fiscal_year),
          project_code: line.destination_project_code,
          project_name: line.destination_project_name ?? '사업명 확인 필요',
          role: 'DESTINATION', amount: line.amount,
          capture_kind: applied ? 'DERIVED_CURRENT' : 'PROPOSED',
          before: amountSnapshot({ original, increase: beforeIncrease.toString(), decrease, execution }),
          after: amountSnapshot({ original, increase: afterIncrease.toString(), decrease, execution }),
        });
      }
      const workflowSteps = request.destinations
        .filter((line) => line.destination_type === 'PENDING_NEW_PROJECT')
        .map((line) => {
          const pendingRow = pendingKeyRows.find((candidate) => String(candidate.source_line_id) === line.line_id);
          const newProject = line.new_project_request_id
            ? newProjectRows.find((candidate) => String(candidate.id) === line.new_project_request_id)
            : pendingRow ? newProjectByLot.get(String(pendingRow.lot_id)) : undefined;
          const link = pendingRow ? linkByPending.get(String(pendingRow.id)) : undefined;
          const project = newProject?.materialized_project_id
            ? materializedProjectMap.get(String(newProject.materialized_project_id))
            : undefined;
          return {
            line_id: line.line_id,
            workflow_group_id: request.id,
            pending_fund_id: pendingRow ? String(pendingRow.id) : null,
            pending_status: pendingRow ? String(pendingRow.status) as PendingNewProjectFund['status'] : null,
            new_project_request_id: newProject ? String(newProject.id) : null,
            new_project_request_status: newProject ? String(newProject.status) as BudgetChangeRequest['status'] : null,
            link_request_id: link ? String(link.id) : null,
            link_request_status: link ? String(link.status) as BudgetChangeRequest['status'] : null,
            materialized_project_id: newProject?.materialized_project_id ? String(newProject.materialized_project_id) : null,
            materialized_project_code: project?.project_code ? String(project.project_code) : null,
            materialized_project_name: project
              ? String(project.detail_project_name || project.fund_project_name || project.project_name || '사업명 확인 필요')
              : null,
          };
        });
      const region = regionMap.get(request.region_id);
      return {
        ...request,
        ...reviewMetadata(requestReviewMap.get(request.id)),
        sido: region?.sido ?? null,
        sigungu: region?.sigungu ?? null,
        region_name: region?.display_name ?? null,
        amount_changes: changes,
        workflow_steps: workflowSteps,
      };
    });

    const pendingRows = pendingRowsFromRpc.map((row) => {
      const keys = pendingKeyMap.get(String(row.id));
      const region = regionMap.get(String(row.region_id));
      return {
        ...row,
        source_lot_id: String(keys?.lot_id ?? ''),
        new_project_request_id: null,
        amount: String(row.amount ?? '0'), fiscal_year: Number(row.fiscal_year),
        planned_project_year: Number(row.planned_project_year),
        sido: region?.sido ?? null,
        sigungu: region?.sigungu ?? null,
        region_name: region?.display_name ?? null,
      };
    }) as PendingNewProjectFund[];

    const normalizedNewProjects: BudgetChangeNewProjectRequest[] = newProjectRows.map((row) => {
      const pendingRow = row.source_lot_id ? pendingByLot.get(String(row.source_lot_id)) : undefined;
      const parentRequestId = row.source_budget_change_request_id
        ? String(row.source_budget_change_request_id) : null;
      const fundingSourceRequestId = parentRequestId
        ?? (pendingRow ? String(pendingRow.source_request_id) : null);
      const sourceRequest = fundingSourceRequestId
        ? normalizedRequests.find((request) => request.id === fundingSourceRequestId)
        : undefined;
      const link = pendingRow ? linkByPending.get(String(pendingRow.id)) : undefined;
      const project = row.materialized_project_id
        ? materializedProjectMap.get(String(row.materialized_project_id))
        : undefined;
      const region = regionMap.get(String(row.region_id));
      return {
        ...reviewMetadata(row),
        id: String(row.id), region_id: String(row.region_id), fiscal_year: Number(row.fiscal_year),
        project_name: String(row.project_name ?? '사업명 확인 필요'),
        project_status: isProjectStatus(row.project_status ? String(row.project_status) : null)
          ? String(row.project_status) as BudgetChangeNewProjectRequest['project_status']
          : null,
        execution_status_reason: row.execution_status_reason ? String(row.execution_status_reason) : null,
        requested_amount: String(row.requested_amount ?? '0'),
        source_lot_id: row.source_lot_id ? String(row.source_lot_id) : null,
        source_budget_change_request_id: parentRequestId,
        source_budget_change_line_id: row.source_budget_change_line_id ? String(row.source_budget_change_line_id) : null,
        status: String(row.status) as BudgetChangeNewProjectRequest['status'],
        official_project_code: row.official_project_code ? String(row.official_project_code) : null,
        requested_at: String(row.requested_at ?? ''),
        rejection_reason: row.rejection_reason ? String(row.rejection_reason) : null,
        materialized_project_id: row.materialized_project_id ? String(row.materialized_project_id) : null,
        materialized_project_code: project?.project_code ? String(project.project_code) : null,
        materialized_project_name: project
          ? String(project.detail_project_name || project.fund_project_name || project.project_name || '사업명 확인 필요')
          : null,
        pending_fund_id: pendingRow ? String(pendingRow.id) : null,
        pending_status: pendingRow ? String(pendingRow.status) as BudgetChangeNewProjectRequest['pending_status'] : null,
        source_request_id: fundingSourceRequestId,
        source_project_id: sourceRequest?.source_project_id ?? null,
        source_project_code: sourceRequest?.source_project_code ?? null,
        source_project_name: sourceRequest?.source_project_name ?? null,
        source_fiscal_year: sourceRequest?.fiscal_year ?? null,
        link_request_id: link ? String(link.id) : null,
        link_request_status: link ? String(link.status) as BudgetChangeNewProjectRequest['link_request_status'] : null,
        workflow_group_id: parentRequestId ?? String(row.id),
        sido: region?.sido ?? null,
        sigungu: region?.sigungu ?? null,
        region_name: region?.display_name ?? null,
      };
    });
    return {
      requests: normalizedRequests,
      pending: pendingRows,
      newProjectRequests: normalizedNewProjects,
      links: linkRows.map((row) => {
        const region = regionMap.get(String(row.region_id));
        return {
          ...row,
          ...reviewMetadata(linkReviewMap.get(String(row.id))),
          amount: String(row.amount ?? '0'),
          planned_project_year: Number(row.planned_project_year),
          sido: region?.sido ?? null,
          sigungu: region?.sigungu ?? null,
          region_name: region?.display_name ?? null,
        };
      }) as PendingNewProjectLinkRequest[],
      statistics: Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, String(value ?? '0')])) as BudgetChangeStatistics,
    };
  });
}
