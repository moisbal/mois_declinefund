"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  getAdminBudgetChangeDashboardAction,
} from '../../app/my-projects/budget-change-actions';
import {
  createPostCheckRequestAction,
  getPostCheckCenterAction,
} from '../../app/confirmations/actions';
import { formatIntegerString, formatWonWithUnit } from '../../lib/amountFormat';
import { getCurrentSessionWithRetry, getProfileByUserId } from '../../lib/auth';
import type {
  BudgetChangeRequest,
  BudgetChangeDestination,
  BudgetChangeNewProjectRequest,
  BudgetChangeStatistics,
  PendingNewProjectFund,
  PendingNewProjectLinkRequest,
  RequestReviewMetadata,
} from '../../lib/budgetChanges';
import {
  formatProjectOption,
  formatBudgetChangeReasonForDisplay,
  formatStoredUserText,
  formatSystemTerm,
  formatUserFacingError,
  getProjectSearchText,
} from '../../lib/presentationLabels';
import { getVisiblePageNumbers, paginateItems, PAGE_SIZE_OPTIONS, type PageSize } from '../../lib/pagination';
import {
  POST_CHECK_STATUS_LABELS,
  type PostCheckRequest,
  type PostCheckSubjectType,
} from '../../lib/postChecks';
import Header from '../common/Header';
import { PageHeader, StatusBadge } from '../common/WorkUi';

type Dashboard = {
  requests: BudgetChangeRequest[];
  pending: PendingNewProjectFund[];
  newProjectRequests: BudgetChangeNewProjectRequest[];
  links: PendingNewProjectLinkRequest[];
  statistics: BudgetChangeStatistics;
};

type Tab = 'NEW_PROJECT_DRAFTS' | 'PENDING_STATUS' | 'HISTORY';
type HistoryKind = 'BUDGET_CHANGE' | 'NEW_PROJECT' | 'FUNDING_LINK';
type HistoryEntry = {
  key: string;
  kind: HistoryKind;
  status: string;
  regionId: string;
  regionLabel: string;
  fiscalYear: number;
  processedAt: string;
  sourceSearch: string;
  destinationSearch: string;
  hasNewProject: boolean;
  amount: string;
  subjectType: PostCheckSubjectType;
  subjectId: string | null;
  request: BudgetChangeRequest | BudgetChangeNewProjectRequest | PendingNewProjectLinkRequest;
};

type HistoryFilters = {
  from: string;
  to: string;
  regionId: string;
  fiscalYear: string;
  kind: 'ALL' | HistoryKind;
  status: string;
  source: string;
  destination: string;
  newProject: 'ALL' | 'YES' | 'NO';
  minimumAmount: string;
  maximumAmount: string;
  confirmationStatus: '' | 'NONE' | 'REQUESTED' | 'REPLIED' | 'COMPLETED';
};

const EMPTY_STATS: BudgetChangeStatistics = {
  transfer_amount: '0',
  transfer_count: '0',
  new_project_allocated_amount: '0',
  new_project_allocated_count: '0',
  pending_new_project_amount: '0',
  pending_new_project_count: '0',
  applied_request_count: '0',
  transaction_gap_amount: '0',
};

const EMPTY_HISTORY_FILTERS: HistoryFilters = {
  from: '',
  to: '',
  regionId: '',
  fiscalYear: '',
  kind: 'ALL',
  status: '',
  source: '',
  destination: '',
  newProject: 'ALL',
  minimumAmount: '',
  maximumAmount: '',
  confirmationStatus: '',
};

const HISTORY_KIND_LABELS: Record<HistoryKind, string> = {
  BUDGET_CHANGE: '예산조정',
  NEW_PROJECT: '신규사업',
  FUNDING_LINK: '예정재원 연결',
};

