import type { UserProfile } from './auth';
import { supabase } from './supabaseClient';
import {
  getProjectReviewDetailFromSource,
  type ProjectReviewDataSource,
  type ProjectReviewDetail,
  type ProjectReviewRelatedProject,
} from './projectReviewCore';
import { overlayFundingPosition, type ProjectFundingPosition } from './fundingManagement';

export {
  getProjectReviewRegionScope,
  type ProjectReviewDataSource,
  type ProjectReviewDetail,
  type ProjectReviewRelatedProject,
} from './projectReviewCore';

export function createSupabaseProjectReviewDataSource(client: typeof supabase = supabase): ProjectReviewDataSource {
  return {
    async findProject(projectId, regionId) {
      let query = client
        .from('projects')
        .select(`
          *,
          total_budget_text:total_budget::text,
          original_alloc_text:original_alloc::text,
          increase_amount_text:increase_amount::text,
          decrease_amount_text:decrease_amount::text,
          alloc_text:alloc::text,
          exec_text:exec::text
        `)
        .is('deleted_at', null)
        .eq('id', projectId);

      if (regionId) {
        query = query.eq('region_id', regionId);
      }

      const { data, error } = await query.maybeSingle();
      if (error) {
        throw error;
      }
      if (!data) return null;
      const { data: positionData, error: positionError } = await (client as any)
        .rpc('get_financial_project_funding_positions', { p_project_id: projectId });
      if (positionError) throw positionError;
      const positions = (positionData ?? []).map((row: Record<string, unknown>) => ({
        ...row,
        project_id: String(row.project_id),
        ledger_original_allocation: String(row.ledger_original_allocation ?? '0'),
        ledger_adjusted_allocation: String(row.ledger_adjusted_allocation ?? '0'),
        ledger_increase_amount: String(row.ledger_increase_amount ?? '0'),
        ledger_decrease_amount: String(row.ledger_decrease_amount ?? '0'),
        ledger_execution_amount: String(row.ledger_execution_amount ?? '0'),
        ledger_execution_rate: Number(row.ledger_execution_rate ?? 0),
        current_wallet_balance: String(row.current_wallet_balance ?? '0'),
        unclassified_decrease_amount: String(row.unclassified_decrease_amount ?? '0'),
      })) as ProjectFundingPosition[];
      return overlayFundingPosition(data as ProjectReviewDetail, positions);
    },

    async findRelatedProjects(projectId) {
      const { data, error } = await client
        .from('project_related_projects')
        .select(`
          *,
          total_budget_text:total_budget::text,
          regional_fund_alloc_text:regional_fund_alloc::text,
          local_fund_alloc_text:local_fund_alloc::text
        `)
        .eq('project_id', projectId)
        .order('created_at', { ascending: true });

      if (error) {
        throw error;
      }
      return (data ?? []) as ProjectReviewRelatedProject[];
    },
  };
}

export async function getProjectReviewDetail(
  profile: UserProfile,
  projectId: string,
  dataSource: ProjectReviewDataSource = createSupabaseProjectReviewDataSource(),
) {
  return getProjectReviewDetailFromSource(profile, projectId, dataSource);
}
