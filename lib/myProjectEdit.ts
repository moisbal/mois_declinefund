import type { ProjectClassificationDraft } from './projectClassification';
import type { ProjectNameChangeDraft } from './projectChange';

export const PROJECT_STATUS_VALUES = ['정상추진', '지연', '완료', '추진곤란'] as const;

export type ProjectStatus = (typeof PROJECT_STATUS_VALUES)[number];

export const PROJECT_STATUS_REASON_LABELS = {
  지연: '지연 사유',
  추진곤란: '추진곤란 사유',
} as const;

export const PROJECT_STATUS_REASON_PLACEHOLDERS = {
  지연: '사업이 지연된 사유와 향후 추진계획을 입력해 주세요.',
  추진곤란: '추진이 곤란한 사유와 향후 조치계획을 입력해 주세요.',
} as const;

export type ProjectStatusWithReason = keyof typeof PROJECT_STATUS_REASON_LABELS;

export type RelatedProjectDraft = {
  clientId: string;
  projectName: string;
  totalBudget: string;
  regionalFundAlloc: string;
  localFundAlloc: string;
};

export type MyProjectEditDraft = {
  detailProjectName: string;
  nameChange: ProjectNameChangeDraft;
  projectPeriod: string;
  projectStartYear: number | null;
  status: ProjectStatus;
  executionStatusReason: string;
  originalAlloc: string;
  increaseAmount: string;
  decreaseAmount: string;
  exec: string;
  classification: ProjectClassificationDraft;
  relatedProjects: RelatedProjectDraft[];
};

const LEDGER_DERIVED_DRAFT_KEYS = new Set<keyof MyProjectEditDraft>([
  'originalAlloc',
  'increaseAmount',
  'decreaseAmount',
  'exec',
]);

export function countMyProjectDraftChanges(
  current: MyProjectEditDraft,
  saved: MyProjectEditDraft,
  ledgerManaged: boolean,
) {
  return (Object.keys(current) as Array<keyof MyProjectEditDraft>).filter((key) => {
    if (ledgerManaged && LEDGER_DERIVED_DRAFT_KEYS.has(key)) return false;
    return JSON.stringify(current[key]) !== JSON.stringify(saved[key]);
  }).length;
}

export function isProjectStatus(value: string | null | undefined): value is ProjectStatus {
  return PROJECT_STATUS_VALUES.includes(value as ProjectStatus);
}

export function requiresExecutionStatusReason(status: ProjectStatus): status is ProjectStatusWithReason {
  return status === '지연' || status === '추진곤란';
}

export function validateExecutionStatusReason(status: ProjectStatus, reason: string) {
  if (!requiresExecutionStatusReason(status)) return null;
  const normalizedReason = reason.trim();
  if (!normalizedReason) return `${PROJECT_STATUS_REASON_LABELS[status]}를 입력해 주세요.`;
  if (normalizedReason.length > 500) return `${PROJECT_STATUS_REASON_LABELS[status]}는 500자 이하로 입력해 주세요.`;
  return null;
}

export function normalizeAmountInput(value: string) {
  const digits = value.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
  return digits || '0';
}

export function isValidAmountString(value: string) {
  return /^\d+$/.test(value) && BigInt(value) <= BigInt('9223372036854775807');
}

export function deriveOriginalAllocation(input: {
  originalAlloc?: string | null;
  adjustedAlloc?: string | null;
  increaseAmount?: string | null;
  decreaseAmount?: string | null;
}) {
  const original = isValidAmountString(input.originalAlloc ?? '') ? BigInt(input.originalAlloc!) : BigInt(0);
  if (original > BigInt(0)) return original.toString();

  const adjusted = isValidAmountString(input.adjustedAlloc ?? '') ? BigInt(input.adjustedAlloc!) : BigInt(0);
  const increase = isValidAmountString(input.increaseAmount ?? '') ? BigInt(input.increaseAmount!) : BigInt(0);
  const decrease = isValidAmountString(input.decreaseAmount ?? '') ? BigInt(input.decreaseAmount!) : BigInt(0);
  return (adjusted - increase + decrease).toString();
}