function formatBudgetDestination(fiscalYear: number, line: BudgetChangeDestination) {
  if (line.destination_type === 'EXISTING_PROJECT') {
    return formatProjectOption({
      fiscal_year: fiscalYear,
      project_name: line.destination_project_name,
      project_code: line.destination_project_code,
      status: 'APPLIED',
    });
  }
  return formatProjectOption({
    fiscal_year: line.planned_project_year,
    project_name: line.materialized_project_name ?? line.planned_project_name,
    project_code: line.materialized_project_code ?? line.official_project_code,
    status: line.new_project_request_status,
  });
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function regionLabel(item: { region_name?: string | null; sido?: string | null; sigungu?: string | null }) {
  return item.region_name || [item.sido, item.sigungu].filter(Boolean).join(' ') || '지역 확인 필요';
}

function finalProcessedAt(item: RequestReviewMetadata & { requested_at: string }) {
  return item.applied_at || item.rejected_at || item.approved_at || item.requested_at;
}

function ReviewOutcome({
  request,
  rejectionReason,
}: {
  request: RequestReviewMetadata;
  rejectionReason: string | null;
}) {
  const rejected = Boolean(request.rejected_at);
  const reviewer = rejected ? request.rejected_by_name : request.approved_by_name;
  const reviewedAt = rejected ? request.rejected_at : request.approved_at;
  if (!rejected && !request.approved_at && request.applied_at) {
    return <dl className="funding-review-outcome">
      <div><dt>처리 방식</dt><dd>관리자 승인 없는 직접 처리</dd></div>
      <div><dt>처리자</dt><dd>{request.applied_by_name || '요청 지자체 사용자'}</dd></div>
      <div><dt>처리일</dt><dd>{formatDateTime(request.applied_at)}</dd></div>
    </dl>;
  }
  return <dl className="funding-review-outcome">
    <div><dt>검토 의견</dt><dd>{formatStoredUserText(rejectionReason, '별도 검토 의견 없음')}</dd></div>
    <div><dt>검토자</dt><dd>{reviewer || '처리자 정보 확인 필요'}</dd></div>
    <div><dt>검토일</dt><dd>{formatDateTime(reviewedAt)}</dd></div>
    {request.applied_at && <>
      <div><dt>적용자</dt><dd>{request.applied_by_name || '처리자 정보 확인 필요'}</dd></div>
      <div><dt>적용일</dt><dd>{formatDateTime(request.applied_at)}</dd></div>
    </>}
  </dl>;
}

function BudgetGroupDetails({ request }: { request: BudgetChangeRequest }) {
  return <details className="funding-group-details">
    <summary>요청 묶음 전체 흐름 보기</summary>
    <dl className="funding-group-summary">
      <div><dt>출처사업</dt><dd>{formatProjectOption({ fiscal_year: request.fiscal_year, project_name: request.source_project_name, project_code: request.source_project_code, status: 'APPLIED' })}</dd></div>
      <div><dt>감액</dt><dd title={`${formatIntegerString(request.total_amount)}원`}>{formatWonWithUnit(request.total_amount)}</dd></div>
      <div><dt>현재 상태</dt><dd>{formatSystemTerm(request.status)}</dd></div>
    </dl>
    <ol className="funding-group-destinations">
      {request.destinations.map((line) => {
        const step = request.workflow_steps?.find((item) => item.line_id === line.line_id);
        return <li key={line.line_id}>
          <strong>목적지 {line.line_no}</strong>
          <span>{formatBudgetDestination(request.fiscal_year, line)}</span>
          <span title={`${formatIntegerString(line.amount)}원`}>{formatWonWithUnit(line.amount)}</span>
          {line.destination_type === 'PENDING_NEW_PROJECT' && <small>
            사업 생성 {step?.new_project_request_status ? formatSystemTerm(step.new_project_request_status) : '요청 전'}
            {' · '}예정재원 {step?.pending_status ? formatSystemTerm(step.pending_status) : '생성 전'}
            {' · '}재원 연결 {step?.link_request_status ? formatSystemTerm(step.link_request_status) : '처리 전'}
            {line.planned_project_status && <>{' · '}집행상태 {formatSystemTerm(line.planned_project_status, '상태 확인 필요')}</>}
            {line.planned_execution_status_reason && <>{' · '}{formatSystemTerm(line.planned_project_status, '집행상태')} 사유 {formatStoredUserText(line.planned_execution_status_reason, '사유 미입력')}</>}
          </small>}
        </li>;
      })}
    </ol>
  </details>;
}

export default function FundingManagementShell() {
  const router = useRouter();
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [data, setData] = useState<Dashboard>({ requests: [], pending: [], newProjectRequests: [], links: [], statistics: EMPTY_STATS });
  const [tab, setTab] = useState<Tab>('HISTORY');
  const [postChecks, setPostChecks] = useState<PostCheckRequest[]>([]);
  const [confirmationTarget, setConfirmationTarget] = useState<{
    subjectType: PostCheckSubjectType;
    subjectId: string;
    label: string;
    parentRequestId?: string;
  } | null>(null);
  const [confirmationMessage, setConfirmationMessage] = useState('');
  const [confirmationDueDate, setConfirmationDueDate] = useState('');
  const [historyFilters, setHistoryFilters] = useState<HistoryFilters>(EMPTY_HISTORY_FILTERS);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState<PageSize>(10);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const historyResultRef = useRef<HTMLParagraphElement | null>(null);

  const load = useCallback(async (token: string) => {
    const [result, postCheckResult] = await Promise.all([
      getAdminBudgetChangeDashboardAction({ accessToken: token }),
      getPostCheckCenterAction({ accessToken: token }),
    ]);
    if ('error' in result) throw new Error(result.error);
    if (postCheckResult.error) throw new Error(postCheckResult.error);
    setData(result.data);
    setPostChecks(postCheckResult.data?.requests ?? []);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const session = await getCurrentSessionWithRetry();
        const currentSession = session.data.session;
        const profile = currentSession?.user?.id
          ? await getProfileByUserId(currentSession.user.id)
          : null;
        const token = currentSession?.access_token;
        if (!token || !profile) return router.replace('/');
        if (profile.first_login) return router.replace('/password-reset');
        if (profile.role !== 'admin') return router.replace('/dashboard');
        setAccessToken(token);
        await load(token);
      } catch (loadError) {
        setError(formatUserFacingError(loadError, '등록·예산연결 모니터링 정보를 불러오지 못했습니다.'));
      } finally {
        setLoading(false);
      }
    })();
  }, [load, router]);

  useEffect(() => {
    if (!accessToken) return;
    const intervalId = window.setInterval(() => { void load(accessToken).catch(() => undefined); }, 5_000);
    return () => window.clearInterval(intervalId);
  }, [accessToken, load]);

  const newProjectDrafts = useMemo(() => data.newProjectRequests.filter((request) => (
    request.status === 'DRAFT'
  )), [data.newProjectRequests]);
  const pendingStatus = useMemo(() => data.pending.filter((pending) => pending.status === 'WAITING'), [data.pending]);

  const historyItems = useMemo<HistoryEntry[]>(() => {
    const budgetHistory: HistoryEntry[] = data.requests
      .filter((request) => request.status !== 'DRAFT')
      .map((request) => ({
        key: `BUDGET_CHANGE:${request.id}`,
        kind: 'BUDGET_CHANGE',
        status: request.status,
        regionId: request.region_id,
        regionLabel: regionLabel(request),
        fiscalYear: request.fiscal_year,
        processedAt: finalProcessedAt(request),
        sourceSearch: getProjectSearchText({ fiscal_year: request.fiscal_year, project_name: request.source_project_name, project_code: request.source_project_code }),
        destinationSearch: request.destinations.map((line) => [
          line.destination_project_name, line.destination_project_code,
          line.planned_project_name, line.materialized_project_name, line.materialized_project_code,
          getProjectSearchText({
            fiscal_year: line.destination_type === 'EXISTING_PROJECT' ? request.fiscal_year : line.planned_project_year,
            project_name: line.destination_type === 'EXISTING_PROJECT'
              ? line.destination_project_name
              : line.materialized_project_name ?? line.planned_project_name,
            project_code: line.destination_type === 'EXISTING_PROJECT'
              ? line.destination_project_code
              : line.materialized_project_code ?? line.official_project_code,
          }),
        ].filter(Boolean).join(' ')).join(' '),
        hasNewProject: request.destinations.some((line) => line.destination_type === 'PENDING_NEW_PROJECT'),
        amount: request.total_amount,
        subjectType: 'BUDGET_CHANGE',
        subjectId: request.status === 'APPLIED' ? request.id : null,
        request,
      }));
    const newProjectHistory: HistoryEntry[] = data.newProjectRequests
      .filter((request) => request.status !== 'DRAFT')
      .map((request) => ({
        key: `NEW_PROJECT:${request.id}`,
        kind: 'NEW_PROJECT',
        status: request.status,
        regionId: request.region_id,
        regionLabel: regionLabel(request),
        fiscalYear: request.fiscal_year,
        processedAt: finalProcessedAt(request),
        sourceSearch: getProjectSearchText({ fiscal_year: request.source_fiscal_year, project_name: request.source_project_name, project_code: request.source_project_code }),
        destinationSearch: getProjectSearchText({ fiscal_year: request.fiscal_year, project_name: request.materialized_project_name ?? request.project_name, project_code: request.materialized_project_code ?? request.official_project_code }),
        hasNewProject: true,
        amount: request.requested_amount,
        subjectType: 'PROJECT',
        subjectId: request.status === 'APPLIED' ? request.materialized_project_id : null,
        request,
      }));
    const linkHistory: HistoryEntry[] = data.links
      .map((request) => ({
        key: `FUNDING_LINK:${request.id}`,
        kind: 'FUNDING_LINK',
        status: request.status,
        regionId: request.region_id,
        regionLabel: regionLabel(request),
        fiscalYear: request.planned_project_year,
        processedAt: finalProcessedAt(request),
        sourceSearch: getProjectSearchText({ fiscal_year: request.planned_project_year, project_name: request.planned_project_name }),
        destinationSearch: getProjectSearchText({ fiscal_year: request.planned_project_year, project_name: request.destination_project_name, project_code: request.destination_project_code }),
        hasNewProject: true,
        amount: request.amount,
        subjectType: 'FUNDING_LINK',
        subjectId: request.status === 'APPLIED' ? request.id : null,
        request,
      }));
    return [...budgetHistory, ...newProjectHistory, ...linkHistory]
      .sort((left, right) => right.processedAt.localeCompare(left.processedAt));
  }, [data.links, data.newProjectRequests, data.requests]);

  const filteredHistory = useMemo(() => {
    const source = historyFilters.source.trim().toLocaleLowerCase('ko-KR');
    const destination = historyFilters.destination.trim().toLocaleLowerCase('ko-KR');
    const minimumAmount = /^\d+$/.test(historyFilters.minimumAmount)
      ? BigInt(historyFilters.minimumAmount) : null;
    const maximumAmount = /^\d+$/.test(historyFilters.maximumAmount)
      ? BigInt(historyFilters.maximumAmount) : null;
    return historyItems.filter((item) => {
      const date = item.processedAt.slice(0, 10);
      const itemAmount = /^\d+$/.test(item.amount) ? BigInt(item.amount) : BigInt(0);
      const latestCheck = postChecks.find((check) => (
        check.subject_type === item.subjectType && check.subject_id === item.subjectId
      ));
      return (!historyFilters.from || date >= historyFilters.from)
        && (!historyFilters.to || date <= historyFilters.to)
        && (!historyFilters.regionId || item.regionId === historyFilters.regionId)
        && (!historyFilters.fiscalYear || item.fiscalYear === Number(historyFilters.fiscalYear))
        && (historyFilters.kind === 'ALL' || item.kind === historyFilters.kind)
        && (!historyFilters.status || item.status === historyFilters.status)
        && (!source || item.sourceSearch.toLocaleLowerCase('ko-KR').includes(source))
        && (!destination || item.destinationSearch.toLocaleLowerCase('ko-KR').includes(destination))
        && (minimumAmount === null || itemAmount >= minimumAmount)
        && (maximumAmount === null || itemAmount <= maximumAmount)
        && (!historyFilters.confirmationStatus
          || (historyFilters.confirmationStatus === 'NONE'
            ? !latestCheck
            : latestCheck?.status === historyFilters.confirmationStatus))
        && (historyFilters.newProject === 'ALL'
          || (historyFilters.newProject === 'YES' ? item.hasNewProject : !item.hasNewProject));
    });
  }, [historyFilters, historyItems, postChecks]);

  const historyRegions = useMemo(() => [...new Map(historyItems
    .map((item) => [item.regionId, item.regionLabel])).entries()]
    .sort((left, right) => left[1].localeCompare(right[1], 'ko-KR')), [historyItems]);
  const historyYears = useMemo(() => [...new Set(historyItems.map((item) => item.fiscalYear))]
    .sort((left, right) => right - left), [historyItems]);
  const historyPagination = useMemo(
    () => paginateItems(filteredHistory, historyPage, historyPageSize),
    [filteredHistory, historyPage, historyPageSize],
  );
  const historyPageNumbers = useMemo(
    () => getVisiblePageNumbers(historyPagination.page, historyPagination.pageCount),
    [historyPagination.page, historyPagination.pageCount],
  );

  useEffect(() => {
    setHistoryPage(1);
  }, [historyFilters, historyPageSize]);

  useEffect(() => {
    setHistoryPage((current) => Math.min(current, historyPagination.pageCount));
  }, [historyPagination.pageCount]);

  const moveHistoryPage = (page: number) => {
    const nextPage = Math.min(Math.max(1, page), historyPagination.pageCount);
    setHistoryPage(nextPage);
    window.requestAnimationFrame(() => {
      historyResultRef.current?.scrollIntoView({ block: 'start' });
    });
  };

  const sendConfirmation = async () => {
    if (!accessToken || !confirmationTarget || !confirmationMessage.trim()) return;
    setSubmitting(`confirmation:${confirmationTarget.subjectType}:${confirmationTarget.subjectId}`);
    setError(null);
    setNotice(null);
    try {
      const result = await createPostCheckRequestAction({
        accessToken,
        subjectType: confirmationTarget.subjectType,
        subjectId: confirmationTarget.subjectId,
        message: confirmationMessage,
        dueDate: confirmationDueDate || undefined,
        parentRequestId: confirmationTarget.parentRequestId,
      });
      if (result.error) throw new Error(result.error);
      setConfirmationTarget(null);
      setConfirmationMessage('');
      setConfirmationDueDate('');
      setNotice('해당 지자체의 권한 있는 사용자에게 확인요청을 보냈습니다. 등록·예산 금액은 변경되지 않았습니다.');
      await load(accessToken);
    } catch (submitError) {
      setError(formatUserFacingError(submitError, '확인요청을 보내지 못했습니다.'));
    } finally {
      setSubmitting(null);
    }
  };

  const latestPostCheck = (item: HistoryEntry) => postChecks.find((check) => (
    check.subject_type === item.subjectType && check.subject_id === item.subjectId
  ));

  const confirmationControl = (item: HistoryEntry, label: string) => {
    const latest = latestPostCheck(item);
    if (!item.subjectId) return <span className="panel-sub">완료 후 확인요청 가능</span>;
    return <div className="funding-inline-actions funding-post-check-actions">
      <StatusBadge
        label={latest ? POST_CHECK_STATUS_LABELS[latest.status] : '확인요청 없음'}
        tone={latest?.status === 'REQUESTED' ? 'warning' : latest?.status === 'REPLIED' ? 'info' : latest?.status === 'COMPLETED' ? 'success' : 'neutral'}
      />
      {latest?.status === 'REQUESTED'
        ? <button type="button" className="small-btn" onClick={() => router.push(`/confirmations?request=${latest.id}`)}>요청 상세</button>
        : <button type="button" className="small-btn" onClick={() => {
          setConfirmationTarget({
            subjectType: item.subjectType,
            subjectId: item.subjectId!,
            label,
            parentRequestId: latest?.id,
          });
          setConfirmationMessage('');
          setConfirmationDueDate('');
        }}>{latest ? '재확인 요청' : '확인요청'}</button>}
    </div>;
  };

  if (loading) return <div className="loading-shell">예산 조정 관리 화면을 준비하는 중입니다...</div>;

  return <div className="dashboard-shell funding-admin-shell">
    <Header title="예산 조정 관리" />
    <main aria-busy={submitting !== null}>
      <div className="admin-page-navigation">
        <button type="button" className="small-btn" onClick={() => router.push('/admin')}>관리자 메뉴</button>
        <button type="button" className="small-btn" onClick={() => router.push('/admin/project-changes')}>사업변경 전체내역</button>
        <button type="button" className="small-btn" disabled={!accessToken || submitting !== null} onClick={() => accessToken && void load(accessToken)}>새로고침</button>
      </div>

      <PageHeader
        eyebrow="등록·예산연결 사후 점검"
        title="사업·예산 처리 모니터링"
        description="신규사업 등록과 신규·기존사업 예산연결은 필수 검증 후 승인 없이 완료됩니다. 관리자는 결과를 조회하고 사후 확인요청을 보낼 수 있습니다."
        meta={<><StatusBadge label={`확인요청 진행 ${postChecks.filter((item) => item.status !== 'COMPLETED').length}건`} tone="warning" /><StatusBadge label="금액 차이 정상값 0원" tone="success" /></>}
      />

      <section className="funding-kpi-grid" aria-label="전체 기간 예산 조정 지표">
        <article title="전체 기간 적용완료 예산조정 중 기존사업 목적지로 확정 이동된 금액입니다."><span>사업간 예산조정 총액</span><strong title={`${formatIntegerString(data.statistics.transfer_amount)}원`}>{formatWonWithUnit(data.statistics.transfer_amount)}</strong><small>전체 기간 적용완료 흐름 · {data.statistics.transfer_count}개 목적지</small></article>
        <article title="전체 기간 적용완료 예산조정 중 공식 신규사업에 실제 연결된 금액입니다."><span>신규사업 배분액</span><strong title={`${formatIntegerString(data.statistics.new_project_allocated_amount)}원`}>{formatWonWithUnit(data.statistics.new_project_allocated_amount)}</strong><small>전체 기간 연결완료 흐름 · {data.statistics.new_project_allocated_count}건</small></article>
        <article title="아직 공식 사업에 연결되지 않은 현재 예정재원 잔액입니다."><span>미연결 예정재원</span><strong title={`${formatIntegerString(data.statistics.pending_new_project_amount)}원`}>{formatWonWithUnit(data.statistics.pending_new_project_amount)}</strong><small>현재 연결대기 잔액 · {data.statistics.pending_new_project_count}건</small></article>
        <article title="적용완료 요청별 출처 감액과 목적지 합계의 차이를 모두 합산한 검증값입니다."><span>적용 거래 차액</span><strong title={`${formatIntegerString(data.statistics.transaction_gap_amount)}원`}>{formatWonWithUnit(data.statistics.transaction_gap_amount)}</strong><small>전체 기간 적용완료 {data.statistics.applied_request_count}건 · 정상값 0원</small></article>
      </section>

      <nav className="funding-tabs" aria-label="사업·예산 처리 조회 구분">
        <button type="button" className={tab === 'HISTORY' ? 'active' : ''} onClick={() => setTab('HISTORY')}>등록·연결 모니터링<span>{historyItems.length}</span></button>
        <button type="button" className={tab === 'NEW_PROJECT_DRAFTS' ? 'active' : ''} onClick={() => setTab('NEW_PROJECT_DRAFTS')}>신규사업 초안<span>{newProjectDrafts.length}</span></button>
        <button type="button" className={tab === 'PENDING_STATUS' ? 'active' : ''} onClick={() => setTab('PENDING_STATUS')}>예정재원 현황<span>{pendingStatus.length}</span></button>
        <button type="button" onClick={() => router.push('/confirmations')}>확인요청 센터<span>{postChecks.filter((item) => item.status !== 'COMPLETED').length}</span></button>
      </nav>

      <section className="panel funding-review-panel">
        {tab === 'NEW_PROJECT_DRAFTS' && <>
          <div className="funding-tab-explainer"><strong>임시저장 신규사업 조회</strong><span>초안은 공식 사업 수·배분액·집행액 통계에서 제외되며, 권한 범위의 초안만 읽기 전용으로 표시합니다.</span></div>
          {newProjectDrafts.length === 0 ? <div className="empty-state">조회할 신규사업 초안이 없습니다.</div> : <div className="funding-review-list">{newProjectDrafts.map((request) => {
            const draftState = request.source_budget_change_request_id
              ? '임시저장 · 재원 연결 준비 중'
              : request.source_lot_id
                ? '임시저장 · 예정재원 연결'
                : '임시저장 · 재원 미연결';
            return <article key={request.id} className="funding-review-card"><div><span className="my-project-status normal">{draftState}</span><h3>{formatProjectOption({ fiscal_year: request.fiscal_year, project_name: request.project_name, status: request.status })}</h3><p>{regionLabel(request)} · 초안 배분액 <strong title={`${formatIntegerString(request.requested_amount)}원`}>{formatWonWithUnit(request.requested_amount)}</strong></p></div><div className="funding-tab-explainer"><strong>다음 단계</strong><span>{request.source_budget_change_request_id ? '연결된 예산조정을 완료하면 사업 등록과 예산연결이 함께 처리됩니다.' : request.source_lot_id ? '필수정보를 확인한 뒤 등록·예산연결을 완료할 수 있습니다.' : '지자체가 기존사업 감액 목적지로 이 초안을 선택해 재원을 연결합니다.'}</span></div></article>;
          })}</div>}
        </>}

        {tab === 'PENDING_STATUS' && <>
          <div className="funding-tab-explainer"><strong>아직 연결되지 않은 예정재원 현황</strong><span>읽기 전용 현황입니다. 지자체가 필수 사업정보와 연결 대상을 갖춰 완료하면 승인 없이 반영됩니다.</span></div>
          {pendingStatus.length === 0 ? <div className="empty-state">연결을 기다리는 예정재원이 없습니다.</div> : <div className="table-scroll"><table className="funding-status-table"><thead><tr><th>지역</th><th>출처사업</th><th>예정사업</th><th className="num">예정금액</th><th>사업 생성</th><th>재원 연결</th><th>후속처리</th></tr></thead><tbody>{pendingStatus.map((pending) => {
            const newProject = data.newProjectRequests.find((request) => request.pending_fund_id === pending.id);
            const link = data.links.find((request) => request.pending_fund_id === pending.id);
            const plannedProject = formatProjectOption({ fiscal_year: pending.planned_project_year, project_name: pending.linked_project_name ?? pending.planned_project_name, project_code: pending.linked_project_code ?? newProject?.materialized_project_code ?? newProject?.official_project_code, status: newProject?.status ?? 'SUBMITTED' });
            const creationStatus = pending.linked_project_id || newProject?.materialized_project_id
              ? '생성완료' : newProject ? formatSystemTerm(newProject.status) : '신청 전';
            const linkStatus = link ? formatSystemTerm(link.status) : formatSystemTerm(pending.status);
            const nextStep = link && ['SUBMITTED', 'APPROVED'].includes(link.status)
              ? '직접 처리 재시도 필요'
              : newProject && ['SUBMITTED', 'APPROVED'].includes(newProject.status)
                ? '필수정보 확인 후 직접 처리 재시도'
                : '공식 사업 생성 또는 연결 요청 필요';
            return <tr key={pending.id}><td>{regionLabel(pending)}</td><td>{formatProjectOption({ fiscal_year: pending.fiscal_year, project_name: pending.source_project_name, project_code: pending.source_project_code, status: 'APPLIED' })}</td><td>{plannedProject}</td><td className="num" title={`${formatIntegerString(pending.amount)}원`}>{formatWonWithUnit(pending.amount)}</td><td>{creationStatus}</td><td>{linkStatus}</td><td>{nextStep}</td></tr>;
          })}</tbody></table></div>}
        </>}

        {tab === 'HISTORY' && <>
          <div className="funding-tab-explainer"><strong>신규사업 등록·예산연결 모니터링</strong><span>지자체, 사업명, 연도, 처리 유형, 금액, 처리일시와 확인요청 상태로 조회합니다. 과거 승인·반려 이력은 사실 그대로 표시합니다.</span></div>
          <div className="funding-history-filters" aria-label="등록·예산연결 모니터링 필터">
            <label>시작일<input type="date" value={historyFilters.from} onChange={(event) => setHistoryFilters((current) => ({ ...current, from: event.target.value }))} /></label>
            <label>종료일<input type="date" value={historyFilters.to} onChange={(event) => setHistoryFilters((current) => ({ ...current, to: event.target.value }))} /></label>
            <label>시도·시군구<select value={historyFilters.regionId} onChange={(event) => setHistoryFilters((current) => ({ ...current, regionId: event.target.value }))}><option value="">전체</option>{historyRegions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
            <label>사업연도<select value={historyFilters.fiscalYear} onChange={(event) => setHistoryFilters((current) => ({ ...current, fiscalYear: event.target.value }))}><option value="">전체</option>{historyYears.map((year) => <option key={year} value={year}>{year}</option>)}</select></label>
            <label>유형<select value={historyFilters.kind} onChange={(event) => setHistoryFilters((current) => ({ ...current, kind: event.target.value as HistoryFilters['kind'] }))}><option value="ALL">전체</option><option value="BUDGET_CHANGE">예산조정</option><option value="NEW_PROJECT">신규사업</option><option value="FUNDING_LINK">예정재원 연결</option></select></label>
            <label>처리상태<select value={historyFilters.status} onChange={(event) => setHistoryFilters((current) => ({ ...current, status: event.target.value }))}><option value="">전체</option><option value="SUBMITTED">직접 처리 재시도</option><option value="APPROVED">과거 승인·반영 대기</option><option value="APPLIED">처리완료</option><option value="REJECTED">과거 반려</option><option value="CANCELLED">취소</option><option value="DUPLICATE">중복 요청</option></select></label>
            <label>출처사업<input value={historyFilters.source} onChange={(event) => setHistoryFilters((current) => ({ ...current, source: event.target.value }))} placeholder="사업명" /></label>
            <label>목적사업<input value={historyFilters.destination} onChange={(event) => setHistoryFilters((current) => ({ ...current, destination: event.target.value }))} placeholder="사업명" /></label>
            <label>신규사업 여부<select value={historyFilters.newProject} onChange={(event) => setHistoryFilters((current) => ({ ...current, newProject: event.target.value as HistoryFilters['newProject'] }))}><option value="ALL">전체</option><option value="YES">포함</option><option value="NO">미포함</option></select></label>
            <label>최소금액<input type="number" min="0" step="1" value={historyFilters.minimumAmount} onChange={(event) => setHistoryFilters((current) => ({ ...current, minimumAmount: event.target.value }))} placeholder="원" /></label>
            <label>최대금액<input type="number" min="0" step="1" value={historyFilters.maximumAmount} onChange={(event) => setHistoryFilters((current) => ({ ...current, maximumAmount: event.target.value }))} placeholder="원" /></label>
            <label>확인요청 상태<select value={historyFilters.confirmationStatus} onChange={(event) => setHistoryFilters((current) => ({ ...current, confirmationStatus: event.target.value as HistoryFilters['confirmationStatus'] }))}><option value="">전체</option><option value="NONE">요청 없음</option><option value="REQUESTED">확인요청</option><option value="REPLIED">회신완료</option><option value="COMPLETED">확인완료</option></select></label>
            <button type="button" className="small-btn" onClick={() => setHistoryFilters(EMPTY_HISTORY_FILTERS)}>필터 초기화</button>
          </div>
          <p className="funding-history-result" ref={historyResultRef}>조회 결과 {filteredHistory.length}건 / 전체 {historyItems.length}건 · {historyPagination.firstItemNumber}-{historyPagination.lastItemNumber}건 표시</p>
          {filteredHistory.length === 0 ? <div className="empty-state">조건에 맞는 처리 이력이 없습니다.</div> : <div className="funding-review-list">{historyPagination.items.map((item) => {
            if (item.kind === 'BUDGET_CHANGE') {
              const request = item.request as BudgetChangeRequest;
              return <article key={item.key} className="funding-history-card"><header><span>{HISTORY_KIND_LABELS[item.kind]}</span><strong>{formatSystemTerm(request.status)}{request.status === 'DUPLICATE' && request.database_status ? ` · ${formatSystemTerm(request.database_status)}` : ''}</strong></header><h3>{formatProjectOption({ fiscal_year: request.fiscal_year, project_name: request.source_project_name, project_code: request.source_project_code, status: 'APPLIED' })}</h3><p>{regionLabel(request)} · <span title={`${formatIntegerString(request.total_amount)}원`}>{formatWonWithUnit(request.total_amount)}</span> · 목적지 {request.destinations.length}곳</p><BudgetGroupDetails request={request} /><p className="panel-sub">조정 사유: {formatBudgetChangeReasonForDisplay(request)} · 적용 기준일 {request.effective_date}</p><ReviewOutcome request={request} rejectionReason={request.rejection_reason} />{confirmationControl(item, formatProjectOption({ fiscal_year: request.fiscal_year, project_name: request.source_project_name, project_code: request.source_project_code, status: 'APPLIED' }))}</article>;
            }
            if (item.kind === 'NEW_PROJECT') {
              const request = item.request as BudgetChangeNewProjectRequest;
              return <article key={item.key} className="funding-history-card"><header><span>{HISTORY_KIND_LABELS[item.kind]}</span><strong>{formatSystemTerm(request.status)}</strong></header><h3>{formatProjectOption({ fiscal_year: request.fiscal_year, project_name: request.materialized_project_name ?? request.project_name, project_code: request.materialized_project_code ?? request.official_project_code, status: request.status })}</h3><p>{regionLabel(request)} · 예정배분 <span title={`${formatIntegerString(request.requested_amount)}원`}>{formatWonWithUnit(request.requested_amount)}</span></p><p className="panel-sub">집행상태: {formatSystemTerm(request.project_status, '미입력')}{request.execution_status_reason ? ` · ${formatSystemTerm(request.project_status, '집행상태')} 사유: ${formatStoredUserText(request.execution_status_reason, '사유 미입력')}` : ''}</p><p className="panel-sub">처리 위치: {request.source_budget_change_request_id ? '부모 예산조정에서 함께 직접 처리' : '독립 신규사업 직접 등록'}</p><ReviewOutcome request={request} rejectionReason={request.rejection_reason} />{confirmationControl(item, formatProjectOption({ fiscal_year: request.fiscal_year, project_name: request.materialized_project_name ?? request.project_name, project_code: request.materialized_project_code ?? request.official_project_code, status: request.status }))}</article>;
            }
            const request = item.request as PendingNewProjectLinkRequest;
            return <article key={item.key} className="funding-history-card"><header><span>{HISTORY_KIND_LABELS[item.kind]}</span><strong>{formatSystemTerm(request.status)}</strong></header><h3>{formatProjectOption({ fiscal_year: request.planned_project_year, project_name: request.planned_project_name, status: 'SUBMITTED' })}</h3><p>{regionLabel(request)} · 연결 대상 {formatProjectOption({ fiscal_year: request.planned_project_year, project_name: request.destination_project_name, project_code: request.destination_project_code, status: 'APPLIED' })} · <span title={`${formatIntegerString(request.amount)}원`}>{formatWonWithUnit(request.amount)}</span></p><ReviewOutcome request={request} rejectionReason={request.rejection_reason} />{confirmationControl(item, formatProjectOption({ fiscal_year: request.planned_project_year, project_name: request.destination_project_name ?? request.planned_project_name, project_code: request.destination_project_code, status: request.status }))}</article>;
          })}</div>}
          {filteredHistory.length > 0 && <div className="pagination funding-history-pagination" aria-label="처리 이력 페이지 이동">
            <label className="page-size-control">
              <span>페이지당</span>
              <select value={historyPageSize} onChange={(event) => setHistoryPageSize(Number(event.target.value) as PageSize)}>
                {PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}건</option>)}
              </select>
            </label>
            <span className="pagination-summary">{historyPagination.page} / {historyPagination.pageCount} 페이지</span>
            <div className="pagination-buttons">
              <button type="button" className="small-btn" disabled={historyPagination.page === 1} onClick={() => moveHistoryPage(1)}>처음</button>
              <button type="button" className="small-btn" disabled={historyPagination.page === 1} onClick={() => moveHistoryPage(historyPagination.page - 1)}>이전</button>
              {historyPageNumbers.map((page) => <button
                key={page}
                type="button"
                className="small-btn page-number"
                aria-label={`${page}페이지`}
                aria-current={page === historyPagination.page ? 'page' : undefined}
                onClick={() => moveHistoryPage(page)}
              >{page}</button>)}
              <button type="button" className="small-btn" disabled={historyPagination.page === historyPagination.pageCount} onClick={() => moveHistoryPage(historyPagination.page + 1)}>다음</button>
              <button type="button" className="small-btn" disabled={historyPagination.page === historyPagination.pageCount} onClick={() => moveHistoryPage(historyPagination.pageCount)}>마지막</button>
            </div>
          </div>}
        </>}
      </section>
      {confirmationTarget && <div className="funding-confirmation-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.currentTarget === event.target) setConfirmationTarget(null);
      }}>
        <section className="funding-confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="funding-confirmation-title">
          <header><div><span>사후 점검</span><h2 id="funding-confirmation-title">확인요청 보내기</h2></div><button type="button" className="small-btn" onClick={() => setConfirmationTarget(null)}>닫기</button></header>
          <p><strong>자동 지정 대상</strong> · {confirmationTarget.label}</p>
          <label><span>확인요청 내용 <b>필수</b></span><textarea autoFocus required maxLength={2000} value={confirmationMessage} onChange={(event) => setConfirmationMessage(event.target.value)} placeholder="지자체가 확인하거나 정정할 내용을 구체적으로 입력하세요." /></label>
          <label><span>회신기한 <i>선택</i></span><input type="date" value={confirmationDueDate} onChange={(event) => setConfirmationDueDate(event.target.value)} /></label>
          <div className="funding-inline-actions"><button type="button" className="small-btn" onClick={() => setConfirmationTarget(null)}>취소</button><button type="button" className="my-project-save-button" disabled={submitting !== null || !confirmationMessage.trim()} onClick={() => void sendConfirmation()}>{submitting ? '발송 중...' : '확인요청 보내기'}</button></div>
        </section>
      </div>}
      {notice && <p className="financial-ledger-notice" role="status">{notice}</p>}
      {error && <p className="financial-ledger-error" role="alert">{error}</p>}
    </main>
  </div>;
}
