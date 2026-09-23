import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  formatProjectOption,
  formatProjectReference,
  formatBudgetChangeReasonForDisplay,
  formatStoredUserText,
  getProjectSearchText,
  getRawProjectSearchTokens,
  sanitizeClassificationNameForDisplay,
  sanitizeProjectNameForDisplay,
} from '../../lib/presentationLabels.ts';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('사업 표시는 사업명만 사용하고 내부 등록번호를 붙이지 않는다', () => {
  assert.equal(formatProjectReference({
    project_name: '백년송도 해양문화복합플랫폼 건립',
    project_code: '2025-26-140-9001',
    status: 'APPLIED',
  }), '백년송도 해양문화복합플랫폼 건립');
  assert.equal(formatProjectOption({
    fiscal_year: 2025,
    project_name: '백년송도 해양문화복합플랫폼 건립',
    project_code: '2025-26-140-9001',
    status: 'APPLIED',
  }), '2025 · 백년송도 해양문화복합플랫폼 건립');
});

test('시험 실행 식별자와 영문 단계명은 구분값을 보존한 한글 표시명으로 바꾼다', () => {
  const cases: Array<[string, number, string]> = [
    ['UAT 신규사업 D 예정재원', 2025, '사용자 검증 · 신규사업 시나리오 라 예정재원'],
    ['UAT 2025 신규사업 연계 검증', 2025, '사용자 검증 · 신규사업 연계 검증'],
    ['GENERIC-BUDGET-UAT 2025 양구 신규사업', 2025, '일반 예산 사용자 검증 · 양구 신규사업'],
    ['AUTO-BUDGET-UAT 2025 양구 신규사업', 2025, '자동 예산 사용자 검증 · 양구 신규사업'],
    ['AUTO-UAT-20260826-180000 REJECTED', 2025, '자동 사용자 검증 · 20260826-180000 · 반려 확인'],
    ['AUTO-UAT-20260826-180000 RAW 9999W', 2025, '자동 사용자 검증 · 20260826-180000 · 9,999원 경계값'],
    ['AUTO-UAT-20260826-180000 GOLDEN', 2025, '자동 사용자 검증 · 20260826-180000 · 기준 시험자료'],
    ['TEST 시연 부산 차년도 의료생활 지원사업 20260908051304', 2027, '시험 시연 부산 차년도 의료생활 지원사업 20260908051304'],
    ['2025-26-140-901', 2025, '사업명 확인 필요'],
  ];
  for (const [raw, year, expected] of cases) {
    assert.equal(sanitizeProjectNameForDisplay(raw, year), expected);
  }
});

test('소분류명은 영문 시험 식별자를 제거하고 업무용 한글 이름으로 표시한다', () => {
  assert.equal(sanitizeClassificationNameForDisplay('UAT 반려 mtl3ai8h'), '사용자 검증 · 반려 검증 소분류');
  assert.equal(sanitizeClassificationNameForDisplay('UAT 매핑 mtl3ai8h'), '사용자 검증 · 기존분류 연결 소분류');
  assert.equal(sanitizeClassificationNameForDisplay('UAT 복합지원 mtl38qts'), '사용자 검증 · 복합지원');
  assert.equal(sanitizeClassificationNameForDisplay('GENERIC RAW mtl38qts'), '분류명 확인 필요');
});

test('확인된 시험 사유와 연구개발 약어만 한글 표시하고 사용자 원문은 보존한다', () => {
  assert.equal(formatStoredUserText('autonomous UAT rejection'), '자동 사용자 검증 반려');
  assert.equal(
    formatStoredUserText('AUTO-UAT-20260826-180000 autonomous UAT rejection'),
    '자동 사용자 검증 · 20260826-180000 · 자동 사용자 검증 반려',
  );
  assert.equal(formatStoredUserText('의료 R&D 산업 클러스터 조성'), '의료 연구개발 산업 클러스터 조성');
  assert.equal(
    formatStoredUserText('반려 RPC status ambiguity 수정 검증'),
    '반려 처리 함수 상태 모호성 수정 검증',
  );
  assert.equal(
    formatStoredUserText('DRAFT upsert workflow 검증 후 금액 영향 없이 반려'),
    '임시저장 갱신 처리 흐름 검증 후 금액 영향 없이 반려',
  );
  assert.equal(formatStoredUserText('House 브랜드 협력 검토'), 'House 브랜드 협력 검토');
  assert.equal(
    formatStoredUserText('TEST-OPS-20260914164057 기존사업 예산배분'),
    '시험 업무 검증 · 실행 20260914-164057 기존사업 예산배분',
  );
  assert.equal(
    formatStoredUserText('[TEST-UAT-202609141419] 지자체 조치: 사업명과 원천 예정재원을 확인했습니다.'),
    '시험 사용자 검증 · 실행 20260914-1419 지자체 조치: 사업명과 원천 예정재원을 확인했습니다.',
  );
  assert.equal(
    formatStoredUserText('TEST 미연결 사업 A 감액 후 기존사업 B 배분'),
    '시험 미연결 사업 시나리오 가 감액 후 기존사업 시나리오 나 배분',
  );
  assert.equal(
    sanitizeProjectNameForDisplay('[TEST-UAT-202609141419] 신규사업', 2027),
    '시험 사용자 검증 · 실행 20260914-1419 신규사업',
  );
});

