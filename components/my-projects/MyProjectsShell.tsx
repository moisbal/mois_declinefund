"use client";

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Header from '../common/Header';
import { getCurrentSession, getCurrentUserProfile, type UserProfile } from '../../lib/auth';
import { formatIntegerString, formatWonAsManwonWithUnit } from '../../lib/amountFormat';
import {
  getMyProjectDisplayName,
  getMyProjects,
  getProjectAllocationMode,
  getProjectLifecycleLabel,
  type MyProjectListItem,
} from '../../lib/myProjects';
import { formatStoredUserText, formatSystemTerm, formatUserFacingError } from '../../lib/presentationLabels';
import MyProjectsOverview from './MyProjectsOverview';
import NewProjectRequestPanel from './NewProjectRequestPanel';
import { EmptyState, ErrorState, PageHeader, StatusBadge } from '../common/WorkUi';

function formatRate(value: number | null) {
  return `${(value ?? 0).toFixed(1)}%`;
}

function getStatusClass(status: string | null) {
  if (status === '완료') return 'complete';
  if (status === '지연' || status === '추진곤란') return 'warning';
  return 'normal';
}

export default function MyProjectsShell() {
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [projects, setProjects] = useState<MyProjectListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [year, setYear] = useState<number | undefined>();
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const fundingManagementEnabled = process.env.NEXT_PUBLIC_FINANCIAL_LEDGER_UI === 'true';

  useEffect(() => {
    const initialize = async () => {
      const sessionResult = await getCurrentSession();
      if (!sessionResult.data.session?.user) {
        router.replace('/');
        return;
      }
      try {
        const profileData = await getCurrentUserProfile();
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
        setProfile(profileData);
        setProjects(await getMyProjects(profileData));
      } catch (loadError) {
        setError(formatUserFacingError(loadError, '내 사업 목록을 불러오지 못했습니다.'));
      } finally {
        setLoading(false);
      }
    };
    void initialize();
  }, [router]);

  const years = useMemo(() => Array.from(new Set(projects.map((project) => project.year).filter(
    (value): value is number => value !== null,
  ))).sort((left, right) => right - left), [projects]);
  const statuses = useMemo(() => Array.from(new Set(projects.map((project) => project.status).filter(
    (value): value is string => Boolean(value),
  ))).sort(), [projects]);
  const filteredProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('ko-KR');
    return projects.filter((project) => (
      (!year || project.year === year)
      && (!status || project.status === status)
      && (!normalizedQuery || [project.project_code, getMyProjectDisplayName(project)].some(
        (value) => value?.toLocaleLowerCase('ko-KR').includes(normalizedQuery),
      ))
    ));
  }, [projects, query, status, year]);

  if (loading) {
    return <div className="loading-shell">내 사업 목록을 불러오는 중입니다...</div>;
  }
  if (!profile) {
    return <div className="loading-shell">접근 권한을 확인하는 중입니다...</div>;
  }

  return (
    <div className="dashboard-shell my-projects-shell">
      <Header title="내 사업 관리" />
      <main>
        <PageHeader
          eyebrow={`${profile.region_name ?? '내 지역'} 담당 업무`}
          title="내 사업 목록"
          description="담당 사업의 추진상태와 예산·집행 현황을 확인하고 필요한 정보를 수정합니다."
          meta={<StatusBadge label={`전체 ${projects.length}건`} tone="info" />}
        />

        <MyProjectsOverview projects={projects} regionName={profile.region_name} />

        {fundingManagementEnabled && <NewProjectRequestPanel profile={profile} />}

        <section className="my-project-list-panel">
          <div className="my-project-list-filters">
            <label>
              <span>사업연도</span>
              <select value={year ?? ''} onChange={(event) => setYear(Number(event.target.value) || undefined)}>
                <option value="">전체</option>
                {years.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label>
              <span>집행상태</span>
              <select value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="">전체</option>
                {statuses.map((item) => <option key={item} value={item}>{formatSystemTerm(item)}</option>)}
              </select>
            </label>
            <label className="my-project-search-field">
              <span>사업명 검색</span>
              <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="사업명" />
            </label>
          </div>

          {error && <ErrorState>{error}</ErrorState>}
          {!error && filteredProjects.length === 0 && <EmptyState title="조건에 맞는 사업이 없습니다." description="사업연도, 상태 또는 검색어를 다시 확인해 주세요." />}
          <div className="my-project-cards">
            {filteredProjects.map((project) => (
              <article key={project.id} className="my-project-card">
                <div className="my-project-card-header">
                  <div>
                    <h2>{getMyProjectDisplayName(project)}</h2>
                  </div>
                  <span className={`my-project-status ${getStatusClass(project.status)}`}>{formatSystemTerm(project.status, '상태 미입력')}</span>
                </div>
                {(() => {
                  const allocation = getProjectAllocationMode(project);
                  return (
                    <dl>
                      <div><dt>사업기간</dt><dd>{project.project_period ?? project.period ?? '-'}</dd></div>
                      <div><dt>신규 / 계속</dt><dd>{getProjectLifecycleLabel(project)}</dd></div>
                      <div><dt>집행상태</dt><dd>{formatSystemTerm(project.status, '상태 미입력')}</dd></div>
                      {(project.status === '지연' || project.status === '추진곤란') && (
                        <div><dt>{formatSystemTerm(project.status)} 사유</dt><dd>{formatStoredUserText(project.execution_status_reason, '사유 미입력')}</dd></div>
                      )}
                      <div><dt>배분 기준</dt><dd>{allocation.mode}</dd></div>
                      <div><dt>{allocation.amountLabel}</dt><dd title={`${formatIntegerString(project.alloc_text ?? '0')}원`}>{formatWonAsManwonWithUnit(project.alloc_text ?? '0')}</dd></div>
                      <div><dt>집행액</dt><dd title={`${formatIntegerString(project.exec_text ?? '0')}원`}>{formatWonAsManwonWithUnit(project.exec_text ?? '0')}</dd></div>
                      <div><dt>집행률</dt><dd>{formatRate(project.rate)}</dd></div>
                    </dl>
                  );
                })()}
                <button type="button" className="my-project-edit-button" onClick={() => router.push(`/my-projects/${project.id}/edit`)}>
                  수정
                </button>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
