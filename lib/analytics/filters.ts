import type { AnalyticsFilters, AnalyticsGroupBy, AnalyticsProjectLifecycle, AnalyticsRateBand, AnalyticsRateBasis, AnalyticsTimeBasis } from './types';

export const LEGACY_BASELINE_DATE = '2026-08-31';
export const DEFAULT_ANALYTICS_FILTERS: AnalyticsFilters = {
  timeBasis: 'current',
  asOf: LEGACY_BASELINE_DATE,
  year: null,
  sido: null,
  sigungu: null,
  groupBy: 'sido',
  rateBasis: 'adjusted',
  largeCategoryId: null,
  middleCategoryId: null,
  smallCategoryId: null,
  projectLifecycle: 'all',
  businessType: null,
  status: null,
  rateBand: 'all',
  rateMin: null,
  rateMax: null,
  allocationMin: null,
  allocationMax: null,
};

const GROUP_BY_VALUES: AnalyticsGroupBy[] = ['national', 'sido', 'sigungu', 'project'];
const TIME_BASIS_VALUES: AnalyticsTimeBasis[] = ['current', 'as_of'];
const RATE_BASIS_VALUES: AnalyticsRateBasis[] = ['adjusted', 'original'];
const RATE_BAND_VALUES: AnalyticsRateBand[] = ['all', 'below30', 'below50', 'below70', 'below90', 'custom'];
const PROJECT_LIFECYCLE_VALUES: AnalyticsProjectLifecycle[] = ['all', 'new', 'continuing', 'needs_review'];
const BUSINESS_TYPE_VALUES = ['HW', 'SW', 'COMPOSITE'] as const;

function optionalText(value: string | null, maxLength = 160) {
  const normalized = value?.trim() ?? '';
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function optionalInteger(value: string | null) {
  if (!value || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 2000 && parsed <= 2200 ? parsed : null;
}

function optionalRate(value: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function optionalAmount(value: string | null) {
  if (!value || !/^\d{1,18}$/.test(value)) return null;
  return value.replace(/^0+(?=\d)/, '');
}

function isIsoDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function enumValue<T extends string>(value: string | null, allowed: readonly T[], fallback: T) {
  return value && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

export function parseAnalyticsFilters(searchParams: URLSearchParams): AnalyticsFilters {
  const rateBand = enumValue(searchParams.get('rateBand'), RATE_BAND_VALUES, DEFAULT_ANALYTICS_FILTERS.rateBand);
  const rateMin = rateBand === 'custom' ? optionalRate(searchParams.get('rateMin')) : null;
  const rateMax = rateBand === 'custom' ? optionalRate(searchParams.get('rateMax')) : null;

  return {
    timeBasis: enumValue(searchParams.get('timeBasis'), TIME_BASIS_VALUES, DEFAULT_ANALYTICS_FILTERS.timeBasis),
    asOf: isIsoDate(searchParams.get('asOf')) ? searchParams.get('asOf')! : DEFAULT_ANALYTICS_FILTERS.asOf,
    year: optionalInteger(searchParams.get('year')),
    sido: optionalText(searchParams.get('sido')),
    sigungu: optionalText(searchParams.get('sigungu')),
    groupBy: enumValue(searchParams.get('groupBy'), GROUP_BY_VALUES, DEFAULT_ANALYTICS_FILTERS.groupBy),
    rateBasis: enumValue(searchParams.get('rateBasis'), RATE_BASIS_VALUES, DEFAULT_ANALYTICS_FILTERS.rateBasis),
    largeCategoryId: optionalText(searchParams.get('largeCategoryId'), 80),
    middleCategoryId: optionalText(searchParams.get('middleCategoryId'), 80),
    smallCategoryId: optionalText(searchParams.get('smallCategoryId'), 80),
    projectLifecycle: enumValue(searchParams.get('projectLifecycle'), PROJECT_LIFECYCLE_VALUES, DEFAULT_ANALYTICS_FILTERS.projectLifecycle),
    businessType: enumValue(searchParams.get('businessType'), BUSINESS_TYPE_VALUES, '') || null,
    status: optionalText(searchParams.get('status'), 80),
    rateBand,
    rateMin,
    rateMax,
    allocationMin: optionalAmount(searchParams.get('allocationMin')),
    allocationMax: optionalAmount(searchParams.get('allocationMax')),
  };
}

export function analyticsFiltersToSearchParams(filters: AnalyticsFilters) {
  const params = new URLSearchParams({
    timeBasis: filters.timeBasis,
    asOf: filters.asOf,
    groupBy: filters.groupBy,
    rateBasis: filters.rateBasis,
    rateBand: filters.rateBand,
  });
  const values: Array<[string, string | number | null]> = [
    ['year', filters.year], ['sido', filters.sido], ['sigungu', filters.sigungu],
    ['largeCategoryId', filters.largeCategoryId], ['middleCategoryId', filters.middleCategoryId],
    ['smallCategoryId', filters.smallCategoryId], ['projectLifecycle', filters.projectLifecycle === 'all' ? null : filters.projectLifecycle], ['businessType', filters.businessType],
    ['status', filters.status], ['rateMin', filters.rateMin], ['rateMax', filters.rateMax],
    ['allocationMin', filters.allocationMin], ['allocationMax', filters.allocationMax],
  ];
  for (const [key, value] of values) {
    if (value !== null && value !== '') params.set(key, String(value));
  }
  return params;
}
