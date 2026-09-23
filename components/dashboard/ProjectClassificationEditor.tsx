"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { UserProfile } from '../../lib/auth';
import {
  getProjectCategoryMaster,
  getProjectClassification,
  updateProjectClassification,
  type ProjectClassificationUpdate,
  type ProjectWithRegion,
} from '../../lib/projects';
import {
  BUSINESS_TYPE_LABELS,
  BUSINESS_TYPE_VALUES,
  emptyProjectClassificationDraft,
  getSmallCategoriesForDraft,
  resetDraftForLargeCategory,
  setPrimarySmallCategory,
  toggleSmallCategorySelection,
  validateCustomSmallCategoryInput,
  type ProjectCategoryMaster,
  type ProjectClassificationDraft,
  validateProjectClassification,
} from '../../lib/projectClassification';
import {
  getProjectSmallCategoryProposals,
  submitSmallCategoryProposal,
  type SmallCategoryProposal,
} from '../../lib/projectChanges';
import { formatProjectName, formatUserFacingError, sanitizeClassificationNameForDisplay } from '../../lib/presentationLabels';
import SmallCategoryProposalStatusList from '../my-projects/SmallCategoryProposalStatusList';

type ProjectClassificationEditorProps = {
  profile: UserProfile;
  project: ProjectWithRegion;
  onClose: () => void;
  onSaved: (updated: ProjectClassificationUpdate) => void;
};

function getProjectDisplayName(project: ProjectWithRegion) {
  return formatProjectName({
    fiscal_year: project.year,
    detail_project_name: project.detail_project_name,
    fund_project_name: project.fund_project_name,
    project_name: project.project_name,
    project_code: project.project_code,
    status: project.status,
  });
}

