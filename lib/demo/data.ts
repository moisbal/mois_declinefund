import { calculateKpis, getProjectRate, type AnalyticsProjectValue } from '../analytics/calculations';
import type {
  AnalyticsFilterOptions,
  AnalyticsFilters,
  AnalyticsProjectLifecycle,
  AnalyticsResult,
  AnalyticsRow,
} from '../analytics/types';

export type DemoLifecycle = 'new' | 'continuing';

export type DemoProject = AnalyticsProjectValue & {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  region: string;
  sido: string;
  sigungu: string;
  year: number;
  projectStartYear: number;
  lifecycle: DemoLifecycle;
  status: '정상추진' | '지연' | '완료' | '추진곤란';
  businessType: 'HW' | 'SW' | 'COMPOSITE';
  largeCategoryId: string;
  middleCategoryId: string;
  smallCategoryId: string;
  allocation: number;
  execution: number;
};

const categoryData = {
  largeCategories: [
    { id: 'life', name: '생활인구' },
    { id: 'industry', name: '산업·일자리' },
    { id: 'care', name: '정주·돌봄' },
    { id: 'tourism', name: '문화·관광' },
  ],
  middleCategories: [
    { id: 'life-settlement', name: '정착지원', largeCategoryId: 'life' },
    { id: 'life-youth', name: '청년활력', largeCategoryId: 'life' },
    { id: 'industry-startup', name: '창업지원', largeCategoryId: 'industry' },
    { id: 'industry-smart', name: '디지털전환', largeCategoryId: 'industry' },
    { id: 'care-medical', name: '보건의료', largeCategoryId: 'care' },
    { id: 'care-living', name: '생활서비스', largeCategoryId: 'care' },
    { id: 'tourism-content', name: '관광콘텐츠', largeCategoryId: 'tourism' },
  ],
  smallCategories: [
    { id: 'settlement-center', name: '정착 거점', middleCategoryId: 'life-settlement', largeCategoryId: 'life' },
    { id: 'youth-housing', name: '청년 주거', middleCategoryId: 'life-youth', largeCategoryId: 'life' },
    { id: 'startup-space', name: '창업 공간', middleCategoryId: 'industry-startup', largeCategoryId: 'industry' },
    { id: 'smart-platform', name: '디지털 플랫폼', middleCategoryId: 'industry-smart', largeCategoryId: 'industry' },
    { id: 'medical-access', name: '의료 접근성', middleCategoryId: 'care-medical', largeCategoryId: 'care' },
    { id: 'care-network', name: '돌봄 네트워크', middleCategoryId: 'care-living', largeCategoryId: 'care' },
    { id: 'tourism-stay', name: '체류형 관광', middleCategoryId: 'tourism-content', largeCategoryId: 'tourism' },
  ],
} satisfies Pick<AnalyticsFilterOptions, 'largeCategories' | 'middleCategories' | 'smallCategories'>;

type Seed = Omit<DemoProject, 'id' | 'projectId' | 'projectCode' | 'region' | 'allocText' | 'execText' | 'originalAllocText' | 'lifecycle'>;

