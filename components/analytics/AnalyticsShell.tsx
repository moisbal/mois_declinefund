"use client";

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import Header from '../common/Header';
import { PageHeader, StatusBadge } from '../common/WorkUi';
import DemoNavigation from '../demo/DemoNavigation';
import { getCurrentSession, getCurrentUserProfile, type UserProfile } from '../../lib/auth';
import { formatIntegerString, formatWonAsManwonWithUnit } from '../../lib/amountFormat';
import { analyticsFiltersToSearchParams, DEFAULT_ANALYTICS_FILTERS, parseAnalyticsFilters } from '../../lib/analytics/filters';
import type { AnalyticsFilters, AnalyticsResult, AnalyticsRow } from '../../lib/analytics/types';
import { getDemoAnalyticsResult } from '../../lib/demo/data';
import type { FundingAnalyticsResult } from '../../lib/fundingAnalytics';
import type { BudgetChangeStatistics } from '../../lib/budgetChanges';
import { BUSINESS_TYPE_LABELS, isBusinessType } from '../../lib/projectClassification';
import {
  formatSystemTerm,
  formatUserFacingError,
  getProjectPresentation,
  sanitizeClassificationNameForDisplay,
} from '../../lib/presentationLabels';
import FundingAnalyticsPanel from './FundingAnalyticsPanel';

function analyticsProjectName(row: AnalyticsRow) {
  if (!row.projectId) return row.projectName ?? row.label;
  const presentation = getProjectPresentation({
    fiscal_year: row.year,
    project_name: row.projectName ?? row.label,
    project_code: row.projectCode,
    status: row.status,
  });
  return presentation.name;
}

const GROUP_LABELS: Record<AnalyticsFilters['groupBy'], string> = {
  national: '전국',
  sido: '시도',
  sigungu: '시군구',
  project: '사업',
};

function rateText(value: number | null) {
  return value === null ? '자료 없음' : `${value.toFixed(1)}%`;
}

function amountText(value: string | null) {
  return value === null ? '자료 없음' : formatWonAsManwonWithUnit(value);
}

function businessTypeText(value: string | null | undefined) {
  return value && isBusinessType(value) ? BUSINESS_TYPE_LABELS[value] : value ? '사업유형 확인 필요' : '-';
}

function sourceBadgeText(source: AnalyticsResult['source']) {
  if (source === 'current_projects') return '현재 최신 저장값';
  if (source === 'historical_unavailable') return '과거자료 없음';
  if (source === 'legacy_snapshot') return '과거자료 기준시점';
  return '재정원장 2단계';
}

function analyticsRequestUrl(filters: AnalyticsFilters, csv = false) {
  const params = analyticsFiltersToSearchParams(filters);
  if (csv) params.set('format', 'csv');
  return `/api/analytics?${params.toString()}`;
}

type AnalyticsShellProps = {
  mode?: 'production' | 'demo';
};

type AnalyticsResponse = AnalyticsResult & {
  funding?: FundingAnalyticsResult | null;
  budgetChangeStatistics?: BudgetChangeStatistics | null;
};

type SortKey = 'label' | 'projectCount' | 'adjustedAllocation' | 'cumulativeExecution' | 'unexecutedAmount' | 'executionRate';

const DEMO_PRESETS: Array<{ label: string; filters: Partial<AnalyticsFilters> }> = [
  { label: '집행률 50% 미만 사업', filters: { groupBy: 'project', rateBand: 'below50' } },
  { label: '시도별 집행현황', filters: { groupBy: 'sido' } },
  { label: '산업·일자리 분야', filters: { groupBy: 'project', largeCategoryId: 'industry' } },
  { label: '시설 중심 사업 현황', filters: { groupBy: 'project', businessType: 'HW' } },
];

function compareRows(left: AnalyticsRow, right: AnalyticsRow, key: SortKey) {
  if (key === 'label') return left.label.localeCompare(right.label, 'ko-KR');
  if (key === 'executionRate') return (left.executionRate ?? -1) - (right.executionRate ?? -1);
  if (key === 'projectCount') return left.projectCount - right.projectCount;
  return BigInt(left[key]) === BigInt(right[key]) ? 0 : BigInt(left[key]) > BigInt(right[key]) ? 1 : -1;
}

