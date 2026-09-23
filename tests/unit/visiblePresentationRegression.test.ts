import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  formatProjectName,
  formatProjectOption,
  formatProjectReference,
  formatStoredUserText,
  getProjectSearchText,
  getRawProjectSearchTokens,
  isInternalTestIdentifier,
  sanitizeClassificationNameForDisplay,
  sanitizeProjectNameForDisplay,
} from '../../lib/presentationLabels.ts';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('재검증 실행 코드가 목록·유사 사업·상세의 공통 표시와 재표시에서 재발하지 않는다', () => {
  const cases = [
    ['TEST-RECHECK-20260915111205 부산 혼합 신규이관', '부산 혼합 신규이관'],
    ['TEST-RECHECK-20260915111205 부산 단일 신규이관', '부산 단일 신규이관'],
    ['[TEST-RECHECK-20260915111205] 양구 혼합 신규이관', '양구 혼합 신규이관'],
    ['순창 단일 신규이관 TEST-RECHECK-20260915111205', '순창 단일 신규이관'],
    ['TEST-FUTURE-CHECK-20260922-120000 부산 생활거점', '부산 생활거점'],
    ['TEST-RECHECK-20260915111205', '사업명 확인 필요'],
    ['[TEST-RECHECK-20260915111205]', '사업명 확인 필요'],
  ];
  for (const [raw, expected] of cases) {
    for (const field of ['project_name', 'detail_project_name', 'fund_project_name']) {
      const project = { year: 2027, [field]: raw };
      assert.equal(formatProjectName(project), expected);
      assert.equal(formatProjectReference(project), expected);
      assert.equal(formatProjectOption(project), `2027 · ${expected}`);
      assert.equal(sanitizeProjectNameForDisplay(expected, 2027), expected);
      assert.equal(isInternalTestIdentifier(raw), true);
      assert.ok(getProjectSearchText(project).includes(raw));
      assert.ok(getProjectSearchText(project).includes(expected));
    }
  }
});

test('시스템 안내와 기존 한글 변환·실제 영문 사업명은 반복 표시해도 보존한다', () => {
  const cases = [
    ['[삭제된 사업] TEST-RECHECK-20260915111205 부산 혼합 신규이관', '[삭제된 사업] 부산 혼합 신규이관'],
    ['[보관된 사업] TEST-RECHECK-20260915111205', '[보관된 사업] 사업명 확인 필요'],
    ['[변경 건] [TEST-UAT-202609141419] 신규사업', '[변경 건] 시험 사용자 검증 · 실행 20260914-1419 신규사업'],
    ['TEST-OPS-20260914164057 기존사업', '시험 업무 검증 · 실행 20260914-164057 기존사업'],
    ['House 브랜드 협력 사업', 'House 브랜드 협력 사업'],
    ['TEST-DRIVE 체험 사업', 'TEST-DRIVE 체험 사업'],
    ['AI 돌봄 서비스', 'AI 돌봄 서비스'],
  ];
  for (const [raw, expected] of cases) {
    const displayed = sanitizeProjectNameForDisplay(raw, 2027);
    assert.equal(displayed, expected);
    assert.equal(sanitizeProjectNameForDisplay(displayed, 2027), expected);
  }
});

test('저장된 알림·변경 사유의 재검증 실행 코드도 표시하지 않는다', () => {
  assert.equal(formatStoredUserText('[TEST-RECHECK-20260915111205] 부산 신규사업 확인'), '부산 신규사업 확인');
  assert.equal(formatStoredUserText('TEST-RECHECK-20260915111205'), '-');
  assert.equal(formatStoredUserText('House 브랜드 협력 검토'), 'House 브랜드 협력 검토');
});

