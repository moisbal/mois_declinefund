import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  chunkPostgrestInValues,
  POSTGREST_IN_FILTER_CHUNK_SIZE,
} from '../../lib/postgrest.ts';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

test('admin summary keeps official-project semantics while chunking long PostgREST filters', () => {
  const route = read('app/api/projects/summary/route.ts');
  assert.equal(POSTGREST_IN_FILTER_CHUNK_SIZE, 200);
  const chunks = chunkPostgrestInValues(Array.from({ length: 3924 }, (_, index) => index));
  assert.equal(chunks.length, 20);
  assert.ok(chunks.every((chunk) => chunk.length <= 200));
  assert.match(route, /AGGREGATION_PAGE_SIZE = POSTGREST_IN_FILTER_CHUNK_SIZE/);
  assert.match(route, /\.not\('project_code', 'is', null\)/);
});

test('new-project drafts are listed separately and keep their request id through funding attachment', () => {
  const workspaceAction = read('app/my-projects/workspace-actions.ts');
  const budgetAction = read('app/my-projects/budget-change-actions.ts');
  const workspace = read('components/my-projects/MyProjectsWorkspace.tsx');
  const panel = read('components/my-projects/NewProjectRequestPanel.tsx');
  const admin = read('components/admin/FundingManagementShell.tsx');
  const migration = read('supabase/migrations/20260903000100_new_project_funding_source_workflow.sql');

  assert.match(workspaceAction, /newProject=1&requestId=\$\{id\}/);
  assert.match(workspace, /공식사업.*초안/);
  assert.match(workspace, /공식 사업 통계에서 제외/);
  assert.match(workspace, /params\.set\('requestId', newProjectRequestId\)/);
  assert.match(workspace, /setNewProjectRequestId\(draft\.id\)/);
  assert.match(workspace, /key=\{newProjectRequestId \?\? 'new-project'\}/);
  assert.match(workspace, /임시저장 · \{draft\.source_label\}/);
  assert.match(budgetAction, /source_budget_change_request_id: parentRequestId/);
  assert.match(budgetAction, /source_request_id: fundingSourceRequestId/);
  assert.match(budgetAction, /workflow_group_id: parentRequestId \?\? String\(row\.id\)/);
  assert.match(panel, /사업만 임시저장/);
  assert.match(panel, /사업목록에서 보기/);
  assert.match(panel, /재원 연결하기/);
  assert.match(panel, /등록 완료 전 확인/);
  assert.match(admin, /NEW_PROJECT_DRAFTS/);
  assert.match(admin, /임시저장 · 재원 미연결/);
  assert.match(migration, /where requests\.id = v_existing\.id/);
  assert.match(migration, /set new_project_request_id = v_existing\.id/);
});

test('missing and zero years are rejected independently from a missing funding source', () => {
  const fields = read('components/my-projects/NewProjectRequestFields.tsx');
  const action = read('app/my-projects/funding-actions.ts');
  assert.match(fields, /projectStartYear: number \| null/);
  assert.match(fields, /value\.projectStartYear === null \|\| value\.projectEndYear === null/);
  assert.match(fields, /value\.projectStartYear < 2000/);
  assert.match(fields, /사업기간에 표시된 연도와 시작·종료연도가 일치/);
  assert.match(action, /projectStartYear < 2000/);
  assert.match(action, /assertNewProjectSchedule/);
});

test('my-projects read failure retries once and the visible retry clears the prior error', () => {
  const workspaceAction = read('app/my-projects/workspace-actions.ts');
  const workspace = read('components/my-projects/MyProjectsWorkspace.tsx');

  assert.match(workspaceAction, /loadMyProjectsWorkspaceAction\(input, false\)/);
  assert.match(workspaceAction, /return loadMyProjectsWorkspaceAction\(input, true\)/);
  assert.match(workspace, /const retryWorkspace = useCallback/);
  assert.match(workspace, /setError\(null\)/);
  assert.match(workspace, /onClick=\{\(\) => void retryWorkspace\(\)\}/);
});

test('login accepts identifiers without bypassing password auth and visible cutover copy is Korean', () => {
  const login = read('components/common/LoginForm.tsx');
  const auth = read('lib/auth.ts');
  const header = read('components/common/Header.tsx');
  const navigation = read('components/common/RightSidebarNavigation.tsx');
  const navigationModel = read('lib/appNavigation.ts');
  const workspace = read('components/my-projects/MyProjectsWorkspace.tsx');
  const cutover = read('components/admin/LedgerCutoverShell.tsx');
  assert.match(login, /아이디 또는 이메일/);
  assert.match(login, /type="text"/);
  assert.match(login, /resolveTestLoginIdentifier\(identifier\)/);
  assert.match(login, /supabase\.auth\.signInWithPassword/);
  assert.match(login, /const \{ data, error \} = await supabase\.auth\.signInWithPassword/);
  assert.match(login, /getCurrentSessionWithRetry\(data\.session\.user\.id\)/);
  assert.match(auth, /SESSION_READY_RETRY_DELAYS_MS/);
  assert.match(auth, /expectedUserId/);
  assert.match(header, /getCurrentSessionWithRetry\(\)/);
  assert.match(header, /getProfileByUserId\(session\.user\.id\)/);
  assert.match(workspace, /getCurrentSessionWithRetry\(\)/);
  assert.doesNotMatch(workspace, /getCurrentUserProfile/);
  assert.match(navigation, /getAppNavigationGroups/);
  assert.match(navigationModel, /운영전환/);
  assert.match(cutover, /운영전환/);
  assert.doesNotMatch(cutover, /Cutover (?:관리|상태|준비)/);
});

test('budget-change form receives the source project year and visible name', () => {
  const editShell = read('components/my-projects/MyProjectEditShell.tsx');
  const myProjects = read('lib/myProjects.ts');
  assert.match(editShell, /<ProjectFundingManagementSection[\s\S]*currentProjectYear=\{project\.year \?\? undefined\}/);
  assert.match(editShell, /<ProjectFundingManagementSection[\s\S]*currentProjectName=\{getMyProjectDisplayName\(project\)\}/);
  assert.match(myProjects, /return getProjectPresentation\(project\)\.name/);
  assert.doesNotMatch(myProjects, /function getDisplayName/);
});

test('analytics retries one transient session or profile read before redirecting', () => {
  const analytics = read('components/analytics/AnalyticsShell.tsx');
  assert.match(analytics, /if \(\(!session\?\.user \|\| !session\.access_token \|\| !currentProfile\) && active\)/);
  assert.match(analytics, /window\.setTimeout\(resolve, 750\)/);
  assert.ok((analytics.match(/sessionResult = await getCurrentSession\(\)/g) ?? []).length >= 2);
});

test('server Supabase reads bypass stale fetch cache after approvals', () => {
  const adminClient = read('lib/supabaseAdmin.ts');
  assert.match(adminClient, /fetch: \(input, init\) => fetch\(input, \{ \.\.\.init, cache: 'no-store' \}\)/);
});

test('analytics fills missing project region labels from the region master', () => {
  const queries = read('lib/analytics/queries.ts');
  assert.match(queries, /resolveAnalyticsRegionLabels/);
  assert.match(queries, /\.from\('regions'\)[\s\S]*\.select\('id, sido, sigungu'\)/);
  assert.match(queries, /regions\.get\(String\(row\.region_id\)\)/);
});
