import { NextResponse } from 'next/server';
import { supabaseAdmin } from '../../../../lib/supabaseAdmin';
import { isPublicDemoMode, PUBLIC_DEMO_DISABLED_MESSAGE } from '../../../../lib/demo-mode';
import {
  aggregateProjectFundingSummary,
  overlayFundingPosition,
  type ProjectFundingPosition,
} from '../../../../lib/fundingManagement';
import { POSTGREST_IN_FILTER_CHUNK_SIZE } from '../../../../lib/postgrest';

const AGGREGATION_PAGE_SIZE = POSTGREST_IN_FILTER_CHUNK_SIZE;

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (isPublicDemoMode) {
    return NextResponse.json({ message: PUBLIC_DEMO_DISABLED_MESSAGE }, { status: 403 });
  }

  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) {
    return NextResponse.json({ message: '로그인이 필요합니다.' }, { status: 401 });
  }

  const token = authorization.slice('Bearer '.length);
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData.user?.id) {
    return NextResponse.json({ message: '로그인 정보를 확인할 수 없습니다.' }, { status: 401 });
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('role, region_id')
    .eq('id', userData.user.id)
    .single();

  if (profileError || !profile || !['admin', 'local_user'].includes(profile.role)) {
    return NextResponse.json({ message: '사업 통계를 조회할 권한이 없습니다.' }, { status: 403 });
  }
  if (profile.role === 'local_user' && !profile.region_id) {
    return NextResponse.json({ message: '지역 정보가 없는 사용자입니다.' }, { status: 403 });
  }

  const regionId = profile.role === 'local_user' ? profile.region_id : null;
  let countQuery = supabaseAdmin
    .from('projects')
    .select('project_code', { count: 'exact', head: true })
    .is('deleted_at', null)
    .not('project_code', 'is', null);
  if (regionId) {
    countQuery = countQuery.eq('region_id', regionId);
  }

  const { count, error: countError } = await countQuery;
  if (countError) {
    console.error('Project summary count failed', countError);
    return NextResponse.json({ message: '사업 건수를 집계하지 못했습니다.' }, { status: 500 });
  }

  const projectCount = count ?? 0;
  const pageCount = Math.ceil(projectCount / AGGREGATION_PAGE_SIZE);
  let positionQuery = supabaseAdmin
    .from('financial_project_funding_positions')
    .select('*');
  if (regionId) {
    positionQuery = positionQuery.eq('region_id', regionId);
  }

  let pages;
  try {
    // The Ledger projection currently contains only Ledger-managed projects.
    // Read it once, scoped to the already-authorized region, instead of asking
    // PostgREST to expand the underlying aggregate view once per project page.
    // Repeating that view query caused the serverless KPI request to time out.
    const { data: positionData, error: positionError } = await positionQuery;
    if (positionError) throw positionError;
    const positions = (positionData ?? []).map((row) => ({
      ...row,
      project_id: String(row.project_id),
      region_id: String(row.region_id),
      fiscal_year: Number(row.fiscal_year),
      ledger_original_allocation: String(row.ledger_original_allocation ?? '0'),
      ledger_adjusted_allocation: String(row.ledger_adjusted_allocation ?? '0'),
      ledger_increase_amount: String(row.ledger_increase_amount ?? '0'),
      ledger_decrease_amount: String(row.ledger_decrease_amount ?? '0'),
      ledger_execution_amount: String(row.ledger_execution_amount ?? '0'),
      ledger_execution_rate: Number(row.ledger_execution_rate ?? 0),
      current_wallet_balance: String(row.current_wallet_balance ?? '0'),
      unclassified_decrease_amount: String(row.unclassified_decrease_amount ?? '0'),
      projection_ready: Boolean(row.projection_ready),
    })) as ProjectFundingPosition[];

    pages = await Promise.all(
      Array.from({ length: pageCount }, async (_, pageIndex) => {
        const from = pageIndex * AGGREGATION_PAGE_SIZE;
        let pageQuery = supabaseAdmin
          .from('projects')
          .select('id, total_budget_text:total_budget::text, alloc_text:alloc::text, exec_text:exec::text')
          .is('deleted_at', null)
          .not('project_code', 'is', null)
          .order('project_code', { ascending: true })
          .order('id', { ascending: true })
          .range(from, from + AGGREGATION_PAGE_SIZE - 1);
        if (regionId) {
          pageQuery = pageQuery.eq('region_id', regionId);
        }

        const { data, error } = await pageQuery;
        if (error) throw error;
        const projectRows = data ?? [];
        return projectRows.map((project) => overlayFundingPosition(project, positions));
      }),
    );
  } catch (error) {
    console.error('Project summary aggregation failed', error);
    return NextResponse.json({ message: '사업 집계 중 오류가 발생했습니다.' }, { status: 500 });
  }

  const summary = aggregateProjectFundingSummary(pages.flat());

  return NextResponse.json({
    projectCount,
    ...summary,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
