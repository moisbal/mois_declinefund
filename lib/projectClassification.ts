export const BUSINESS_TYPE_VALUES = ['HW', 'SW', 'COMPOSITE'] as const;

export type BusinessType = (typeof BUSINESS_TYPE_VALUES)[number];

export const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
  HW: '시설·인프라 중심',
  SW: '프로그램·서비스 중심',
  COMPOSITE: '복합형(시설+서비스)',
};

export type LargeCategory = {
  id: string;
  code: string;
  name: string;
};

export type MiddleCategory = {
  id: string;
  code: string;
  name: string;
  large_category_id: string;
};

export type SmallCategory = {
  id: string;
  code: string;
  name: string;
  large_category_id: string;
  middle_category_id: string;
};

export const CUSTOM_CLASSIFICATION_METHOD_VALUES = [
  'EXACT_MASTER',
  'ALIAS_EXACT',
  'ALIAS_CONTAINS',
  'SIMILAR_NAME',
  'MANUAL_CONTEXT',
] as const;

export type CustomClassificationMethod = (typeof CUSTOM_CLASSIFICATION_METHOD_VALUES)[number];

export type CustomValidationStatus = 'PENDING_REVIEW' | 'CONFIRMED' | 'REJECTED';

export type CustomSmallCategorySelection = {
  inputValue: string;
  normalizedValue: string;
  largeCategoryId: string;
  middleCategoryId: string;
  suggestedSmallCategoryId: string | null;
  classificationMethod: CustomClassificationMethod;
  confidence: number;
  validationStatus: CustomValidationStatus;
};

export type CustomSmallCategorySuggestion = {
  largeCategoryId: string;
  middleCategoryId: string;
  smallCategoryId: string;
  largeCategoryName: string;
  middleCategoryName: string;
  smallCategoryName: string;
  confidence: number;
  classificationMethod: Exclude<CustomClassificationMethod, 'MANUAL_CONTEXT'>;
};

export type ProjectCategoryMaster = {
  largeCategories: LargeCategory[];
  middleCategories: MiddleCategory[];
  smallCategories: SmallCategory[];
};

export type ProjectClassificationDraft = {
  largeCategoryId: string | null;
  middleCategoryId: string | null;
  primarySmallCategoryId: string | null;
  smallCategoryIds: string[];
  customSmallCategories: CustomSmallCategorySelection[];
  businessType: BusinessType | null;
};

export function emptyProjectClassificationDraft(): ProjectClassificationDraft {
  return {
    largeCategoryId: null,
    middleCategoryId: null,
    primarySmallCategoryId: null,
    smallCategoryIds: [],
    customSmallCategories: [],
    businessType: null,
  };
}

export function isBusinessType(value: string | null | undefined): value is BusinessType {
  return BUSINESS_TYPE_VALUES.includes(value as BusinessType);
}

export function isCustomClassificationMethod(
  value: string | null | undefined,
): value is CustomClassificationMethod {
  return CUSTOM_CLASSIFICATION_METHOD_VALUES.includes(value as CustomClassificationMethod);
}

export function normalizeCustomSmallCategoryText(value: string) {
  return value.trim().toLocaleLowerCase('ko-KR').replace(/[\s\p{P}]+/gu, '');
}

export function validateCustomSmallCategoryInput(value: string) {
  const trimmedValue = value.trim();
  if (trimmedValue.length < 2 || trimmedValue.length > 100) {
    return '소분류 직접 입력은 2~100자로 입력하세요.';
  }
  if (!/^[0-9A-Za-z가-힣·&() /-]+$/.test(trimmedValue)) {
    return '소분류 직접 입력에는 한글, 영문, 숫자 및 기본 기호만 사용할 수 있습니다.';
  }
  if (normalizeCustomSmallCategoryText(trimmedValue).length < 2) {
    return '유효한 소분류 직접 입력값을 입력하세요.';
  }
  return null;
}

export function getSmallCategoriesForDraft(
  master: ProjectCategoryMaster,
  _draft: Pick<ProjectClassificationDraft, 'largeCategoryId' | 'middleCategoryId'>,
) {
  // Recommendation is ranking, never filtering. Every approved category stays
  // searchable after another category is selected.
  return master.smallCategories;
}

