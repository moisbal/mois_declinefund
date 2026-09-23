"use client";

import { useEffect, useMemo, useState } from 'react';
import { getCurrentSession, type UserProfile } from '../../lib/auth';
import { getProjectFundingPositionAction } from '../../app/my-projects/funding-actions';
import { formatIntegerString, formatWonWithUnit } from '../../lib/amountFormat';
import { calculateProjectBudget } from '../../lib/myProjectEdit';
import { toRelatedProjectDrafts } from '../../lib/myProjects';
import { formatStoredUserText, formatSystemTerm, formatUserFacingError, getProjectPresentation, sanitizeClassificationNameForDisplay, sanitizeProjectNameForDisplay } from '../../lib/presentationLabels';
import {
  BUSINESS_TYPE_LABELS,
  type ProjectCategoryMaster,
  type ProjectClassificationDraft,
} from '../../lib/projectClassification';
import { getProjectCategoryMaster, getProjectClassification } from '../../lib/projects';
import {
  getProjectReviewDetail,
  type ProjectReviewDetail,
  type ProjectReviewRelatedProject,
} from '../../lib/projectReview';
import ProjectRelatedProjectsSection from '../my-projects/ProjectRelatedProjectsSection';
import type { FundingCohortSummary, ProjectFundingPosition } from '../../lib/fundingManagement';

type ProjectReviewDetailPanelProps = {
  profile: UserProfile;
  projectId: string;
  refreshVersion?: number;
};

type LoadedReview = {
  project: ProjectReviewDetail;
  relatedProjects: ProjectReviewRelatedProject[];
  classification: ProjectClassificationDraft;
  master: ProjectCategoryMaster;
  fundingPosition: ProjectFundingPosition | null;
  fundingCohorts: FundingCohortSummary[];
};

function displayText(value: string | number | null | undefined) {
  return value === null || value === undefined || String(value).trim() === '' ? '-' : String(value);
}

function displayWon(value: string | null | undefined) {
  const raw = value ?? '0';
  return <span className="amount-display" title={`${formatIntegerString(raw)}원`}>{formatWonWithUnit(raw)}</span>;
}

