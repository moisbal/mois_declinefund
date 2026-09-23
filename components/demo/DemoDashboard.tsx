import DemoNavigation from './DemoNavigation';
import { calculateDemoSummary, demoProjects, formatDemoWon } from '../../lib/demo/data';

const summary = calculateDemoSummary(demoProjects);

export default function DemoDashboard() {
  return (
    <div className="dashboard-shell demo-shell">
      <DemoNavigation />
      <main>
        <section className="demo-readonly-notice" role="status">
          <strong>공개 데모 모드</strong>
          <span>아래 수치는 가상의 예시이며 실제 사업·지역·사용자 데이터와 연결되지 않습니다.</span>
        </section>

        <section className="summary-banner">
          <div>
            <div className="banner-title">전국 기금 집행 개요</div>
            <div className="banner-sub">대시보드와 통계 화면의 구성·집계 방식을 체험할 수 있습니다.</div>
          </div>
        </section>

        <section className="kpi-grid" aria-label="데모 핵심 지표">
          <div className="kpi-card"><div className="kpi-label">사업 개수</div><div className="kpi-value">{summary.projectCount}</div></div>
          <div className="kpi-card"><div className="kpi-label">조정 후 배분액</div><div className="kpi-value kpi-money-value">{formatDemoWon(summary.allocation)}</div></div>
          <div className="kpi-card"><div className="kpi-label">누적 집행액</div><div className="kpi-value kpi-money-value">{formatDemoWon(summary.execution)}</div></div>
          <div className="kpi-card"><div className="kpi-label">가중 집행률</div><div className="kpi-value">{summary.rate.toFixed(1)}%</div></div>
        </section>

        <section className="panel">
          <h2>예시 사업 목록</h2>
          <p className="panel-sub">입력·수정·다운로드는 공개 데모에서 비활성화되어 있습니다.</p>
          <div className="table-scroll">
            <table>
              <thead><tr><th>광역</th><th>시군구</th><th>사업명</th><th>사업구분</th><th className="num">조정 후 배분액</th><th className="num">누적 집행액</th><th className="num">집행률</th><th>상태</th></tr></thead>
              <tbody>
                {demoProjects.map((project) => {
                  const rate = (project.execution / project.allocation) * 100;
                  return <tr key={project.id}><td>{project.region}</td><td>{project.sigungu}</td><td>{project.projectName}</td><td>{project.lifecycle === 'new' ? '신규' : '계속'}</td><td className="num">{formatDemoWon(project.allocation)}</td><td className="num">{formatDemoWon(project.execution)}</td><td className="num">{rate.toFixed(1)}%</td><td>{project.status}</td></tr>;
                })}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
