"use server";

import { createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import {
  isIsoDate,
  isPositiveBigIntString,
  isUuid,
  toOptionalTrimmedText,
  type FinancialActionResult,
  type FinancialBudgetYear,
  type TransferDestinationProject,
} from '../../lib/financialLedger';
import { isPublicDemoMode, PUBLIC_DEMO_DISABLED_MESSAGE } from '../../lib/demo-mode';
import { assertLedgerTestWriteEnabled } from '../../lib/ledgerRuntime';
import { formatUserFacingError } from '../../lib/presentationLabels';

type AuthenticatedInput = {
  accessToken: string;
};

type IdempotentInput = AuthenticatedInput & {
  idempotencyKey: string;
};

type MutationResult = {
  id: string;
  status: string;
};

function assertAccessToken(accessToken: string) {
  if (!accessToken || accessToken.length > 8_000) {
    throw new Error('로그인 세션을 다시 확인해 주세요.');
  }
}

function assertUuid(value: string, label: string) {
  if (!isUuid(value)) {
    throw new Error(`${label}이(가) 올바르지 않습니다.`);
  }
}

function assertIdempotencyKey(value: string) {
  assertUuid(value, '요청 식별키');
}

function assertAmount(value: string, label = '금액') {
  if (!isPositiveBigIntString(value)) {
    throw new Error(`${label}은(는) bigint 범위의 양의 원 단위 정수여야 합니다.`);
  }
}

function assertDate(value: string, label = '일자') {
  if (!isIsoDate(value)) {
    throw new Error(`${label}는 YYYY-MM-DD 형식의 실제 날짜여야 합니다.`);
  }
}

function createFinancialClient(accessToken: string) {
  if (isPublicDemoMode) {
    throw new Error(PUBLIC_DEMO_DISABLED_MESSAGE);
  }
  assertAccessToken(accessToken);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('Supabase 환경변수가 설정되지 않았습니다.');
  }

  // The caller's JWT is forwarded, not elevated. Every SECURITY DEFINER RPC
  // still derives auth.uid() and region permissions from this token.
  return createClient(url, anonKey, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
}

function mapDatabaseError(error: unknown) {
  return formatUserFacingError(error, '재정원장 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
}

async function callRpc<T>(accessToken: string, functionName: string, args: Record<string, unknown>) {
  const supabase = createFinancialClient(accessToken);
  const { data, error } = await supabase.rpc(functionName, args);
  if (error) {
    throw error;
  }
  return data as T;
}

async function runRead<T>(work: () => Promise<T>): Promise<FinancialActionResult<T>> {
  try {
    return { data: await work() };
  } catch (error) {
    return { error: mapDatabaseError(error) };
  }
}

async function runMutation<T>(work: () => Promise<T>): Promise<FinancialActionResult<T>> {
  try {
    assertLedgerTestWriteEnabled();
    const data = await work();
    revalidatePath('/my-projects');
    revalidatePath('/dashboard');
    return { data };
  } catch (error) {
    return { error: mapDatabaseError(error) };
  }
}

export async function getFinancialBudgetYearsAction(
  input: AuthenticatedInput,
): Promise<FinancialActionResult<FinancialBudgetYear[]>> {
  return runRead(async () => {
    const rows = await callRpc<FinancialBudgetYear[]>(input.accessToken, 'get_financial_budget_years', {});
    return rows ?? [];
  });
}

export async function getTransferDestinationProjectsAction(
  input: AuthenticatedInput & { sourceBudgetYearId: string },
): Promise<FinancialActionResult<TransferDestinationProject[]>> {
  return runRead(async () => {
    assertUuid(input.sourceBudgetYearId, '원천 재원 위치');
    const rows = await callRpc<TransferDestinationProject[]>(input.accessToken, 'get_transfer_destination_projects', {
      p_source_budget_year_id: input.sourceBudgetYearId,
    });
    return rows ?? [];
  });
}

export async function createProjectBudgetCohortAction(input: IdempotentInput & {
  projectId: string;
  originFiscalYear: number;
  initialAllocation: string;
  allocationType: 'INITIAL' | 'EXTERNAL_INCREASE';
  memo: string;
  effectiveDate: string;
}): Promise<FinancialActionResult<{ cohortId: string; budgetYearId: string }>> {
  return runMutation(async () => {
    assertUuid(input.projectId, '사업');
    assertIdempotencyKey(input.idempotencyKey);
    assertAmount(input.initialAllocation, '최초 배분액');
    if (!Number.isInteger(input.originFiscalYear) || input.originFiscalYear < 2000 || input.originFiscalYear > 2200) {
      throw new Error('최초 재원연도가 올바르지 않습니다.');
    }
    assertDate(input.effectiveDate, '최초 재원 효력일');
    const rows = await callRpc<Array<{ cohort_id: string; budget_year_id: string }>>(
      input.accessToken,
      'create_project_budget_cohort',
      {
        p_project_id: input.projectId,
        p_origin_fiscal_year: input.originFiscalYear,
        p_initial_allocation: input.initialAllocation,
        p_allocation_type: input.allocationType,
        p_memo: toOptionalTrimmedText(input.memo, 1000, '메모'),
        p_effective_date: input.effectiveDate,
        p_idempotency_key: input.idempotencyKey,
      },
    );
    const row = rows?.[0];
    if (!row) throw new Error('생성 결과를 받지 못했습니다.');
    return { cohortId: row.cohort_id, budgetYearId: row.budget_year_id };
  });
}

export async function createOrSubmitTransferAction(input: IdempotentInput & {
  sourceBudgetYearId: string;
  destinationProjectId: string;
  amount: string;
  reasonCode: string;
  memo: string;
  effectiveDate: string;
  submit?: boolean;
}): Promise<FinancialActionResult<MutationResult>> {
  return runMutation(async () => {
    assertUuid(input.sourceBudgetYearId, '원천 재원 위치');
    assertUuid(input.destinationProjectId, '수신 사업');
    assertIdempotencyKey(input.idempotencyKey);
    assertAmount(input.amount);
    assertDate(input.effectiveDate, '이동일');
    const rows = await callRpc<Array<{ transfer_id: string; status: string }>>(
      input.accessToken,
      'create_or_submit_transfer',
      {
        p_source_budget_year_id: input.sourceBudgetYearId,
        p_destination_project_id: input.destinationProjectId,
        p_amount: input.amount,
        p_reason_code: toOptionalTrimmedText(input.reasonCode, 100, '이동 사유'),
        p_memo: toOptionalTrimmedText(input.memo, 1000, '메모'),
        p_effective_date: input.effectiveDate,
        p_idempotency_key: input.idempotencyKey,
        p_submit: input.submit ?? true,
      },
    );
    const row = rows?.[0];
    if (!row) throw new Error('재원이동 결과를 받지 못했습니다.');
    return { id: row.transfer_id, status: row.status };
  });
}

export async function submitTransferAction(input: AuthenticatedInput & { transferId: string }) {
  return runMutation(async () => {
    assertUuid(input.transferId, '재원이동');
    const rows = await callRpc<Array<{ transfer_id: string; status: string }>>(input.accessToken, 'submit_transfer', {
      p_transfer_id: input.transferId,
    });
    const row = rows?.[0];
    if (!row) throw new Error('재원이동 제출 결과를 받지 못했습니다.');
    return { id: row.transfer_id, status: row.status };
  });
}

export async function approveTransferAction(input: AuthenticatedInput & { transferId: string; resolutionNote: string }) {
  return runTransferResolution(input, 'approve_transfer', '승인');
}

export async function rejectTransferAction(input: AuthenticatedInput & { transferId: string; resolutionNote: string }) {
  return runTransferResolution(input, 'reject_transfer', '반려', true);
}

export async function withdrawTransferAction(input: AuthenticatedInput & { transferId: string; resolutionNote: string }) {
  return runTransferResolution(input, 'withdraw_transfer', '철회');
}

async function runTransferResolution(
  input: AuthenticatedInput & { transferId: string; resolutionNote: string },
  functionName: 'approve_transfer' | 'reject_transfer' | 'withdraw_transfer',
  label: string,
  requiredNote = false,
): Promise<FinancialActionResult<MutationResult>> {
  return runMutation(async () => {
    assertUuid(input.transferId, '재원이동');
    const note = toOptionalTrimmedText(input.resolutionNote, 1000, `${label} 사유`);
    if (requiredNote && !note) throw new Error(`${label} 사유를 입력하세요.`);
    const rows = await callRpc<Array<{ transfer_id: string; status: string }>>(input.accessToken, functionName, {
      p_transfer_id: input.transferId,
      p_resolution_note: note,
    });
    const row = rows?.[0];
    if (!row) throw new Error(`재원이동 ${label} 결과를 받지 못했습니다.`);
    return { id: row.transfer_id, status: row.status };
  });
}

export async function createTransferReversalAction(input: IdempotentInput & {
  originalTransferId: string;
  amount: string;
  memo: string;
  effectiveDate: string;
}) {
  return runMutation(async () => {
    assertUuid(input.originalTransferId, '원 재원이동');
    assertIdempotencyKey(input.idempotencyKey);
    assertAmount(input.amount);
    assertDate(input.effectiveDate, '정정일');
    const rows = await callRpc<Array<{ transfer_id: string; status: string }>>(input.accessToken, 'create_transfer_reversal', {
      p_original_transfer_id: input.originalTransferId,
      p_amount: input.amount,
      p_memo: toOptionalTrimmedText(input.memo, 1000, '메모'),
      p_effective_date: input.effectiveDate,
      p_idempotency_key: input.idempotencyKey,
    });
    const row = rows?.[0];
    if (!row) throw new Error('재원이동 정정 결과를 받지 못했습니다.');
    return { id: row.transfer_id, status: row.status };
  });
}

export async function confirmExecutionAction(input: IdempotentInput & {
  budgetYearId: string;
  amount: string;
  executionDate: string;
  memo: string;
}): Promise<FinancialActionResult<MutationResult>> {
  return runMutation(async () => {
    assertUuid(input.budgetYearId, '재원 위치');
    assertIdempotencyKey(input.idempotencyKey);
    assertAmount(input.amount, '집행액');
    assertDate(input.executionDate, '집행일');
    const rows = await callRpc<Array<{ execution_id: string; status: string }>>(input.accessToken, 'confirm_execution', {
      p_budget_year_id: input.budgetYearId,
      p_amount: input.amount,
      p_execution_date: input.executionDate,
      p_memo: toOptionalTrimmedText(input.memo, 1000, '메모'),
      p_idempotency_key: input.idempotencyKey,
    });
    const row = rows?.[0];
    if (!row) throw new Error('집행 결과를 받지 못했습니다.');
    return { id: row.execution_id, status: row.status };
  });
}

export async function createExecutionReversalAction(input: IdempotentInput & {
  originalExecutionId: string;
  amount: string;
  memo: string;
  executionDate: string;
}) {
  return runLedgerReversal(input, 'create_execution_reversal', 'originalExecutionId', '집행', input.executionDate);
}

export async function createCarryoverAction(input: IdempotentInput & {
  sourceBudgetYearId: string;
  destinationProjectId: string;
  amount: string;
  memo: string;
  effectiveDate: string;
}) {
  return runMutation(async () => {
    assertUuid(input.sourceBudgetYearId, '원천 재원 위치');
    assertUuid(input.destinationProjectId, '수신 사업');
    assertIdempotencyKey(input.idempotencyKey);
    assertAmount(input.amount, '이월액');
    assertDate(input.effectiveDate, '이월 효력일');
    const rows = await callRpc<Array<{ carryover_id: string; carryover_type: string }>>(input.accessToken, 'create_carryover', {
      p_source_budget_year_id: input.sourceBudgetYearId,
      p_destination_project_id: input.destinationProjectId,
      p_amount: input.amount,
      p_memo: toOptionalTrimmedText(input.memo, 1000, '메모'),
      p_effective_date: input.effectiveDate,
      p_idempotency_key: input.idempotencyKey,
    });
    const row = rows?.[0];
    if (!row) throw new Error('이월 결과를 받지 못했습니다.');
    return { id: row.carryover_id, status: row.carryover_type };
  });
}

export async function createCarryoverReversalAction(input: IdempotentInput & {
  originalCarryoverId: string;
  amount: string;
  memo: string;
  effectiveDate: string;
}) {
  return runLedgerReversal(input, 'create_carryover_reversal', 'originalCarryoverId', '이월', input.effectiveDate);
}

export async function createBudgetAdjustmentAction(input: IdempotentInput & {
  budgetYearId: string;
  adjustmentType: 'RETURN' | 'EXTERNAL_DECREASE' | 'CORRECTION_INCREASE' | 'CORRECTION_DECREASE';
  amount: string;
  reasonCode: string;
  memo: string;
  effectiveDate: string;
}) {
  return runMutation(async () => {
    assertUuid(input.budgetYearId, '재원 위치');
    assertIdempotencyKey(input.idempotencyKey);
    assertAmount(input.amount, '조정액');
    assertDate(input.effectiveDate, '조정일');
    const rows = await callRpc<Array<{ adjustment_id: string; status: string }>>(input.accessToken, 'create_budget_adjustment', {
      p_budget_year_id: input.budgetYearId,
      p_adjustment_type: input.adjustmentType,
      p_amount: input.amount,
      p_reason_code: toOptionalTrimmedText(input.reasonCode, 100, '조정 사유'),
      p_memo: toOptionalTrimmedText(input.memo, 1000, '메모'),
      p_effective_date: input.effectiveDate,
      p_idempotency_key: input.idempotencyKey,
    });
    const row = rows?.[0];
    if (!row) throw new Error('예산 조정 결과를 받지 못했습니다.');
    return { id: row.adjustment_id, status: row.status };
  });
}

export async function createBudgetAdjustmentReversalAction(input: IdempotentInput & {
  originalAdjustmentId: string;
  amount: string;
  memo: string;
  effectiveDate: string;
}) {
  return runLedgerReversal(input, 'create_budget_adjustment_reversal', 'originalAdjustmentId', '예산 조정', input.effectiveDate);
}

async function runLedgerReversal(
  input: IdempotentInput & Record<string, string>,
  functionName: 'create_execution_reversal' | 'create_carryover_reversal' | 'create_budget_adjustment_reversal',
  originalIdKey: 'originalExecutionId' | 'originalCarryoverId' | 'originalAdjustmentId',
  label: string,
  effectiveDate: string,
): Promise<FinancialActionResult<MutationResult>> {
  return runMutation(async () => {
    const originalId = input[originalIdKey];
    assertUuid(originalId, `원 ${label}`);
    assertIdempotencyKey(input.idempotencyKey);
    assertAmount(input.amount, '정정액');
    assertDate(effectiveDate, `${label} 정정 효력일`);
    const dateParameter = functionName === 'create_execution_reversal'
      ? { p_execution_date: effectiveDate }
      : { p_effective_date: effectiveDate };
    const rows = await callRpc<Array<Record<string, string>>>(input.accessToken, functionName, {
      [`p_original_${functionName === 'create_execution_reversal' ? 'execution' : functionName === 'create_carryover_reversal' ? 'carryover' : 'adjustment'}_id`]: originalId,
      p_amount: input.amount,
      p_memo: toOptionalTrimmedText(input.memo, 1000, '메모'),
      ...dateParameter,
      p_idempotency_key: input.idempotencyKey,
    });
    const row = rows?.[0];
    if (!row) throw new Error(`${label} 정정 결과를 받지 못했습니다.`);
    const id = row.execution_id ?? row.carryover_id ?? row.adjustment_id;
    if (!id) throw new Error(`${label} 정정 식별자를 받지 못했습니다.`);
    return { id, status: row.status ?? row.carryover_type ?? 'CONFIRMED' };
  });
}