const seeds: Seed[] = [
  { projectName: '생활인구 정착지원센터', sido: '가람도', sigungu: '새빛시', year: 2025, projectStartYear: 2025, status: '정상추진', businessType: 'HW', largeCategoryId: 'life', middleCategoryId: 'life-settlement', smallCategoryId: 'settlement-center', allocation: 2400000000, execution: 720000000 },
  { projectName: '지역돌봄 복합공간 조성', sido: '가람도', sigungu: '새빛군', year: 2025, projectStartYear: 2024, status: '정상추진', businessType: 'COMPOSITE', largeCategoryId: 'care', middleCategoryId: 'care-living', smallCategoryId: 'care-network', allocation: 1850000000, execution: 1110000000 },
  { projectName: '청년 창업·주거 연계사업', sido: '가람도', sigungu: '물결시', year: 2026, projectStartYear: 2026, status: '지연', businessType: 'SW', largeCategoryId: 'industry', middleCategoryId: 'industry-startup', smallCategoryId: 'startup-space', allocation: 3100000000, execution: 620000000 },
  { projectName: '공공의료 접근성 개선', sido: '한울도', sigungu: '푸른시', year: 2025, projectStartYear: 2023, status: '완료', businessType: 'HW', largeCategoryId: 'care', middleCategoryId: 'care-medical', smallCategoryId: 'medical-access', allocation: 2700000000, execution: 2430000000 },
  { projectName: '스마트 농촌 생활서비스', sido: '한울도', sigungu: '솔마을군', year: 2026, projectStartYear: 2024, status: '정상추진', businessType: 'SW', largeCategoryId: 'care', middleCategoryId: 'care-living', smallCategoryId: 'care-network', allocation: 2050000000, execution: 1742500000 },
  { projectName: '청년 정착주택 리모델링', sido: '한울도', sigungu: '푸른시', year: 2026, projectStartYear: 2026, status: '정상추진', businessType: 'HW', largeCategoryId: 'life', middleCategoryId: 'life-youth', smallCategoryId: 'youth-housing', allocation: 1600000000, execution: 480000000 },
  { projectName: '체류형 관광 거점 조성', sido: '누리도', sigungu: '해온시', year: 2025, projectStartYear: 2025, status: '정상추진', businessType: 'HW', largeCategoryId: 'tourism', middleCategoryId: 'tourism-content', smallCategoryId: 'tourism-stay', allocation: 3200000000, execution: 960000000 },
  { projectName: '지역특화 창업 플랫폼', sido: '누리도', sigungu: '들샘군', year: 2025, projectStartYear: 2024, status: '정상추진', businessType: 'SW', largeCategoryId: 'industry', middleCategoryId: 'industry-smart', smallCategoryId: 'smart-platform', allocation: 1450000000, execution: 1160000000 },
  { projectName: '마을의료 이동지원', sido: '누리도', sigungu: '해온시', year: 2026, projectStartYear: 2026, status: '추진곤란', businessType: 'COMPOSITE', largeCategoryId: 'care', middleCategoryId: 'care-medical', smallCategoryId: 'medical-access', allocation: 980000000, execution: 98000000 },
  { projectName: '귀촌 정착 원스톱 지원', sido: '새롬도', sigungu: '별하군', year: 2025, projectStartYear: 2025, status: '정상추진', businessType: 'SW', largeCategoryId: 'life', middleCategoryId: 'life-settlement', smallCategoryId: 'settlement-center', allocation: 1250000000, execution: 687500000 },
  { projectName: '산업단지 창업허브', sido: '새롬도', sigungu: '꽃마을시', year: 2026, projectStartYear: 2024, status: '정상추진', businessType: 'HW', largeCategoryId: 'industry', middleCategoryId: 'industry-startup', smallCategoryId: 'startup-space', allocation: 3700000000, execution: 2590000000 },
  { projectName: '로컬관광 콘텐츠랩', sido: '새롬도', sigungu: '별하군', year: 2026, projectStartYear: 2026, status: '지연', businessType: 'SW', largeCategoryId: 'tourism', middleCategoryId: 'tourism-content', smallCategoryId: 'tourism-stay', allocation: 1100000000, execution: 220000000 },
  { projectName: '도서지역 돌봄 네트워크', sido: '푸름도', sigungu: '바다시', year: 2025, projectStartYear: 2023, status: '정상추진', businessType: 'COMPOSITE', largeCategoryId: 'care', middleCategoryId: 'care-living', smallCategoryId: 'care-network', allocation: 2100000000, execution: 1890000000 },
  { projectName: '청년 공유주거 공급', sido: '푸름도', sigungu: '섬빛군', year: 2026, projectStartYear: 2026, status: '정상추진', businessType: 'HW', largeCategoryId: 'life', middleCategoryId: 'life-youth', smallCategoryId: 'youth-housing', allocation: 2200000000, execution: 660000000 },
  { projectName: '해양관광 체류서비스', sido: '푸름도', sigungu: '바다시', year: 2025, projectStartYear: 2024, status: '완료', businessType: 'COMPOSITE', largeCategoryId: 'tourism', middleCategoryId: 'tourism-content', smallCategoryId: 'tourism-stay', allocation: 1900000000, execution: 1900000000 },
  { projectName: '산촌 디지털 판로지원', sido: '온새도', sigungu: '고운군', year: 2025, projectStartYear: 2025, status: '정상추진', businessType: 'SW', largeCategoryId: 'industry', middleCategoryId: 'industry-smart', smallCategoryId: 'smart-platform', allocation: 900000000, execution: 315000000 },
  { projectName: '산촌 보건 진료거점', sido: '온새도', sigungu: '고운군', year: 2026, projectStartYear: 2024, status: '정상추진', businessType: 'HW', largeCategoryId: 'care', middleCategoryId: 'care-medical', smallCategoryId: 'medical-access', allocation: 1750000000, execution: 1400000000 },
  { projectName: '생활인구 워케이션 센터', sido: '온새도', sigungu: '새들시', year: 2026, projectStartYear: 2026, status: '지연', businessType: 'COMPOSITE', largeCategoryId: 'life', middleCategoryId: 'life-settlement', smallCategoryId: 'settlement-center', allocation: 1500000000, execution: 300000000 },
];

