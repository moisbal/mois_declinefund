import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260914000500_new_project_soft_delete.sql'), 'utf8');
const originHistoryHotfix = fs.readFileSync(path.join(root, 'supabase/migrations/20260914000600_new_project_delete_origin_history_hotfix.sql'), 'utf8');
const budgetDraftSoftDeleteCompat = fs.readFileSync(path.join(root, 'supabase/migrations/20260915000200_budget_change_draft_soft_delete_compat.sql'), 'utf8');
const actions = fs.readFileSync(path.join(root, 'app/my-projects/workspace-actions.ts'), 'utf8');
const workspace = fs.readFileSync(path.join(root, 'components/my-projects/MyProjectsWorkspace.tsx'), 'utf8');
const detail = fs.readFileSync(path.join(root, 'components/my-projects/MyProjectEditShell.tsx'), 'utf8');
const requestPanel = fs.readFileSync(path.join(root, 'components/my-projects/NewProjectRequestPanel.tsx'), 'utf8');
const deleteDialog = fs.readFileSync(path.join(root, 'components/my-projects/NewProjectDeleteDialog.tsx'), 'utf8');
const table = fs.readFileSync(path.join(root, 'components/dashboard/ProjectTable.tsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8');
const workspaceCss = fs.readFileSync(path.join(root, 'components/my-projects/MyProjectsWorkspace.module.css'), 'utf8');
const summaryRoute = fs.readFileSync(path.join(root, 'app/api/projects/summary/route.ts'), 'utf8');
const projectsQuery = fs.readFileSync(path.join(root, 'lib/projects.ts'), 'utf8');

test('삭제는 같은 지자체 담당자만 원자적 논리 삭제 RPC로 실행한다', () => {
  assert.match(migration, /v_role <> 'local_user'/);
  assert.match(migration, /v_project\.region_id <> v_actor_region_id/);
  assert.match(migration, /for update;/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /financial_guard_deleted_project_reference/);
  assert.match(migration, /set deleted_at = v_now, deleted_by = v_actor_id, deletion_event_id = v_event\.id/);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.(projects|financial_new_project_requests)/i);
  assert.match(actions, /soft_delete_financial_new_project/);
});

test('공식 신규사업은 금액만이 아니라 원장·요청·이력까지 차단 조건으로 확인한다', () => {
  assert.match(migration, /financial_new_project_deletion_block_reason/);
  for (const tableName of [
    'project_budget_years',
    'financial_unallocated_fund_movements',
    'financial_budget_change_requests',
    'financial_pending_new_project_link_requests',
    'legacy_ledger_reconstruction_entries',
  ]) assert.match(migration, new RegExp(`public\\.${tableName}`));
  assert.match(migration, /기존 Legacy 사업은 이 기능으로 삭제할 수 없습니다/);
  assert.match(migration, /현재 잔액이 0원이더라도/);
  assert.match(originHistoryHotfix, /source_lot_id is not null/);
  assert.match(originHistoryHotfix, /source_budget_change_line_id is not null/);
  assert.match(originHistoryHotfix, /신규사업 등록 시 재원 연결 또는 예산조정 이력이 있어 삭제할 수 없습니다/);
});

test('삭제 감사기록과 확인요청 이력은 보존되고 일반 조회·후보에서는 제외된다', () => {
  assert.match(migration, /create table if not exists public\.project_deletion_events/);
  assert.match(migration, /project_deletion_events_immutable/);
  assert.match(migration, /\[삭제된 사업\]/);
  assert.match(migration, /projects\.deleted_at is null/);
  assert.match(migration, /requests\.deleted_at is null/);
  assert.match(migration, /get_financial_budget_change_candidates/);
  assert.match(migration, /get_transfer_destination_projects/);
});

test('초안 목록과 상세는 사업명·연도를 보여주는 공통 삭제 확인창을 사용한다', () => {
  assert.match(workspace, /조회·수정<\/button>.*삭제<\/button>/s);
  assert.match(workspace, /<NewProjectDeleteDialog/);
  assert.match(detail, /신규사업 삭제/);
  assert.match(detail, /targetKind="PROJECT"/);
});

