import { formatIntegerString, formatWonAsManwonWithUnit } from '../../lib/amountFormat';
import type { FundingAnalyticsResult } from '../../lib/fundingAnalytics';
import type { BudgetChangeStatistics } from '../../lib/budgetChanges';

type FundingAnalyticsPanelProps = {
  funding: FundingAnalyticsResult;
  budgetChangeStatistics: BudgetChangeStatistics | null;
};

function amount(value: string) {
  return <span className="amount-display" title={`${formatIntegerString(value)}원`}>{formatWonAsManwonWithUnit(value)}</span>;
}

function rate(value: number | null) {
  return value === null ? '자료 없음' : `${value.toFixed(1)}%`;
}

function add(left: string, right: string) {
  return (BigInt(left || '0') + BigInt(right || '0')).toString();
}

function calculateDisplayRate(execution: string, allocation: string) {
  const denominator = BigInt(allocation || '0');
  if (denominator <= BigInt(0)) return null;
  return Number((BigInt(execution || '0') * BigInt(1_000_000)) / denominator) / 10_000;
}

export default function FundingAnalyticsPanel({ funding, budgetChangeStatistics }: FundingAnalyticsPanelProps) {
  const { totals } = funding;
  const cohortBuckets = funding.buckets.filter((bucket) => bucket.budgetCohortId !== null);
  const visibleCohorts = cohortBuckets.slice(0, 100);

  return (
    <section className="panel" aria-labelledby="funding-analytics-title">
      <div className="analytics-table-heading">
        <div>
          <h2 id="funding-analytics-title">예산·집행 및 사업변경</h2>
          <p className="panel-sub">배분액 = 집행액 + 미집행액입니다. 신규사업 예정재원은 사업 연결 전까지 별도로 보존합니다.</p>
        </div>
        <div className="analytics-source-badge">확정 재정원장</div>
      </div>

      <h3>배분 및 집행</h3>
      <div className="kpi-grid">
        <div className="kpi-card"><div className="kpi-label">배분액</div><div className="kpi-value kpi-money-value">{amount(add(totals.confirmedExecutionAmount, totals.currentWalletBalance))}</div><small>집행액 + 미집행액</small></div>
        <div className="kpi-card"><div className="kpi-label">확정 집행액</div><div className="kpi-value kpi-money-value">{amount(totals.confirmedExecutionAmount)}</div></div>
        <div className="kpi-card"><div className="kpi-label">미집행액</div><div className="kpi-value kpi-money-value">{amount(totals.currentWalletBalance)}</div><small>배분액 - 집행액</small></div>
        <div className="kpi-card"><div className="kpi-label">집행률</div><div className="kpi-value">{rate(calculateDisplayRate(totals.confirmedExecutionAmount, add(totals.confirmedExecutionAmount, totals.currentWalletBalance)))}</div><small>집행액 ÷ 배분액</small></div>
      </div>

      <h3>사업변경</h3>
      <div className="kpi-grid">
        <div className="kpi-card"><div className="kpi-label">사업간 예산조정 총액</div><div className="kpi-value kpi-money-value">{amount(budgetChangeStatistics?.transfer_amount ?? '0')}</div><small>{budgetChangeStatistics?.transfer_count ?? '0'}건 · 전체 재원총량에 중복 합산하지 않습니다.</small></div>
        <div className="kpi-card"><div className="kpi-label">사업변경 예정재원</div><div className="kpi-value kpi-money-value">{amount(budgetChangeStatistics?.pending_new_project_amount ?? '0')}</div><small>{budgetChangeStatistics?.pending_new_project_count ?? '0'}건 · 사업 연결 전 보존</small></div>
        <div className="kpi-card"><div className="kpi-label">신규사업 연결완료</div><div className="kpi-value kpi-money-value">{amount(budgetChangeStatistics?.new_project_allocated_amount ?? '0')}</div><small>{budgetChangeStatistics?.new_project_allocated_count ?? '0'}건</small></div>
        <div className="kpi-card"><div className="kpi-label">연결 확인 필요 감액</div><div className="kpi-value kpi-money-value">{amount(totals.unclassifiedDecreaseAmount)}</div><small>{totals.unclassifiedDecreaseCount.toLocaleString('ko-KR')}건</small></div>
      </div>

      {visibleCohorts.length === 0 ? <p className="empty-state">현재 조건에 확정된 원재원이 없습니다.</p> : (
        <div className="table-scroll analytics-table-scroll">
          <table className="analytics-table">
            <thead><tr><th>지역</th><th>연도</th><th>원재원</th><th className="num">배분액(만원)</th><th className="num">집행액(만원)</th><th className="num">미집행액(만원)</th><th className="num">집행률</th></tr></thead>
            <tbody>{visibleCohorts.map((bucket, index) => <tr key={bucket.key}>
              <td>{bucket.label}</td>
              <td>{bucket.fiscalYear ?? '-'}</td>
              <td>{bucket.fiscalYear ? `${bucket.fiscalYear}년 원재원` : `원재원 ${index + 1}`}</td>
              <td className="num">{amount(add(bucket.confirmedExecutionAmount, bucket.currentWalletBalance))}</td>
              <td className="num">{amount(bucket.confirmedExecutionAmount)}</td>
              <td className="num">{amount(bucket.currentWalletBalance)}</td>
              <td className="num">{rate(calculateDisplayRate(bucket.confirmedExecutionAmount, add(bucket.confirmedExecutionAmount, bucket.currentWalletBalance)))}</td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
      {cohortBuckets.length > visibleCohorts.length && <p className="financial-ledger-status">화면에는 앞 100개 원재원만 표시합니다. 상단 합계는 전체 {cohortBuckets.length.toLocaleString('ko-KR')}개를 사용합니다.</p>}
    </section>
  );
}