export function getRecommendedSmallCategories(
  master: ProjectCategoryMaster,
  draft: Pick<ProjectClassificationDraft, 'primarySmallCategoryId' | 'largeCategoryId' | 'middleCategoryId'>,
  limit = 8,
) {
  const primary = master.smallCategories.find((category) => category.id === draft.primarySmallCategoryId);
  return [...master.smallCategories]
    .sort((left, right) => {
      const leftScore = Number(left.middle_category_id === (primary?.middle_category_id ?? draft.middleCategoryId)) * 2
        + Number(left.large_category_id === (primary?.large_category_id ?? draft.largeCategoryId));
      const rightScore = Number(right.middle_category_id === (primary?.middle_category_id ?? draft.middleCategoryId)) * 2
        + Number(right.large_category_id === (primary?.large_category_id ?? draft.largeCategoryId));
      return rightScore - leftScore || left.name.localeCompare(right.name, 'ko-KR');
    })
    .slice(0, Math.max(1, limit));
}

export function resetDraftForLargeCategory(
  draft: ProjectClassificationDraft,
  largeCategoryId: string | null,
): ProjectClassificationDraft {
  return {
    ...draft,
    largeCategoryId,
    middleCategoryId: null,
    primarySmallCategoryId: null,
    smallCategoryIds: [],
    customSmallCategories: [],
  };
}

export function toggleSmallCategorySelection(
  master: ProjectCategoryMaster,
  draft: ProjectClassificationDraft,
  smallCategoryId: string,
  checked: boolean,
): ProjectClassificationDraft {
  const smallCategory = master.smallCategories.find((category) => category.id === smallCategoryId);
  if (!smallCategory) {
    return draft;
  }

  if (!checked) {
    const smallCategoryIds = draft.smallCategoryIds.filter((id) => id !== smallCategory.id);
    const primarySmallCategoryId = draft.primarySmallCategoryId === smallCategory.id
      ? (smallCategoryIds[0] ?? null)
      : draft.primarySmallCategoryId;
    const primary = master.smallCategories.find((category) => category.id === primarySmallCategoryId);
    return {
      ...draft,
      largeCategoryId: primary?.large_category_id ?? null,
      middleCategoryId: primary?.middle_category_id ?? null,
      primarySmallCategoryId,
      smallCategoryIds,
    };
  }

  const primarySmallCategoryId = draft.primarySmallCategoryId ?? smallCategory.id;
  const primary = master.smallCategories.find((category) => category.id === primarySmallCategoryId) ?? smallCategory;

  return {
    ...draft,
    largeCategoryId: primary.large_category_id,
    middleCategoryId: primary.middle_category_id,
    primarySmallCategoryId,
    smallCategoryIds: draft.smallCategoryIds.includes(smallCategory.id)
      ? draft.smallCategoryIds
      : [...draft.smallCategoryIds, smallCategory.id],
  };
}

export function setPrimarySmallCategory(
  master: ProjectCategoryMaster,
  draft: ProjectClassificationDraft,
  smallCategoryId: string,
): ProjectClassificationDraft {
  const primary = master.smallCategories.find((category) => category.id === smallCategoryId);
  if (!primary || !draft.smallCategoryIds.includes(primary.id)) {
    return draft;
  }
  return {
    ...draft,
    primarySmallCategoryId: primary.id,
    largeCategoryId: primary.large_category_id,
    middleCategoryId: primary.middle_category_id,
  };
}

