export const PROJECT_NAME_CHANGE_BASIS_VALUES = [
  'LOCAL_NOTICE',
  'FUND_REVIEW_APPROVAL',
  'OTHER',
] as const;

export type ProjectNameChangeBasis = (typeof PROJECT_NAME_CHANGE_BASIS_VALUES)[number];

export const PROJECT_NAME_CHANGE_BASIS_LABELS: Record<ProjectNameChangeBasis, string> = {
  LOCAL_NOTICE: '지자체 → 조합 통보',
  FUND_REVIEW_APPROVAL: '기금심의 후 승인',
  OTHER: '기타',
};

export const PROJECT_NAME_CHANGE_REASON_VALUES = [
  'CONTENT_CHANGE',
  'BUDGET_ADJUSTMENT',
  'SUBPROJECT_ADJUSTMENT',
  'UNDERPERFORMING_REPLACEMENT',
  'OTHER',
] as const;

export type ProjectNameChangeReason = (typeof PROJECT_NAME_CHANGE_REASON_VALUES)[number];

export const PROJECT_NAME_CHANGE_REASON_LABELS: Record<ProjectNameChangeReason, string> = {
  CONTENT_CHANGE: '사업내용 변경',
  BUDGET_ADJUSTMENT: '사업간 예산 조정',
  SUBPROJECT_ADJUSTMENT: '기금사업 내 세부사업 조정',
  UNDERPERFORMING_REPLACEMENT: '기존사업 추진 부진으로 신규사업 추진',
  OTHER: '기타',
};

export const PROJECT_NAME_CHANGE_REASON_HELP: Partial<Record<ProjectNameChangeReason, string>> = {
  CONTENT_CHANGE: '장소, 세부 추진사항 등 경미한 변경',
};

export const SIMILARITY_RELATIONSHIP_VALUES = [
  'SAME_LOGICAL_PROJECT',
  'SUBPROJECT',
  'SEPARATE',
  'UNDECIDED',
] as const;

export type SimilarityRelationship = (typeof SIMILARITY_RELATIONSHIP_VALUES)[number];

export const SIMILARITY_RELATIONSHIP_LABELS: Record<SimilarityRelationship, string> = {
  SAME_LOGICAL_PROJECT: '동일 논리사업으로 연계',
  SUBPROJECT: '상위사업·서브프로젝트 관계',
  SEPARATE: '별도 사업으로 유지',
  UNDECIDED: '나중에 결정',
};

export { SMALL_CATEGORY_PROPOSAL_STATUS_LABELS } from './presentationLabels.ts';

export type ProjectNameChangeDraft = {
  basisCode: ProjectNameChangeBasis | null;
  otherBasis: string;
  reasonCodes: ProjectNameChangeReason[];
  otherReason: string;
  detail: string;
};

export function emptyProjectNameChangeDraft(): ProjectNameChangeDraft {
  return {
    basisCode: null,
    otherBasis: '',
    reasonCodes: [],
    otherReason: '',
    detail: '',
  };
}

export function validateProjectNameChange(
  oldName: string,
  newName: string,
  change: ProjectNameChangeDraft,
) {
  const normalizedOldName = oldName.trim();
  const normalizedNewName = newName.trim();
  if (normalizedNewName.length < 2 || normalizedNewName.length > 250) {
    return '변경 사업명은 2~250자로 입력하세요.';
  }
  if (normalizedNewName === normalizedOldName) return null;
  if (!change.basisCode) return '사업명 변경 근거를 선택하세요.';
  if (change.basisCode === 'OTHER' && change.otherBasis.trim().length < 2) {
    return '기타 변경 근거를 입력하세요.';
  }
  if (change.reasonCodes.length === 0) return '사업명 변경 사유를 1개 이상 선택하세요.';
  if (change.reasonCodes.includes('OTHER') && change.otherReason.trim().length < 2) {
    return '기타 변경 사유를 입력하세요.';
  }
  return null;
}

export function toggleProjectNameChangeReason(
  reasons: ProjectNameChangeReason[],
  reason: ProjectNameChangeReason,
) {
  return reasons.includes(reason)
    ? reasons.filter((item) => item !== reason)
    : [...reasons, reason];
}
