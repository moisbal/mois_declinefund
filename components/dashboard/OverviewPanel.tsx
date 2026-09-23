"use client";

import { useEffect, useState } from 'react';
import { getProjectSummaryForUser } from '../../lib/projects';
import type { UserProfile } from '../../lib/auth';
import { formatIntegerString, formatWonAsManwonWithUnit } from '../../lib/amountFormat';
import { getCurrentSession } from '../../lib/auth';
import { getAdminBudgetChangeDashboardAction } from '../../app/my-projects/budget-change-actions';
import { formatUserFacingError } from '../../lib/presentationLabels';
import { EmptyState, ErrorState } from '../common/WorkUi';

type OverviewPanelProps = {
  profile: UserProfile;
  refreshVersion?: number;
};

type SummaryState = {
  projectCount: number;
  totalBudgetSum: string;
  allocSum: string;
  execSum: string;
  overallRate: number;
};

export default function OverviewPanel({ profile, refreshVersion = 0 }: OverviewPanelProps) {
  const [summary, setSummary] = useState<SummaryState>({
    projectCount: 0,
    totalBudgetSum: '0',
    allocSum: '0',
    execSum: '0',
    overallRate: 0,
  });
  const [loading, setLoading] = useState(true);
  const [pendingNewProjectAmount, setPendingNewProjectAmount] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    const loadSummary = async () => {
      setLoading(true);
      setError(null);
      try {
        const [data, session] = await Promise.all([getProjectSummaryForUser(), getCurrentSession()]);
        setSummary(data);
        const token = session.data.session?.access_token;
        if (token && profile.role === 'admin' && process.env.NEXT_PUBLIC_FINANCIAL_LEDGER_UI === 'true') {
          const budgetChanges = await getAdminBudgetChangeDashboardAction({ accessToken: token });
          if ('error' in budgetChanges) throw new Error(budgetChanges.error);
          setPendingNewProjectAmount(budgetChanges.data.statistics.pending_new_project_amount);
        }
      } catch (err) {
        setError(formatUserFacingError(err, '데이터를 불러오는 중 오류가 발생했습니다.'));
      } finally {
        setLoading(false);
      }
    };
    loadSummary();
  }, [profile, refreshVersion, retryVersion]);

  if (loading) {
    return <div className="panel">데이터 로딩 중...</div>;
  }

  if (error) {
    return <section className="panel">
      <ErrorState>
        <strong>{error}</strong>
        <button type="button" className="small-btn" onClick={() => setRetryVersion((current) => current + 1)}>
          다시 시도
        </button>
      </ErrorState>
    </section>;
  }

  if (summary.projectCount === 0) {
    return <section className="panel"><EmptyState title="조회된 공식 사업이 없습니다." description="현재 권한과 조회 기준에 해당하는 공식 사업이 없습니다. 신규사업 초안은 별도 목록에서 확인해 주세요." /></section>;
  }

  return (
    <section className="tab-panel active" id="tab-overview">
      <div className="overview-heading">
        <div className="banner-title">{profile.role === 'local_user' ? `${profile.region_name ?? '내 지역'} 기금 집행 개요` : '전국 기금 집행 개요'}</div>
        <div className="banner-sub">로그인 권한 범위의 기금 배분·집행 데이터</div>
      </div>
      <div className={`kpi-grid${profile.role === 'admin' ? ' admin-kpi-grid' : ''}`}>
        <div className="kpi-card">
          <div className="kpi-label">사업 개수</div>
          <div className="kpi-value">{summary.projectCount.toLocaleString()}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">총 배분액(만원)</div>
          <div
            className="kpi-value kpi-money-value"
            title={`${formatIntegerString(summary.allocSum)}원`}
          >
            {formatWonAsManwonWithUnit(summary.allocSum)}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">집행액(만원)</div>
          <div
            className="kpi-value kpi-money-value"
            title={`${formatIntegerString(summary.execSum)}원`}
          >
            {formatWonAsManwonWithUnit(summary.execSum)}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">미집행액(만원)</div>
          <div
            className="kpi-value kpi-money-value"
            title={`${formatIntegerString((BigInt(summary.allocSum) - BigInt(summary.execSum)).toString())}원`}
          >
            {formatWonAsManwonWithUnit((BigInt(summary.allocSum) - BigInt(summary.execSum)).toString())}
          </div>
        </div>
        <div className="kpi-card">
          <div
            className="kpi-label"
            title="전체 사업의 집행액 합계 ÷ 조정 후 배분액 합계 × 100"
          >전체 집행률 ⓘ</div>
          <div className="kpi-value">{summary.overallRate.toFixed(1)}%</div>
        </div>
        {profile.role === 'admin' && pendingNewProjectAmount !== null && <div className="kpi-card">
          <div className="kpi-label">사업변경 예정재원(만원)</div>
          <div className="kpi-value kpi-money-value" title={`${formatIntegerString(pendingNewProjectAmount)}원`}>
            {formatWonAsManwonWithUnit(pendingNewProjectAmount)}
          </div>
        </div>}
      </div>
      <p className="overview-supporting-metric">
        참고 지표 · 사업 총사업비 {formatWonAsManwonWithUnit(summary.totalBudgetSum)}
      </p>
    </section>
  );
}