export function addCustomSmallCategorySelection(
  draft: ProjectClassificationDraft,
  inputValue: string,
  suggestion: CustomSmallCategorySuggestion,
): ProjectClassificationDraft {
  const normalizedValue = normalizeCustomSmallCategoryText(inputValue);
  if (!normalizedValue) {
    return draft;
  }
  if (
    (draft.largeCategoryId && draft.largeCategoryId !== suggestion.largeCategoryId)
    || (draft.middleCategoryId && draft.middleCategoryId !== suggestion.middleCategoryId)
    || draft.customSmallCategories.some((category) => category.normalizedValue === normalizedValue)
  ) {
    return draft;
  }

  return {
    ...draft,
    largeCategoryId: suggestion.largeCategoryId,
    middleCategoryId: suggestion.middleCategoryId,
    customSmallCategories: [
      ...draft.customSmallCategories,
      {
        inputValue: inputValue.trim(),
        normalizedValue,
        largeCategoryId: suggestion.largeCategoryId,
        middleCategoryId: suggestion.middleCategoryId,
        suggestedSmallCategoryId: suggestion.smallCategoryId,
        classificationMethod: suggestion.classificationMethod,
        confidence: suggestion.confidence,
        validationStatus: ['EXACT_MASTER', 'ALIAS_EXACT', 'ALIAS_CONTAINS'].includes(
          suggestion.classificationMethod,
        )
          ? 'CONFIRMED'
          : 'PENDING_REVIEW',
      },
    ],
  };
}

export function removeCustomSmallCategorySelection(
  draft: ProjectClassificationDraft,
  normalizedValue: string,
): ProjectClassificationDraft {
  const customSmallCategories = draft.customSmallCategories.filter(
    (category) => category.normalizedValue !== normalizedValue,
  );
  return {
    ...draft,
    middleCategoryId: customSmallCategories.length === 0 && draft.smallCategoryIds.length === 0
      ? null
      : draft.middleCategoryId,
    customSmallCategories,
  };
}

export function validateProjectClassification(
  master: ProjectCategoryMaster,
  draft: ProjectClassificationDraft,
) {
  if (!draft.largeCategoryId) {
    return '대분류를 1개 선택하세요.';
  }
  if (!draft.middleCategoryId) {
    return '대표 소분류를 선택해 중분류를 확정하세요.';
  }
  if (!draft.primarySmallCategoryId || draft.smallCategoryIds.length === 0) {
    return '대표 소분류를 1개 선택하세요.';
  }
  if (!draft.businessType) {
    return '사업유형을 1개 선택하세요.';
  }
  if (!isBusinessType(draft.businessType)) {
    return '사업유형 값이 올바르지 않습니다.';
  }

  const middleCategory = master.middleCategories.find(
    (category) => category.id === draft.middleCategoryId,
  );
  if (!middleCategory || middleCategory.large_category_id !== draft.largeCategoryId) {
    return '선택한 대분류와 중분류가 일치하지 않습니다.';
  }

  const uniqueSmallCategoryIds = new Set(draft.smallCategoryIds);
  if (uniqueSmallCategoryIds.size !== draft.smallCategoryIds.length) {
    return '동일한 소분류를 중복 선택할 수 없습니다.';
  }

  const selectedSmallCategories = master.smallCategories.filter((category) => (
    uniqueSmallCategoryIds.has(category.id)
  ));
  if (selectedSmallCategories.length !== uniqueSmallCategoryIds.size) {
    return '선택한 소분류 중 분류 마스터에 없는 값이 있습니다.';
  }

  const primarySmallCategory = selectedSmallCategories.find(
    (category) => category.id === draft.primarySmallCategoryId,
  );
  if (!primarySmallCategory) {
    return '대표 소분류는 선택된 소분류 중에서 지정하세요.';
  }
  if (
    primarySmallCategory.large_category_id !== draft.largeCategoryId
    || primarySmallCategory.middle_category_id !== draft.middleCategoryId
  ) {
    return '대분류와 중분류는 대표 소분류의 상위 분류와 일치해야 합니다.';
  }

  const customValues = new Set<string>();
  for (const customSmallCategory of draft.customSmallCategories) {
    const inputError = validateCustomSmallCategoryInput(customSmallCategory.inputValue);
    if (inputError) {
      return inputError;
    }
    if (!isCustomClassificationMethod(customSmallCategory.classificationMethod)) {
      return '사용자 입력 소분류의 분류 방식이 올바르지 않습니다.';
    }
    if (customValues.has(customSmallCategory.normalizedValue)) {
      return '동일한 사용자 입력 소분류를 중복 선택할 수 없습니다.';
    }
    customValues.add(customSmallCategory.normalizedValue);
  }

  return null;
}
