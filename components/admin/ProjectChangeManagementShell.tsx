"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Header from '../common/Header';
import { PageHeader, StatusBadge } from '../common/WorkUi';
import { getCurrentSession, getCurrentUserProfile } from '../../lib/auth';
import { getAdminBudgetChangeDashboardAction } from '../../app/my-projects/budget-change-actions';
import { formatIntegerString, formatWonWithUnit } from '../../lib/amountFormat';
import type { BudgetChangeRequest, BudgetChangeStatistics } from '../../lib/budgetChanges';
import {
  formatProjectOption,
  formatProjectReference,
  formatStoredUserText,
  formatSystemTerm,
  formatUserFacingError,
  getProjectSearchText,
  sanitizeClassificationNameForDisplay,
  sanitizeProjectNameForDisplay,
} from '../../lib/presentationLabels';
import {
  getAdminProjectChangeEvents,
  projectChangeFiltersToSearchParams,
  type ProjectChangeEvent,
  type ProjectChangeFilters,
} from '../../lib/projectChanges';
import {
  PROJECT_NAME_CHANGE_BASIS_LABELS,
  PROJECT_NAME_CHANGE_BASIS_VALUES,
  PROJECT_NAME_CHANGE_REASON_LABELS,
  PROJECT_NAME_CHANGE_REASON_VALUES,
  SIMILARITY_RELATIONSHIP_LABELS,
} from '../../lib/projectChange';

const EMPTY_FILTERS: ProjectChangeFilters = {};
const EMPTY_BUDGET_STATS: BudgetChangeStatistics = {
  transfer_amount: '0', transfer_count: '0',
  new_project_allocated_amount: '0', new_project_allocated_count: '0',
  pending_new_project_amount: '0', pending_new_project_count: '0',
  applied_request_count: '0', transaction_gap_amount: '0',
};

function classificationText(snapshot: ProjectChangeEvent['old_classification']) {
  return [snapshot.large_category_name, snapshot.middle_category_name, snapshot.primary_small_category_name]
    .filter(Boolean)
    .map((name) => sanitizeClassificationNameForDisplay(name))
    .join(' > ') || '-';
}