export default function ProjectReviewDetailPanel({
  profile,
  projectId,
  refreshVersion = 0,
}: ProjectReviewDetailPanelProps) {
  const [loaded, setLoaded] = useState<LoadedReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manualRefreshVersion, setManualRefreshVersion] = useState(0);

  useEffect(() => {
    let active = true;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const session = await getCurrentSession();
        const accessToken = session.data.session?.access_token;
        if (!accessToken) throw new Error('로그인 세션을 확인하지 못했습니다.');
        const [detail, classification, master, funding] = await Promise.all([
          getProjectReviewDetail(profile, projectId),
          getProjectClassification(projectId),
          getProjectCategoryMaster(),
          getProjectFundingPositionAction({ accessToken, projectId }),
        ]);
        if ('error' in funding) throw new Error(funding.error);
        if (active) {
          setLoaded({ ...detail, classification, master, fundingPosition: funding.data.position, fundingCohorts: funding.data.cohorts });
        }
      } catch (loadError) {
        if (active) {
          setLoaded(null);
          setError(formatUserFacingError(loadError, '관리자 검수 정보를 불러오지 못했습니다.'));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      active = false;
    };
  }, [manualRefreshVersion, profile, projectId, refreshVersion]);

  useEffect(() => {
    const refreshOnPageShow = () => setManualRefreshVersion((current) => current + 1);
    const refreshOnVisibility = () => {
      if (document.visibilityState === 'visible') {
        refreshOnPageShow();
      }
    };

    window.addEventListener('pageshow', refreshOnPageShow);
    document.addEventListener('visibilitychange', refreshOnVisibility);
    return () => {
      window.removeEventListener('pageshow', refreshOnPageShow);
      document.removeEventListener('visibilitychange', refreshOnVisibility);
    };
  }, []);

  const classificationLabels = useMemo(() => {
    if (!loaded) {
      return { large: '-', middle: '-', small: [] as string[] };
    }
    const selectedSmallIds = new Set(loaded.classification.smallCategoryIds);
    return {
      large: sanitizeClassificationNameForDisplay(loaded.master.largeCategories.find((item) => item.id === loaded.classification.largeCategoryId)?.name, '-'),
      middle: sanitizeClassificationNameForDisplay(loaded.master.middleCategories.find((item) => item.id === loaded.classification.middleCategoryId)?.name, '-'),
      small: [
        ...loaded.master.smallCategories
          .filter((item) => selectedSmallIds.has(item.id))
          .map((item) => sanitizeClassificationNameForDisplay(item.name)),
        ...loaded.classification.customSmallCategories.map((item) => `직접 입력: ${sanitizeClassificationNameForDisplay(item.inputValue)}`),
      ],
    };
  }, [loaded]);

  if (loading && !loaded) {
    return <div className="panel">관리자 검수 정보를 최신 시스템에서 불러오는 중입니다...</div>;
  }
  if (error || !loaded) {
    return <div className="panel error-message">{error || '사업 검수 정보를 찾을 수 없습니다.'}</div>;
  }

  const { project, relatedProjects } = loaded;
  const ledgerPosition = loaded.fundingPosition?.projection_ready ? loaded.fundingPosition : null;
  const budget = calculateProjectBudget({
    originalAlloc: ledgerPosition?.ledger_original_allocation ?? project.original_alloc_text ?? project.alloc_text ?? '0',
    increaseAmount: ledgerPosition?.ledger_increase_amount ?? project.increase_amount_text ?? '0',
    decreaseAmount: ledgerPosition?.ledger_decrease_amount ?? project.decrease_amount_text ?? '0',
    exec: ledgerPosition?.ledger_execution_amount ?? project.exec_text ?? '0',
  });
  const relatedDrafts = toRelatedProjectDrafts(relatedProjects);
  const rawDisplayName = project.detail_project_name?.trim()
    || project.fund_project_name?.trim()
    || project.project_name?.trim()
    || '-';
  const presentation = getProjectPresentation({
    fiscal_year: project.year,
    project_name: rawDisplayName,
    project_code: project.project_code,
    status: project.status,
  });
  const displayName = presentation.name;

  return (
    <section className="panel admin-project-review" aria-labelledby="admin-project-review-title">
      <div className="admin-project-review-heading">
        <div>
          <div className="section-title" id="admin-project-review-title">관리자 사업 검수</div>
          <p className="panel-sub">
            {displayName} · 마지막 저장 {project.updated_at ? new Date(project.updated_at).toLocaleString('ko-KR') : '-'}
          </p>
        </div>
        <button
          type="button"
          className="small-btn"
          onClick={() => setManualRefreshVersion((current) => current + 1)}
          disabled={loading}
        >
          {loading ? '재조회 중...' : '최신값 다시 조회'}
        </button>
      </div>

      <div className="admin-project-review-grid">
        <section className="admin-project-review-card">
          <h3>기본 사업정보</h3>
          <dl>
            <div><dt>지역</dt><dd>{[project.sido, project.sigungu].filter(Boolean).join(' ') || '-'}</dd></div>
            <div><dt>사업연도</dt><dd>{displayText(project.year)}</dd></div>
            <div><dt>세부사업명</dt><dd>{project.detail_project_name ? sanitizeProjectNameForDisplay(project.detail_project_name, project.year) : '-'}</dd></div>
            <div><dt>기금사업명</dt><dd>{project.fund_project_name ? sanitizeProjectNameForDisplay(project.fund_project_name, project.year) : '-'}</dd></div>
            <div><dt>원자료 사업명</dt><dd>{project.project_name ? sanitizeProjectNameForDisplay(project.project_name, project.year) : '-'}</dd></div>
            <div><dt>사업기간</dt><dd>{displayText(project.project_period ?? project.period)}</dd></div>
            <div><dt>사업 시작연도</dt><dd>{displayText(project.project_start_year)}</dd></div>
            <div><dt>집행상태</dt><dd>{formatSystemTerm(project.status)}</dd></div>
            {(project.status === '지연' || project.status === '추진곤란') && (
              <div><dt>{formatSystemTerm(project.status)} 사유</dt><dd>{formatStoredUserText(project.execution_status_reason, '사유 미입력')}</dd></div>
            )}
            <div><dt>원자료 사업구분</dt><dd>{displayText(project.project_type)}</dd></div>
          </dl>
        </section>

        <section className="admin-project-review-card">
          <h3>분류정보 및 수행방식</h3>
          <dl>
            <div><dt>기존 대분류</dt><dd>{displayText(project.category)}</dd></div>
            <div><dt>대분류</dt><dd>{classificationLabels.large}</dd></div>
            <div><dt>중분류</dt><dd>{classificationLabels.middle}</dd></div>
            <div><dt>소분류</dt><dd>{classificationLabels.small.length ? classificationLabels.small.join(', ') : '-'}</dd></div>
            <div><dt>사업유형</dt><dd>{project.business_type ? BUSINESS_TYPE_LABELS[project.business_type] : '-'}</dd></div>
          </dl>
        </section>
      </div>

      <section className="admin-project-review-card admin-project-review-budget">
        <h3>예산 및 집행</h3>
        {loaded.fundingPosition && !loaded.fundingPosition.projection_ready && <div className="funding-warning"><strong>재원처리 미확인</strong><span>미분류 감액 {formatWonWithUnit(loaded.fundingPosition.unclassified_decrease_amount)} — 확정 전에는 기존 사업값을 표시합니다.</span></div>}
        <dl>
          <div><dt>총사업비</dt><dd>{displayWon(project.total_budget_text)}</dd></div>
          <div><dt>당초 배분액</dt><dd>{displayWon(ledgerPosition?.ledger_original_allocation ?? project.original_alloc_text ?? project.alloc_text)}</dd></div>
          <div><dt>증액액</dt><dd>{displayWon(ledgerPosition?.ledger_increase_amount ?? project.increase_amount_text)}</dd></div>
          <div><dt>감액액</dt><dd>{displayWon(ledgerPosition?.ledger_decrease_amount ?? project.decrease_amount_text)}</dd></div>
          <div><dt>조정 후 배분액</dt><dd>{displayWon(ledgerPosition?.ledger_adjusted_allocation ?? project.alloc_text ?? budget.adjustedAlloc.toString())}</dd></div>
          <div><dt>집행액</dt><dd>{displayWon(ledgerPosition?.ledger_execution_amount ?? project.exec_text)}</dd></div>
          <div><dt>미집행액</dt><dd>{displayWon(budget.balance.toString())}</dd></div>
          <div title="현재 사업 집행액 ÷ 원장 기준 조정 후 배분액"><dt>사업 현재 집행률</dt><dd>{Number(ledgerPosition?.ledger_execution_rate ?? project.rate ?? budget.rate).toFixed(2)}%</dd></div>
        </dl>
      </section>

      {loaded.fundingCohorts.length > 0 && <section className="admin-project-review-card"><h3>원재원 누적집행률</h3><dl>{loaded.fundingCohorts.map((cohort) => <div key={cohort.funding_reference_id} title="동일 원재원의 누적 확정집행 ÷ 최초배분"><dt>{cohort.origin_fiscal_year} 원재원</dt><dd>{cohort.execution_rate == null ? '검수 중' : `${Number(cohort.execution_rate).toFixed(2)}%`} · 최초배분 {formatWonWithUnit(cohort.initial_allocation)}</dd></div>)}</dl></section>}

      <ProjectRelatedProjectsSection
        readOnly
        rows={relatedDrafts}
        sectionNumber={4}
      />
    </section>
  );
}
