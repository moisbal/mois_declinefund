import { Suspense } from 'react';
import AnalyticsShell from '../../../components/analytics/AnalyticsShell';

export default function DemoAnalyticsPage() {
  return (
    <Suspense fallback={<div className="loading-shell">데모 통계 화면을 준비하는 중입니다...</div>}>
      <AnalyticsShell mode="demo" />
    </Suspense>
  );
}