export default function ProjectChangeManagementShell() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [filters, setFilters] = useState<ProjectChangeFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<ProjectChangeFilters>(EMPTY_FILTERS);
  const [events, setEvents] = useState<ProjectChangeEvent[]>([]);
  const [budgetRequests, setBudgetRequests] = useState<BudgetChangeRequest[]>([]);
  const [budgetStatistics, setBudgetStatistics] = useState<BudgetChangeStatistics>(EMPTY_BUDGET_STATS);
  const [budgetSourceSearch, setBudgetSourceSearch] = useState('');
  const [budgetDestinationSearch, setBudgetDestinationSearch] = useState('');
  const [budgetStatus, setBudgetStatus] = useState('');
  const [budgetPendingOnly, setBudgetPendingOnly] = useState(false);
  const [selected, setSelected] = useState<ProjectChangeEvent | null>(null);
  const [selectedBudget, setSelectedBudget] = useState<BudgetChangeRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const initialize = async () => {
      const session = await getCurrentSession();
      if (!session.data.session?.user) return router.replace('/');
      const profile = await getCurrentUserProfile();
      if (!profile) return router.replace('/');
      if (profile.first_login) return router.replace('/password-reset');
      if (profile.role !== 'admin') return router.replace('/dashboard');
      setAccessToken(session.data.session.access_token);
      setReady(true);
    };
    void initialize();
  }, [router]);

  const load = useCallback(async (nextFilters: ProjectChangeFilters, token = accessToken) => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const [metadataEvents, budgetResult] = await Promise.all([
        getAdminProjectChangeEvents(nextFilters),
        getAdminBudgetChangeDashboardAction({ accessToken: token }),
      ]);
      if ('error' in budgetResult) throw new Error(budgetResult.error);
      setEvents(metadataEvents);
      setBudgetRequests(budgetResult.data.requests);
      setBudgetStatistics(budgetResult.data.statistics);
      setSelected(null);
      setSelectedBudget(null);
      setAppliedFilters(nextFilters);
    } catch (loadError) {
      setError(formatUserFacingError(loadError, '사업변경 내역을 불러오지 못했습니다.'));
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => { if (ready && accessToken) void load(EMPTY_FILTERS, accessToken); }, [ready, accessToken, load]);

  const summary = useMemo(() => ({
    total: events.length,
    pending: events.filter((event) => event.status === 'REVIEW_REQUIRED').length,
    completed: events.filter((event) => event.status === 'COMPLETED').length,
    similarity: events.filter((event) => event.similarity_candidate && !event.similarity_result).length,
    classification: events.filter((event) => event.change_kind !== 'PROJECT_NAME').length,
  }), [events]);

  const filteredBudgetRequests = useMemo(() => budgetRequests.filter((request) => {
    if (filters.year && request.fiscal_year !== filters.year) return false;
    if (filters.sido && !request.sido?.includes(filters.sido)) return false;
    if (filters.sigungu && !request.sigungu?.includes(filters.sigungu)) return false;
    if (budgetStatus && request.status !== budgetStatus) return false;
    if (budgetSourceSearch && !getProjectSearchText({
      fiscal_year: request.fiscal_year,
      project_name: request.source_project_name,
      project_code: request.source_project_code,
    }).toLocaleLowerCase('ko-KR').includes(budgetSourceSearch.toLocaleLowerCase('ko-KR'))) return false;
    if (budgetDestinationSearch && !request.destinations.some((line) => [
      getProjectSearchText({
        fiscal_year: line.planned_project_year ?? request.fiscal_year,
        project_name: line.destination_project_name,
        project_code: line.destination_project_code,
      }),
      getProjectSearchText({
        fiscal_year: line.planned_project_year ?? request.fiscal_year,
        project_name: line.planned_project_name,
      }),
    ].join(' ').toLocaleLowerCase('ko-KR').includes(budgetDestinationSearch.toLocaleLowerCase('ko-KR')))) return false;
    if (budgetPendingOnly && !request.destinations.some((line) => line.destination_type === 'PENDING_NEW_PROJECT')) return false;
    return true;
  }), [budgetDestinationSearch, budgetPendingOnly, budgetRequests, budgetSourceSearch, budgetStatus, filters]);

  const exportXlsx = async () => {
    setExporting(true);
    setError(null);
    try {
      const session = await getCurrentSession();
      const token = session.data.session?.access_token;
      if (!token) throw new Error('로그인 세션이 만료되었습니다.');
      const response = await fetch(`/api/admin/project-changes/export?${projectChangeFiltersToSearchParams(appliedFilters)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || '엑셀 파일을 만들지 못했습니다.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `사업변경-이력-${new Date().toISOString().slice(0, 10)}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(formatUserFacingError(exportError, '엑셀 파일을 내려받지 못했습니다.'));
    } finally {
      setExporting(false);
    }
  };

  if (!ready) return <div className="loading-shell">관리자 권한을 확인하는 중입니다...</div>;

  return <div className="dashboard-shell project-change-management-shell">
    <Header title="사업변경 관리" />
    <main aria-busy={loading || exporting}>
      <PageHeader
        eyebrow="관리자 통합 이력"
        title="사업변경 관리"
        description="사업정보 변경과 예산 조정 거래를 분리해 조회하고, 변경 전·후 근거를 확인합니다."
        meta={<><StatusBadge label={`확인 필요 ${summary.pending}건`} tone={summary.pending > 0 ? 'warning' : 'success'} /><StatusBadge label={`변경완료 ${summary.completed}건`} tone="info" /></>}
      />
      <div className="admin-page-navigation">
        <button type="button" className="small-btn" onClick={() => router.push('/admin')}>관리자 메뉴</button>
        <button type="button" className="small-btn" onClick={() => router.push('/admin/small-category-proposals')}>소분류 제안 관리</button>
      </div>

      <section className="funding-kpi-grid">
        <article><span>전체 변경건수</span><strong>{summary.total.toLocaleString('ko-KR')}</strong></article>
        <article><span>확인대기</span><strong>{summary.pending.toLocaleString('ko-KR')}</strong></article>
        <article><span>변경완료</span><strong>{summary.completed.toLocaleString('ko-KR')}</strong></article>
        <article><span>유사사업 확인 필요</span><strong>{summary.similarity.toLocaleString('ko-KR')}</strong></article>
        <article><span>분류 변경</span><strong>{summary.classification.toLocaleString('ko-KR')}</strong></article>
        <article><span>예산 조정 적용</span><strong>{budgetStatistics.applied_request_count}</strong></article>
        <article><span>신규사업 예정금액</span><strong title={`${formatIntegerString(budgetStatistics.pending_new_project_amount)}원`}>{formatWonWithUnit(budgetStatistics.pending_new_project_amount)}</strong></article>
      </section>

      <section className="panel">
        <div className="section-title">예산 조정 거래</div>
        <p className="panel-sub">사업정보 변경과 구분된 예산 조정 이벤트입니다. 출처 감액과 목적지 합계는 항상 같은 거래로 연결됩니다.</p>
        <div className="project-change-filter-grid">
          <label><span>출처사업</span><input value={budgetSourceSearch} onChange={(event) => setBudgetSourceSearch(event.target.value)} placeholder="사업명" /></label>
          <label><span>목적사업</span><input value={budgetDestinationSearch} onChange={(event) => setBudgetDestinationSearch(event.target.value)} placeholder="사업명·예정명" /></label>
          <label><span>연도</span><input type="number" value={filters.year ?? ''} onChange={(event) => setFilters({ ...filters, year: Number(event.target.value) || undefined })} /></label>
          <label><span>시도</span><input value={filters.sido ?? ''} onChange={(event) => setFilters({ ...filters, sido: event.target.value || undefined })} /></label>
          <label><span>시군구</span><input value={filters.sigungu ?? ''} onChange={(event) => setFilters({ ...filters, sigungu: event.target.value || undefined })} /></label>
          <label><span>처리상태</span><select value={budgetStatus} onChange={(event) => setBudgetStatus(event.target.value)}><option value="">전체</option><option value="DRAFT">임시저장</option><option value="SUBMITTED">직접 처리 재시도</option><option value="APPROVED">과거 승인·반영 대기</option><option value="REJECTED">과거 반려</option><option value="APPLIED">처리완료</option></select></label>
          <label><span>신규사업 예정</span><select value={budgetPendingOnly ? 'true' : ''} onChange={(event) => setBudgetPendingOnly(event.target.value === 'true')}><option value="">전체</option><option value="true">포함 거래만</option></select></label>
        </div>
        <div className="table-scroll"><table className="project-change-table"><thead><tr><th>이벤트 유형</th><th>적용일</th><th>지역</th><th>출처사업</th><th>목적사업 / 신규사업 예정</th><th className="num">거래금액(원)</th><th>처리상태</th><th>차액</th></tr></thead><tbody>{filteredBudgetRequests.map((request) => <tr key={request.id} className="project-change-row" onClick={() => setSelectedBudget(request)}>
          <td>예산 조정</td><td>{request.effective_date}</td><td>{request.region_name ?? (`${request.sido ?? ''} ${request.sigungu ?? ''}`.trim() || '-')}</td><td>{formatProjectOption({ fiscal_year: request.fiscal_year, project_name: request.source_project_name, project_code: request.source_project_code, status: 'APPLIED' })}</td><td>{request.destinations.map((line) => <div key={line.line_id}>{formatProjectOption({ fiscal_year: line.destination_type === 'EXISTING_PROJECT' ? request.fiscal_year : line.planned_project_year, project_name: line.destination_type === 'EXISTING_PROJECT' ? line.destination_project_name : line.materialized_project_name ?? line.planned_project_name, project_code: line.destination_type === 'EXISTING_PROJECT' ? line.destination_project_code : line.materialized_project_code ?? line.official_project_code, status: line.destination_type === 'EXISTING_PROJECT' ? 'APPLIED' : line.new_project_request_status })} · <span title={`${formatIntegerString(line.amount)}원`}>{formatWonWithUnit(line.amount)}</span></div>)}</td><td className="num" title={`${formatIntegerString(request.total_amount)}원`}>{formatWonWithUnit(request.total_amount)}</td><td>{formatSystemTerm(request.status)}</td><td>0원</td>
        </tr>)}</tbody></table></div>
      </section>

      {selectedBudget && <section className="panel project-change-detail">
        <div className="admin-project-review-heading"><div><div className="section-title">예산 조정 전·후 금액</div><p className="panel-sub">{formatProjectOption({ fiscal_year: selectedBudget.fiscal_year, project_name: selectedBudget.source_project_name, project_code: selectedBudget.source_project_code, status: 'APPLIED' })} · {formatSystemTerm(selectedBudget.status)}</p></div><button type="button" className="small-btn" onClick={() => setSelectedBudget(null)}>닫기</button></div>
        <p className="financial-ledger-notice">원장·계산·이력과 화면 금액은 모두 원 단위로 표시합니다.</p>
        <div className="table-scroll"><table><thead><tr><th>구분</th><th>사업</th><th>기준</th><th className="num">당초 배분액</th><th className="num">증액액</th><th className="num">감액액</th><th className="num">조정 후 배분액</th><th className="num">집행액</th><th className="num">미집행액</th></tr></thead><tbody>{selectedBudget.amount_changes?.flatMap((change) => [
          <tr key={`${change.event_type}-${change.event_id}-${change.project_id}-before`}><td>{change.role === 'SOURCE' ? '출처 감액' : '목적지 증액'}</td><td>{formatProjectOption({ fiscal_year: change.fiscal_year, project_name: change.project_name, project_code: change.project_code, status: 'APPLIED' })}</td><td>변경 전</td>{Object.values(change.before).map((value, index) => <td key={index} className="num" title={`${formatIntegerString(value)}원`}>{formatWonWithUnit(value)}</td>)}</tr>,
          <tr key={`${change.event_type}-${change.event_id}-${change.project_id}-after`}><td>{change.event_type === 'PENDING_LINK' ? '예정재원 연결' : change.role === 'SOURCE' ? '출처 감액' : '목적지 증액'}</td><td>{formatProjectOption({ fiscal_year: change.fiscal_year, project_name: change.project_name, project_code: change.project_code, status: 'APPLIED' })}</td><td>변경 후 · {change.capture_kind === 'EXACT_AT_APPLY' ? '적용시점 확정' : change.capture_kind === 'PROPOSED' ? '승인 전 예상' : '현재원장 역산'}</td>{Object.values(change.after).map((value, index) => <td key={index} className="num" title={`${formatIntegerString(value)}원`}>{formatWonWithUnit(value)}</td>)}</tr>,
        ])}</tbody></table></div>
        {selectedBudget.workflow_steps && selectedBudget.workflow_steps.length > 0 && <div className="admin-project-review-grid">{selectedBudget.workflow_steps.map((step) => <article key={step.pending_fund_id} className="admin-project-review-card"><h3>신규사업 재원 흐름</h3><p>예산조정 {formatSystemTerm(selectedBudget.status)}</p><p>→ 예정재원 {formatSystemTerm(step.pending_status)}</p><p>→ 신규사업 요청 {step.new_project_request_status ? formatSystemTerm(step.new_project_request_status) : '미제출'}</p><p>→ 연결 요청 {step.link_request_status ? formatSystemTerm(step.link_request_status) : '미생성'}</p><p>→ {step.materialized_project_name ? formatProjectReference({ project_name: step.materialized_project_name, project_code: step.materialized_project_code, status: step.new_project_request_status }) : '목적사업 미확정'}</p></article>)}</div>}
      </section>}

      <section className="panel">
        <div className="section-title">변경 이벤트 검색</div>
        <div className="project-change-filter-grid">
          <label><span>연도</span><input type="number" value={filters.year ?? ''} onChange={(event) => setFilters({ ...filters, year: Number(event.target.value) || undefined })} /></label>
          <label><span>시도</span><input value={filters.sido ?? ''} onChange={(event) => setFilters({ ...filters, sido: event.target.value || undefined })} /></label>
          <label><span>시군구</span><input value={filters.sigungu ?? ''} onChange={(event) => setFilters({ ...filters, sigungu: event.target.value || undefined })} /></label>
          <label><span>변경 전 사업명</span><input value={filters.oldName ?? ''} onChange={(event) => setFilters({ ...filters, oldName: event.target.value || undefined })} /></label>
          <label><span>변경 후 사업명</span><input value={filters.newName ?? ''} onChange={(event) => setFilters({ ...filters, newName: event.target.value || undefined })} /></label>
          <label><span>변경근거</span><select value={filters.basisCode ?? ''} onChange={(event) => setFilters({ ...filters, basisCode: event.target.value || undefined })}><option value="">전체</option>{PROJECT_NAME_CHANGE_BASIS_VALUES.map((value) => <option key={value} value={value}>{PROJECT_NAME_CHANGE_BASIS_LABELS[value]}</option>)}</select></label>
          <label><span>변경사유</span><select value={filters.reasonCode ?? ''} onChange={(event) => setFilters({ ...filters, reasonCode: event.target.value || undefined })}><option value="">전체</option>{PROJECT_NAME_CHANGE_REASON_VALUES.map((value) => <option key={value} value={value}>{PROJECT_NAME_CHANGE_REASON_LABELS[value]}</option>)}</select></label>
          <label><span>처리상태</span><select value={filters.status ?? ''} onChange={(event) => setFilters({ ...filters, status: event.target.value || undefined })}><option value="">전체</option><option value="COMPLETED">변경완료</option><option value="REVIEW_REQUIRED">확인 필요</option></select></label>
          <label><span>유사사업 여부</span><select value={filters.hasSimilarity === undefined ? '' : String(filters.hasSimilarity)} onChange={(event) => setFilters({ ...filters, hasSimilarity: event.target.value === '' ? undefined : event.target.value === 'true' })}><option value="">전체</option><option value="true">있음</option><option value="false">없음</option></select></label>
          <label><span>변경일 시작</span><input type="date" value={filters.dateFrom ?? ''} onChange={(event) => setFilters({ ...filters, dateFrom: event.target.value || undefined })} /></label>
          <label><span>변경일 종료</span><input type="date" value={filters.dateTo ?? ''} onChange={(event) => setFilters({ ...filters, dateTo: event.target.value || undefined })} /></label>
        </div>
        <div className="analytics-actions"><button type="button" className="my-project-save-button" onClick={() => void load(filters)} disabled={loading}>{loading ? '조회 중...' : '조회'}</button><button type="button" className="small-btn" onClick={() => { setFilters(EMPTY_FILTERS); void load(EMPTY_FILTERS); }}>초기화</button><button type="button" className="small-btn" onClick={() => void exportXlsx()} disabled={exporting}>{exporting ? '엑셀 생성 중...' : '엑셀 내려받기'}</button></div>
        {error && <div className="error-message">{error}</div>}
      </section>

      <section className="panel">
        <div className="section-title">사업변경 목록</div>
        <div className="table-scroll"><table className="project-change-table"><thead><tr><th>변경일시</th><th>시도</th><th>시군구</th><th>연도</th><th>변경 전 사업명</th><th>변경 후 사업명</th><th>변경근거</th><th>변경사유</th><th>분류 전</th><th>분류 후</th><th>관련 소분류</th><th>유사사업</th><th>관계유형</th><th>변경자</th><th>처리상태</th></tr></thead>
          <tbody>{events.map((event) => <tr key={event.id} onClick={() => setSelected(event)} className="project-change-row">
            <td>{new Date(event.changed_at).toLocaleString('ko-KR')}</td><td>{event.regions?.sido ?? '-'}</td><td>{event.regions?.sigungu ?? '-'}</td><td>{event.fiscal_year ?? '-'}</td><td>{sanitizeProjectNameForDisplay(event.old_name, event.fiscal_year)}</td><td>{sanitizeProjectNameForDisplay(event.new_name, event.fiscal_year)}</td><td>{event.change_basis_label ?? '-'}</td><td>{event.change_reason_labels.join(', ') || '-'}</td><td>{classificationText(event.old_classification)}</td><td>{classificationText(event.new_classification)}</td><td>{event.related_small_category_labels.join(', ') || '-'}</td><td>{event.similarity_candidate ? '있음' : '없음'}</td><td>{event.similarity_result ? SIMILARITY_RELATIONSHIP_LABELS[event.similarity_result as keyof typeof SIMILARITY_RELATIONSHIP_LABELS] ?? '확인 필요' : '-'}</td><td>{event.actorLabel ?? '-'}</td><td>{event.status === 'COMPLETED' ? '변경완료' : '확인 필요'}</td>
          </tr>)}</tbody></table></div>
      </section>

      {selected && <section className="panel project-change-detail">
        <div className="admin-project-review-heading"><div><div className="section-title">사업변경 상세</div><p className="panel-sub">{formatProjectReference({ project_name: selected.new_name ?? selected.old_name, project_code: selected.project_code, status: 'APPLIED' })}</p></div><button type="button" className="small-btn" onClick={() => setSelected(null)}>닫기</button></div>
        <div className="admin-project-review-grid">
          <article className="admin-project-review-card"><h3>기본정보</h3><dl><div><dt>지자체</dt><dd>{selected.regions?.display_name ?? '-'}</dd></div><div><dt>사업연도</dt><dd>{selected.fiscal_year ?? '-'}</dd></div><div><dt>처리상태</dt><dd>{selected.status === 'COMPLETED' ? '변경완료' : '확인 필요'}</dd></div></dl></article>
          <article className="admin-project-review-card"><h3>사업명 변경</h3><dl><div><dt>변경 전</dt><dd>{sanitizeProjectNameForDisplay(selected.old_name, selected.fiscal_year)}</dd></div><div><dt>변경 후</dt><dd>{sanitizeProjectNameForDisplay(selected.new_name, selected.fiscal_year)}</dd></div><div><dt>근거</dt><dd>{selected.change_basis_label ?? '-'}</dd></div><div><dt>사유</dt><dd>{selected.change_reason_labels.join(', ') || '-'}</dd></div><div><dt>상세내용</dt><dd>{formatStoredUserText(selected.detail, '-')}</dd></div></dl></article>
          <article className="admin-project-review-card"><h3>분류 변경</h3><dl><div><dt>변경 전</dt><dd>{classificationText(selected.old_classification)}</dd></div><div><dt>변경 후</dt><dd>{classificationText(selected.new_classification)}</dd></div><div><dt>관련 소분류</dt><dd>{selected.related_small_category_labels.join(', ') || '-'}</dd></div></dl></article>
          <article className="admin-project-review-card"><h3>유사사업</h3><dl><div><dt>후보 여부</dt><dd>{selected.similarity_candidate ? '있음' : '없음'}</dd></div><div><dt>관계처리</dt><dd>{selected.similarity_result ? SIMILARITY_RELATIONSHIP_LABELS[selected.similarity_result as keyof typeof SIMILARITY_RELATIONSHIP_LABELS] ?? '확인 필요' : '-'}</dd></div></dl></article>
          <article className="admin-project-review-card"><h3>변경이력</h3><dl><div><dt>변경자</dt><dd>{selected.actorLabel ?? '사용자 정보 없음'}</dd></div><div><dt>변경일시</dt><dd>{new Date(selected.changed_at).toLocaleString('ko-KR')}</dd></div></dl></article>
          <article className="admin-project-review-card"><h3>재정 영향</h3><p className="financial-ledger-notice">재정금액 영향 없음 · 사업정보 변경 차액 0원</p>{selected.ledger_transaction_reference && <p>관련 재정원장 거래가 있습니다.</p>}</article>
        </div>
      </section>}
    </main>
  </div>;
}