export default function ProjectClassificationEditor({
  profile,
  project,
  onClose,
  onSaved,
}: ProjectClassificationEditorProps) {
  const [master, setMaster] = useState<ProjectCategoryMaster | null>(null);
  const [draft, setDraft] = useState<ProjectClassificationDraft>(emptyProjectClassificationDraft);
  const [smallCategoryQuery, setSmallCategoryQuery] = useState('');
  const [customSmallCategoryInput, setCustomSmallCategoryInput] = useState('');
  const [proposalReason, setProposalReason] = useState('');
  const [submittingProposal, setSubmittingProposal] = useState(false);
  const [proposalMessage, setProposalMessage] = useState<string | null>(null);
  const [proposals, setProposals] = useState<SmallCategoryProposal[]>([]);
  const [proposalsLoading, setProposalsLoading] = useState(true);
  const [proposalsError, setProposalsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProposals = useCallback(async () => {
    setProposalsLoading(true);
    setProposalsError(null);
    try {
      setProposals(await getProjectSmallCategoryProposals(project.id));
    } catch (loadError) {
      setProposals([]);
      setProposalsError(formatUserFacingError(loadError, '소분류 제안 처리현황을 불러오지 못했습니다.'));
    } finally {
      setProposalsLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      setSmallCategoryQuery('');
      setCustomSmallCategoryInput('');
      setProposalReason('');
      setProposalMessage(null);

      try {
        const [categoryMaster, classification] = await Promise.all([
          getProjectCategoryMaster(),
          getProjectClassification(project.id),
        ]);
        if (!cancelled) {
          setMaster(categoryMaster);
          setDraft(classification);
        }
      } catch (loadError) {
        if (!cancelled) {
          setMaster(null);
          setDraft(emptyProjectClassificationDraft());
          setError(formatUserFacingError(loadError, '사업 분류 정보를 불러오지 못했습니다.'));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  useEffect(() => {
    void loadProposals();
  }, [loadProposals]);

  const middleCategory = useMemo(() => (
    master?.middleCategories.find((category) => category.id === draft.middleCategoryId) ?? null
  ), [draft.middleCategoryId, master]);

  const selectedSmallCategories = useMemo(() => {
    if (!master) {
      return [];
    }
    const selectedIds = new Set(draft.smallCategoryIds);
    return master.smallCategories.filter((category) => selectedIds.has(category.id));
  }, [draft.smallCategoryIds, master]);

  const availableSmallCategories = useMemo(() => {
    if (!master) {
      return [];
    }
    const normalizedQuery = smallCategoryQuery.trim().toLocaleLowerCase('ko-KR');
    return getSmallCategoriesForDraft(master, draft).filter((category) => (
      !normalizedQuery
      || category.name.toLocaleLowerCase('ko-KR').includes(normalizedQuery)
      || sanitizeClassificationNameForDisplay(category.name).toLocaleLowerCase('ko-KR').includes(normalizedQuery)
      || category.code.toLocaleLowerCase('ko-KR').includes(normalizedQuery)
    ));
  }, [draft, master, smallCategoryQuery]);

  const updateLargeCategory = (nextLargeCategoryId: string | null) => {
    if (nextLargeCategoryId === draft.largeCategoryId) {
      return;
    }

    if (draft.smallCategoryIds.length + draft.customSmallCategories.length > 0) {
      const confirmed = window.confirm(
        '대분류를 변경하면 현재 선택한 표준·사용자 입력 소분류가 초기화됩니다. 변경하시겠습니까?',
      );
      if (!confirmed) {
        return;
      }
    }

    setDraft((current) => resetDraftForLargeCategory(current, nextLargeCategoryId));
    setSmallCategoryQuery('');
    setCustomSmallCategoryInput('');
    setProposalReason('');
    setProposalMessage(null);
    setError(null);
  };

  const submitProposal = async () => {
    const inputError = validateCustomSmallCategoryInput(customSmallCategoryInput);
    if (inputError) {
      setError(inputError);
      return;
    }
    if (proposalReason.trim().length < 5) {
      setError('소분류 제안 사유를 5자 이상 입력하세요.');
      return;
    }
    if (proposals.some((item) => item.status === 'SUBMITTED'
      && item.proposed_name.trim().toLocaleLowerCase('ko-KR') === customSmallCategoryInput.trim().toLocaleLowerCase('ko-KR'))) {
      setError('같은 소분류 제안이 이미 검토 대기 중입니다. 아래 처리현황을 확인해 주세요.');
      return;
    }

    setSubmittingProposal(true);
    setError(null);
    try {
      await submitSmallCategoryProposal(
        project.id,
        customSmallCategoryInput,
        proposalReason,
      );
      setCustomSmallCategoryInput('');
      setProposalReason('');
      setProposalMessage('관리자 검토 목록에 제안을 등록했습니다. 승인 전까지 공식 분류 통계에는 포함되지 않습니다.');
      await loadProposals();
    } catch (proposalError) {
      setError(formatUserFacingError(proposalError, '소분류 제안을 등록하지 못했습니다.'));
    } finally {
      setSubmittingProposal(false);
    }
  };

  const updateSmallCategory = (smallCategoryId: string, checked: boolean) => {
    if (!master) {
      return;
    }

    setDraft((current) => toggleSmallCategorySelection(master, current, smallCategoryId, checked));
    setError(null);
  };

  const save = async () => {
    if (!master) {
      return;
    }

    const validationError = validateProjectClassification(master, draft);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const updated = await updateProjectClassification(project.id, draft, profile);
      onSaved(updated);
    } catch (saveError) {
      setError(formatUserFacingError(saveError, '사업 분류를 저장하지 못했습니다.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="classification-editor" aria-label="사업 분류 편집">
      <div className="classification-editor-header">
        <div>
          <div className="section-title">사업 기본정보 · 분류</div>
          <p className="panel-sub">
            {getProjectDisplayName(project)}
          </p>
        </div>
        <button type="button" className="small-btn" onClick={onClose}>닫기</button>
      </div>

      {loading && <div className="classification-loading">분류체계와 저장값을 불러오는 중입니다...</div>}
      {!loading && !master && (
        <div className="error-message">
          {error || '분류체계를 불러오지 못했습니다. migration SQL 적용 여부를 확인하세요.'}
        </div>
      )}

      {!loading && master && (
        <div className="classification-form">
          <section className="classification-section" aria-labelledby="project-category-title">
            <h3 id="project-category-title">사업분류</h3>
            <label className="classification-field">
              <span>대분류</span>
              <select
                value={draft.largeCategoryId ?? ''}
                onChange={(event) => updateLargeCategory(event.target.value || null)}
              >
                <option value="">대분류 선택</option>
                {master.largeCategories.map((category) => (
                  <option key={category.id} value={category.id}>{sanitizeClassificationNameForDisplay(category.name)}</option>
                ))}
              </select>
            </label>

            <div className="classification-field">
              <span>중분류</span>
              <div className="readonly-category" aria-live="polite">
                {middleCategory?.name ?? '소분류를 선택하면 자동으로 설정됩니다.'}
              </div>
              <small>※ 선택한 소분류에 따라 자동 설정됩니다.</small>
            </div>

            <div className="classification-field">
              <span>대표·관련 소분류</span>
              <div className="selected-category-chips" aria-live="polite">
                {selectedSmallCategories.map((category) => (
                  <span key={category.id} className={`category-chip ${draft.primarySmallCategoryId === category.id ? 'category-chip-primary' : ''}`}>
                    <label>
                      <input
                        type="radio"
                        name={`dashboard-primary-small-category-${project.id}`}
                        checked={draft.primarySmallCategoryId === category.id}
                        onChange={() => setDraft((current) => setPrimarySmallCategory(master, current, category.id))}
                      />
                      {draft.primarySmallCategoryId === category.id ? '대표' : '대표로 지정'} · {sanitizeClassificationNameForDisplay(category.name)}
                    </label>
                    <button type="button" onClick={() => updateSmallCategory(category.id, false)} aria-label={`${sanitizeClassificationNameForDisplay(category.name)} 선택 해제`}>×</button>
                  </span>
                ))}
                {selectedSmallCategories.length === 0 && (
                  <span className="classification-empty">소분류를 1개 이상 선택하세요.</span>
                )}
              </div>
              <input
                type="search"
                value={smallCategoryQuery}
                onChange={(event) => setSmallCategoryQuery(event.target.value)}
                placeholder="전체 승인 소분류 검색..."
                aria-label="전체 승인 소분류 검색"
              />
              <small>추천은 정렬 기준일 뿐이며, 아래 전체 승인 소분류는 계속 검색·선택할 수 있습니다.</small>
              <div className="small-category-options" role="group" aria-label="전체 승인 소분류">
                {availableSmallCategories.map((category) => (
                  <label key={category.id} className="small-category-option">
                    <input
                      type="checkbox"
                      checked={draft.smallCategoryIds.includes(category.id)}
                      onChange={(event) => updateSmallCategory(category.id, event.target.checked)}
                    />
                    <span>{sanitizeClassificationNameForDisplay(category.name)}</span>
                  </label>
                ))}
                {availableSmallCategories.length === 0 && (
                  <span className="classification-empty">
                    선택 가능한 소분류가 없습니다. 분류 마스터를 추가하거나 검색어를 바꾸세요.
                  </span>
                )}
              </div>

              <div className="custom-small-category-input">
                <div className="custom-small-category-heading">
                  <strong>목록에 없는 소분류 제안</strong>
                  <small>제안은 관리자 승인·매핑 후에만 공식 분류로 사용됩니다.</small>
                </div>
                <div className="custom-small-category-controls">
                  <input
                    type="text"
                    value={customSmallCategoryInput}
                    onChange={(event) => {
                      setCustomSmallCategoryInput(event.target.value);
                      setProposalMessage(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void submitProposal();
                      }
                    }}
                    placeholder="예: 청년 귀농 창업 정착 지원"
                    aria-label="목록에 없는 소분류 직접 입력"
                  />
                  <button
                    type="button"
                    className="small-btn"
                    onClick={() => void submitProposal()}
                    disabled={submittingProposal}
                  >
                    {submittingProposal ? '등록 중...' : '관리자에게 제안'}
                  </button>
                </div>
                <textarea
                  value={proposalReason}
                  onChange={(event) => setProposalReason(event.target.value)}
                  placeholder="제안 사유와 적용 사업 내용을 입력하세요."
                  aria-label="소분류 제안 사유"
                  rows={3}
                />
                {proposalMessage && <div className="success-message" aria-live="polite">{proposalMessage}</div>}
              </div>
              <SmallCategoryProposalStatusList items={proposals} loading={proposalsLoading} error={proposalsError} />
            </div>
          </section>

          <section className="classification-section business-type-section" aria-labelledby="business-type-title">
            <h3 id="business-type-title">사업유형</h3>
            <div className="business-type-options">
              {BUSINESS_TYPE_VALUES.map((businessType) => (
                <label key={businessType} className="business-type-option">
                  <input
                    type="radio"
                    name={`business-type-${project.id}`}
                    value={businessType}
                    checked={draft.businessType === businessType}
                    onChange={() => {
                      setDraft((current) => ({ ...current, businessType }));
                      setError(null);
                    }}
                  />
                  {BUSINESS_TYPE_LABELS[businessType]}
                </label>
              ))}
            </div>
          </section>

          {error && <div className="error-message">{error}</div>}
          <div className="classification-actions">
            <button type="button" className="small-btn" onClick={onClose} disabled={saving}>취소</button>
            <button type="button" className="classification-save-btn" onClick={save} disabled={saving}>
              {saving ? '저장 중...' : '분류 저장'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
