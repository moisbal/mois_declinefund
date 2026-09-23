import { supabase } from './supabaseClient';
import type { SimilarityRelationship } from './projectChange';

export type SimilarProjectCandidate = {
  candidateProjectId: string;
  projectName: string;
  projectCode: string;
  fiscalYear: number | null;
  regionName: string | null;
  classificationName: string | null;
  similarityScore: number;
  candidateSetHash: string;
  shouldPrompt: boolean;
};

export type ProjectClassificationSnapshot = {
  large_category_id?: string | null;
  large_category_name?: string | null;
  middle_category_id?: string | null;
  middle_category_name?: string | null;
  primary_small_category_id?: string | null;
  primary_small_category_name?: string | null;
  related_small_categories?: Array<{ id: string; name: string }>;
  business_type?: string | null;
};

export type ProjectChangeEvent = {
  id: string;
  project_id: string;
  project_code: string;
  region_id: string;
  fiscal_year: number | null;
  change_kind: 'PROJECT_NAME' | 'CLASSIFICATION' | 'PROJECT_METADATA';
  old_name: string | null;
  new_name: string | null;
  change_basis_code: string | null;
  change_basis_label: string | null;
  other_basis: string | null;
  change_reason_codes: string[];
  change_reason_labels: string[];
  other_reason: string | null;
  detail: string | null;
  old_classification: ProjectClassificationSnapshot;
  new_classification: ProjectClassificationSnapshot;
  related_small_category_labels: string[];
  similarity_candidate: boolean;
  similarity_result: string | null;
  ledger_transaction_reference: string | null;
  monetary_impact: string | number;
  status: 'COMPLETED' | 'REVIEW_REQUIRED';
  changed_by: string;
  changed_at: string;
  regions?: { sido: string | null; sigungu: string | null; display_name: string | null } | null;
  actorLabel?: string;
};

export type ProjectChangeFilters = {
  year?: number;
  sido?: string;
  sigungu?: string;
  projectCode?: string;
  oldName?: string;
  newName?: string;
  basisCode?: string;
  reasonCode?: string;
  status?: string;
  hasSimilarity?: boolean;
  dateFrom?: string;
  dateTo?: string;
};

export type SmallCategoryProposal = {
  id: string;
  project_id: string;
  project_code: string;
  region_id: string;
  proposed_name: string;
  proposal_reason: string;
  recommended_middle_category_id: string | null;
  middle_category_review_required: boolean;
  similar_small_categories: Array<{
    id: string;
    name: string;
    middle_category_id: string;
    similarity: number;
  }>;
  status: 'SUBMITTED' | 'APPROVED' | 'MAPPED' | 'REJECTED';
  approved_small_category_id: string | null;
  mapped_small_category_id: string | null;
  rejection_reason: string | null;
  created_at: string;
  reviewed_at: string | null;
  projects?: {
    project_name: string | null;
    fund_project_name: string | null;
    detail_project_name: string | null;
    year: number | null;
    primary_small_category_id: string | null;
  } | null;
  regions?: { display_name: string | null } | null;
  middle_categories?: { name: string | null } | null;
  currentPrimarySmallCategoryName?: string | null;
  currentRelatedSmallCategoryNames?: string[];
  resolvedSmallCategoryName?: string | null;
};

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export async function getSimilarProjectCandidates(projectId: string, projectName: string) {
  const { data, error } = await (supabase as any).rpc('get_project_similarity_candidates', {
    p_project_id: projectId,
    p_new_name: projectName,
    p_limit: 5,
  });
  if (error) throw error;
  return (data ?? []).map((row: Record<string, unknown>) => ({
    candidateProjectId: String(row.candidate_project_id),
    projectName: String(row.project_name ?? '-'),
    projectCode: String(row.project_code ?? '-'),
    fiscalYear: row.fiscal_year === null ? null : Number(row.fiscal_year),
    regionName: row.region_name === null ? null : String(row.region_name),
    classificationName: row.classification_name === null ? null : String(row.classification_name),
    similarityScore: Number(row.similarity_score ?? 0),
    candidateSetHash: String(row.candidate_set_hash ?? ''),
    shouldPrompt: Boolean(row.should_prompt),
  })) as SimilarProjectCandidate[];
}

export async function recordProjectSimilarityDecision(input: {
  projectId: string;
  sourceProjectName: string;
  candidateSetHash: string;
  candidateProjectId?: string | null;
  similarity?: number | null;
  relationshipType: SimilarityRelationship;
  note?: string;
}) {
  const { data, error } = await (supabase as any).rpc('record_project_similarity_decision', {
    p_project_id: input.projectId,
    p_source_project_name: input.sourceProjectName,
    p_candidate_set_hash: input.candidateSetHash,
    p_candidate_project_id: input.candidateProjectId ?? null,
    p_similarity: input.similarity ?? null,
    p_relationship_type: input.relationshipType,
    p_decision_note: input.note?.trim() || null,
  });
  if (error) throw error;
  return data as string;
}

