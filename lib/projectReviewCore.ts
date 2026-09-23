import type { UserProfile } from './auth';
import type { Database } from '../types/supabase';

type ProjectRow = Database['public']['Tables']['projects']['Row'];
type RelatedProjectRow = Database['public']['Tables']['project_related_projects']['Row'];

export type ProjectReviewDetail = ProjectRow & {
  total_budget_text: string | null;
  original_alloc_text: string | null;
  increase_amount_text: string | null;
  decrease_amount_text: string | null;
  alloc_text: string | null;
  exec_text: string | null;
};

export type ProjectReviewRelatedProject = RelatedProjectRow & {
  total_budget_text: string;
  regional_fund_alloc_text: string;
  local_fund_alloc_text: string;
};

export type ProjectReviewDataSource = {
  findProject: (
    projectId: string,
    regionId: string | null,
  ) => Promise<ProjectReviewDetail | null>;
  findRelatedProjects: (projectId: string) => Promise<ProjectReviewRelatedProject[]>;
};

export function getProjectReviewRegionScope(profile: UserProfile) {
  if (profile.role === 'admin') {
    return null;
  }
  if (profile.role === 'local_user' && profile.region_id) {
    return profile.region_id;
  }
  throw new Error('사업 조회 권한 또는 지역 정보가 없습니다.');
}

export async function getProjectReviewDetailFromSource(
  profile: UserProfile,
  projectId: string,
  dataSource: ProjectReviewDataSource,
) {
  const regionId = getProjectReviewRegionScope(profile);
  const [project, relatedProjects] = await Promise.all([
    dataSource.findProject(projectId, regionId),
    dataSource.findRelatedProjects(projectId),
  ]);

  if (!project) {
    throw new Error('사업을 찾을 수 없거나 접근 권한이 없습니다.');
  }

  return { project, relatedProjects };
}