export function calculateProjectBudget(draft: Pick<
  MyProjectEditDraft,
  'originalAlloc' | 'increaseAmount' | 'decreaseAmount' | 'exec'
>) {
  const originalAlloc = isValidAmountString(draft.originalAlloc) ? BigInt(draft.originalAlloc) : BigInt(0);
  const increaseAmount = isValidAmountString(draft.increaseAmount) ? BigInt(draft.increaseAmount) : BigInt(0);
  const decreaseAmount = isValidAmountString(draft.decreaseAmount) ? BigInt(draft.decreaseAmount) : BigInt(0);
  const exec = isValidAmountString(draft.exec) ? BigInt(draft.exec) : BigInt(0);
  const adjustedAlloc = originalAlloc + increaseAmount - decreaseAmount;
  const balance = adjustedAlloc - exec;
  const rateBasisPoints = adjustedAlloc > BigInt(0)
    ? ((exec * BigInt(10000)) + (adjustedAlloc / BigInt(2))) / adjustedAlloc
    : BigInt(0);

  return {
    exec,
    adjustedAlloc,
    balance,
    rate: Number(rateBasisPoints) / 100,
  };
}

export function createRelatedProjectDraft(): RelatedProjectDraft {
  return {
    clientId: crypto.randomUUID(),
    projectName: '',
    totalBudget: '0',
    regionalFundAlloc: '0',
    localFundAlloc: '0',
  };
}

export function getRelatedProjectsEmptyState(rows: readonly RelatedProjectDraft[]) {
  return rows.length === 0 ? '연계된 사업 없음' : null;
}

export function validateMyProjectEditDraft(
  draft: MyProjectEditDraft,
  projectYear: number | null,
) {
  if (draft.detailProjectName.trim().length < 2 || draft.detailProjectName.trim().length > 250) {
    return '사업명은 2~250자로 입력하세요.';
  }
  if (draft.projectPeriod.trim().length < 2 || draft.projectPeriod.trim().length > 120) {
    return '사업기간은 2~120자로 입력하세요.';
  }
  if (!isProjectStatus(draft.status)) {
    return '집행상태를 선택하세요.';
  }
  const statusReasonError = validateExecutionStatusReason(draft.status, draft.executionStatusReason);
  if (statusReasonError) return statusReasonError;
  if (
    !draft.projectStartYear
    || draft.projectStartYear < 1900
    || (projectYear !== null && draft.projectStartYear > projectYear)
  ) {
    return '시작연도는 사업연도 이하로 입력하세요.';
  }

  const amountValues = [
    draft.originalAlloc,
    draft.increaseAmount,
    draft.decreaseAmount,
    draft.exec,
  ];
  if (amountValues.some((value) => !isValidAmountString(value))) {
    return '예산과 집행액은 bigint 범위의 0 이상 정수로 입력하세요.';
  }

  const budget = calculateProjectBudget(draft);
  if (budget.adjustedAlloc < BigInt(0)) {
    return '감액액은 당초 배분액과 증액액의 합계를 초과할 수 없습니다.';
  }
  if (budget.exec > budget.adjustedAlloc) {
    return '집행액은 조정 후 배분액을 초과할 수 없습니다.';
  }

  const relatedNames = new Set<string>();
  for (const relatedProject of draft.relatedProjects) {
    const normalizedName = relatedProject.projectName.trim().toLocaleLowerCase('ko-KR');
    if (normalizedName.length < 2 || normalizedName.length > 200 || relatedNames.has(normalizedName)) {
      return '타 사업명은 2~200자로 중복 없이 입력하세요.';
    }
    relatedNames.add(normalizedName);
    if (
      !isValidAmountString(relatedProject.totalBudget)
      || !isValidAmountString(relatedProject.regionalFundAlloc)
      || !isValidAmountString(relatedProject.localFundAlloc)
    ) {
      return '타 사업 연계 금액은 bigint 범위의 0 이상 정수로 입력하세요.';
    }
  }

  return null;
}
