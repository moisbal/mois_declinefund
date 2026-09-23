import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const budget = fs.readFileSync(path.join(root, 'components/my-projects/ProjectBudgetSection.tsx'), 'utf8');
const basic = fs.readFileSync(path.join(root, 'components/my-projects/ProjectBasicInfoSection.tsx'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'components/my-projects/MyProjectEditShell.tsx'), 'utf8');
const lifecycle = fs.readFileSync(path.join(root, 'components/my-projects/ProjectLifecycleOptions.tsx'), 'utf8');
const businessType = fs.readFileSync(path.join(root, 'components/my-projects/ProjectBusinessTypeOptions.tsx'), 'utf8');
const statusFields = fs.readFileSync(path.join(root, 'components/my-projects/ProjectExecutionStatusFields.tsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260903000600_execution_status_reason.sql'), 'utf8');

test('자동 계산 금액은 만원 변환 없이 원 단위로 표시한다', () => {
  const calculatedCard = budget.slice(budget.indexOf('시스템 자동 계산'));
  assert.match(calculatedCard, /formatIntegerString\(calculated\.adjustedAlloc\.toString\(\)\)\}원/);
  assert.match(calculatedCard, /formatIntegerString\(calculated\.balance\.toString\(\)\)\}원/);
  assert.doesNotMatch(calculatedCard, /formatWonAsManwonWithUnit\(calculated\./);
});

test('지연·추진곤란 공통 사유 입력과 원장 집행 입력이 사업 편집 화면에 연결된다', () => {
  assert.match(basic, /ProjectExecutionStatusFields/);
  assert.match(statusFields, /PROJECT_STATUS_REASON_PLACEHOLDERS/);
  assert.match(statusFields, /textarea/);
  assert.match(shell, /executionStatusReason: project\.execution_status_reason \?\? ''/);
  assert.match(shell, /<ProjectFinancialLedgerSection[\s\S]*embedded/);
});

test('라디오 선택지는 모든 사업에서 가로쓰기와 박스 단위 반응형 줄바꿈을 공유한다', () => {
  assert.match(css, /input\[type='radio'\][\s\S]*width: 16px !important;[\s\S]*height: 16px !important;/);
  assert.match(css, /\.my-project-field input:not\(\[type='radio'\]\):not\(\[type='checkbox'\]\)/);
  assert.match(css, /\.project-lifecycle-options \{[\s\S]*display: flex;[\s\S]*flex-flow: row wrap/);
  assert.match(css, /\.project-lifecycle-options label \{[\s\S]*display: inline-flex;[\s\S]*flex-direction: row;[\s\S]*min-width: min\(168px, 100%\)/);
  assert.match(css, /\.project-lifecycle-options input\[type='radio'\] \{[\s\S]*width: 18px !important/);
  assert.match(css, /\.project-lifecycle-options label > span \{[\s\S]*writing-mode: horizontal-tb;[\s\S]*white-space: nowrap/);
  assert.match(css, /\.project-lifecycle-options label\.selected/);
  assert.match(css, /\.project-lifecycle-options label:focus-within/);
  assert.match(lifecycle, /<input[\s\S]*<span>신규사업<\/span>/);
  assert.match(lifecycle, /<input[\s\S]*<span>계속사업<\/span>/);
  assert.match(lifecycle, /role="radiogroup"/);
  assert.match(lifecycle, /className=\{projectStartYear !== null && !continuing \? 'selected'/);
  assert.match(businessType, /<input[\s\S]*my-project-business-type-copy/);
});

test('공통 집행상태 사유 RPC는 기존 메타데이터 저장을 감싸고 금액 컬럼을 직접 수정하지 않는다', () => {
  const rpc = migration.slice(
    migration.indexOf('create or replace function public.update_my_project_metadata_v4'),
    migration.indexOf('-- Compatibility'),
  );
  assert.match(rpc, /update_my_project_metadata_v2/);
  assert.match(rpc, /set execution_status_reason = v_new_reason/);
  assert.doesNotMatch(rpc, /set[\s\S]{0,160}\b(?:total_budget|original_alloc|increase_amount|decrease_amount|alloc|exec)\s*=/);
});

test('신규사업 초안과 적용 사업은 공통 사유 컬럼을 사용한다', () => {
  assert.match(migration, /financial_new_project_requests[\s\S]*execution_status_reason/);
  assert.match(migration, /financial_save_new_project_request_draft_v2/);
  assert.match(migration, /financial_copy_new_project_execution_status_reason/);
  assert.match(migration, /지연 사유를 입력해 주세요/);
  assert.match(migration, /추진곤란 사유를 입력해 주세요/);
});
