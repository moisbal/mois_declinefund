import { NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import { supabaseAdmin } from '../../../../../lib/supabaseAdmin';
import { isPublicDemoMode, PUBLIC_DEMO_DISABLED_MESSAGE } from '../../../../../lib/demo-mode';
import {
  SIMILARITY_RELATIONSHIP_LABELS,
} from '../../../../../lib/projectChange';
import { assertLedgerTestTarget } from '../../../../../lib/ledgerRuntime';
import {
  formatSmallCategoryProposalStatus,
  formatStoredUserText,
  formatSystemTerm,
  sanitizeClassificationNameForDisplay,
  sanitizeProjectNameForDisplay,
} from '../../../../../lib/presentationLabels';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function text(value: unknown) {
  return value === null || value === undefined ? '' : String(value);
}

function snapshot(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function relatedNames(value: unknown) {
  return Array.isArray(value)
    ? value.flatMap((item) => item && typeof item === 'object' && 'name' in item
      ? [sanitizeClassificationNameForDisplay(text(item.name), '')]
      : []).join(', ')
    : '';
}

function styleSheet(sheet: ExcelJS.Worksheet) {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: `${sheet.getColumn(sheet.columnCount).letter}1` };
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF245A92' } };
  header.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.eachRow((row, rowNumber) => {
    row.alignment = { vertical: 'top', wrapText: true };
    if (rowNumber > 1) row.height = 30;
  });
}

async function requireAdmin(request: Request) {
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(authorization.slice(7));
  if (error || !data.user?.id) return null;
  const { data: profile } = await supabaseAdmin.from('profiles').select('role').eq('id', data.user.id).single();
  return profile?.role === 'admin' ? data.user.id : null;
}

export async function GET(request: Request) {
  try {
    assertLedgerTestTarget();
  } catch {
    return NextResponse.json({ message: '검증된 시험 환경에서만 내려받을 수 있습니다.' }, { status: 503 });
  }
  if (isPublicDemoMode) return NextResponse.json({ message: PUBLIC_DEMO_DISABLED_MESSAGE }, { status: 403 });
  if (!await requireAdmin(request)) return NextResponse.json({ message: '접근 권한이 없습니다.' }, { status: 403 });

  const url = new URL(request.url);
  const year = Number(url.searchParams.get('year')) || null;
  const sido = url.searchParams.get('sido')?.trim() || null;
  const sigungu = url.searchParams.get('sigungu')?.trim() || null;
  const projectCode = url.searchParams.get('projectCode')?.trim() || null;
  const oldName = url.searchParams.get('oldName')?.trim() || null;
  const newName = url.searchParams.get('newName')?.trim() || null;
  const basisCode = url.searchParams.get('basisCode')?.trim() || null;
  const reasonCode = url.searchParams.get('reasonCode')?.trim() || null;
  const status = url.searchParams.get('status')?.trim() || null;
  const similarity = url.searchParams.get('hasSimilarity');
  const dateFrom = url.searchParams.get('dateFrom')?.trim() || null;
  const dateTo = url.searchParams.get('dateTo')?.trim() || null;

  let regionIds: string[] | null = null;
  if (sido || sigungu) {
    let regionQuery = supabaseAdmin.from('regions').select('id');
    if (sido) regionQuery = regionQuery.eq('sido', sido);
    if (sigungu) regionQuery = regionQuery.eq('sigungu', sigungu);
    const { data: regions, error: regionError } = await regionQuery;
    if (regionError) {
      console.error('Project change export region lookup failed', regionError);
      return NextResponse.json({ message: '지역 조건을 확인하지 못했습니다.' }, { status: 500 });
    }
    regionIds = (regions ?? []).map((region) => region.id);
  }

  let query = supabaseAdmin.from('project_change_events')
    .select('*, regions(sido, sigungu, display_name)')
    .order('changed_at', { ascending: false });
  if (regionIds) {
    if (regionIds.length === 0) query = query.eq('region_id', '00000000-0000-0000-0000-000000000000');
    else query = query.in('region_id', regionIds);
  }
  if (year) query = query.eq('fiscal_year', year);
  if (projectCode) query = query.ilike('project_code', `%${projectCode}%`);
  if (oldName) query = query.ilike('old_name', `%${oldName}%`);
  if (newName) query = query.ilike('new_name', `%${newName}%`);
  if (basisCode) query = query.eq('change_basis_code', basisCode);
  if (reasonCode) query = query.contains('change_reason_codes', [reasonCode]);
  if (status) query = query.eq('status', status);
  if (similarity === 'true' || similarity === 'false') query = query.eq('similarity_candidate', similarity === 'true');
  if (dateFrom) query = query.gte('changed_at', `${dateFrom}T00:00:00`);
  if (dateTo) query = query.lte('changed_at', `${dateTo}T23:59:59.999`);

  const { data, error } = await query;
  if (error) {
    console.error('Project change export query failed', error);
    return NextResponse.json({ message: '사업변경 내보내기 자료를 조회하지 못했습니다.' }, { status: 500 });
  }
  const events = (data ?? []).map((row: any) => ({ ...row, regions: one(row.regions) }));

  const actorIds = [...new Set(events.map((row) => row.changed_by).filter(Boolean))];
  const { data: actors } = actorIds.length > 0
    ? await supabaseAdmin.from('profiles').select('id, name, login_id, email').in('id', actorIds)
    : { data: [] };
  const actorLabels = new Map((actors ?? []).map((actor) => [actor.id, actor.name && !/[A-Za-z@]/.test(actor.name) ? actor.name : '사용자']));
  const projectIds = [...new Set(events.map((row) => row.project_id))];

  const [{ data: decisions }, { data: proposals }] = await Promise.all([
    projectIds.length > 0
      ? supabaseAdmin.from('project_similarity_decisions')
        .select('source_project_id, source_project_name, candidate_project_id, candidate_similarity, relationship_type, decided_at, source:projects!project_similarity_decisions_source_project_id_fkey(project_code), candidate:projects!project_similarity_decisions_candidate_project_id_fkey(project_code, project_name, fund_project_name, detail_project_name)')
        .in('source_project_id', projectIds)
      : Promise.resolve({ data: [] }),
    projectIds.length > 0
      ? supabaseAdmin.from('project_small_category_proposals')
        .select('project_id, project_code, proposed_name, proposal_reason, status, rejection_reason, created_at, reviewed_at, regions(display_name), projects(project_name, fund_project_name, detail_project_name, year), middle_categories!project_small_category_proposals_recommended_middle_category_id_fkey(name)')
        .in('project_id', projectIds)
      : Promise.resolve({ data: [] }),
  ]);
  const decisionByProjectAndName = new Map<string, any>();
  for (const raw of decisions ?? []) {
    const row: any = raw;
    const key = `${row.source_project_id}::${row.source_project_name}`;
    if (!decisionByProjectAndName.has(key)) decisionByProjectAndName.set(key, row);
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = '지방소멸대응기금 시험 시스템';
  workbook.created = new Date();

  const changes = workbook.addWorksheet('사업변경 이력');
  changes.columns = [
    ['변경일시', 22], ['시도', 12], ['시군구', 14], ['사업연도', 10],
    ['변경 전 사업명', 28], ['변경 후 사업명', 28], ['변경 근거', 22], ['기타 변경 근거', 24],
    ['변경 사유', 35], ['기타 변경 사유', 24], ['상세 변경내용', 40],
    ['기존 대분류', 18], ['변경 대분류', 18], ['기존 중분류', 18], ['변경 중분류', 18],
    ['기존 대표 소분류', 22], ['변경 대표 소분류', 22], ['관련 소분류', 35],
    ['유사사업 여부', 14], ['유사사업명', 28], ['관계유형', 24], ['변경자', 18], ['처리상태', 14], ['재정 영향', 20],
  ].map(([header, width]) => ({ header: String(header), key: String(header), width: Number(width) }));
  for (const event of events) {
    const oldClass = snapshot(event.old_classification);
    const newClass = snapshot(event.new_classification);
    const decision = decisionByProjectAndName.get(`${event.project_id}::${event.new_name}`);
    const candidate = one<any>(decision?.candidate);
    changes.addRow({
      변경일시: new Date(event.changed_at).toLocaleString('ko-KR'), 시도: event.regions?.sido ?? '', 시군구: event.regions?.sigungu ?? '', 사업연도: event.fiscal_year ?? '',
      '변경 전 사업명': sanitizeProjectNameForDisplay(event.old_name, event.fiscal_year), '변경 후 사업명': sanitizeProjectNameForDisplay(event.new_name, event.fiscal_year), '변경 근거': event.change_basis_label ?? '', '기타 변경 근거': formatStoredUserText(event.other_basis, ''),
      '변경 사유': (event.change_reason_labels ?? []).join(', '), '기타 변경 사유': formatStoredUserText(event.other_reason, ''), '상세 변경내용': formatStoredUserText(event.detail, ''),
      '기존 대분류': sanitizeClassificationNameForDisplay(text(oldClass.large_category_name), ''), '변경 대분류': sanitizeClassificationNameForDisplay(text(newClass.large_category_name), ''), '기존 중분류': sanitizeClassificationNameForDisplay(text(oldClass.middle_category_name), ''), '변경 중분류': sanitizeClassificationNameForDisplay(text(newClass.middle_category_name), ''),
      '기존 대표 소분류': sanitizeClassificationNameForDisplay(text(oldClass.primary_small_category_name), ''), '변경 대표 소분류': sanitizeClassificationNameForDisplay(text(newClass.primary_small_category_name), ''), '관련 소분류': relatedNames(newClass.related_small_categories),
      '유사사업 여부': event.similarity_candidate ? '있음' : '없음',
      유사사업명: sanitizeProjectNameForDisplay(candidate?.detail_project_name || candidate?.fund_project_name || candidate?.project_name),
      관계유형: event.similarity_result ? SIMILARITY_RELATIONSHIP_LABELS[event.similarity_result as keyof typeof SIMILARITY_RELATIONSHIP_LABELS] ?? formatSystemTerm(event.similarity_result, '관계 확인 필요') : '',
      변경자: actorLabels.get(event.changed_by) ?? '사용자', 처리상태: event.status === 'COMPLETED' ? '변경완료' : '확인 필요', '재정 영향': '재정금액 영향 없음',
    });
  }
  styleSheet(changes);

  const links = workbook.addWorksheet('유사사업 연계');
  links.columns = [['판단일시', 22], ['원 사업명', 28], ['유사사업명', 28], ['유사도', 12], ['관계유형', 26]].map(([header, width]) => ({ header: String(header), key: String(header), width: Number(width) }));
  for (const raw of decisions ?? []) {
    const row: any = raw;
    const candidate = one<any>(row.candidate);
    links.addRow({ 판단일시: row.decided_at ? new Date(row.decided_at).toLocaleString('ko-KR') : '', '원 사업명': sanitizeProjectNameForDisplay(row.source_project_name), '유사사업명': sanitizeProjectNameForDisplay(candidate?.detail_project_name || candidate?.fund_project_name || candidate?.project_name), 유사도: row.candidate_similarity == null ? '' : `${Math.round(Number(row.candidate_similarity) * 100)}%`, 관계유형: SIMILARITY_RELATIONSHIP_LABELS[row.relationship_type as keyof typeof SIMILARITY_RELATIONSHIP_LABELS] ?? formatSystemTerm(row.relationship_type, '관계 확인 필요') });
  }
  styleSheet(links);

  const proposalSheet = workbook.addWorksheet('소분류 제안·처리');
  proposalSheet.columns = [['제안일시', 22], ['신청 지자체', 18], ['사업명', 28], ['사업연도', 10], ['제안 소분류명', 24], ['제안사유', 40], ['추천 중분류', 22], ['처리상태', 16], ['반려사유', 30], ['처리일시', 22]].map(([header, width]) => ({ header: String(header), key: String(header), width: Number(width) }));
  for (const raw of proposals ?? []) {
    const row: any = raw;
    const project = one<any>(row.projects);
    const region = one<any>(row.regions);
    const middle = one<any>(row.middle_categories);
    proposalSheet.addRow({ 제안일시: new Date(row.created_at).toLocaleString('ko-KR'), '신청 지자체': region?.display_name ?? '', 사업명: sanitizeProjectNameForDisplay(project?.detail_project_name || project?.fund_project_name || project?.project_name, project?.year), 사업연도: project?.year ?? '', '제안 소분류명': sanitizeClassificationNameForDisplay(row.proposed_name), 제안사유: formatStoredUserText(row.proposal_reason, '제안 사유 미입력'), '추천 중분류': sanitizeClassificationNameForDisplay(middle?.name, '중분류 확인 필요'), 처리상태: formatSmallCategoryProposalStatus(row.status), 반려사유: formatStoredUserText(row.rejection_reason, ''), 처리일시: row.reviewed_at ? new Date(row.reviewed_at).toLocaleString('ko-KR') : '' });
  }
  styleSheet(proposalSheet);

  const buffer = await workbook.xlsx.writeBuffer();
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="project-changes-${new Date().toISOString().slice(0, 10)}.xlsx"`,
      'Cache-Control': 'no-store',
      'X-Export-Row-Count': String(events.length),
    },
  });
}
