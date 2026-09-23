export type AnalyticsGroupBy = 'national' | 'sido' | 'sigungu' | 'project';
export type AnalyticsTimeBasis = 'current' | 'as_of';
export type AnalyticsRateBasis = 'adjusted' | 'original';
export type AnalyticsRateBand = 'all' | 'below30' | 'below50' | 'below70' | 'below90' | 'custom';
export type AnalyticsSource = 'current_projects' | 'historical_unavailable' | 'legacy_snapshot' | 'ledger_not_implemented';
export type AnalyticsProjectLifecycle = 'all' | 'new' | 'continuing' | 'needs_review';

export type AnalyticsFilters = {
  timeBasis: AnalyticsTimeBasis;
  asOf: string;
  year: number | null;
  sido: string | null;
  sigungu: string | null;
  groupBy: AnalyticsGroupBy;
  rateBasis: AnalyticsRateBasis;
  largeCategoryId: string | null;
  middleCategoryId: string | null;
  smallCategoryId: string | null;
  projectLifecycle: AnalyticsProjectLifecycle;
  businessType: 'HW' | 'SW' | 'COMPOSITE' | null;
  status: string | null;
  rateBand: AnalyticsRateBand;
  rateMin: number | null;
  rateMax: number | null;
  allocationMin: string | null;
  allocationMax: string | null;
};

export type AnalyticsFilterOptions = {
  years: number[];
  sidos: string[];
  sigungusBySido: Record<string, string[]>;
  statuses: string[];
  largeCategories: Array<{ id: string; name: string }>;
  middleCategories: Array<{ id: string; name: string; largeCategoryId: string }>;
  smallCategories: Array<{ id: string; name: string; middleCategoryId: string; largeCategoryId: string }>;
};

export type AnalyticsKpis = {
  projectCount: number;
  adjustedAllocation: string;
  cumulativeExecution: string;
  unexecutedAmount: string;
  executionRate: number | null;
  originalAllocation: string | null;
  originalExecutionRate: number | null;
  unknownAdjustedAmountCount: number;
  unknownExecutionCount: number;
  unknownOriginalAmountCount: number;
};

export type AnalyticsRow = AnalyticsKpis & {
  key: string;
  label: string;
  sido: string | null;
  sigungu: string | null;
  projectId: string | null;
  projectCode: string | null;
  year?: number | null;
  projectName?: string | null;
  largeCategoryName?: string | null;
  middleCategoryName?: string | null;
  smallCategoryName?: string | null;
  businessType?: 'HW' | 'SW' | 'COMPOSITE' | null;
  status?: string | null;
};

export type AnalyticsResult = {
  source: AnalyticsSource;
  sourceMessage: string;
  filters: AnalyticsFilters;
  options: AnalyticsFilterOptions;
  kpis: AnalyticsKpis | null;
  rows: AnalyticsRow[];
  totalGroupCount: number;
  rowsTruncated: boolean;
  regionRestricted: boolean;
};