function csvCell(value: string | number | null | undefined) {
  return `"${String(value ?? '자료 없음').replace(/"/g, '""')}"`;
}

function downloadDemoCsv(result: AnalyticsResult, filters: AnalyticsFilters) {
  const rows = result.rows;
  const header = filters.groupBy === 'project'
    ? ['연도', '시도', '시군구', '사업명', '대분류', '중분류', '사업유형', '사업수', '조정후배분액(원)', '누적집행액(원)', '미집행액(원)', '집행률(%)']
    : ['구분', '사업수', '조정후배분액(원)', '누적집행액(원)', '미집행액(원)', '집행률(%)'];
  const body = rows.map((row) => (filters.groupBy === 'project'
    ? [row.year, row.sido, row.sigungu, analyticsProjectName(row), sanitizeClassificationNameForDisplay(row.largeCategoryName, '-'), sanitizeClassificationNameForDisplay(row.middleCategoryName, '-'), businessTypeText(row.businessType), row.projectCount, row.adjustedAllocation, row.cumulativeExecution, row.unexecutedAmount, row.executionRate?.toFixed(4)]
    : [row.label, row.projectCount, row.adjustedAllocation, row.cumulativeExecution, row.unexecutedAmount, row.executionRate?.toFixed(4)]
  ).map(csvCell).join(','));
  const blob = new Blob([`\uFEFF${[header.map(csvCell).join(','), ...body].join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `기금-분석-예시-${filters.asOf}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function AnalyticsShell({ mode = 'production' }: AnalyticsShellProps) {
  const isDemo = mode === 'demo';
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlFilters = useMemo(
    () => isDemo ? { ...DEFAULT_ANALYTICS_FILTERS } : parseAnalyticsFilters(new URLSearchParams(searchParams.toString())),
    [isDemo, searchParams],
  );
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [draft, setDraft] = useState<AnalyticsFilters>(urlFilters);
  const [demoFilters, setDemoFilters] = useState<AnalyticsFilters>({ ...DEFAULT_ANALYTICS_FILTERS });
  const [result, setResult] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'label', direction: 'asc' });
  const [refreshVersion, setRefreshVersion] = useState(0);
  const activeFilters = isDemo ? demoFilters : urlFilters;

  useEffect(() => {
    if (!isDemo) setDraft(urlFilters);
  }, [isDemo, urlFilters]);

  useEffect(() => {
    let active = true;
    const initialize = async () => {
      if (isDemo) {
        if (active) setLoading(false);
        return;
      }
      try {
        let sessionResult = await getCurrentSession();
        let session = sessionResult.data.session;
        let currentProfile = session?.user && session.access_token
          ? await getCurrentUserProfile()
          : null;
        if ((!session?.user || !session.access_token || !currentProfile) && active) {
          await new Promise((resolve) => window.setTimeout(resolve, 750));
          sessionResult = await getCurrentSession();
          session = sessionResult.data.session;
          currentProfile = session?.user && session.access_token
            ? await getCurrentUserProfile()
            : null;
        }
        if (!session?.user || !session.access_token) {
          router.replace('/');
          return;
        }
        if (!currentProfile) {
          router.replace('/');
          return;
        }
        if (currentProfile.first_login) {
          router.replace('/password-reset');
          return;
        }
        if (!active) return;
        setProfile(currentProfile);
        setAccessToken(session.access_token);
      } catch (loadError) {
        if (active) setError(formatUserFacingError(loadError, '로그인 정보를 확인하지 못했습니다.'));
      }
    };
    void initialize();
    return () => { active = false; };
  }, [isDemo, router]);

  useEffect(() => {
    if (!isDemo && !accessToken) return;
    let active = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        if (isDemo) {
          if (active) setResult(getDemoAnalyticsResult(activeFilters));
        } else {
          const response = await fetch(analyticsRequestUrl(activeFilters), {
            headers: { Authorization: `Bearer ${accessToken}` },
            cache: 'no-store',
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.message ?? '통계 데이터를 불러오지 못했습니다.');
          if (active) setResult(payload as AnalyticsResponse);
        }
      } catch (loadError) {
        if (active) {
          setResult(null);
          setError(formatUserFacingError(loadError, '통계 데이터를 불러오지 못했습니다.'));
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [accessToken, activeFilters, isDemo, refreshVersion]);

  useEffect(() => {
    if (isDemo) return undefined;
    const refreshLatestValues = () => setRefreshVersion((current) => current + 1);
    const refreshOnVisibility = () => {
      if (document.visibilityState === 'visible') refreshLatestValues();
    };

    window.addEventListener('pageshow', refreshLatestValues);
    document.addEventListener('visibilitychange', refreshOnVisibility);
    return () => {
      window.removeEventListener('pageshow', refreshLatestValues);
      document.removeEventListener('visibilitychange', refreshOnVisibility);
    };
  }, [isDemo]);

  const options = result?.options;
  const middleCategories = useMemo(() => (
    (options?.middleCategories ?? []).filter((category) => !draft.largeCategoryId || category.largeCategoryId === draft.largeCategoryId)
  ), [draft.largeCategoryId, options?.middleCategories]);
  const smallCategories = useMemo(() => (
    (options?.smallCategories ?? []).filter((category) => (
      (!draft.largeCategoryId || category.largeCategoryId === draft.largeCategoryId)
      && (!draft.middleCategoryId || category.middleCategoryId === draft.middleCategoryId)
    ))
  ), [draft.largeCategoryId, draft.middleCategoryId, options?.smallCategories]);
  const sigungus = draft.sido ? options?.sigungusBySido[draft.sido] ?? [] : [];

  const updateDraft = <K extends keyof AnalyticsFilters>(key: K, value: AnalyticsFilters[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const applyFilters = () => {
    if (isDemo) {
      setDemoFilters({ ...draft });
      setSort({ key: 'label', direction: 'asc' });
      return;
    }
    const params = analyticsFiltersToSearchParams(draft);
    router.push(`${pathname}?${params.toString()}`);
  };

  const resetFilters = () => {
    if (isDemo) {
      const reset = { ...DEFAULT_ANALYTICS_FILTERS };
      setDraft(reset);
      setDemoFilters(reset);
      setSort({ key: 'label', direction: 'asc' });
      return;
    }
    router.push('/analytics');
  };

  const drillDown = (row: AnalyticsRow) => {
    if (activeFilters.groupBy === 'project') return;
    const next: AnalyticsFilters = { ...activeFilters };
    if (activeFilters.groupBy === 'national') next.groupBy = 'sido';
    if (activeFilters.groupBy === 'sido') {
      next.sido = row.sido;
      next.sigungu = null;
      next.groupBy = 'sigungu';
    }
    if (activeFilters.groupBy === 'sigungu') {
      next.sido = row.sido;
      next.sigungu = row.sigungu;
      next.groupBy = 'project';
    }
    if (isDemo) {
      setDraft(next);
      setDemoFilters(next);
    } else {
      router.push(`${pathname}?${analyticsFiltersToSearchParams(next).toString()}`);
    }
  };

  const drillUp = () => {
    const next: AnalyticsFilters = { ...activeFilters };
    if (activeFilters.groupBy === 'project') {
      next.groupBy = 'sigungu';
      next.sigungu = null;
    } else if (activeFilters.groupBy === 'sigungu') {
      next.groupBy = 'sido';
      next.sido = null;
      next.sigungu = null;
    } else if (activeFilters.groupBy === 'sido') {
      next.groupBy = 'national';
    } else {
      return;
    }
    if (isDemo) {
      setDraft(next);
      setDemoFilters(next);
    } else {
      router.push(`${pathname}?${analyticsFiltersToSearchParams(next).toString()}`);
    }
  };

  const canDrillUp = activeFilters.groupBy !== 'national';

  const exportCsv = async () => {
    if (isDemo) {
      if (result) downloadDemoCsv(result, activeFilters);
      return;
    }
    if (!accessToken) return;
    setExporting(true);
    setError(null);
    try {
      const response = await fetch(analyticsRequestUrl(activeFilters, true), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.message ?? '분석 자료를 만들지 못했습니다.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `기금-분석-${activeFilters.asOf}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(formatUserFacingError(exportError, '통계 파일을 만들지 못했습니다.'));
    } finally {
      setExporting(false);
    }
  };

  const conditionSummary = useMemo(() => {
    const items = [activeFilters.timeBasis === 'current'
      ? '현재 시스템 최신 확정값'
      : `${activeFilters.asOf.replace(/-/g, '.')} 과거 기준`];
    if (activeFilters.year) items.push(`사업연도 ${activeFilters.year}`);
    if (activeFilters.sido) items.push(activeFilters.sido);
    if (activeFilters.sigungu) items.push(activeFilters.sigungu);
    if (activeFilters.largeCategoryId) items.push(sanitizeClassificationNameForDisplay(options?.largeCategories.find((item) => item.id === activeFilters.largeCategoryId)?.name, '대분류 확인 필요'));
    if (activeFilters.middleCategoryId) items.push(sanitizeClassificationNameForDisplay(options?.middleCategories.find((item) => item.id === activeFilters.middleCategoryId)?.name, '중분류 확인 필요'));
    if (activeFilters.smallCategoryId) items.push(sanitizeClassificationNameForDisplay(options?.smallCategories.find((item) => item.id === activeFilters.smallCategoryId)?.name, '소분류 확인 필요'));
    if (activeFilters.businessType) items.push(businessTypeText(activeFilters.businessType));
    if (activeFilters.rateBand === 'below50') items.push('집행률 50% 미만');
    if (activeFilters.allocationMin) items.push(`배분액 ${formatWonAsManwonWithUnit(activeFilters.allocationMin)} 이상`);
    if (activeFilters.allocationMax) items.push(`배분액 ${formatWonAsManwonWithUnit(activeFilters.allocationMax)} 이하`);
    return items.join(' · ');
  }, [activeFilters, options]);

  const sortedRows = useMemo(() => {
    if (!result) return [];
    return [...result.rows].sort((left, right) => compareRows(left, right, sort.key) * (sort.direction === 'asc' ? 1 : -1));
  }, [result, sort]);

  const regionDistribution = useMemo(() => {
    const buckets = new Map<string, { label: string; projectCount: number; amount: bigint }>();
    for (const row of result?.rows ?? []) {
      const label = [row.sido, row.sigungu].filter(Boolean).join(' ') || row.label || '지역 미분류';
      const current = buckets.get(label) ?? { label, projectCount: 0, amount: 0n };
      current.projectCount += row.projectCount;
      current.amount += BigInt(row.adjustedAllocation);
      buckets.set(label, current);
    }
    const values = [...buckets.values()].sort((left, right) => (
      left.amount === right.amount ? left.label.localeCompare(right.label, 'ko-KR') : left.amount > right.amount ? -1 : 1
    ));
    const maximum = values[0]?.amount ?? 0n;
    return values.slice(0, 20).map((value) => ({
      ...value,
      width: maximum > 0n ? Math.max(2, Number((value.amount * 1_000n) / maximum) / 10) : 0,
    }));
  }, [result]);

  const toggleSort = (key: SortKey) => setSort((current) => current.key === key
    ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
    : { key, direction: key === 'label' ? 'asc' : 'desc' });

  const sortHeading = (label: string, key: SortKey, numeric = true) => (
    <th className={numeric ? 'num' : undefined}>
      <button type="button" className="analytics-sort-button" onClick={() => toggleSort(key)}>
        {label}{sort.key === key ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  );

  if (!isDemo && !profile && !error) {
    return <div className="loading-shell">통계 화면 권한을 확인하는 중입니다...</div>;
  }

  return (
    <div className={`dashboard-shell${isDemo ? ' demo-shell' : ''}`}>
      {isDemo ? <DemoNavigation /> : <Header title="통계·요구자료" />}
      <main className="analytics-shell">
        {!isDemo && <PageHeader
          eyebrow="통계·요구자료"
          title="사업·재정 현황 분석"
          description="조회기준과 집계범위를 조합해 사업, 배분, 집행 현황을 비교합니다."
          meta={result ? <StatusBadge label={sourceBadgeText(result.source)} tone="info" /> : <StatusBadge label="조회조건 선택" />}
        />}
        {isDemo && <section className="demo-readonly-notice" role="status">
          <strong>공개 데모용 상세 분석</strong>
          <span>가상 기준자료 18건을 브라우저에서 집계합니다. 로그인이나 외부 자료 호출 없이 모든 조건을 체험할 수 있습니다.</span>
        </section>}
        <section className="summary-banner">
          <div>
            <div className="banner-title">통계·요구자료 분석</div>
            <div className="banner-sub">조건과 산출기준을 조합해 사업·재정 현황을 {isDemo ? '같은 계산식으로 즉시 재집계합니다.' : '서버에서 재집계합니다.'}</div>
          </div>
          {result && <div className="analytics-source-badge">{isDemo ? '예시 기준시점' : sourceBadgeText(result.source)}</div>}
        </section>

        {isDemo && <section className="demo-analysis-presets" aria-label="예시 분석">
          <strong>예시 분석</strong>
          {DEMO_PRESETS.map((preset) => <button key={preset.label} type="button" className="small-btn" onClick={() => {
            const next = { ...DEFAULT_ANALYTICS_FILTERS, ...preset.filters };
            setDraft(next);
            setDemoFilters(next);
            setSort({ key: 'label', direction: 'asc' });
          }}>{preset.label}</button>)}
        </section>}

        <section className="panel">
          <h2>기본 조회조건</h2>
          <div className="analytics-filter-grid">
              <label>
                조회 시점
                <select value={draft.timeBasis} onChange={(event) => updateDraft('timeBasis', event.target.value as AnalyticsFilters['timeBasis'])}>
                  <option value="current">현재 최신값</option>
                  <option value="as_of">과거 기준일</option>
                </select>
              </label>
              <label>
                기준일자
                <input type="date" value={draft.asOf} disabled={draft.timeBasis === 'current'} onChange={(event) => updateDraft('asOf', event.target.value)} />
              </label>
            <label>
              사업연도
              <select value={draft.year ?? ''} onChange={(event) => updateDraft('year', event.target.value ? Number(event.target.value) : null)}>
                <option value="">전체</option>
                {(options?.years ?? []).map((year) => <option key={year} value={year}>{year}</option>)}
              </select>
            </label>
            <label>
              시도
              <select
                value={draft.sido ?? ''}
                disabled={profile?.role === 'local_user'}
                onChange={(event) => {
                  updateDraft('sido', event.target.value || null);
                  updateDraft('sigungu', null);
                }}
              >
                <option value="">전체</option>
                {(options?.sidos ?? []).map((sido) => <option key={sido} value={sido}>{sido}</option>)}
              </select>
            </label>
            <label>
              시군구
              <select
                value={draft.sigungu ?? ''}
                disabled={profile?.role === 'local_user' || !draft.sido}
                onChange={(event) => updateDraft('sigungu', event.target.value || null)}
              >
                <option value="">전체</option>
                {sigungus.map((sigungu) => <option key={sigungu} value={sigungu}>{sigungu}</option>)}
              </select>
            </label>
            <label>
              집계단위
              <select value={draft.groupBy} onChange={(event) => updateDraft('groupBy', event.target.value as AnalyticsFilters['groupBy'])}>
                {Object.entries(GROUP_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          </div>

          <details className="analytics-advanced">
            <summary>고급 조회조건</summary>
            <div className="analytics-filter-grid">
              <label>
                대분류
                <select value={draft.largeCategoryId ?? ''} onChange={(event) => {
                  updateDraft('largeCategoryId', event.target.value || null);
                  updateDraft('middleCategoryId', null);
                  updateDraft('smallCategoryId', null);
                }}>
                  <option value="">전체</option>
                  {(options?.largeCategories ?? []).map((category) => <option key={category.id} value={category.id}>{sanitizeClassificationNameForDisplay(category.name)}</option>)}
                </select>
              </label>
              <label>
                중분류
                <select value={draft.middleCategoryId ?? ''} onChange={(event) => {
                  updateDraft('middleCategoryId', event.target.value || null);
                  updateDraft('smallCategoryId', null);
                }}>
                  <option value="">전체</option>
                  {middleCategories.map((category) => <option key={category.id} value={category.id}>{sanitizeClassificationNameForDisplay(category.name)}</option>)}
                </select>
              </label>
              <label>
                소분류
                <select value={draft.smallCategoryId ?? ''} onChange={(event) => updateDraft('smallCategoryId', event.target.value || null)}>
                  <option value="">전체</option>
                  {smallCategories.map((category) => <option key={category.id} value={category.id}>{sanitizeClassificationNameForDisplay(category.name)}</option>)}
                </select>
              </label>
              <label>
                사업구분
                <select value={draft.projectLifecycle} onChange={(event) => updateDraft('projectLifecycle', event.target.value as AnalyticsFilters['projectLifecycle'])}>
                  <option value="all">전체</option>
                  <option value="new">신규 사업</option>
                  <option value="continuing">계속 사업</option>
                  <option value="needs_review">구분 검증 필요</option>
                </select>
              </label>
              <label>
                사업유형
                <select value={draft.businessType ?? ''} onChange={(event) => updateDraft('businessType', (event.target.value || null) as AnalyticsFilters['businessType'])}>
                  <option value="">전체</option>
                  <option value="HW">시설·기반 중심</option>
                  <option value="SW">프로그램·서비스 중심</option>
                  <option value="COMPOSITE">복합</option>
                </select>
              </label>
              <label>
                사업상태
                <select value={draft.status ?? ''} onChange={(event) => updateDraft('status', event.target.value || null)}>
                  <option value="">전체</option>
                  {(options?.statuses ?? []).map((status) => <option key={status} value={status}>{formatSystemTerm(status, '상태 확인 필요')}</option>)}
                </select>
              </label>
              <label>
                배분액 최소(원)
                <input inputMode="numeric" pattern="[0-9]*" placeholder="예: 1000000000" value={draft.allocationMin ?? ''} onChange={(event) => updateDraft('allocationMin', event.target.value.replace(/\D/g, '') || null)} />
              </label>
              <label>
                배분액 최대(원)
                <input inputMode="numeric" pattern="[0-9]*" placeholder="예: 3000000000" value={draft.allocationMax ?? ''} onChange={(event) => updateDraft('allocationMax', event.target.value.replace(/\D/g, '') || null)} />
              </label>
            </div>
            <p className="panel-sub">사업구분은 사업연도와 사업 시작연도를 비교합니다. 시작연도가 없거나 사업연도보다 뒤인 값은 ‘구분 검증 필요’로 분리합니다. 이월·재원이동 조건은 실제 재정원장 운영 후 거래기반 분석으로 추가됩니다.</p>
          </details>

          <div className="analytics-criteria">
            <div>
              <strong>산출기준</strong>
              <div className="analytics-radio-row">
                <label><input type="radio" checked={draft.rateBasis === 'adjusted'} onChange={() => updateDraft('rateBasis', 'adjusted')} /> 집행률(조정 후 배분액 기준)</label>
                <label><input type="radio" checked={draft.rateBasis === 'original'} onChange={() => updateDraft('rateBasis', 'original')} /> 당초 배분액 대비 실제 집행액 비율</label>
              </div>
              <small>{draft.rateBasis === 'adjusted' ? '누적 실제 집행액 ÷ 조정 후 배분액 × 100' : '당초 배분액이 비어 있는 사업·집계는 자료 없음으로 표시합니다.'}</small>
            </div>
            <label>
              집행률 범위
              <select value={draft.rateBand} onChange={(event) => updateDraft('rateBand', event.target.value as AnalyticsFilters['rateBand'])}>
                <option value="all">전체</option>
                <option value="below30">30% 미만</option>
                <option value="below50">50% 미만</option>
                <option value="below70">70% 미만</option>
                <option value="below90">90% 미만</option>
                <option value="custom">사용자 지정</option>
              </select>
            </label>
            {draft.rateBand === 'custom' && <div className="analytics-rate-range">
              <label>최소 <input type="number" min="0" max="100" value={draft.rateMin ?? ''} onChange={(event) => updateDraft('rateMin', event.target.value === '' ? null : Number(event.target.value))} /></label>
              <label>최대 <input type="number" min="0" max="100" value={draft.rateMax ?? ''} onChange={(event) => updateDraft('rateMax', event.target.value === '' ? null : Number(event.target.value))} /></label>
            </div>}
          </div>

          <div className="analytics-actions">
            <button className="my-project-save-button" type="button" onClick={applyFilters}>조회</button>
            <button className="small-btn" type="button" onClick={resetFilters}>초기화</button>
            {!isDemo && <button className="small-btn" type="button" disabled={loading} onClick={() => setRefreshVersion((current) => current + 1)}>
              {loading ? '재조회 중...' : '최신값 다시 조회'}
            </button>}
          </div>
        </section>

        {result && <section className="panel analytics-summary">
          <div><strong>조회조건</strong><span>{conditionSummary}</span></div>
          <div><strong>산출기준</strong><span>{activeFilters.rateBasis === 'adjusted' ? '집행률(조정 후 배분액 기준)' : '당초 배분액 대비 실제 집행액 비율'}</span></div>
          <div><strong>집계단위</strong><span>{GROUP_LABELS[activeFilters.groupBy]}</span></div>
          <p className="financial-ledger-status">{result.sourceMessage}</p>
          {result.regionRestricted && <p className="panel-sub">지자체 사용자는 자신의 지역 범위만 조회할 수 있습니다.</p>}
        </section>}

        {!isDemo && result?.funding && !loading && <FundingAnalyticsPanel funding={result.funding} budgetChangeStatistics={result.budgetChangeStatistics ?? null} />}

        {loading && <div className="panel">통계 데이터를 집계하는 중입니다...</div>}
        {error && <p className="financial-ledger-error" role="alert">{error}</p>}

        {result?.kpis && !loading && <>
          <section className="kpi-grid">
            <div className="kpi-card"><div className="kpi-label">검색결과 사업수</div><div className="kpi-value">{result.kpis.projectCount.toLocaleString('ko-KR')}</div></div>
            <div className="kpi-card"><div className="kpi-label">조정 후 배분액(만원)</div><div className="kpi-value kpi-money-value" title={`${formatIntegerString(result.kpis.adjustedAllocation)}원`}>{formatWonAsManwonWithUnit(result.kpis.adjustedAllocation)}</div></div>
            <div className="kpi-card"><div className="kpi-label">누적 집행액(만원)</div><div className="kpi-value kpi-money-value" title={`${formatIntegerString(result.kpis.cumulativeExecution)}원`}>{formatWonAsManwonWithUnit(result.kpis.cumulativeExecution)}</div></div>
            <div className="kpi-card"><div className="kpi-label">미집행액(만원)</div><div className="kpi-value kpi-money-value" title={`${formatIntegerString(result.kpis.unexecutedAmount)}원`}>{formatWonAsManwonWithUnit(result.kpis.unexecutedAmount)}</div></div>
            <div className="kpi-card"><div className="kpi-label" title="전체 사업의 집행액 합계 ÷ 선택한 배분액 합계 × 100">전체 집행률 ⓘ</div><div className="kpi-value">{rateText(result.kpis.executionRate)}</div></div>
          </section>

          <section className="panel analytics-region-distribution" aria-labelledby="analytics-region-distribution-title">
            <div className="analytics-table-heading">
              <div><h2 id="analytics-region-distribution-title">지역 분포도</h2><p className="panel-sub">현재 조회조건의 지역별 조정 후 배분액과 사업 수를 비교합니다.</p></div>
            </div>
            {result.rowsTruncated && activeFilters.groupBy === 'project' && <p className="financial-ledger-status">현재 화면에 표시된 사업 500건을 기준으로 그립니다. 전체 비교는 시도 또는 시군구 집계를 선택해 주세요.</p>}
            {regionDistribution.length === 0 ? <p className="empty-state">표시할 지역 자료가 없습니다.</p> : <div className="analytics-region-bars">{regionDistribution.map((region) => <div key={region.label} className="analytics-region-bar-row">
              <div><strong>{region.label}</strong><span>{region.projectCount.toLocaleString('ko-KR')}개 사업 · {amountText(region.amount.toString())}</span></div>
              <div className="analytics-region-bar-track" aria-label={`${region.label} 조정 후 배분액 ${formatIntegerString(region.amount.toString())}원`}><span style={{ width: `${region.width}%` }} /></div>
            </div>)}</div>}
          </section>

          <section className="panel">
            <div className="analytics-table-heading">
              <div><h2>집계 결과</h2><p className="panel-sub">행을 선택하면 다음 세부 집계단위로 이동합니다. 열 제목을 눌러 정렬할 수 있습니다.</p></div>
              <div className="analytics-table-buttons">
                {canDrillUp && <button className="small-btn" type="button" onClick={drillUp}>상위 집계로 돌아가기</button>}
                <button className="small-btn" type="button" onClick={() => void exportCsv()} disabled={exporting || result.source === 'ledger_not_implemented' || result.source === 'historical_unavailable'}>{exporting ? '자료 생성 중...' : '분석 자료 내려받기'}</button>
              </div>
            </div>
            {result.rowsTruncated && <p className="financial-ledger-status">표시 성능을 위해 앞 500개 행만 보입니다. 내려받는 자료에는 현재 조건의 전체 집계 결과가 포함됩니다.</p>}
            {sortedRows.length === 0 ? <p className="empty-state">현재 조건에 해당하는 사업이 없습니다.</p> : (
              <div className="table-scroll analytics-table-scroll">
                <table className="analytics-table">
                  {activeFilters.groupBy === 'project' ? <>
                    <thead><tr><th>연도</th><th>시도</th><th>시군구</th>{sortHeading('사업명', 'label', false)}<th>대분류</th><th>중분류</th><th>사업유형</th>{sortHeading('사업수', 'projectCount')}{sortHeading('조정후배분액(만원)', 'adjustedAllocation')}{sortHeading('누적집행액(만원)', 'cumulativeExecution')}{sortHeading('미집행액(만원)', 'unexecutedAmount')}{sortHeading('사업별 집행률', 'executionRate')}</tr></thead>
                    <tbody>{sortedRows.map((row) => <tr key={row.key}><td>{row.year ?? '-'}</td><td>{row.sido ?? '-'}</td><td>{row.sigungu ?? '-'}</td><td>{analyticsProjectName(row)}</td><td>{sanitizeClassificationNameForDisplay(row.largeCategoryName, '-')}</td><td>{sanitizeClassificationNameForDisplay(row.middleCategoryName, '-')}</td><td>{businessTypeText(row.businessType)}</td><td className="num">{row.projectCount.toLocaleString('ko-KR')}</td><td className="num amount-display" title={`${formatIntegerString(row.adjustedAllocation)}원`}>{amountText(row.adjustedAllocation)}</td><td className="num amount-display" title={`${formatIntegerString(row.cumulativeExecution)}원`}>{amountText(row.cumulativeExecution)}</td><td className="num amount-display" title={`${formatIntegerString(row.unexecutedAmount)}원`}>{amountText(row.unexecutedAmount)}</td><td className="num">{rateText(row.executionRate)}</td></tr>)}</tbody>
                  </> : <>
                    <thead><tr>{sortHeading(GROUP_LABELS[activeFilters.groupBy], 'label', false)}{sortHeading('사업수', 'projectCount')}{sortHeading('조정후배분액(만원)', 'adjustedAllocation')}{sortHeading('누적집행액(만원)', 'cumulativeExecution')}{sortHeading('미집행액(만원)', 'unexecutedAmount')}{sortHeading('전체 집행률', 'executionRate')}</tr></thead>
                    <tbody>{sortedRows.map((row) => <tr key={row.key} className="analytics-drill-row" onClick={() => drillDown(row)}><td>{row.label}</td><td className="num">{row.projectCount.toLocaleString('ko-KR')}</td><td className="num amount-display" title={`${formatIntegerString(row.adjustedAllocation)}원`}>{amountText(row.adjustedAllocation)}</td><td className="num amount-display" title={`${formatIntegerString(row.cumulativeExecution)}원`}>{amountText(row.cumulativeExecution)}</td><td className="num amount-display" title={`${formatIntegerString(row.unexecutedAmount)}원`}>{amountText(row.unexecutedAmount)}</td><td className="num">{rateText(row.executionRate)}</td></tr>)}</tbody>
                  </>}
                </table>
              </div>
            )}
          </section>
        </>}

        {result?.source === 'ledger_not_implemented' && !loading && <section className="panel"><p className="empty-state">재정원장 거래기반 기준일 분석은 2단계 기능입니다.</p></section>}
        {result?.source === 'historical_unavailable' && !loading && <section className="panel"><p className="empty-state">선택한 기준일의 공식 과거 자료가 없습니다. 조회 시점을 ‘현재 최신값’으로 바꾸면 시험 시스템의 최신 확정값을 확인할 수 있습니다.</p></section>}
      </main>
    </div>
  );
}
