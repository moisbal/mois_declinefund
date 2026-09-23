"use server";

import { createClient } from '@supabase/supabase-js';
import type {
  WorkspaceProject,
  WorkspaceRequestRow,
} from '../../lib/myProjectsWorkspace';
import {
  formatProjectOption,
  formatStoredUserText,
  formatUserFacingError,
} from '../../lib/presentationLabels';

export type WorkspaceSnapshot = {
  environment: 'TEST' | 'PRODUCTION' | 'UNKNOWN';
  regionName: string;
  projects: WorkspaceProject[];
  requests: WorkspaceRequestRow[];
  categories: {
    large: Array<{ id: string; name: string }>;
    middle: Array<{ id: string; name: string; large_category_id: string }>;
    small: Array<{ id: string; name: string; middle_category_id: string }>;
  };
  baseline: {
    project_count: number;
    original_allocation: string;
    adjusted_allocation: string;
    execution: string;
    raw_request_count: number;
  };
};

export type WorkspaceActionResult = { data: WorkspaceSnapshot; error?: never } | { data?: never; error: string };
export type NewProjectDeletionTargetKind = 'DRAFT' | 'PROJECT';
export type NewProjectDeletionEligibility = {
  target_kind: NewProjectDeletionTargetKind;
  target_id: string;
  project_name: string;
  fiscal_year: number;
  can_delete: boolean;
  reason: string | null;
  project_id: string | null;
  request_id: string | null;
  impact: string;
};
export type NewProjectDeletionResult = {
  deletion_event_id: string;
  target_kind: NewProjectDeletionTargetKind;
  target_id: string;
  project_name: string;
  fiscal_year: number;
  deleted_at: string;
};