export async function submitSmallCategoryProposal(
  projectId: string,
  proposedName: string,
  proposalReason: string,
) {
  const { data, error } = await (supabase as any).rpc('submit_project_small_category_proposal', {
    p_project_id: projectId,
    p_proposed_name: proposedName,
    p_proposal_reason: proposalReason,
  });
  if (error) throw error;
  return data as string;
}

export async function getProjectChangeEvents(projectId?: string): Promise<ProjectChangeEvent[]> {
  let query = (supabase as any)
    .from('project_change_events')
    .select('*, regions(sido, sigungu, display_name)')
    .order('changed_at', { ascending: false });
  if (projectId) query = query.eq('project_id', projectId);
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []).map((row: any) => ({ ...row, regions: one(row.regions) })) as ProjectChangeEvent[];

  const actorIds = [...new Set(rows.map((row) => row.changed_by).filter(Boolean))];
  if (actorIds.length === 0) return rows;
  const { data: actors } = await supabase
    .from('profiles')
    .select('id, name, login_id, email')
    .in('id', actorIds);
  const labels = new Map((actors ?? []).map((actor) => [
    actor.id,
    actor.name?.trim() && !/[A-Za-z@]/.test(actor.name) ? actor.name.trim() : '사용자',
  ]));
  return rows.map((row) => ({ ...row, actorLabel: labels.get(row.changed_by) ?? '사용자 정보 없음' }));
}

export async function getAdminProjectChangeEvents(
  filters: ProjectChangeFilters = {},
): Promise<ProjectChangeEvent[]> {
  let regionIds: string[] | null = null;
  if (filters.sido || filters.sigungu) {
    let regionQuery = supabase.from('regions').select('id');
    if (filters.sido) regionQuery = regionQuery.eq('sido', filters.sido);
    if (filters.sigungu) regionQuery = regionQuery.eq('sigungu', filters.sigungu);
    const { data: regions, error: regionError } = await regionQuery;
    if (regionError) throw regionError;
    regionIds = (regions ?? []).map((region) => region.id);
    if (regionIds.length === 0) return [];
  }

  let query = (supabase as any)
    .from('project_change_events')
    .select('*, regions(sido, sigungu, display_name)')
    .order('changed_at', { ascending: false })
    .limit(1000);
  if (regionIds) query = query.in('region_id', regionIds);
  if (filters.year) query = query.eq('fiscal_year', filters.year);
  if (filters.projectCode) query = query.ilike('project_code', `%${filters.projectCode}%`);
  if (filters.oldName) query = query.ilike('old_name', `%${filters.oldName}%`);
  if (filters.newName) query = query.ilike('new_name', `%${filters.newName}%`);
  if (filters.basisCode) query = query.eq('change_basis_code', filters.basisCode);
  if (filters.reasonCode) query = query.contains('change_reason_codes', [filters.reasonCode]);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.hasSimilarity !== undefined) query = query.eq('similarity_candidate', filters.hasSimilarity);
  if (filters.dateFrom) query = query.gte('changed_at', `${filters.dateFrom}T00:00:00`);
  if (filters.dateTo) query = query.lte('changed_at', `${filters.dateTo}T23:59:59.999`);
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []).map((row: any) => ({ ...row, regions: one(row.regions) })) as ProjectChangeEvent[];

  const actorIds = [...new Set(rows.map((row) => row.changed_by))];
  const { data: actors } = actorIds.length > 0
    ? await supabase.from('profiles').select('id, name, login_id, email').in('id', actorIds)
    : { data: [] };
  const labels = new Map((actors ?? []).map((actor) => [
    actor.id,
    actor.name?.trim() && !/[A-Za-z@]/.test(actor.name) ? actor.name.trim() : '사용자',
  ]));
  return rows.map((row) => ({ ...row, actorLabel: labels.get(row.changed_by) ?? '사용자 정보 없음' }));
}