export const demoProjects: DemoProject[] = seeds.map((seed, index) => ({
  ...seed,
  id: `demo-${String(index + 1).padStart(3, '0')}`,
  projectId: `DEMO-${String(index + 1).padStart(3, '0')}`,
  projectCode: `DEMO-${String(index + 1).padStart(3, '0')}`,
  region: seed.sido,
  lifecycle: seed.projectStartYear === seed.year ? 'new' : 'continuing',
  allocText: String(seed.allocation),
  execText: String(seed.execution),
  originalAllocText: String(seed.allocation),
}));

export const demoRegions = [...new Set(demoProjects.map((project) => project.sido))];

export function formatDemoWon(value: number) {
  const eok = Math.floor(value / 100_000_000);
  const man = Math.round((value % 100_000_000) / 10_000);
  return man > 0 ? `${eok.toLocaleString('ko-KR')}억 ${man.toLocaleString('ko-KR')}만원` : `${eok.toLocaleString('ko-KR')}억원`;
}

export function calculateDemoSummary(projects: DemoProject[]) {
  const allocation = projects.reduce((sum, project) => sum + project.allocation, 0);
  const execution = projects.reduce((sum, project) => sum + project.execution, 0);
  return { projectCount: projects.length, allocation, execution, unexecuted: allocation - execution, rate: allocation > 0 ? execution / allocation * 100 : 0 };
}

function projectLifecycle(project: DemoProject): Exclude<AnalyticsProjectLifecycle, 'all' | 'needs_review'> {
  return project.lifecycle;
}

function matchesRateBand(project: DemoProject, filters: AnalyticsFilters) {
  if (filters.rateBand === 'all') return true;
  const rate = getProjectRate(project, filters.rateBasis);
  if (rate === null) return false;
  if (filters.rateBand === 'below30') return rate < 30;
  if (filters.rateBand === 'below50') return rate < 50;
  if (filters.rateBand === 'below70') return rate < 70;
  if (filters.rateBand === 'below90') return rate < 90;
  return (filters.rateMin === null || rate >= filters.rateMin) && (filters.rateMax === null || rate <= filters.rateMax);
}