test('유사 사업 안내와 상세 입력 초기값은 공통 표시 함수를 거친다', () => {
  const dialog = read('components/my-projects/SimilarProjectDialog.tsx');
  const shell = read('components/my-projects/MyProjectEditShell.tsx');
  const projects = read('lib/myProjects.ts');
  assert.match(dialog, /sanitizeProjectNameForDisplay\(sourceProjectName\)/);
  assert.match(dialog, /formatProjectReference\(\{ project_name: candidate\.projectName/);
  assert.match(dialog, /sanitizeClassificationNameForDisplay\(candidate\.classificationName/);
  assert.match(shell, /detailProjectName: getMyProjectDisplayName\(project\)/);
  assert.match(shell, /title=\{getMyProjectDisplayName\(project\)\}/);
  assert.match(projects, /return getProjectPresentation\(project\)\.name/);
});

test('자동 통합시험 실행 식별자는 원본 검색값을 보존하면서 한글 사업명으로 표시한다', () => {
  const trailing = '자동 통합시험 부산 생활거점 AUTO-INT-20260909-100000';
  const leading = 'AUTO-INT-20260909-130000 부산 차년도 공동배분';

  assert.equal(
    formatProjectName({ year: 2027, project_name: trailing }),
    '자동 통합시험 부산 생활거점 · 실행 20260909-100000',
  );
  assert.equal(
    formatProjectName({ year: 2027, project_name: leading }),
    '자동 통합시험 · 부산 차년도 공동배분 · 실행 20260909-130000',
  );
  assert.equal(isInternalTestIdentifier(trailing), true);
  assert.match(getProjectSearchText({ year: 2027, project_name: trailing }), /AUTO-INT-20260909-100000/);
  assert.deepEqual(
    getRawProjectSearchTokens('자동 통합시험 · 부산 생활거점 · 실행 20260909-100000'),
    [['AUTO-INT'], ['부산'], ['생활거점'], ['20260909-100000']],
  );
});

test('자동 통합시험 감사 사유도 영문 실행 접두어를 노출하지 않는다', () => {
  assert.equal(
    formatStoredUserText('AUTO-INT-20260909-140000 rejection resubmit'),
    '자동 통합시험 · 20260909-140000 · 반려 재신청',
  );
  assert.equal(
    formatStoredUserText('자동 통합시험 반려 사유 AUTO-INT-20260909-140000'),
    '자동 통합시험 · 20260909-140000 · 반려 사유',
  );
});

test('기존 사용자 검증 사유의 내부 영문 처리 용어도 한글로 표시한다', () => {
  assert.equal(
    formatStoredUserText('UAT Scenario A · 2024 existing project'),
    '사용자 검증 · 시나리오 가 · 2024 기존사업',
  );
  assert.equal(
    formatStoredUserText('Sunchang grouped new-project UAT'),
    '순창 묶음 신규사업 사용자 검증',
  );
  assert.equal(formatStoredUserText('CONCURRENT_DRAFT_UAT'), '동시 임시저장 사용자 검증');
});

test('자동 통합시험 분류명도 영문 실행 접두어를 노출하지 않는다', () => {
  assert.equal(
    sanitizeClassificationNameForDisplay('자동시연 신규분류 AUTO-INT-20260909-171000'),
    '사용자 검증 · 자동시연 신규분류 · 실행 20260909-171000',
  );
});

test('사용자 화면은 원재원 UUID를 숨기고 사업변경 경로를 실제 페이지로 제공한다', () => {
  const fundingPanel = read('components/analytics/FundingAnalyticsPanel.tsx');
  const header = read('components/common/Header.tsx');
  const navigation = read('lib/appNavigation.ts');
  const route = read('app/admin/project-changes/page.tsx');
  const analytics = read('components/analytics/AnalyticsShell.tsx');

  assert.doesNotMatch(fundingPanel, /원재원 식별값|\{bucket\.budgetCohortId\}/);
  assert.match(fundingPanel, /\$\{bucket\.fiscalYear\}년 원재원/);
  assert.match(header, /RightSidebarNavigation/);
  assert.match(navigation, /href: '\/admin\/project-changes'/);
  assert.match(route, /ProjectChangeManagementShell/);
  assert.doesNotMatch(analytics, />\{category\.name\}<\/option>/);
  assert.match(analytics, /sanitizeClassificationNameForDisplay\(category\.name\)/);
});

test('사업 목록·대시보드·분석은 모두 중앙 사업명 표시 함수를 사용한다', () => {
  const files = [
    'components/my-projects/MyProjectsWorkspace.tsx',
    'components/dashboard/ProjectTable.tsx',
    'components/analytics/AnalyticsShell.tsx',
    'components/admin/ProjectChangeManagementShell.tsx',
  ];
  for (const file of files) {
    const source = read(file);
    assert.match(source, /formatProjectName|getProjectDisplayName|analyticsProjectName|formatProjectReference|sanitizeProjectNameForDisplay/);
  }
});
