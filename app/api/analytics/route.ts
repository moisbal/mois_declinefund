import { NextResponse } from 'next/server';
import { parseAnalyticsFilters } from '../../../lib/analytics/filters';
import { authenticateAnalyticsUser, getAnalyticsResult } from '../../../lib/analytics/queries';
import type { AnalyticsRow } from '../../../lib/analytics/types';
import { isPublicDemoMode, PUBLIC_DEMO_DISABLED_MESSAGE } from '../../../lib/demo-mode';
import { queryBudgetChangeStatistics, queryFundingAnalytics } from '../../../lib/fundingAnalytics';

export const dynamic = 'force-dynamic';

function csvCell(value: string | number | null) {
  const text = value === null ? '자료 없음' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function csvFromRows(rows: AnalyticsRow[]) {
  const header = ['구분', '사업수', '조정후배분액(원)', '누적집행액(원)', '미집행액(원)', '집행률(%)', '당초배분액(원)', '당초배분액 대비 실제집행 비율(%)'];
  const values = rows.map((row) => [
    row.label,
    row.projectCount,
    row.adjustedAllocation,
    row.cumulativeExecution,
    row.unexecutedAmount,
    row.executionRate === null ? null : row.executionRate.toFixed(4),
    row.originalAllocation,
    row.originalExecutionRate === null ? null : row.originalExecutionRate.toFixed(4),
  ].map(csvCell).join(','));
  return `\uFEFF${[header.map(csvCell).join(','), ...values].join('\r\n')}`;
}

export async function GET(request: Request) {
  if (isPublicDemoMode) {
    return NextResponse.json({ message: PUBLIC_DEMO_DISABLED_MESSAGE }, { status: 403 });
  }

  try {
    const authorization = request.headers.get('authorization') ?? '';
    if (!authorization.startsWith('Bearer ')) {
      return NextResponse.json({ message: '로그인이 필요합니다.' }, { status: 401 });
    }

    const url = new URL(request.url);
    const filters = parseAnalyticsFilters(url.searchParams);
    const accessToken = authorization.slice('Bearer '.length);
    const profile = await authenticateAnalyticsUser(accessToken);
    const csv = url.searchParams.get('format') === 'csv';
    const [result, funding, budgetChangeStatistics] = await Promise.all([
      getAnalyticsResult(filters, profile, csv ? Number.MAX_SAFE_INTEGER : undefined),
      !csv && filters.timeBasis === 'current' ? queryFundingAnalytics(accessToken, filters) : Promise.resolve(null),
      !csv && filters.timeBasis === 'current' ? queryBudgetChangeStatistics(accessToken, filters) : Promise.resolve(null),
    ]);

    if (!csv) {
      return NextResponse.json({ ...result, funding, budgetChangeStatistics }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    if (result.source === 'ledger_not_implemented') {
      return NextResponse.json({ message: result.sourceMessage }, { status: 409 });
    }

    return new NextResponse(csvFromRows(result.rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="analytics-${filters.groupBy}-${filters.asOf}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Analytics query failed', error);
    return NextResponse.json({ message: '통계 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' }, { status: 500 });
  }
}