function filteredDemoProjects(filters: AnalyticsFilters) {
  return demoProjects.filter((project) => {
    const allocation = BigInt(project.allocText ?? '0');
    if (filters.year !== null && project.year !== filters.year) return false;
    if (filters.sido && project.sido !== filters.sido) return false;
    if (filters.sigungu && project.sigungu !== filters.sigungu) return false;
    if (filters.largeCategoryId && project.largeCategoryId !== filters.largeCategoryId) return false;
    if (filters.middleCategoryId && project.middleCategoryId !== filters.middleCategoryId) return false;
    if (filters.smallCategoryId && project.smallCategoryId !== filters.smallCategoryId) return false;
    if (filters.projectLifecycle !== 'all' && projectLifecycle(project) !== filters.projectLifecycle) return false;
    if (filters.businessType && project.businessType !== filters.businessType) return false;
    if (filters.status && project.status !== filters.status) return false;
    if (filters.allocationMin !== null && allocation < BigInt(filters.allocationMin)) return false;
    if (filters.allocationMax !== null && allocation > BigInt(filters.allocationMax)) return false;
    return matchesRateBand(project, filters);
  });
}

function optionData(): AnalyticsFilterOptions {
  const sidos = [...new Set(demoProjects.map((project) => project.sido))].sort();
  return {
    years: [...new Set(demoProjects.map((project) => project.year))].sort(),
    sidos,
    sigungusBySido: Object.fromEntries(sidos.map((sido) => [sido, [...new Set(demoProjects.filter((project) => project.sido === sido).map((project) => project.sigungu))].sort()])),
    statuses: [...new Set(demoProjects.map((project) => project.status))].sort(),
    ...categoryData,
  };
}

function categoryName(id: string, type: 'large' | 'middle' | 'small') {
  const list = type === 'large' ? categoryData.largeCategories : type === 'middle' ? categoryData.middleCategories : categoryData.smallCategories;
  return list.find((category) => category.id === id)?.name ?? '미분류';
}

function groupRows(projects: DemoProject[], filters: AnalyticsFilters): AnalyticsRow[] {
  const groups = new Map<string, DemoProject[]>();
  for (const project of projects) {
    const key = filters.groupBy === 'national' ? 'national'
      : filters.groupBy === 'sido' ? `sido:${project.sido}`
        : filters.groupBy === 'sigungu' ? `sigungu:${project.sido}:${project.sigungu}` : `project:${project.id}`;
    groups.set(key, [...(groups.get(key) ?? []), project]);
  }
  return [...groups.entries()].map(([key, grouped]) => {
    const first = grouped[0];
    const label = filters.groupBy === 'national' ? '전국'
      : filters.groupBy === 'sido' ? first.sido
        : filters.groupBy === 'sigungu' ? `${first.sido} ${first.sigungu}` : `${first.projectCode} · ${first.projectName}`;
    return {
      key, label, sido: first.sido, sigungu: first.sigungu,
      projectId: filters.groupBy === 'project' ? first.id : null,
      projectCode: filters.groupBy === 'project' ? first.projectCode : null,
      year: first.year, projectName: first.projectName,
      largeCategoryName: categoryName(first.largeCategoryId, 'large'),
      middleCategoryName: categoryName(first.middleCategoryId, 'middle'),
      smallCategoryName: categoryName(first.smallCategoryId, 'small'),
      businessType: first.businessType, status: first.status,
      ...calculateKpis(grouped, filters.rateBasis),
    };
  });
}

export function getDemoAnalyticsResult(filters: AnalyticsFilters): AnalyticsResult {
  const projects = filteredDemoProjects(filters);
  return {
    source: 'legacy_snapshot',
    sourceMessage: '공개 데모는 가상의 고정 기준자료 18건으로 동작합니다. 기준일자는 표시용이며 과거 시점 재구성 기능은 제공하지 않습니다.',
    filters,
    options: optionData(),
    kpis: calculateKpis(projects, filters.rateBasis),
    rows: groupRows(projects, filters),
    totalGroupCount: new Set(projects.map((project) => filters.groupBy === 'national' ? 'national' : filters.groupBy === 'sido' ? project.sido : filters.groupBy === 'sigungu' ? `${project.sido}:${project.sigungu}` : project.id)).size,
    rowsTruncated: false,
    regionRestricted: false,
  };
}
