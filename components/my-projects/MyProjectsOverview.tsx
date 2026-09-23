import { formatIntegerString, formatWonAsManwonWithUnit } from '../../lib/amountFormat';
import {
  getProjectLifecycleLabel,
  type MyProjectListItem,
} from '../../lib/myProjects';

type MyProjectsOverviewProps = {
  projects: MyProjectListItem[];
  regionName: string | null;
};

type YearSummary = {
  year: number;
  allocation: bigint;
  execution: bigint;
};

function toAmount(value: string | null) {
  return value !== null && /^\d+$/.test(value) ? BigInt(value) : BigInt(0);
}

function getRate(execution: bigint, allocation: bigint) {
  if (allocation === BigInt(0)) return 0;
  return Number((execution * BigInt(1000)) / allocation) / 10;
}

function getBarWidth(value: bigint, maximum: bigint) {
  if (maximum === BigInt(0)) return 0;
  return Number((value * BigInt(10000)) / maximum) / 100;
}

export default function MyProjectsOverview({ projects, regionName }: MyProjectsOverviewProps) {
  const totalAllocation = projects.reduce((total, project) => total + toAmount(project.alloc_text), BigInt(0));
  const totalExecution = projects.reduce((total, project) => total + toAmount(project.exec_text), BigInt(0));
  const newProjectCount = projects.filter((project) => getProjectLifecycleLabel(project) === '신규사업').length;
  const continuingProjectCount = projects.filter((project) => getProjectLifecycleLabel(project) === '계속사업').length;
  const statusCounts = ['정상추진', '완료', '지연', '추진곤란', '상태 미입력'].map((status) => ({
    status,
    count: projects.filter((project) => (project.status ?? '상태 미입력') === status).length,
  })).filter((item) => item.count > 0);

  const yearlySummaries = Array.from(projects.reduce((summary, project) => {
    if (project.year === null) return summary;
    const current = summary.get(project.year) ?? {
      year: project.year,
      allocation: BigInt(0),
      execution: BigInt(0),
    };
    current.allocation += toAmount(project.alloc_text);
    current.execution += toAmount(project.exec_text);
    summary.set(project.year, current);
    return summary;
  }, new Map<number, YearSummary>()).values()).sort((left, right) => left.year - right.year);
  const yearlyMaximum = yearlySummaries.reduce((maximum, item) => {
    const itemMaximum = item.execution > item.allocation ? item.execution : item.allocation;
    return itemMaximum > maximum ? itemMaximum : maximum;
  }, BigInt(0));
  const displayRegionName = regionName ?? '내 지역';

  return (
    <section className="my-projects-overview" aria-labelledby="my-projects-overview-title">
      <div className="my-projects-overview-heading">
        <div>
          <p>{displayRegionName} 담당 사업 전체 현황</p>
          <h2 id="my-projects-overview-title">기금 배분·집행 현황</h2>
          <span>아래 현황은 검색 조건과 무관한 담당 사업 전체 기준입니다.</span>
        </div>
        <strong>{projects.length.toLocaleString('ko-KR')}건</strong>
      </div>

      <div className="my-projects-overview-kpis">
        <div>
          <span>총 배분액</span>
          <strong title={`${formatIntegerString(totalAllocation.toString())}원`}>{formatWonAsManwonWithUnit(totalAllocation.toString())}</strong>
        </div>
        <div>
          <span>총 집행액</span>
          <strong title={`${formatIntegerString(totalExecution.toString())}원`}>{formatWonAsManwonWithUnit(totalExecution.toString())}</strong>
        </div>
        <div>
          <span>전체 집행률</span>
          <strong>{getRate(totalExecution, totalAllocation).toFixed(1)}%</strong>
        </div>
        <div>
          <span>신규 / 계속</span>
          <strong>{newProjectCount.toLocaleString('ko-KR')} / {continuingProjectCount.toLocaleString('ko-KR')}건</strong>
        </div>
      </div>

      <div className="my-projects-overview-charts">
        <div className="my-projects-year-chart">
          <div className="my-projects-chart-heading">
            <h3>연도별 배분액 대비 집행액</h3>
            <span><i className="allocation" aria-hidden="true" />배분액 <i className="execution" aria-hidden="true" />집행액</span>
          </div>
          <div role="img" aria-label="연도별 배분액과 집행액 비교 그래프" className="my-projects-year-rows">
            {yearlySummaries.map((item) => (
              <div className="my-projects-year-row" key={item.year}>
                <strong>{item.year}년</strong>
                <div className="my-projects-year-bars">
                  <div><span className="allocation" style={{ width: `${getBarWidth(item.allocation, yearlyMaximum)}%` }} /></div>
                  <div><span className="execution" style={{ width: `${getBarWidth(item.execution, yearlyMaximum)}%` }} /></div>
                </div>
                <span className="my-projects-year-values">
                  {formatWonAsManwonWithUnit(item.allocation.toString())} / {formatWonAsManwonWithUnit(item.execution.toString())}
                </span>
              </div>
            ))}
            {!yearlySummaries.length && <p className="empty-state">연도 정보가 있는 사업이 없습니다.</p>}
          </div>
        </div>

        <div className="my-projects-status-chart" aria-label="집행상태별 사업 수">
          <h3>집행상태별 사업 수</h3>
          <div>
            {statusCounts.map((item) => (
              <div className="my-projects-status-row" key={item.status}>
                <span>{item.status}</span>
                <div aria-hidden="true"><i style={{ width: `${projects.length ? (item.count / projects.length) * 100 : 0}%` }} /></div>
                <strong>{item.count.toLocaleString('ko-KR')}건</strong>
              </div>
            ))}
            {!statusCounts.length && <p className="empty-state">집행상태가 입력된 사업이 없습니다.</p>}
          </div>
        </div>
      </div>
    </section>
  );
}
