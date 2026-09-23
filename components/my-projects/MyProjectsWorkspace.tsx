"use client";

import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import { getMyProjectsWorkspaceAction } from '../../app/my-projects/workspace-actions';
import { formatIntegerString } from '../../lib/amountFormat';
import { getCurrentSessionWithRetry, getProfileByUserId, type UserProfile } from '../../lib/auth';
import { formatProjectName, formatUserFacingError, sanitizeClassificationNameForDisplay, sanitizeProjectNameForDisplay } from '../../lib/presentationLabels';
import {
  buildProjectSummary,
  buildWorkspaceSearchParams,
  EMPTY_PROJECT_FILTERS,
  filterWorkspaceProjects,
  filterWorkspaceRequests,
  getExecutionRateLabel,
  getProjectInformationIssues,
  getWorkspaceProjectLifecycle,
  getWorkspaceProjectStatus,
  groupWorkspaceRequests,
  paginateWorkspaceItems,
  parseWorkspaceSearchParams,
  requestStatusLabel,
  sortWorkspaceProjects,
  type WorkspaceProject,
  type WorkspaceProjectFilters,
  type WorkspaceProjectSort,
  type WorkspaceRequestGroup,
  type WorkspaceTab,
} from '../../lib/myProjectsWorkspace';
import Header from '../common/Header';
import NewProjectRequestPanel from './NewProjectRequestPanel';
import NewProjectDeleteDialog from './NewProjectDeleteDialog';
import styles from './MyProjectsWorkspace.module.css';

type Snapshot = Awaited<ReturnType<typeof getMyProjectsWorkspaceAction>> extends { data?: infer T }
  ? NonNullable<T>
  : never;

const TAB_LABELS: Record<WorkspaceTab, string> = {
  projects: '사업 목록',
  active: '진행 중 요청',
  completed: '완료된 요청',
};

const FILTER_LABELS: Array<{ key: keyof WorkspaceProjectFilters; label: string }> = [
  { key: 'query', label: '검색' },
  { key: 'year', label: '사업연도' },
  { key: 'lifecycle', label: '신규/계속' },
  { key: 'status', label: '집행상태' },
  { key: 'largeCategoryId', label: '대분류' },
  { key: 'middleCategoryId', label: '중분류' },
  { key: 'smallCategoryId', label: '소분류' },
  { key: 'funding', label: '재원' },
  { key: 'completeness', label: '정보' },
  { key: 'executionRate', label: '집행률' },
];

function formatWon(value: string | null | undefined) {
  return `${formatIntegerString(value ?? '0')}원`;
}

function formatDate(value: string | null | undefined, withTime = false) {
  if (!value) return '미입력';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', withTime
    ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed);
}

function requestTone(status: string) {
  if (status === 'REJECTED') return styles.danger;
  if (status === 'SUBMITTED' || status === 'APPROVED') return styles.pending;
  if (status === 'APPLIED' || status === 'LINKED' || status === 'COMPLETED') return styles.success;
  return styles.neutral;
}

function businessTypeLabel(value: WorkspaceProject['business_type']) {
  if (value === 'HW') return '시설·인프라 중심';
  if (value === 'SW') return '프로그램·서비스 중심';
  if (value === 'COMPOSITE') return '복합형';
  return '미입력';
}

function readInitialState() {
  const params = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
  return parseWorkspaceSearchParams(params);
}

function readInitialNewProjectRequestId() {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('requestId');
}

