import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyProjectNameChangeDraft,
  toggleProjectNameChangeReason,
  validateProjectNameChange,
} from '../../lib/projectChange.ts';
import {
  emptyProjectClassificationDraft,
  getSmallCategoriesForDraft,
  setPrimarySmallCategory,
  toggleSmallCategorySelection,
  validateProjectClassification,
  type ProjectCategoryMaster,
} from '../../lib/projectClassification.ts';
import {
  formatProjectReference,
  formatSmallCategoryProposalStatus,
  formatSystemTerm,
  formatUserFacingError,
} from '../../lib/presentationLabels.ts';

const master: ProjectCategoryMaster = {
  largeCategories: [{ id: 'large-a', code: 'A', name: '문화관광' }, { id: 'large-b', code: 'B', name: '산업일자리' }],
  middleCategories: [
    { id: 'middle-a', code: 'A1', name: '문화', large_category_id: 'large-a' },
    { id: 'middle-b', code: 'B1', name: '일자리', large_category_id: 'large-b' },
  ],
  smallCategories: [
    { id: 'small-a', code: 'A1-1', name: '문화공간', large_category_id: 'large-a', middle_category_id: 'middle-a' },
    { id: 'small-b', code: 'B1-1', name: '청년창업', large_category_id: 'large-b', middle_category_id: 'middle-b' },
    { id: 'small-c', code: 'B1-2', name: '직업교육', large_category_id: 'large-b', middle_category_id: 'middle-b' },
  ],
};

test('사업명 변경 근거와 복수 사유 및 기타 입력을 검증한다', () => {
  const empty = emptyProjectNameChangeDraft();
  assert.equal(validateProjectNameChange('기존 사업', '변경 사업', empty), '사업명 변경 근거를 선택하세요.');

  const otherBasis = { ...empty, basisCode: 'OTHER' as const, reasonCodes: ['CONTENT_CHANGE' as const] };
  assert.equal(validateProjectNameChange('기존 사업', '변경 사업', otherBasis), '기타 변경 근거를 입력하세요.');

  const otherReason = {
    ...empty,
    basisCode: 'LOCAL_NOTICE' as const,
    reasonCodes: ['BUDGET_ADJUSTMENT' as const, 'OTHER' as const],
  };
  assert.equal(validateProjectNameChange('기존 사업', '변경 사업', otherReason), '기타 변경 사유를 입력하세요.');
  assert.equal(validateProjectNameChange('기존 사업', '변경 사업', { ...otherReason, otherReason: '현장 요청' }), null);
  assert.deepEqual(toggleProjectNameChangeReason(['CONTENT_CHANGE'], 'BUDGET_ADJUSTMENT'), ['CONTENT_CHANGE', 'BUDGET_ADJUSTMENT']);
});

test('소분류 선택은 다른 중분류 후보를 숨기지 않고 대표 1개와 관련 N개를 유지한다', () => {
  let draft = emptyProjectClassificationDraft();
  draft = toggleSmallCategorySelection(master, draft, 'small-a', true);
  draft = toggleSmallCategorySelection(master, draft, 'small-b', true);
  draft = toggleSmallCategorySelection(master, draft, 'small-c', true);
  draft = setPrimarySmallCategory(master, draft, 'small-b');
  draft = { ...draft, businessType: 'COMPOSITE' };

  assert.equal(getSmallCategoriesForDraft(master, draft).length, 3);
  assert.equal(draft.primarySmallCategoryId, 'small-b');
  assert.deepEqual(draft.smallCategoryIds, ['small-a', 'small-b', 'small-c']);
  assert.equal(draft.largeCategoryId, 'large-b');
  assert.equal(draft.middleCategoryId, 'middle-b');
  assert.equal(validateProjectClassification(master, draft), null);
});

test('공식 분류 금액은 대표 소분류 기준으로 사업당 한 번만 합산한다', () => {
  const projects = [{ id: 'p1', allocation: 100_000_000, primary: 'small-b', related: ['small-a', 'small-c'] }];
  const total = projects.reduce((sum, project) => sum + project.allocation, 0);
  const officialByPrimary = projects.filter((project) => project.primary === 'small-b')
    .reduce((sum, project) => sum + project.allocation, 0);
  assert.equal(total, 100_000_000);
  assert.equal(officialByPrimary, 100_000_000);
});

test('업무 화면의 상태와 데이터베이스 오류는 원문 영문을 노출하지 않는다', () => {
  assert.equal(formatSmallCategoryProposalStatus('SUBMITTED'), '검토 대기');
  assert.equal(formatSmallCategoryProposalStatus('MAPPED'), '기존분류 연결');
  assert.equal(formatSystemTerm('AWAITING_EXTERNAL_REVIEW'), '확인 필요');
  assert.equal(
    formatUserFacingError({ code: '23505', message: 'duplicate key value violates unique constraint' }, '요청 처리에 실패했습니다.'),
    '같은 내용의 요청이 이미 등록되어 있습니다.',
  );
  assert.equal(
    formatUserFacingError(new Error('unexpected backend error'), '요청 처리에 실패했습니다.'),
    '요청 처리에 실패했습니다.',
  );
  assert.equal(formatUserFacingError(new Error('이미 처리된 요청입니다.'), '실패'), '이미 처리된 요청입니다.');
});

test('사업 표시는 한글 사업명만 사용하고 내부 코드를 노출하지 않는다', () => {
  assert.equal(
    formatProjectReference({ project_name: '청년 정착 지원', project_code: '2026-ABC-001' }),
    '청년 정착 지원',
  );
});