test('예산조정 사유의 영문 금액과 A/B/C/D 별칭은 실제 사업명 또는 한글로 표시한다', () => {
  assert.equal(
    formatBudgetChangeReasonForDisplay({ reason: '기존사업+신규사업 혼합 100m' }),
    '기존사업+신규사업 혼합 1억원',
  );
  assert.equal(
    formatBudgetChangeReasonForDisplay({
      reason: 'A 1천만원을 B 3백만원·C 2백만원·신규 D 5백만원으로 배분',
      fiscal_year: 2027,
      source_project_name: '출처 사업',
      destinations: [
        { line_no: 1, destination_project_name: '첫째 목적지' },
        { line_no: 2, destination_project_name: '둘째 목적지' },
        { line_no: 3, planned_project_name: '셋째 신규사업' },
      ],
    }),
    '출처 사업 1천만원을 첫째 목적지 3백만원·둘째 목적지 2백만원·신규 셋째 신규사업 5백만원으로 배분',
  );
});

test('한글 표시명과 원본 이름 모두 검색 색인에 남는다', () => {
  const searchText = getProjectSearchText({
    fiscal_year: 2025,
    project_name: 'AUTO-UAT-20260826-180000 GOLDEN',
  });
  assert.match(searchText, /자동 사용자 검증/);
  assert.match(searchText, /기준 시험자료/);
  assert.match(searchText, /AUTO-UAT-20260826-180000 GOLDEN/);
  assert.deepEqual(
    getRawProjectSearchTokens('자동 사용자 검증 · 20260826-180000 · 기준 시험자료'),
    [['AUTO-UAT'], ['20260826-180000'], ['GOLDEN']],
  );
  assert.deepEqual(
    getRawProjectSearchTokens('사용자 검증 · 순창 신규사업 시나리오 나'),
    [['UAT'], ['순창'], ['신규사업'], ['B']],
  );
  assert.deepEqual(getRawProjectSearchTokens('의료 연구개발'), [['의료'], ['연구개발', 'R&D']]);
});

test('주요 업무 화면은 사업코드 열·보조표시·계정 이메일을 노출하지 않는다', () => {
  const newProject = read('components/my-projects/NewProjectRequestPanel.tsx');
  const myProjects = read('components/my-projects/MyProjectsShell.tsx');
  const dashboardTable = read('components/dashboard/ProjectTable.tsx');
  const dashboardOverview = read('components/dashboard/OverviewPanel.tsx');
  const review = read('components/admin/ProjectReviewDetailPanel.tsx');
  const header = read('components/common/Header.tsx');
  const proposalManagement = read('components/admin/CustomSmallCategoryReviewPanel.tsx');
  const fundingManagement = read('components/admin/FundingManagementShell.tsx');
  const confirmationCenter = read('components/confirmations/ConfirmationCenterShell.tsx');

  assert.doesNotMatch(newProject, /<th>공식 사업코드<\/th>|presentation\.codeLabel/);
  assert.doesNotMatch(myProjects, /my-project-code|codeLabel|\[테스트\]/);
  assert.doesNotMatch(dashboardTable, /사업코드\(보조\)|getProjectDisplayCode/);
  assert.doesNotMatch(dashboardOverview, /데이터를 불러오는 중 오류가 발생했습니다:\s*\{error\}/);
  assert.match(dashboardOverview, /<ErrorState>/);
  assert.match(dashboardOverview, /다시 시도/);
  assert.doesNotMatch(review, /presentation\.codeLabel|<dt>사업코드<\/dt>|\[테스트\]/);
  assert.doesNotMatch(header, /userEmail|session\.user\.email/);
  assert.doesNotMatch(proposalManagement, /<strong>\{item\.input_value\}<\/strong>/);
  assert.match(proposalManagement, /sanitizeClassificationNameForDisplay/);
  assert.doesNotMatch(fundingManagement, /신규사업 요청 식별값\s*\{request\.id\}/);
  assert.match(confirmationCenter, /sanitizeProjectNameForDisplay/);
  assert.match(confirmationCenter, /formatStoredUserText\(notification\.body/);
  assert.doesNotMatch(confirmationCenter, />\{selected\.(?:requested_by|replied_by|completed_by)\}</);
});
