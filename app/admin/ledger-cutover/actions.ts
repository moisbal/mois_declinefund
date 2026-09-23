"use server";

import { createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import type { FinancialActionResult } from '../../../lib/financialLedger';
import { isPublicDemoMode, PUBLIC_DEMO_DISABLED_MESSAGE } from '../../../lib/demo-mode';
import { assertLedgerTestTarget } from '../../../lib/ledgerRuntime';
import { formatUserFacingError } from '../../../lib/presentationLabels';

export type LedgerCutover = {
  id: string;
  operating_start_date: string;
  baseline_as_of: string;
  status: 'PREPARING' | 'REVIEWING' | 'CONFIRMED';
  memo: string | null;
  created_at: string | null;
};

export type BaselinePreparationResult = {
  baseline_candidates: number;
  auto_excluded: number;
  needs_review: number;
};

type AuthenticatedInput = {
  accessToken: string;
};

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertAccessToken(accessToken: string) {
  if (!accessToken || accessToken.length > 8_000) {
    throw new Error('로그인 세션을 다시 확인해 주세요.');
  }
}

function assertIsoDate(value: string) {
  if (!ISO_DATE_PATTERN.test(value)) {
    throw new Error('운영 시작일은 YYYY-MM-DD 형식의 실제 날짜여야 합니다.');
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('운영 시작일은 YYYY-MM-DD 형식의 실제 날짜여야 합니다.');
  }
}

function createLedgerClient(accessToken: string) {
  if (isPublicDemoMode) {
    throw new Error(PUBLIC_DEMO_DISABLED_MESSAGE);
  }
  assertAccessToken(accessToken);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('Supabase 환경변수가 설정되지 않았습니다.');
  }

  // Do not elevate privileges: PostgreSQL receives the signed-in admin's JWT.
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

function errorMessage(error: unknown) {
  return formatUserFacingError(error, '운영전환 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
}

async function runAction<T>(work: () => Promise<T>): Promise<FinancialActionResult<T>> {
  try {
    return { data: await work() };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

async function runMutation<T>(work: () => Promise<T>): Promise<FinancialActionResult<T>> {
  return runAction(async () => {
    // Legacy Baseline review remains possible with LEDGER_MODE disabled, but
    // this phase never permits it against an unverified or production target.
    assertLedgerTestTarget();
    return work();
  });
}

export async function getLedgerCutoverAction(
  input: AuthenticatedInput,
): Promise<FinancialActionResult<LedgerCutover | null>> {
  return runAction(async () => {
    const supabase = createLedgerClient(input.accessToken);
    const { data, error } = await supabase
      .from('financial_ledger_cutovers')
      .select('id, operating_start_date, baseline_as_of, status, memo, created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return (data as LedgerCutover | null) ?? null;
  });
}

export async function createLedgerCutoverAction(input: AuthenticatedInput & {
  operatingStartDate: string;
  memo: string;
}): Promise<FinancialActionResult<{ cutoverId: string }>> {
  return runMutation(async () => {
    assertIsoDate(input.operatingStartDate);
    if (input.memo.trim().length > 1_000) {
      throw new Error('메모는 1,000자 이하여야 합니다.');
    }

    const supabase = createLedgerClient(input.accessToken);
    const { data, error } = await supabase.rpc('financial_create_ledger_cutover', {
      p_operating_start_date: input.operatingStartDate,
      p_memo: input.memo.trim() || null,
    });
    if (error) throw error;
    if (typeof data !== 'string' || !data) {
      throw new Error('운영전환 작업 식별값을 반환받지 못했습니다.');
    }

    revalidatePath('/admin');
    revalidatePath('/admin/ledger-cutover');
    return { cutoverId: data };
  });
}

export async function prepareLegacyBaselinesAction(input: AuthenticatedInput & {
  cutoverId: string;
}): Promise<FinancialActionResult<BaselinePreparationResult>> {
  return runMutation(async () => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.cutoverId)) {
      throw new Error('운영전환 작업 식별값이 올바르지 않습니다.');
    }

    const supabase = createLedgerClient(input.accessToken);
    const { data, error } = await supabase.rpc('financial_prepare_legacy_baselines', {
      p_cutover_id: input.cutoverId,
    });
    if (error) throw error;

    const result = Array.isArray(data) ? data[0] : null;
    if (!result) {
      throw new Error('기준잔액 초안 생성 결과를 반환받지 못했습니다.');
    }

    revalidatePath('/admin');
    revalidatePath('/admin/ledger-cutover');
    return result as BaselinePreparationResult;
  });
}
