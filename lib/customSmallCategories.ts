import { supabase } from './supabaseClient';
import type { Database } from '../types/supabase';

type ProjectRow = Database['public']['Tables']['projects']['Row'];
type CustomSmallCategoryRow = Database['public']['Tables']['project_custom_small_categories']['Row'];

export type CustomSmallCategoryReviewItem = Pick<
  CustomSmallCategoryRow,
  | 'id'
  | 'project_id'
  | 'input_value'
  | 'normalized_value'
  | 'classification_method'
  | 'confidence'
  | 'validation_status'
  | 'created_at'
> & {
  projects: Pick<ProjectRow, 'project_code' | 'project_name' | 'fund_project_name' | 'detail_project_name'> | null;
  large_categories: { name: string } | null;
  middle_categories: { name: string } | null;
  small_categories: { name: string } | null;
};

export async function getCustomSmallCategoryReviewItems(): Promise<CustomSmallCategoryReviewItem[]> {
  const { data, error } = await supabase
    .from('project_custom_small_categories')
    .select(`
      id,
      project_id,
      input_value,
      normalized_value,
      classification_method,
      confidence,
      validation_status,
      created_at,
      projects(project_code, project_name, fund_project_name, detail_project_name),
      large_categories(name),
      middle_categories(name),
      small_categories(name)
    `)
    .in('validation_status', ['PENDING_REVIEW', 'CONFIRMED'])
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []).map((item: any) => ({
    ...item,
    projects: Array.isArray(item.projects) ? item.projects[0] ?? null : item.projects ?? null,
    large_categories: Array.isArray(item.large_categories)
      ? item.large_categories[0] ?? null
      : item.large_categories ?? null,
    middle_categories: Array.isArray(item.middle_categories)
      ? item.middle_categories[0] ?? null
      : item.middle_categories ?? null,
    small_categories: Array.isArray(item.small_categories)
      ? item.small_categories[0] ?? null
      : item.small_categories ?? null,
  })) as CustomSmallCategoryReviewItem[];
}

export async function reviewCustomSmallCategory(
  customSmallCategoryId: string,
  action: 'CONFIRM' | 'REJECT' | 'PROMOTE',
  standardSmallCategoryName?: string,
) {
  const { data, error } = await supabase
    .rpc('review_project_custom_small_category', {
      p_custom_small_category_id: customSmallCategoryId,
      p_action: action,
      p_standard_small_category_name: standardSmallCategoryName ?? null,
      p_standard_small_category_code: null,
    })
    .single();

  if (error) {
    throw error;
  }

  return data as {
    id: string;
    validation_status: string;
    promoted_small_category_id: string | null;
  };
}