function clientFor(accessToken: string) {
  if (!accessToken || accessToken.length > 8_000) throw new Error('로그인 세션을 다시 확인해 주세요.');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('시험 조회 환경이 설정되지 않았습니다.');
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

function text(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function nullableText(value: unknown) {
  const valueText = text(value).trim();
  return valueText || null;
}

function amount(value: unknown) {
  const valueText = text(value, '0');
  return /^-?\d+$/.test(valueText) ? valueText : '0';
}

function latestTime(row: Record<string, unknown>) {
  return nullableText(row.applied_at) ?? nullableText(row.rejected_at) ?? nullableText(row.approved_at);
}

function statusStage(status: string, kind: WorkspaceRequestRow['kind'], hasPendingDestination = false) {
  if (status === 'REJECTED') return '보완 후 재요청 필요';
  if (status === 'DRAFT') return hasPendingDestination ? '재원 연결 준비 중' : '요청 내용 작성 중';
  if (status === 'SUBMITTED') {
    if (kind === 'PENDING_LINK') return '예정재원 직접 연결 재시도 필요';
    return hasPendingDestination ? '등록·예산연결 재시도 필요' : '직접 처리 재시도 필요';
  }
  if (status === 'APPROVED') {
    if (kind === 'NEW_PROJECT') return '과거 승인 건 직접 처리 재시도 필요';
    if (kind === 'PENDING_LINK') return '과거 승인 건 연결 재시도 필요';
    return hasPendingDestination ? '과거 요청 직접 처리 재시도 필요' : '예산 반영 재시도 필요';
  }
  if (status === 'APPLIED' || status === 'LINKED' || status === 'COMPLETED') return '처리 완료';
  if (status === 'CANCELLED') return '취소 완료';
  if (status === 'DUPLICATE') return '중복 요청 종료';
  return '처리상태 확인 필요';
}

function projectLabel(year: unknown, name: unknown, fallback: string) {
  const yearValue = Number(year);
  return formatProjectOption({
    fiscal_year: Number.isInteger(yearValue) ? yearValue : null,
    project_name: nullableText(name) ?? fallback,
  });
}

function destinationLabel(request: Record<string, unknown>) {
  const destinations = Array.isArray(request.destinations)
    ? request.destinations as Record<string, unknown>[]
    : [];
  if (destinations.length === 0) return '목적지 확인 필요';
  const labels = destinations.map((destination) => projectLabel(
    destination.planned_project_year ?? request.fiscal_year,
    destination.destination_project_name ?? destination.planned_project_name,
    destination.destination_type === 'PENDING_NEW_PROJECT' ? '신규사업 예정' : '사업명 확인 필요',
  ));
  return labels.length === 1 ? labels[0] : `${labels[0]} 외 ${labels.length - 1}곳`;
}

function budgetRequestRow(row: Record<string, unknown>): WorkspaceRequestRow {
  const id = text(row.id);
  const status = text(row.status);
  const destinations = Array.isArray(row.destinations) ? row.destinations as Record<string, unknown>[] : [];
  const hasPendingDestination = destinations.some((destination) => destination.destination_type === 'PENDING_NEW_PROJECT');
  return {
    id,
    correlation_id: id,
    kind: 'BUDGET_CHANGE',
    requested_at: text(row.requested_at),
    processed_at: latestTime(row),
    fiscal_year: Number(row.fiscal_year),
    source_label: projectLabel(row.fiscal_year, row.source_project_name, '출처 사업 확인 필요'),
    destination_label: destinationLabel(row),
    amount: amount(row.total_amount),
    status,
    stage: statusStage(status, 'BUDGET_CHANGE', hasPendingDestination),
    rejection_reason: row.rejection_reason
      ? formatStoredUserText(text(row.rejection_reason), '반려 사유 확인 필요')
      : null,
    detail_href: row.source_project_id ? `/my-projects/${text(row.source_project_id)}/edit?section=funding&request=${id}` : null,
    can_edit: status === 'DRAFT',
    steps: [
      { key: `${id}:requested`, label: '기존 사업 감액 요청', occurred_at: text(row.requested_at), state: 'done' },
      ...(status === 'REJECTED'
        ? [{ key: `${id}:rejected`, label: '관리자 반려', occurred_at: latestTime(row), state: 'blocked' as const }]
        : status === 'DRAFT'
          ? [{ key: `${id}:draft`, label: '요청 내용 작성 중', occurred_at: null, state: 'current' as const }]
          : [{ key: `${id}:review`, label: status === 'APPLIED' ? '승인 없이 직접 처리' : '직접 처리 재시도 필요', occurred_at: nullableText(row.applied_at), state: status === 'APPLIED' ? 'done' as const : 'current' as const }]),
      ...(status === 'APPROVED'
        ? [{ key: `${id}:apply`, label: hasPendingDestination ? '신규사업·예정재원 처리 중' : '예산 반영 대기', occurred_at: null, state: 'current' as const }]
        : status === 'APPLIED'
          ? [{ key: `${id}:applied`, label: hasPendingDestination ? '감액 반영 및 예정재원 생성' : '예산 조정 반영 완료', occurred_at: latestTime(row), state: 'done' as const }]
          : []),
    ],
  };
}

function newProjectRequestRow(row: Record<string, unknown>): WorkspaceRequestRow {
  const id = text(row.id);
  const status = text(row.status);
  const correlationId = nullableText(row.source_budget_change_request_id);
  return {
    id,
    correlation_id: correlationId,
    kind: 'NEW_PROJECT',
    requested_at: text(row.requested_at ?? row.created_at),
    processed_at: latestTime(row),
    fiscal_year: Number(row.fiscal_year),
    source_label: correlationId ? '연결된 예산조정 재원' : row.source_lot_id ? '대기재원 연결' : '재원 미연결 초안',
    destination_label: projectLabel(row.fiscal_year, row.project_name, '신규사업 예정'),
    amount: amount(row.requested_amount),
    status,
    stage: statusStage(status, 'NEW_PROJECT'),
    rejection_reason: row.rejection_reason || row.resolution_note
      ? formatStoredUserText(text(row.rejection_reason ?? row.resolution_note), '반려 사유 확인 필요')
      : null,
    detail_href: row.materialized_project_id
      ? `/my-projects/${text(row.materialized_project_id)}/edit`
      : status === 'DRAFT' && !correlationId
        ? `/my-projects?newProject=1&requestId=${id}`
        : null,
    can_edit: status === 'DRAFT' && !correlationId,
    steps: [
      { key: `${id}:new-request`, label: '신규사업 요청', occurred_at: text(row.requested_at ?? row.created_at), state: 'done' },
      ...(status === 'REJECTED'
        ? [{ key: `${id}:new-rejected`, label: '신규사업 요청 반려', occurred_at: latestTime(row), state: 'blocked' as const }]
        : status === 'SUBMITTED'
          ? [{ key: `${id}:new-review`, label: '신규사업 직접 처리 재시도 필요', occurred_at: null, state: 'current' as const }]
          : status === 'APPROVED'
            ? [{ key: `${id}:new-approved`, label: '과거 승인 건 직접 처리 재시도 필요', occurred_at: nullableText(row.approved_at), state: 'current' as const }]
            : status === 'APPLIED'
              ? [{ key: `${id}:new-applied`, label: '신규사업 등록·예산연결 완료', occurred_at: latestTime(row), state: 'done' as const }]
              : []),
    ],
  };
}

function pendingLinkRequestRow(row: Record<string, unknown>, sourceRequestId: string | null): WorkspaceRequestRow {
  const id = text(row.id);
  const status = text(row.status);
  return {
    id,
    correlation_id: sourceRequestId,
    kind: 'PENDING_LINK',
    requested_at: text(row.requested_at),
    processed_at: latestTime(row),
    fiscal_year: Number(row.planned_project_year),
    source_label: projectLabel(row.planned_project_year, row.planned_project_name, '신규사업 예정'),
    destination_label: projectLabel(row.planned_project_year, row.destination_project_name, '연결 대상 사업'),
    amount: amount(row.amount),
    status,
    stage: statusStage(status, 'PENDING_LINK'),
    rejection_reason: row.rejection_reason
      ? formatStoredUserText(text(row.rejection_reason), '반려 사유 확인 필요')
      : null,
    detail_href: row.destination_project_id ? `/my-projects/${text(row.destination_project_id)}/edit?section=funding&request=${id}` : null,
    can_edit: false,
    steps: [
      { key: `${id}:link-request`, label: '예정재원 연결 요청', occurred_at: text(row.requested_at), state: status === 'SUBMITTED' ? 'current' : 'done' },
      ...(status === 'REJECTED'
        ? [{ key: `${id}:link-rejected`, label: '연결 요청 반려', occurred_at: latestTime(row), state: 'blocked' as const }]
        : status === 'APPROVED'
          ? [{ key: `${id}:link-approved`, label: '과거 승인 건 직접 연결 재시도 필요', occurred_at: nullableText(row.approved_at), state: 'current' as const }]
          : status === 'APPLIED'
            ? [{ key: `${id}:link-applied`, label: '목적지 사업 증액 반영 완료', occurred_at: latestTime(row), state: 'done' as const }]
            : []),
    ],
  };
}

async function loadMyProjectsWorkspaceAction(
  input: { accessToken: string },
  retryOnce: boolean,
): Promise<WorkspaceActionResult> {
  try {
    const client = clientFor(input.accessToken);
    const userResult = await client.auth.getUser(input.accessToken);
    if (userResult.error || !userResult.data.user) throw new Error('로그인 사용자를 확인하지 못했습니다.');
    const profileResult = await client.from('profiles')
      .select('role,region_id,region_name').eq('id', userResult.data.user.id).single();
    if (profileResult.error || !profileResult.data) throw new Error('사용자 지역 정보를 확인하지 못했습니다.');
    if (profileResult.data.role !== 'local_user' || !profileResult.data.region_id) {
      throw new Error('지자체 담당자 계정만 내 사업을 조회할 수 있습니다.');
    }
    const regionId = profileResult.data.region_id;
    const database = client as any;
    const [projectsResult, positionsResult, largeResult, middleResult, smallResult,
      assignmentResult, relatedAssignmentResult, proposalResult, budgetResult,
      budgetMetadataResult, newProjectResult, pendingResult, linkResult,
      linkMetadataResult, runtimeResult] = await Promise.all([
      database.from('projects').select(`
        id,project_code,region_id,year,project_name,fund_project_name,detail_project_name,
        project_period,period,project_start_year,project_end_year,status,execution_status_reason,
        business_type,large_category_id,middle_category_id,primary_small_category_id,
        original_alloc_text:original_alloc::text,increase_amount_text:increase_amount::text,
        decrease_amount_text:decrease_amount::text,alloc_text:alloc::text,exec_text:exec::text,
        rate,updated_at
      `, { count: 'exact' }).eq('region_id', regionId).not('project_code', 'is', null)
        .is('deleted_at', null)
        .order('year', { ascending: false }).order('project_code', { ascending: true }),
      database.rpc('get_financial_project_funding_positions', { p_project_id: null }),
      database.from('large_categories').select('id,name').order('name'),
      database.from('middle_categories').select('id,name,large_category_id').order('name'),
      database.from('small_categories').select('id,name,middle_category_id').order('name'),
      database.from('project_small_categories').select('project_id,small_category_id'),
      database.from('project_related_small_categories').select('project_id,small_category_id'),
      database.from('project_small_category_proposals').select('project_id,status').in('status', ['DRAFT', 'SUBMITTED', 'PENDING']),
      database.rpc('get_financial_budget_change_requests', {
        p_project_id: null, p_status: null, p_year: null, p_region_id: regionId,
      }),
      database.from('financial_budget_change_requests')
        .select('id,approved_at,rejected_at,applied_at').eq('region_id', regionId),
      database.rpc('get_financial_new_project_requests', { p_status: null }),
      database.rpc('get_financial_pending_new_project_funds', {
        p_status: null, p_year: null, p_region_id: regionId,
      }),
      database.rpc('get_financial_pending_new_project_link_requests', { p_status: null }),
      database.from('financial_pending_new_project_link_requests')
        .select('id,approved_at,rejected_at,applied_at').eq('region_id', regionId),
      database.from('financial_ledger_runtime').select('environment_kind').limit(1).maybeSingle(),
    ]);

    const requiredResults = [projectsResult, positionsResult, largeResult, middleResult, smallResult,
      assignmentResult, relatedAssignmentResult, proposalResult, budgetResult, newProjectResult,
      pendingResult, linkResult, runtimeResult, budgetMetadataResult, linkMetadataResult];
    const firstError = requiredResults.find((result) => result.error)?.error;
    if (firstError) throw firstError;

    const large: WorkspaceSnapshot['categories']['large'] = (largeResult.data ?? []).map((row: Record<string, unknown>) => ({ id: text(row.id), name: text(row.name) }));
    const middle: WorkspaceSnapshot['categories']['middle'] = (middleResult.data ?? []).map((row: Record<string, unknown>) => ({
      id: text(row.id), name: text(row.name), large_category_id: text(row.large_category_id),
    }));
    const small: WorkspaceSnapshot['categories']['small'] = (smallResult.data ?? []).map((row: Record<string, unknown>) => ({
      id: text(row.id), name: text(row.name), middle_category_id: text(row.middle_category_id),
    }));
    const largeMap = new Map(large.map((row) => [row.id, row.name]));
    const middleMap = new Map(middle.map((row) => [row.id, row.name]));
    const smallMap = new Map(small.map((row) => [row.id, row.name]));
    const projectSmallIds = new Map<string, Set<string>>();
    for (const row of [...(assignmentResult.data ?? []), ...(relatedAssignmentResult.data ?? [])] as Record<string, unknown>[]) {
      const projectId = text(row.project_id);
      const list = projectSmallIds.get(projectId) ?? new Set<string>();
      list.add(text(row.small_category_id));
      projectSmallIds.set(projectId, list);
    }
    const proposalProjectIds = new Set((proposalResult.data ?? []).map((row: Record<string, unknown>) => text(row.project_id)));
    const positionMap = new Map((positionsResult.data ?? []).map((row: Record<string, unknown>) => [text(row.project_id), row]));

    const projects: WorkspaceProject[] = (projectsResult.data ?? []).map((row: Record<string, unknown>) => {
      const projectId = text(row.id);
      const position = positionMap.get(projectId) as Record<string, unknown> | undefined;
      const projectionReady = position?.projection_ready === true;
      const smallCategoryIds = [...(projectSmallIds.get(projectId) ?? new Set<string>())];
      const primarySmallCategoryId = nullableText(row.primary_small_category_id) ?? smallCategoryIds[0] ?? null;
      if (primarySmallCategoryId && !smallCategoryIds.includes(primarySmallCategoryId)) smallCategoryIds.unshift(primarySmallCategoryId);
      const projectName = nullableText(row.detail_project_name)
        ?? nullableText(row.fund_project_name)
        ?? nullableText(row.project_name)
        ?? '사업명 미입력';
      return {
        id: projectId,
        project_code: nullableText(row.project_code),
        year: row.year == null ? null : Number(row.year),
        project_name: projectName,
        project_period: nullableText(row.project_period) ?? nullableText(row.period),
        project_start_year: row.project_start_year == null ? null : Number(row.project_start_year),
        project_end_year: row.project_end_year == null ? null : Number(row.project_end_year),
        status: nullableText(row.status),
        execution_status_reason: nullableText(row.execution_status_reason),
        business_type: ['HW', 'SW', 'COMPOSITE'].includes(text(row.business_type))
          ? text(row.business_type) as WorkspaceProject['business_type'] : null,
        large_category_id: nullableText(row.large_category_id),
        large_category_name: largeMap.get(text(row.large_category_id)) ?? null,
        middle_category_id: nullableText(row.middle_category_id),
        middle_category_name: middleMap.get(text(row.middle_category_id)) ?? null,
        primary_small_category_id: primarySmallCategoryId,
        small_category_ids: smallCategoryIds,
        small_category_names: smallCategoryIds.map((id) => smallMap.get(id)).filter((value): value is string => Boolean(value)),
        original_alloc_text: projectionReady ? amount(position?.ledger_original_allocation) : row.original_alloc_text == null ? null : amount(row.original_alloc_text),
        increase_amount_text: projectionReady ? amount(position?.ledger_increase_amount) : row.increase_amount_text == null ? null : amount(row.increase_amount_text),
        decrease_amount_text: projectionReady ? amount(position?.ledger_decrease_amount) : row.decrease_amount_text == null ? null : amount(row.decrease_amount_text),
        alloc_text: projectionReady ? amount(position?.ledger_adjusted_allocation) : row.alloc_text == null ? null : amount(row.alloc_text),
        exec_text: projectionReady ? amount(position?.ledger_execution_amount) : row.exec_text == null ? null : amount(row.exec_text),
        rate: projectionReady ? Number(position?.ledger_execution_rate ?? 0) : row.rate == null ? null : Number(row.rate),
        projection_ready: projectionReady,
        classification_review_needed: proposalProjectIds.has(projectId),
        updated_at: nullableText(row.updated_at),
      };
    });

    if (projects.some((project) => !project.id) || projects.some((project) => project.project_code === null)) {
      throw new Error('사업 목록에 식별정보가 없는 행이 포함되어 있습니다.');
    }
    if (projects.some((project) => (projectsResult.data ?? []).find((row: Record<string, unknown>) => text(row.id) === project.id)?.region_id !== regionId)) {
      throw new Error('다른 지역 사업이 조회되어 안전상 표시를 중단했습니다.');
    }

    const pendingSourceRequestMap = new Map<string, string | null>((pendingResult.data ?? []).map((row: Record<string, unknown>) => [
      text(row.id), nullableText(row.source_request_id),
    ]));
    const budgetMetadataMap = new Map<string, Record<string, unknown>>((budgetMetadataResult.data ?? []).map(
      (row: Record<string, unknown>) => [text(row.id), row],
    ));
    const linkMetadataMap = new Map<string, Record<string, unknown>>((linkMetadataResult.data ?? []).map(
      (row: Record<string, unknown>) => [text(row.id), row],
    ));
    const requests = [
      ...(budgetResult.data ?? []).map((row: Record<string, unknown>) => budgetRequestRow({
        ...row,
        ...(budgetMetadataMap.get(text(row.id)) ?? {}),
      })),
      ...(newProjectResult.data ?? []).map((row: Record<string, unknown>) => newProjectRequestRow(row)),
      ...(linkResult.data ?? []).map((row: Record<string, unknown>) => pendingLinkRequestRow(
        { ...row, ...(linkMetadataMap.get(text(row.id)) ?? {}) },
        pendingSourceRequestMap.get(text(row.pending_fund_id)) ?? null,
      )),
    ].filter((request) => request.id);

    const sum = (field: 'original_alloc_text' | 'alloc_text' | 'exec_text') => projects.reduce(
      (total, project) => total + BigInt(project[field] ?? '0'), BigInt(0),
    ).toString();

    return {
      data: {
        environment: runtimeResult.data?.environment_kind === 'TEST'
          ? 'TEST'
          : runtimeResult.data?.environment_kind === 'PRODUCTION' ? 'PRODUCTION' : 'UNKNOWN',
        regionName: profileResult.data.region_name ?? '내 지역',
        projects,
        requests,
        categories: { large, middle, small },
        baseline: {
          project_count: Number(projectsResult.count ?? projects.length),
          original_allocation: sum('original_alloc_text'),
          adjusted_allocation: sum('alloc_text'),
          execution: sum('exec_text'),
          raw_request_count: requests.length,
        },
      },
    };
  } catch (error) {
    if (retryOnce) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      return loadMyProjectsWorkspaceAction(input, false);
    }
    return { error: formatUserFacingError(error, '내 사업 업무정보를 불러오지 못했습니다.') };
  }
}

export async function getMyProjectsWorkspaceAction(input: { accessToken: string }): Promise<WorkspaceActionResult> {
  return loadMyProjectsWorkspaceAction(input, true);
}

function assertDeletionInput(targetKind: string, targetId: string) {
  if (!['DRAFT', 'PROJECT'].includes(targetKind)) throw new Error('삭제 대상 종류를 확인해 주세요.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId)) {
    throw new Error('삭제 대상 ID를 확인해 주세요.');
  }
}

export async function getNewProjectDeletionEligibilityAction(input: {
  accessToken: string;
  targetKind: NewProjectDeletionTargetKind;
  targetId: string;
}): Promise<{ data: NewProjectDeletionEligibility; error?: never } | { data?: never; error: string }> {
  try {
    assertDeletionInput(input.targetKind, input.targetId);
    const client = clientFor(input.accessToken);
    const userResult = await client.auth.getUser(input.accessToken);
    if (userResult.error || !userResult.data.user) throw new Error('로그인 사용자를 확인하지 못했습니다.');
    const { data, error } = await (client as any)
      .rpc('get_financial_new_project_deletion_eligibility', {
        p_target_kind: input.targetKind,
        p_target_id: input.targetId,
      })
      .single();
    if (error) throw error;
    return { data: data as NewProjectDeletionEligibility };
  } catch (error) {
    return { error: formatUserFacingError(error, '신규사업 삭제 가능 여부를 확인하지 못했습니다.') };
  }
}

export async function deleteNewProjectAction(input: {
  accessToken: string;
  targetKind: NewProjectDeletionTargetKind;
  targetId: string;
}): Promise<{ data: NewProjectDeletionResult; error?: never } | { data?: never; error: string }> {
  try {
    assertDeletionInput(input.targetKind, input.targetId);
    const client = clientFor(input.accessToken);
    const userResult = await client.auth.getUser(input.accessToken);
    if (userResult.error || !userResult.data.user) throw new Error('로그인 사용자를 확인하지 못했습니다.');
    const { data, error } = await (client as any)
      .rpc('soft_delete_financial_new_project', {
        p_target_kind: input.targetKind,
        p_target_id: input.targetId,
        p_reason: '지자체 담당자가 신규사업 화면에서 삭제',
      })
      .single();
    if (error) throw error;
    return { data: data as NewProjectDeletionResult };
  } catch (error) {
    return { error: formatUserFacingError(error, '신규사업을 삭제하지 못했습니다.') };
  }
}
