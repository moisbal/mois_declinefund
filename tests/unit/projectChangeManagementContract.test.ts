import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const migration = read('supabase/migrations/20260826000100_project_change_management_delta.sql');
const localClassification = read('components/my-projects/ProjectClassificationSection.tsx');
const localProposalStatus = read('components/my-projects/SmallCategoryProposalStatusList.tsx');
const proposalQueries = read('lib/projectChanges.ts');
const presentationLabels = read('lib/presentationLabels.ts');
const localName = read('components/my-projects/ProjectBasicInfoSection.tsx');
const adminChanges = read('components/admin/ProjectChangeManagementShell.tsx');
const adminProposals = read('components/admin/SmallCategoryProposalManagementShell.tsx');
const exportRoute = read('app/api/admin/project-changes/export/route.ts');
const hotfixes = [
  '20260826000200_project_change_management_rpc_hotfix.sql',
  '20260826000300_project_change_management_rpc_id_hotfix.sql',
  '20260826000400_project_change_management_rpc_return_hotfix.sql',
  '20260826000500_project_similarity_return_hotfix.sql',
].map((name) => read(`supabase/migrations/${name}`));

function section(start: string, end: string) {
  const from = migration.indexOf(start);
  const to = migration.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing section ${start}`);
  return migration.slice(from, to);
}

test('delta is TEST-bound, transactional, and guards monetary totals', () => {
  assert.match(migration, /^begin;/);
  assert.match(migration, /environment_kind = 'TEST'/);
  assert.match(migration, /bound_project_ref = 'reviewtestxxxxxxxxxx'/);
  assert.match(migration, /Metadata delta changed project monetary totals/);
  assert.match(migration, /monetary_impact bigint not null default 0 check \(monetary_impact = 0\)/);
  assert.match(migration, /commit;\s*$/);
});

test('representative category is one-per-project grain and related categories are excluded from official money view', () => {
  assert.match(migration, /primary_small_category_id uuid/);
  assert.match(migration, /create table if not exists public\.project_related_small_categories/);
  const view = section('create or replace view public.project_primary_classification_statistics', 'comment on view');
  assert.doesNotMatch(view, /project_related_small_categories/);
  assert.match(view, /projects\.id as project_id/);
  assert.match(localClassification, /추천 소분류/);
  assert.match(localClassification, /전체 소분류/);
  assert.doesNotMatch(localClassification, /disabled=\{isBlocked\}/);
});

test('name history, reason arrays, similarity decisions, and proposal workflow are normalized metadata', () => {
  assert.match(migration, /create table if not exists public\.project_change_events/);
  assert.match(migration, /change_reason_codes text\[\]/);
  assert.match(migration, /create table if not exists public\.project_similarity_decisions/);
  assert.match(migration, /SAME_LOGICAL_PROJECT/);
  assert.match(migration, /SUBPROJECT/);
  assert.match(migration, /SEPARATE/);
  assert.match(migration, /UNDECIDED/);
  assert.match(migration, /create table if not exists public\.project_small_category_proposals/);
  assert.match(migration, /'SUBMITTED', 'APPROVED', 'MAPPED', 'REJECTED'/);
  assert.match(localName, /사업명 변경 근거/);
  assert.match(localName, /사업명 변경 사유/);
  assert.match(localName, /복수선택 가능/);
});

test('local proposal workflow refetches per-project status, blocks duplicate pending submissions, and localizes status', () => {
  assert.match(localClassification, /getProjectSmallCategoryProposals/);
  assert.match(localClassification, /SmallCategoryProposalStatusList/);
  assert.match(localClassification, /같은 소분류 제안이 이미 검토 대기 중입니다/);
  assert.match(proposalQueries, /\.eq\('project_id', projectId\)/);
  assert.match(localProposalStatus, /formatSmallCategoryProposalStatus/);
  assert.match(localProposalStatus, /반려 사유/);
  for (const label of ['검토 대기', '신규분류 승인', '기존분류 연결', '반려']) {
    assert.match(presentationLabels, new RegExp(label));
  }
});

test('proposal reads do not depend on a missing PostgREST relation and the admin screen can recover from load failures', () => {
  assert.doesNotMatch(proposalQueries, /middle_categories!/);
  assert.match(proposalQueries, /from\('middle_categories'\)\.select\('id, name'\)/);
  assert.match(proposalQueries, /middleCategoryNames/);
  assert.match(adminProposals, /loadError/);
  assert.match(adminProposals, /<ErrorState>/);
  assert.match(adminProposals, /다시 시도/);
  assert.doesNotMatch(adminProposals, /if \(!ready \|\| !master\)/);
});

test('metadata save does not write Ledger or compatibility monetary columns', () => {
  const rpc = section('create or replace function public.update_my_project_metadata_v2', 'create or replace view public.project_primary_classification_statistics');
  assert.doesNotMatch(rpc, /update public\.financial_/);
  assert.doesNotMatch(rpc, /insert into public\.financial_/);
  assert.doesNotMatch(rpc, /original_alloc\s*=/);
  assert.doesNotMatch(rpc, /increase_amount\s*=/);
  assert.doesNotMatch(rpc, /decrease_amount\s*=/);
  assert.doesNotMatch(rpc, /\balloc\s*=/);
  assert.doesNotMatch(rpc, /\bexec\s*=/);
});

test('new tables are region/admin RLS, RPC-only writes, and anon has no access', () => {
  for (const table of ['project_related_small_categories', 'project_small_category_proposals', 'project_change_events', 'project_similarity_decisions']) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(migration, /profiles\.role = 'admin' or profiles\.region_id = projects\.region_id/);
  assert.match(migration, /from public, anon, authenticated/);
  assert.match(migration, /grant select on table[\s\S]*to authenticated/);
  assert.doesNotMatch(migration, /grant (insert|update|delete).*authenticated/i);
});

test('admin pages expose event filters, detail, proposal actions, and filtered three-sheet XLSX', () => {
  for (const label of ['변경 전 사업명', '변경 후 사업명', '변경근거', '변경사유', '유사사업 여부', '변경일 시작']) {
    assert.match(adminChanges, new RegExp(label));
  }
  for (const label of ['신규 승인', '기존분류 매핑', '반려', '중분류 선택']) {
    assert.match(adminProposals, new RegExp(label));
  }
  assert.match(adminProposals, /현재 대표\/관련 소분류/);
  assert.match(exportRoute, /사업변경 이력/);
  assert.match(exportRoute, /유사사업 연계/);
  assert.match(exportRoute, /소분류 제안·처리/);
  assert.match(exportRoute, /change_reason_codes/);
  assert.match(exportRoute, /X-Export-Row-Count/);
  assert.match(exportRoute, /assertLedgerTestTarget\(\)/);
  assert.doesNotMatch(exportRoute, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('post-apply RPC hotfixes remain TEST-bound and metadata-only', () => {
  for (const hotfix of hotfixes) {
    assert.match(hotfix, /^begin;/);
    assert.match(hotfix, /environment_kind = 'TEST'/);
    assert.match(hotfix, /bound_project_ref = 'reviewtestxxxxxxxxxx'/);
    assert.doesNotMatch(hotfix, /update public\.projects\s+set\s+(?:total_budget|original_alloc|increase_amount|decrease_amount|alloc|exec|rate)/i);
    assert.doesNotMatch(hotfix, /insert into public\.(?:financial_|project_budget_|project_execution_|project_carryovers|project_fund_transfers)/i);
    assert.match(hotfix, /commit;\s*$/);
  }
  assert.match(hotfixes[0], /projects\.id/);
  assert.match(hotfixes[1], /small_categories\.id/);
  assert.match(hotfixes[2], /projects\.project_code::text/);
  assert.match(hotfixes[3], /ranked\.project_code::text/);
});