test('삭제된 초안 직접 주소는 빈 편집 폼으로 열지 않고 원시 사업명을 노출하지 않는다', () => {
  assert.match(requestPanel, /if \(linkedRequestId && !linkedRequest\)/);
  assert.match(requestPanel, /getNewProjectDeletionEligibilityAction/);
  assert.match(requestPanel, /setRequestId\(undefined\)/);
  assert.match(requestPanel, /setOpen\(false\)/);
  assert.match(requestPanel, /onRequestUnavailableRef\.current\?\.\(message\)/);
  assert.match(workspace, /onRequestUnavailable=\{\(message\) =>/);
  assert.match(workspace, /setNewProjectRequestId\(null\)/);
  assert.match(deleteDialog, /sanitizeProjectNameForDisplay\(eligibility\.project_name, year\)/);
});

test('예산조정 작성본 재저장은 내부 신규사업 초안을 물리 삭제하지 않는다', () => {
  assert.match(budgetDraftSoftDeleteCompat, /financial_soft_delete_budget_change_generated_drafts/);
  assert.match(budgetDraftSoftDeleteCompat, /insert into public\.project_deletion_events/);
  assert.match(budgetDraftSoftDeleteCompat, /set deleted_at = v_now/);
  assert.match(budgetDraftSoftDeleteCompat, /source_budget_change_request_id = null/);
  assert.match(budgetDraftSoftDeleteCompat, /source_budget_change_line_id = null/);
  assert.match(budgetDraftSoftDeleteCompat, /financial_test_uat_save_budget_change_request_with_drafts/);
  const replacementBodies = Array.from(
    budgetDraftSoftDeleteCompat.matchAll(/\$new\$([\s\S]*?)\$new\$/g),
    (match) => match[1],
  );
  assert.equal(replacementBodies.length, 2);
  for (const replacementBody of replacementBodies) {
    assert.doesNotMatch(
      replacementBody,
      /delete\s+from\s+public\.financial_new_project_requests/i,
    );
  }
});

test('대시보드 표는 분류와 누적 집행액 수정을 기능 셀 가까이에 배치한다', () => {
  assert.match(table, /aria-label=\{`\$\{getProjectDisplayName\(project\)\} 분류 수정`\}/);
  assert.match(table, /project\.id === classificationProjectId \? '닫기' : '수정'/);
  assert.match(table, /집행액 수정/);
  assert.match(table, /변경 후 누적 집행액\(원\)/);
  assert.doesNotMatch(table, /<th>수정<\/th>/);
  assert.match(table, /조회 중\.\.\.' : '조회'/);
  assert.match(css, /\.classification-action-button|\.table-action-button/);
});

test('관리자 데이터 영역과 지자체 6개 요약 카드는 반응형 격자를 사용한다', () => {
  assert.match(css, /--admin-work-max: 1780px/);
  assert.match(css, /\.work-page-header-compact/);
  assert.match(css, /\.dashboard-project-table-scroll[\s\S]*overflow-x: auto/);
  assert.match(workspaceCss, /\.summaryGrid \{[\s\S]*grid-template-columns: repeat\(6, minmax\(0, 1fr\)\)/);
  assert.match(workspaceCss, /@media \(max-width: 1280px\)[\s\S]*\.summaryGrid \{ grid-template-columns: repeat\(3/);
});

test('KPI 집계는 원장 투영 뷰를 권한 범위에서 한 번만 조회한다', () => {
  assert.match(summaryRoute, /positionQuery = positionQuery\.eq\('region_id', regionId\)/);
  assert.match(summaryRoute, /const \{ data: positionData, error: positionError \} = await positionQuery/);
  assert.doesNotMatch(summaryRoute, /\.in\('project_id', projectRows\.map/);
  assert.match(projectsQuery, /\.is\('deleted_at', null\)[\s\S]*\.not\('project_code', 'is', null\)/);
});