function Pagination({ page, pageCount, start, end, total, onPage }: {
  page: number;
  pageCount: number;
  start: number;
  end: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const first = Math.max(1, Math.min(page - 2, pageCount - 4));
  const pages = Array.from({ length: Math.min(5, pageCount) }, (_, index) => first + index);
  return (
    <nav className={styles.pagination} aria-label="목록 페이지 이동">
      <span>전체 {total.toLocaleString('ko-KR')}건 중 {start.toLocaleString('ko-KR')}–{end.toLocaleString('ko-KR')}건</span>
      <div>
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>이전</button>
        {pages.map((item) => (
          <button
            key={item}
            type="button"
            className={item === page ? styles.currentPage : undefined}
            aria-current={item === page ? 'page' : undefined}
            onClick={() => onPage(item)}
          >{item}</button>
        ))}
        <button type="button" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>다음</button>
      </div>
    </nav>
  );
}

function SummaryButton({ label, count, tone, onClick, help }: {
  label: string;
  count: number;
  tone: 'neutral' | 'notice' | 'pending' | 'danger';
  onClick: () => void;
  help: string;
}) {
  return (
    <button type="button" className={`${styles.summaryButton} ${styles[tone]}`} onClick={onClick}>
      <span>{label}</span>
      <strong>{count.toLocaleString('ko-KR')}건</strong>
      <small>{help}</small>
    </button>
  );
}

function NewProjectApplication({ profile, onClose, onChanged, onRequestUnavailable }: {
  profile: UserProfile;
  onClose: () => void;
  onChanged: () => void;
  onRequestUnavailable: (message: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const notifiedRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const openButton = host.querySelector<HTMLButtonElement>('.new-project-request-heading button');
    if (!host.querySelector('.funding-workflow-grid')) openButton?.click();
    const observer = new MutationObserver(() => {
      const notice = host.querySelector('.financial-ledger-notice[role="status"]');
      if (!notice || notifiedRef.current) return;
      notifiedRef.current = true;
      onChanged();
    });
    observer.observe(host, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [onChanged]);

  return (
    <section id="new-project-request" className={styles.application} aria-labelledby="new-project-title">
      <div className={styles.applicationHeading}>
        <div>
          <p>신규사업 신청</p>
          <h2 id="new-project-title">신규사업 신청</h2>
          <span>2026년 9월 1일 이후 신규사업을 신청하고 처리상태를 확인할 수 있습니다.</span>
        </div>
        <button type="button" onClick={onClose}>닫기</button>
      </div>
      <div ref={hostRef} className={styles.applicationBody}>
        <NewProjectRequestPanel
          profile={profile}
          onDeleted={() => onChanged()}
          onRequestUnavailable={onRequestUnavailable}
        />
      </div>
    </section>
  );
}

function ProjectBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  return <span className={`${styles.badge} ${styles[tone]}`}>{children}</span>;
}

export default function MyProjectsWorkspace() {
  const router = useRouter();
  const initial = useMemo(readInitialState, []);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [accessToken, setAccessToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>(initial.tab);
  const [filters, setFilters] = useState<WorkspaceProjectFilters>(initial.filters);
  const [searchDraft, setSearchDraft] = useState(initial.filters.query);
  const [sort, setSort] = useState<WorkspaceProjectSort>(initial.sort);
  const [page, setPage] = useState(initial.page);
  const [pageSize, setPageSize] = useState(initial.pageSize);
  const [requestQuery, setRequestQuery] = useState(initial.requestQuery);
  const [requestQueryDraft, setRequestQueryDraft] = useState(initial.requestQuery);
  const [requestStatus, setRequestStatus] = useState(initial.requestStatus);
  const [requestYear, setRequestYear] = useState(initial.requestYear);
  const [selectedRequest, setSelectedRequest] = useState<WorkspaceRequestGroup | null>(null);
  const [showNewProject, setShowNewProject] = useState(initial.newProject);
  const [newProjectRequestId, setNewProjectRequestId] = useState(readInitialNewProjectRequestId);
  const [deleteDraft, setDeleteDraft] = useState<{ id: string; name: string; year: number } | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const loadWorkspace = useCallback(async (token: string) => {
    const result = await getMyProjectsWorkspaceAction({ accessToken: token });
    if ('error' in result) throw new Error(result.error);
    setSnapshot(result.data);
  }, []);

  const retryWorkspace = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      await loadWorkspace(accessToken);
    } catch (loadError) {
      setError(formatUserFacingError(loadError, '내 사업을 불러오지 못했습니다.'));
    } finally {
      setLoading(false);
    }
  }, [accessToken, loadWorkspace]);

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      const sessionResult = await getCurrentSessionWithRetry();
      const session = sessionResult.data.session;
      if (!session?.user) {
        router.replace('/');
        return;
      }
      try {
        const profileData = await getProfileByUserId(session.user.id);
        if (!profileData) {
          router.replace('/');
          return;
        }
        if (profileData.first_login) {
          router.replace('/password-reset');
          return;
        }
        if (profileData.role !== 'local_user' || !profileData.region_id) {
          router.replace('/dashboard');
          return;
        }
        if (cancelled) return;
        setProfile(profileData);
        setAccessToken(session.access_token);
        await loadWorkspace(session.access_token);
      } catch (loadError) {
        if (!cancelled) setError(formatUserFacingError(loadError, '내 사업을 불러오지 못했습니다.'));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setHydrated(true);
          const savedScroll = Number(sessionStorage.getItem('my-projects-scroll') ?? 0);
          if (savedScroll > 0) requestAnimationFrame(() => window.scrollTo({ top: savedScroll }));
        }
      }
    };
    void initialize();
    return () => { cancelled = true; };
  }, [loadWorkspace, router]);

      useEffect(() => {
    if (!hydrated) return;
    const params = buildWorkspaceSearchParams({
      tab, filters, sort, page, pageSize: pageSize === 50 ? 50 : 20,
      requestQuery, requestStatus, requestYear, newProject: showNewProject,
    });
    if (showNewProject && newProjectRequestId) params.set('requestId', newProjectRequestId);
    const query = params.toString();
    window.history.replaceState(null, '', query ? `/my-projects?${query}` : '/my-projects');
  }, [filters, hydrated, newProjectRequestId, page, pageSize, requestQuery, requestStatus, requestYear, showNewProject, sort, tab]);

  useEffect(() => {
    if (!showNewProject) return;
    requestAnimationFrame(() => document.getElementById('new-project-request')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [showNewProject]);

  const projects = useMemo(() => snapshot?.projects ?? [], [snapshot?.projects]);
  const projectSummary = useMemo(() => buildProjectSummary(projects), [projects]);
  const groupedRequests = useMemo(() => groupWorkspaceRequests(snapshot?.requests ?? []), [snapshot?.requests]);
  const standaloneDrafts = useMemo(() => groupedRequests.filter((request) => (
    request.kind === 'NEW_PROJECT' && request.status === 'DRAFT' && !request.correlation_id
  )), [groupedRequests]);
  const activeRequests = useMemo(() => groupedRequests.filter((request) => !request.is_completed), [groupedRequests]);
  const completedRequests = useMemo(() => groupedRequests.filter((request) => request.is_completed), [groupedRequests]);
  const pendingRequests = activeRequests.filter((request) => ['SUBMITTED', 'APPROVED'].includes(request.status));
  const rejectedRequests = activeRequests.filter((request) => request.status === 'REJECTED');
  const currentYear = new Date().getFullYear();

  const filteredProjects = useMemo(
    () => sortWorkspaceProjects(filterWorkspaceProjects(projects, filters, currentYear), sort),
    [currentYear, filters, projects, sort],
  );
  const projectPage = useMemo(() => paginateWorkspaceItems(filteredProjects, page, pageSize), [filteredProjects, page, pageSize]);
  const requestSource = tab === 'completed' ? completedRequests : activeRequests;
  const filteredRequests = useMemo(() => {
    const specialFiltered = requestStatus === 'pending'
      ? requestSource.filter((request) => ['SUBMITTED', 'APPROVED'].includes(request.status))
      : requestStatus === 'rejected'
        ? requestSource.filter((request) => request.status === 'REJECTED')
        : filterWorkspaceRequests(requestSource, { status: requestStatus });
    return filterWorkspaceRequests(specialFiltered, { query: requestQuery, year: requestYear });
  }, [requestQuery, requestSource, requestStatus, requestYear]);
  const requestPage = useMemo(() => paginateWorkspaceItems(filteredRequests, page, pageSize), [filteredRequests, page, pageSize]);

  useEffect(() => {
    if (!snapshot) return;
    if (tab === 'projects' && page !== projectPage.page) setPage(projectPage.page);
    if (tab !== 'projects' && page !== requestPage.page) setPage(requestPage.page);
  }, [page, projectPage.page, requestPage.page, snapshot, tab]);

  const years = useMemo(() => [...new Set(projects.flatMap((project) => project.year === null ? [] : [project.year]))]
    .sort((left, right) => right - left), [projects]);
  const requestYears = useMemo(() => [...new Set(groupedRequests.map((request) => request.fiscal_year))]
    .sort((left, right) => right - left), [groupedRequests]);
  const middleOptions = snapshot?.categories.middle.filter((item) => !filters.largeCategoryId
    || item.large_category_id === filters.largeCategoryId) ?? [];
  const smallOptions = snapshot?.categories.small.filter((item) => !filters.middleCategoryId
    || item.middle_category_id === filters.middleCategoryId) ?? [];
  const statusOptions = [...new Set(projects.map((project) => getWorkspaceProjectStatus(project)))];
  const activeFilterChips = FILTER_LABELS.flatMap(({ key, label }) => {
    const raw = filters[key];
    if (!raw) return [];
    const names: Record<string, string> = {
      connected: '연결됨', unconnected: '연결 필요', missing: '미입력', complete: '정상',
      classification: '분류 확인 필요', funding: '재원 연결 필요', before: '집행 전',
      '0-25': '0–25%', '25-50': '25–50%', '50-75': '50–75%', '75-100': '75–100%', '100+': '100% 이상',
    };
    const categoryName = [...(snapshot?.categories.large ?? []), ...(snapshot?.categories.middle ?? []), ...(snapshot?.categories.small ?? [])]
      .find((item) => item.id === raw)?.name;
    return [{ key, label: `${label}: ${categoryName ?? names[raw] ?? raw}` }];
  });

  const updateFilter = (key: keyof WorkspaceProjectFilters, value: string) => {
    setFilters((current) => ({
      ...current,
      [key]: value,
      ...(key === 'largeCategoryId' ? { middleCategoryId: '', smallCategoryId: '' } : {}),
      ...(key === 'middleCategoryId' ? { smallCategoryId: '' } : {}),
    }));
    setPage(1);
  };

  const openProject = (project: WorkspaceProject) => {
    sessionStorage.setItem('my-projects-scroll', String(window.scrollY));
    router.push(`/my-projects/${project.id}/edit`);
  };

  const onProjectKey = (event: KeyboardEvent<HTMLTableRowElement>, project: WorkspaceProject) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openProject(project);
    }
  };

  const selectTab = (nextTab: WorkspaceTab) => {
    setTab(nextTab);
    setPage(1);
    setSelectedRequest(null);
    setRequestStatus('');
  };

  const openAttention = (kind: 'all' | 'missing' | 'pending' | 'rejected' | 'delayed') => {
    if (kind === 'pending' || kind === 'rejected') {
      setTab('active');
      setRequestStatus(kind);
    } else {
      setTab('projects');
      setRequestStatus('');
      setSearchDraft('');
      setFilters({
        ...EMPTY_PROJECT_FILTERS,
        completeness: kind === 'missing' ? 'missing' : '',
        status: kind === 'delayed' ? '지연·추진곤란' : '',
      });
    }
    setPage(1);
  };

  if (loading) return <div className={styles.loading}>내 사업 업무공간을 준비하는 중입니다...</div>;
  if (!profile) return <div className={styles.loading}>접근 권한을 확인하는 중입니다...</div>;

  const visibleProjectPage = projectPage;
  const visibleRequestPage = requestPage;

  return (
    <div className={styles.shell}>
      <Header title="내 사업" />
      <main className={styles.main}>
        <header className={styles.pageHeader}>
          <div>
            <p className={styles.region}>{snapshot?.regionName ?? profile.region_name ?? '내 지역'} 담당 업무</p>
            <div className={styles.titleLine}>
              <h1>내 사업</h1>
              <span>공식사업 {projects.length.toLocaleString('ko-KR')}건 · 초안 {standaloneDrafts.length.toLocaleString('ko-KR')}건</span>
              {snapshot?.environment === 'TEST' && <em>시험 환경</em>}
            </div>
            <p>담당 사업의 현황을 확인하고 필요한 정보를 수정할 수 있습니다.</p>
          </div>
          <div className={styles.headerActions}>
            <button type="button" className={styles.secondaryButton} onClick={() => router.push('/dashboard')}>대시보드에서 자세히 보기</button>
            <button type="button" className={styles.primaryButton} onClick={() => { setNewProjectRequestId(null); setShowNewProject(true); }}>+ 신규사업 생성</button>
          </div>
        </header>

        {error && (
          <div className={styles.error} role="alert">
            <strong>업무정보를 불러오지 못했습니다.</strong><span>{error}</span>
            {accessToken && <button type="button" onClick={() => void retryWorkspace()}>다시 시도</button>}
          </div>
        )}

        {!error && snapshot && (
          <>
            <section className={styles.attention} aria-labelledby="attention-title">
              <div className={styles.sectionHeading}>
                <div><p>업무 요약</p><h2 id="attention-title">지금 확인할 일</h2></div>
                <span>담당 지역 전체 데이터 기준</span>
              </div>
              <div className={styles.summaryGrid}>
                <SummaryButton label="전체 사업" count={projectSummary.total} tone="neutral" help="사업 목록 전체 보기" onClick={() => openAttention('all')} />
                <SummaryButton label="신규사업 초안" count={standaloneDrafts.length} tone="notice" help="공식 사업 통계와 분리된 임시저장" onClick={() => { setTab('projects'); setPage(1); }} />
                <SummaryButton label="정보 미입력" count={projectSummary.missing} tone="notice" help="필수정보 누락 사업" onClick={() => openAttention('missing')} />
                <SummaryButton label="처리대기" count={pendingRequests.length} tone="pending" help="임시저장 또는 직접 처리 재시도 필요" onClick={() => openAttention('pending')} />
                <SummaryButton label="반려·보완" count={rejectedRequests.length} tone="danger" help="사용자 확인 필요" onClick={() => openAttention('rejected')} />
                <SummaryButton label="지연·추진곤란" count={projectSummary.delayed} tone="danger" help="집행상태 확인" onClick={() => openAttention('delayed')} />
              </div>
            </section>

            {showNewProject && (
              <NewProjectApplication
                key={newProjectRequestId ?? 'new-project'}
                profile={profile}
                onClose={() => { setShowNewProject(false); setNewProjectRequestId(null); }}
                onChanged={() => accessToken && void loadWorkspace(accessToken)}
                onRequestUnavailable={(message) => {
                  setShowNewProject(false);
                  setNewProjectRequestId(null);
                  setError(message);
                }}
              />
            )}

            <section className={styles.workspace} aria-label="내 사업 업무 목록">
              <div className={styles.tabs} role="tablist" aria-label="내 사업 화면 선택">
                {([
                  ['projects', `사업 목록 ${projects.length.toLocaleString('ko-KR')}`],
                  ['active', `진행 중 요청 ${activeRequests.length.toLocaleString('ko-KR')}`],
                  ['completed', `완료된 요청 ${completedRequests.length.toLocaleString('ko-KR')}`],
                ] as Array<[WorkspaceTab, string]>).map(([key, label]) => (
                  <button
                    type="button"
                    role="tab"
                    key={key}
                    aria-selected={tab === key}
                    aria-controls={`workspace-panel-${key}`}
                    className={tab === key ? styles.activeTab : undefined}
                    onClick={() => selectTab(key)}
                  >{label}</button>
                ))}
              </div>

              {tab === 'projects' ? (
                <div id="workspace-panel-projects" role="tabpanel" className={styles.panel}>
                  <div className={styles.panelHeading}>
                    <div><h2>사업 목록</h2><p>검색 결과 {filteredProjects.length.toLocaleString('ko-KR')}건</p></div>
                    <label className={styles.pageSize}><span>페이지당</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value) === 50 ? 50 : 20); setPage(1); }}><option value="20">20건</option><option value="50">50건</option></select></label>
                  </div>

                  <div className="financial-ledger-notice" role="status">
                    <strong>신규사업 초안 {standaloneDrafts.length.toLocaleString('ko-KR')}건 · 공식 사업 통계에서 제외</strong>
                    {standaloneDrafts.length === 0
                      ? <span>임시저장한 신규사업이 없습니다.</span>
                      : <ul>{standaloneDrafts.map((draft) => <li key={draft.id}><span>{draft.destination_label} · 임시저장 · {draft.source_label} · 배분액 {formatWon(draft.amount)}</span><div className={styles.draftActions}>{draft.detail_href && <button type="button" className={styles.linkButton} onClick={() => { window.history.replaceState(null, '', draft.detail_href!); setNewProjectRequestId(draft.id); setShowNewProject(true); }}>조회·수정</button>}<button type="button" className={styles.deleteLinkButton} onClick={() => setDeleteDraft({ id: draft.id, name: draft.destination_label, year: draft.fiscal_year })}>삭제</button></div></li>)}</ul>}
                  </div>

                  <form className={styles.filters} onSubmit={(event) => { event.preventDefault(); updateFilter('query', searchDraft); }}>
                    <label className={styles.searchField}><span>사업명 검색</span><div><input type="search" value={searchDraft} placeholder="사업명을 입력하세요" onChange={(event) => setSearchDraft(event.target.value)} /><button type="submit">검색</button>{searchDraft && <button type="button" aria-label="검색어 지우기" onClick={() => { setSearchDraft(''); updateFilter('query', ''); }}>지우기</button>}</div></label>
                    <label><span>사업연도</span><select value={filters.year} onChange={(event) => updateFilter('year', event.target.value)}><option value="">전체</option>{years.map((year) => <option value={year} key={year}>{year}년</option>)}</select></label>
                    <label><span>신규/계속</span><select value={filters.lifecycle} onChange={(event) => updateFilter('lifecycle', event.target.value)}><option value="">전체</option><option>신규사업</option><option>계속사업</option><option>미입력</option></select></label>
                    <label><span>집행상태</span><select value={filters.status} onChange={(event) => updateFilter('status', event.target.value)}><option value="">전체</option><option value="지연·추진곤란">지연·추진곤란</option>{statusOptions.map((status) => <option value={status} key={status}>{status}</option>)}</select></label>
                    <label><span>대분류</span><select value={filters.largeCategoryId} onChange={(event) => updateFilter('largeCategoryId', event.target.value)}><option value="">전체</option>{snapshot.categories.large.map((item) => <option value={item.id} key={item.id}>{sanitizeClassificationNameForDisplay(item.name)}</option>)}</select></label>
                    <label><span>중분류</span><select value={filters.middleCategoryId} onChange={(event) => updateFilter('middleCategoryId', event.target.value)}><option value="">전체</option>{middleOptions.map((item) => <option value={item.id} key={item.id}>{sanitizeClassificationNameForDisplay(item.name)}</option>)}</select></label>
                    <label><span>소분류</span><select value={filters.smallCategoryId} onChange={(event) => updateFilter('smallCategoryId', event.target.value)}><option value="">전체</option>{smallOptions.map((item) => <option value={item.id} key={item.id}>{sanitizeClassificationNameForDisplay(item.name)}</option>)}</select></label>
                    <label><span>재원 연결</span><select value={filters.funding} onChange={(event) => updateFilter('funding', event.target.value)}><option value="">전체</option><option value="connected">연결됨</option><option value="unconnected">연결 필요</option></select></label>
                    <label><span>정보 완결성</span><select value={filters.completeness} onChange={(event) => updateFilter('completeness', event.target.value)}><option value="">전체</option><option value="missing">정보 미입력</option><option value="complete">정보 정상</option><option value="classification">분류 확인 필요</option><option value="funding">재원 연결 필요</option></select></label>
                    <label><span>집행률 구간</span><select value={filters.executionRate} onChange={(event) => updateFilter('executionRate', event.target.value)}><option value="">전체</option><option value="before">집행 전</option><option value="0-25">0–25%</option><option value="25-50">25–50%</option><option value="50-75">50–75%</option><option value="75-100">75–100%</option><option value="100+">100% 이상</option></select></label>
                    <label><span>정렬</span><select value={sort} onChange={(event) => { setSort(event.target.value as WorkspaceProjectSort); setPage(1); }}><option value="updated">최근 수정순</option><option value="year">사업연도 최신순</option><option value="name">사업명순</option><option value="rate-low">집행률 낮은 순</option><option value="allocation-high">조정 후 배분액 큰 순</option><option value="attention">확인 필요 사업 우선</option></select></label>
                  </form>

                  {activeFilterChips.length > 0 && (
                    <div className={styles.chips} aria-label="적용 중인 필터">
                      {activeFilterChips.map((chip) => <button type="button" key={chip.key} onClick={() => { if (chip.key === 'query') setSearchDraft(''); updateFilter(chip.key, ''); }}>{chip.label}<span aria-hidden="true">×</span><span className={styles.srOnly}>필터 해제</span></button>)}
                      <button type="button" className={styles.resetButton} onClick={() => { setFilters(EMPTY_PROJECT_FILTERS); setSearchDraft(''); setPage(1); }}>전체 초기화</button>
                    </div>
                  )}

                  {filteredProjects.length === 0 ? (
                    <div className={styles.empty} role="status"><strong>조건에 맞는 사업이 없습니다.</strong><span>검색어 또는 적용 중인 필터를 확인하고 전체 초기화를 이용해 주세요.</span></div>
                  ) : (
                    <>
                      <div className={`${styles.tableWrap} ${styles.projectTableWrap}`}>
                        <table className={styles.projectTable}>
                          <thead><tr><th>사업연도</th><th>사업명</th><th>신규/계속</th><th>집행상태</th><th className={styles.number}>조정 후 배분액</th><th className={styles.number}>집행액</th><th>집행률</th><th>확인 필요</th><th>최근 수정일</th><th>작업</th></tr></thead>
                          <tbody>{visibleProjectPage.items.map((project) => {
                            const issues = getProjectInformationIssues(project);
                            const status = getWorkspaceProjectStatus(project);
                            const needsAttention = issues.length > 0 || project.classification_review_needed || !project.projection_ready;
                            const projectName = formatProjectName(project);
                            return (
                              <tr key={project.id} tabIndex={0} role="link" aria-label={`${projectName} 상세 열기`} onClick={() => openProject(project)} onKeyDown={(event) => onProjectKey(event, project)}>
                                <td>{project.year ?? '미입력'}</td>
                                <td className={styles.projectName} title={projectName}><button type="button" onClick={(event) => { event.stopPropagation(); openProject(project); }}>{projectName}</button><small>{sanitizeClassificationNameForDisplay(project.large_category_name, '대분류 미입력')} · {businessTypeLabel(project.business_type)}</small></td>
                                <td>{getWorkspaceProjectLifecycle(project)}</td>
                                <td><ProjectBadge tone={status === '정상추진' || status === '완료' ? 'success' : status === '미입력' ? 'neutral' : 'danger'}>{status}</ProjectBadge></td>
                                <td className={styles.number}>{formatWon(project.alloc_text)}</td>
                                <td className={styles.number}>{formatWon(project.exec_text)}</td>
                                <td>{getExecutionRateLabel(project, currentYear)}</td>
                                <td>{needsAttention ? <div className={styles.badges}>{issues.length > 0 && <ProjectBadge tone="warning">정보 미입력 {issues.length}</ProjectBadge>}{project.classification_review_needed && <ProjectBadge tone="warning">분류 확인</ProjectBadge>}{!project.projection_ready && <ProjectBadge tone="danger">재원 연결</ProjectBadge>}</div> : <ProjectBadge tone="success">정보 정상</ProjectBadge>}</td>
                                <td>{formatDate(project.updated_at)}</td>
                                <td><button type="button" className={styles.linkButton} onClick={(event) => { event.stopPropagation(); openProject(project); }}>상세·수정</button></td>
                              </tr>
                            );
                          })}</tbody>
                        </table>
                      </div>
                      <div className={styles.mobileCards}>{visibleProjectPage.items.map((project) => {
                        const issues = getProjectInformationIssues(project);
                        const status = getWorkspaceProjectStatus(project);
                        return <article key={project.id}><div><span>{project.year ?? '연도 미입력'}</span><ProjectBadge tone={status === '정상추진' || status === '완료' ? 'success' : 'danger'}>{status}</ProjectBadge></div><h3>{formatProjectName(project)}</h3><dl><div><dt>신규/계속</dt><dd>{getWorkspaceProjectLifecycle(project)}</dd></div><div><dt>조정 후 배분액</dt><dd>{formatWon(project.alloc_text)}</dd></div><div><dt>집행액</dt><dd>{formatWon(project.exec_text)}</dd></div><div><dt>집행률</dt><dd>{getExecutionRateLabel(project, currentYear)}</dd></div></dl>{issues.length > 0 && <p>정보 미입력: {issues.join(', ')}</p>}<button type="button" onClick={() => openProject(project)}>상세·수정</button></article>;
                      })}</div>
                      <Pagination {...visibleProjectPage} onPage={setPage} />
                    </>
                  )}
                </div>
              ) : (
                <div id={`workspace-panel-${tab}`} role="tabpanel" className={styles.panel}>
                  <div className={styles.panelHeading}>
                    <div><h2>{TAB_LABELS[tab]}</h2><p>{tab === 'active' ? '현재 확인하거나 처리를 기다리는 요청만 표시합니다.' : '최종 처리가 끝난 요청을 최근 처리일시 순으로 표시합니다.'}</p></div>
                    <div className={styles.requestHeadingActions}><button type="button" onClick={() => accessToken && void loadWorkspace(accessToken)}>목록 새로고침</button><label className={styles.pageSize}><span>페이지당</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value) === 50 ? 50 : 20); setPage(1); }}><option value="20">20건</option><option value="50">50건</option></select></label></div>
                  </div>
                  <form className={styles.requestFilters} onSubmit={(event) => { event.preventDefault(); setRequestQuery(requestQueryDraft); setPage(1); }}>
                    <label className={styles.searchField}><span>요청 검색</span><div><input type="search" value={requestQueryDraft} placeholder="출처 또는 목적지 사업명" onChange={(event) => setRequestQueryDraft(event.target.value)} /><button type="submit">검색</button>{requestQueryDraft && <button type="button" onClick={() => { setRequestQueryDraft(''); setRequestQuery(''); setPage(1); }}>지우기</button>}</div></label>
                    <label><span>상태</span><select value={requestStatus} onChange={(event) => { setRequestStatus(event.target.value); setPage(1); }}><option value="">전체</option>{tab === 'active' ? <><option value="pending">처리대기</option><option value="rejected">과거 반려·보완</option><option value="DRAFT">임시저장</option><option value="SUBMITTED">직접 처리 재시도</option><option value="APPROVED">과거 승인·반영 재시도</option></> : <><option value="APPLIED">처리완료</option><option value="CANCELLED">취소완료</option><option value="DUPLICATE">중복 종료</option></>}</select></label>
                    <label><span>연도</span><select value={requestYear} onChange={(event) => { setRequestYear(event.target.value); setPage(1); }}><option value="">전체</option>{requestYears.map((year) => <option value={year} key={year}>{year}년</option>)}</select></label>
                  </form>
                  {filteredRequests.length === 0 ? <div className={styles.empty} role="status"><strong>{tab === 'active' ? '진행 중인 요청이 없습니다.' : '완료된 요청이 없습니다.'}</strong><span>검색어나 상태·연도 필터를 변경해 보세요.</span></div> : <>
                    <div className={`${styles.tableWrap} ${styles.requestTableWrap}`}><table className={styles.requestTable}><thead><tr><th>요청일시</th>{tab === 'completed' && <th>처리일시</th>}<th>요청 유형</th><th>출처</th><th>목적지</th><th className={styles.number}>요청금액</th><th>현재 단계</th><th>상태</th><th>보완·반려 사유</th><th>작업</th></tr></thead><tbody>{visibleRequestPage.items.map((request) => <tr key={`${request.kind}:${request.id}`}><td>{formatDate(request.requested_at, true)}</td>{tab === 'completed' && <td>{formatDate(request.processed_at, true)}</td>}<td>{request.kind === 'BUDGET_CHANGE' ? '예산조정' : request.kind === 'NEW_PROJECT' ? '신규사업' : '예정재원 연결'}</td><td>{sanitizeProjectNameForDisplay(request.source_label, request.fiscal_year)}</td><td>{sanitizeProjectNameForDisplay(request.destination_label, request.fiscal_year)}</td><td className={styles.number}>{formatWon(request.amount)}</td><td>{request.stage}</td><td><span className={`${styles.requestStatus} ${requestTone(request.status)}`}>{requestStatusLabel(request.status)}</span></td><td>{request.rejection_reason ?? '해당 없음'}</td><td><div className={styles.rowActions}>{request.can_edit && request.detail_href && <button type="button" onClick={() => router.push(request.detail_href!)}>보완</button>}<button type="button" onClick={() => setSelectedRequest(request)}>상세보기</button></div></td></tr>)}</tbody></table></div>
                    <div className={styles.requestMobileCards}>{visibleRequestPage.items.map((request) => (
                      <article key={`${request.kind}:${request.id}`}>
                        <div>
                          <span>{request.kind === 'BUDGET_CHANGE' ? '예산조정' : request.kind === 'NEW_PROJECT' ? '신규사업' : '예정재원 연결'}</span>
                          <span className={`${styles.requestStatus} ${requestTone(request.status)}`}>{requestStatusLabel(request.status)}</span>
                        </div>
                        <h3>{sanitizeProjectNameForDisplay(request.destination_label, request.fiscal_year)}</h3>
                        <dl>
                          <div><dt>요청일시</dt><dd>{formatDate(request.requested_at, true)}</dd></div>
                          {tab === 'completed' && <div><dt>처리일시</dt><dd>{formatDate(request.processed_at, true)}</dd></div>}
                          <div><dt>출처</dt><dd>{sanitizeProjectNameForDisplay(request.source_label, request.fiscal_year)}</dd></div>
                          <div><dt>요청금액</dt><dd>{formatWon(request.amount)}</dd></div>
                          <div><dt>현재 단계</dt><dd>{request.stage}</dd></div>
                        </dl>
                        {request.rejection_reason && <p><strong>보완·반려 사유</strong>{request.rejection_reason}</p>}
                        <div className={styles.mobileRequestActions}>
                          {request.can_edit && request.detail_href && <button type="button" onClick={() => router.push(request.detail_href!)}>보완</button>}
                          <button type="button" onClick={() => setSelectedRequest(request)}>상세보기</button>
                        </div>
                      </article>
                    ))}</div>
                    <Pagination {...visibleRequestPage} onPage={setPage} />
                  </>}

                  {selectedRequest && (
                    <aside className={styles.requestDetail} aria-labelledby="request-detail-title">
                      <div><div><p>{selectedRequest.kind === 'BUDGET_CHANGE' ? '예산조정' : selectedRequest.kind === 'NEW_PROJECT' ? '신규사업' : '예정재원 연결'}</p><h3 id="request-detail-title">요청 처리 흐름</h3></div><button type="button" onClick={() => setSelectedRequest(null)}>닫기</button></div>
                      <dl><div><dt>출처</dt><dd>{sanitizeProjectNameForDisplay(selectedRequest.source_label, selectedRequest.fiscal_year)}</dd></div><div><dt>목적지</dt><dd>{sanitizeProjectNameForDisplay(selectedRequest.destination_label, selectedRequest.fiscal_year)}</dd></div><div><dt>금액</dt><dd>{formatWon(selectedRequest.amount)}</dd></div><div><dt>현재 단계</dt><dd>{selectedRequest.stage}</dd></div></dl>
                      <ol>{selectedRequest.steps.map((step) => <li key={step.key} className={styles[step.state]}><i aria-hidden="true" /><div><strong>{step.label}</strong><span>{step.occurred_at ? formatDate(step.occurred_at, true) : step.state === 'current' ? '현재 단계' : '시간 정보 없음'}</span></div></li>)}</ol>
                      {selectedRequest.rejection_reason && <p className={styles.rejection}><strong>보완·반려 사유</strong>{selectedRequest.rejection_reason}</p>}
                      {selectedRequest.raw_row_count > 1 && <small>기존 관계 식별자로 연결된 기술적 요청 {selectedRequest.raw_row_count}건을 하나의 업무 흐름으로 표시했습니다.</small>}
                      {selectedRequest.detail_href && <button type="button" className={styles.primaryButton} onClick={() => router.push(selectedRequest.detail_href!)}>관련 사업에서 자세히 보기</button>}
                    </aside>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </main>
      {deleteDraft && accessToken && <NewProjectDeleteDialog
        accessToken={accessToken}
        targetKind="DRAFT"
        targetId={deleteDraft.id}
        fallbackName={deleteDraft.name}
        fallbackYear={deleteDraft.year}
        onCancel={() => setDeleteDraft(null)}
        onDeleted={async () => {
          setDeleteDraft(null);
          await loadWorkspace(accessToken);
        }}
      />}
    </div>
  );
}