export async function getSmallCategoryProposals(projectId?: string): Promise<SmallCategoryProposal[]> {
  let query = (supabase as any)
    .from('project_small_category_proposals')
    .select(`
      *,
      projects(project_name, fund_project_name, detail_project_name, year, primary_small_category_id),
      regions(display_name)
    `)
    .order('created_at', { ascending: false });
  if (projectId) query = query.eq('project_id', projectId);
  const { data, error } = await query;
  if (error) throw error;
  const proposals = (data ?? []).map((row: any) => ({
    ...row,
    projects: one(row.projects),
    regions: one(row.regions),
    middle_categories: null,
  })) as SmallCategoryProposal[];

  if (proposals.length === 0) return proposals;
  const projectIds = [...new Set(proposals.map((item) => item.project_id).filter(Boolean))];
  const recommendedMiddleCategoryIds = [...new Set(proposals
    .map((item) => item.recommended_middle_category_id)
    .filter(Boolean))] as string[];
  const [relatedResult, middleCategoryResult] = await Promise.all([
    (supabase as any)
      .from('project_related_small_categories')
      .select('project_id, small_category_id')
      .in('project_id', projectIds),
    recommendedMiddleCategoryIds.length > 0
      ? supabase.from('middle_categories').select('id, name').in('id', recommendedMiddleCategoryIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const { data: relatedRows, error: relatedError } = relatedResult;
  if (relatedError) throw relatedError;
  if (middleCategoryResult.error) throw middleCategoryResult.error;
  const middleCategoryNames = new Map(
    (middleCategoryResult.data ?? []).map((category) => [category.id, category.name]),
  );

  const categoryIds = [...new Set([
    ...proposals.map((item) => item.projects?.primary_small_category_id).filter(Boolean),
    ...proposals.map((item) => item.approved_small_category_id).filter(Boolean),
    ...proposals.map((item) => item.mapped_small_category_id).filter(Boolean),
    ...(relatedRows ?? []).map((row: any) => row.small_category_id).filter(Boolean),
  ])] as string[];
  const { data: categories, error: categoryError } = categoryIds.length > 0
    ? await supabase.from('small_categories').select('id, name').in('id', categoryIds)
    : { data: [], error: null };
  if (categoryError) throw categoryError;
  const categoryNames = new Map((categories ?? []).map((category) => [category.id, category.name]));
  const relatedByProject = new Map<string, string[]>();
  for (const row of relatedRows ?? []) {
    const name = categoryNames.get(row.small_category_id);
    if (!name) continue;
    relatedByProject.set(row.project_id, [...(relatedByProject.get(row.project_id) ?? []), name]);
  }

  return proposals.map((item) => ({
    ...item,
    middle_categories: item.recommended_middle_category_id
      ? { name: middleCategoryNames.get(item.recommended_middle_category_id) ?? null }
      : null,
    currentPrimarySmallCategoryName: item.projects?.primary_small_category_id
      ? categoryNames.get(item.projects.primary_small_category_id) ?? null
      : null,
    currentRelatedSmallCategoryNames: relatedByProject.get(item.project_id) ?? [],
    resolvedSmallCategoryName: item.approved_small_category_id
      ? categoryNames.get(item.approved_small_category_id) ?? null
      : item.mapped_small_category_id
        ? categoryNames.get(item.mapped_small_category_id) ?? null
        : null,
  }));
}

export function getProjectSmallCategoryProposals(projectId: string) {
  return getSmallCategoryProposals(projectId);
}

export async function reviewSmallCategoryProposal(input: {
  proposalId: string;
  action: 'APPROVE' | 'MAP' | 'REJECT';
  middleCategoryId?: string | null;
  existingSmallCategoryId?: string | null;
  rejectionReason?: string;
}) {
  const { data, error } = await (supabase as any).rpc('review_project_small_category_proposal', {
    p_proposal_id: input.proposalId,
    p_action: input.action,
    p_middle_category_id: input.middleCategoryId ?? null,
    p_existing_small_category_id: input.existingSmallCategoryId ?? null,
    p_rejection_reason: input.rejectionReason?.trim() || null,
  });
  if (error) throw error;
  return data;
}

export function projectChangeFiltersToSearchParams(filters: ProjectChangeFilters) {
  const params = new URLSearchParams();
  if (filters.year) params.set('year', String(filters.year));
  if (filters.sido) params.set('sido', filters.sido);
  if (filters.sigungu) params.set('sigungu', filters.sigungu);
  if (filters.projectCode) params.set('projectCode', filters.projectCode);
  if (filters.oldName) params.set('oldName', filters.oldName);
  if (filters.newName) params.set('newName', filters.newName);
  if (filters.basisCode) params.set('basisCode', filters.basisCode);
  if (filters.reasonCode) params.set('reasonCode', filters.reasonCode);
  if (filters.status) params.set('status', filters.status);
  if (filters.hasSimilarity !== undefined) params.set('hasSimilarity', String(filters.hasSimilarity));
  if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
  if (filters.dateTo) params.set('dateTo', filters.dateTo);
  return params;
}
