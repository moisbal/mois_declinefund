import type { AnalyticsFilters, AnalyticsSource } from './types';

export type AnalyticsSourceResolution = {
  source: AnalyticsSource;
  sourceMessage: string;
};

export function resolveAnalyticsSourcePolicy(
  filters: Pick<AnalyticsFilters, 'timeBasis' | 'asOf'>,
  confirmedLedgerStartDate: string | null,
): AnalyticsSourceResolution {
  if (filters.timeBasis === 'current') {
    return {
      source: 'current_projects',
      sourceMessage: '사업 테이블의 최신 확정 저장값을 조회했습니다. 기준일자와 무관하게 현재값을 표시합니다.',
    };
  }

  if (confirmedLedgerStartDate && filters.asOf >= confirmedLedgerStartDate) {
    return {
      source: 'ledger_not_implemented',
      sourceMessage: '확정된 재정원장 운영전환 이후의 거래기반 기준일 재구성은 아직 제공되지 않습니다. 현재값을 과거값으로 대신 표시하지 않았습니다.',
    };
  }

  return {
    source: 'historical_unavailable',
    sourceMessage: '선택한 기준일의 공식 기준시점 자료 또는 거래 이력이 없어 과거값을 재구성할 수 없습니다. 현재값을 과거 기준값으로 대신 표시하지 않았습니다.',
  };
}
