"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getCurrentSession, getCurrentUserProfile, UserProfile } from '../../lib/auth';
import Header from '../common/Header';
import OverviewPanel from './OverviewPanel';
import ProjectTable from './ProjectTable';
import ChangeLogPanel from './ChangeLogPanel';
import ProjectReviewDetailPanel from '../admin/ProjectReviewDetailPanel';
import { PageHeader, StatusBadge } from '../common/WorkUi';

export default function DashboardShell() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedProjectCode, setSelectedProjectCode] = useState<string | null>(null);
  const [projectRefreshVersion, setProjectRefreshVersion] = useState(0);

  useEffect(() => {
    const initialize = async () => {
      const sessionResult = await getCurrentSession();
      const session = sessionResult.data.session;
      if (!session?.user) {
        router.push('/');
        return;
      }

      try {
        const profileData = await getCurrentUserProfile();
        if (!profileData) {
          router.push('/');
          return;
        }
        if (profileData.first_login) {
          router.push('/password-reset');
          return;
        }
        setProfile(profileData);
      } catch (error) {
        console.error('프로필 조회 오류', error);
        router.push('/');
      } finally {
        setLoading(false);
      }
    };

    initialize();
  }, [router]);

  useEffect(() => {
    const refreshLatestValues = () => setProjectRefreshVersion((current) => current + 1);
    const refreshOnVisibility = () => {
      if (document.visibilityState === 'visible') refreshLatestValues();
    };

    window.addEventListener('pageshow', refreshLatestValues);
    document.addEventListener('visibilitychange', refreshOnVisibility);
    return () => {
      window.removeEventListener('pageshow', refreshLatestValues);
      document.removeEventListener('visibilitychange', refreshOnVisibility);
    };
  }, []);

  if (loading) {
    return <div className="loading-shell">로딩 중...</div>;
  }

  if (!profile) {
    return <div className="loading-shell">사용자 정보를 불러오는 중입니다...</div>;
  }

  return (
    <div className="dashboard-shell">
      <Header />
      <main>
        <PageHeader
          eyebrow={profile.role === 'admin' ? '관리자 업무 현황' : `${profile.region_name ?? '지자체'} 업무 현황`}
          title="사업 현황 대시보드"
          description="핵심 지표를 확인하고 사업 목록에서 상세 검토 대상을 선택합니다."
          meta={<StatusBadge label={profile.role === 'admin' ? '전체 지역' : '담당 지역'} tone="info" />}
          compact
        />
        <OverviewPanel profile={profile} refreshVersion={projectRefreshVersion} />
        <ProjectTable
          profile={profile}
          selectedProjectId={selectedProjectId}
          onSelectProject={(projectId, projectCode) => {
            setSelectedProjectId(projectId);
            setSelectedProjectCode(projectCode);
          }}
          onProjectSaved={() => setProjectRefreshVersion((current) => current + 1)}
          refreshVersion={projectRefreshVersion}
        />
        {profile.role === 'admin' && selectedProjectId && (
          <ProjectReviewDetailPanel
            profile={profile}
            projectId={selectedProjectId}
            refreshVersion={projectRefreshVersion}
          />
        )}
        <ChangeLogPanel
          profile={profile}
          projectId={selectedProjectId ?? undefined}
          projectCode={selectedProjectCode ?? undefined}
          refreshVersion={projectRefreshVersion}
        />
      </main>
    </div>
  );
}
