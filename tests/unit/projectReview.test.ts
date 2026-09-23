import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateProjectBudget, deriveOriginalAllocation, getRelatedProjectsEmptyState } from '../../lib/myProjectEdit.ts';
import type {
  ProjectReviewDataSource,
  ProjectReviewDetail,
  ProjectReviewRelatedProject,
} from '../../lib/projectReviewCore.ts';

function profile(
  id: string,
  role: 'admin' | 'local_user',
  regionId: string | null,
) {
  return {
    id,
    email: `${id}@example.com`,
    login_id: id,
    name: id,
    role,
    region_id: regionId,
    region_name: regionId,
    first_login: false,
    created_at: null,
    updated_at: null,
  };
}

function createMemorySource() {
  let currentProject = {
    id: 'project-a',
    project_id: '2026-52-770-0001',
    project_code: '2026-52-770-0001',
    region_id: 'region-a',
    original_alloc_text: '1000',
    increase_amount_text: '0',
    decrease_amount_text: '0',
    alloc_text: '1000',
    exec_text: '250',
    rate: 25,
    updated_at: '2026-08-24T00:00:00.000Z',
  } as ProjectReviewDetail;
  let currentRelatedProjects: ProjectReviewRelatedProject[] = [];

  const source: ProjectReviewDataSource = {
    async findProject(projectId, regionId) {
      if (
        currentProject.id !== projectId
        || (regionId !== null && currentProject.region_id !== regionId)
      ) {
        return null;
      }
      return { ...currentProject };
    },
    async findRelatedProjects(projectId) {
      return currentRelatedProjects
        .filter((item) => item.project_id === projectId)
        .map((item) => ({ ...item }));
    },
  };

  return {
    source,
    saveLatest() {
      currentProject = {
        ...currentProject,
        original_alloc_text: '210000000',
        increase_amount_text: '10000000',
        decrease_amount_text: '5000000',
        alloc_text: '215000000',
        exec_text: '107500000',
        rate: 50,
        updated_at: '2026-08-24T02:01:16.210Z',
      };
      currentRelatedProjects = [{
        id: 'related-a',
        project_id: currentProject.id,
        project_name: 'UAT 연계사업',
        total_budget: 300000000,
        regional_fund_alloc: 100000000,
        local_fund_alloc: 50000000,
        total_budget_text: '300000000',
        regional_fund_alloc_text: '100000000',
        local_fund_alloc_text: '50000000',
        created_at: '2026-08-24T02:01:16.210Z',
        updated_at: '2026-08-24T02:01:16.210Z',
      }];
    },
  };
}

test('rounds the local execution rate exactly like the DB numeric(2) calculation', () => {
  const result = calculateProjectBudget({
    originalAlloc: '3',
    increaseAmount: '0',
    decreaseAmount: '0',
    exec: '2',
  });

  assert.equal(result.rate, 66.67);
});

test('treats a legacy adjusted allocation as the original allocation instead of an increase', () => {
  assert.equal(deriveOriginalAllocation({
    originalAlloc: '0',
    adjustedAlloc: '800000000',
    increaseAmount: '0',
    decreaseAmount: '0',
  }), '800000000');
  assert.equal(deriveOriginalAllocation({
    originalAlloc: '0',
    adjustedAlloc: '800000000',
    increaseAmount: '800000000',
    decreaseAmount: '0',
  }), '0');
});

test('related-project view state distinguishes the required admin empty state', () => {
  assert.equal(getRelatedProjectsEmptyState([]), '연계된 사업 없음');
  assert.equal(getRelatedProjectsEmptyState([{
    clientId: 'related-a',
    projectName: '연계사업',
    totalBudget: '1',
    regionalFundAlloc: '1',
    localFundAlloc: '0',
  }]), null);
});

test('local save and both admin readers observe the same latest project and related rows', async () => {
  const { getProjectReviewDetailFromSource } = await import('../../lib/projectReviewCore.ts');
  const memory = createMemorySource();
  const localA = profile('local_a', 'local_user', 'region-a');
  const adminA = profile('admin_a', 'admin', null);
  const adminB = profile('admin_b', 'admin', null);

  const before = await getProjectReviewDetailFromSource(localA, 'project-a', memory.source);
  assert.equal(before.project.alloc_text, '1000');
  assert.deepEqual(before.relatedProjects, []);

  memory.saveLatest();

  const [localAfter, adminAAfter, adminBAfter] = await Promise.all([
    getProjectReviewDetailFromSource(localA, 'project-a', memory.source),
    getProjectReviewDetailFromSource(adminA, 'project-a', memory.source),
    getProjectReviewDetailFromSource(adminB, 'project-a', memory.source),
  ]);

  for (const result of [localAfter, adminAAfter, adminBAfter]) {
    assert.equal(result.project.alloc_text, '215000000');
    assert.equal(result.project.exec_text, '107500000');
    assert.equal(result.project.rate, 50);
    assert.equal(result.relatedProjects[0]?.project_name, 'UAT 연계사업');
  }
});

test('fresh re-entry reads current data, empty relations stay empty, and local cross-region access is denied', async () => {
  const { getProjectReviewDetailFromSource } = await import('../../lib/projectReviewCore.ts');
  const memory = createMemorySource();
  const admin = profile('admin_a', 'admin', null);
  const otherLocal = profile('local_b', 'local_user', 'region-b');

  const firstEntry = await getProjectReviewDetailFromSource(admin, 'project-a', memory.source);
  assert.deepEqual(firstEntry.relatedProjects, []);

  memory.saveLatest();
  const reEntry = await getProjectReviewDetailFromSource(admin, 'project-a', memory.source);
  assert.equal(reEntry.project.updated_at, '2026-08-24T02:01:16.210Z');
  assert.equal(reEntry.relatedProjects.length, 1);

  await assert.rejects(
    getProjectReviewDetailFromSource(otherLocal, 'project-a', memory.source),
    /접근 권한/,
  );
});
