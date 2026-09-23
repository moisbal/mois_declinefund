"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getRecommendedSmallCategories,
  getSmallCategoriesForDraft,
  setPrimarySmallCategory,
  toggleSmallCategorySelection,
  validateCustomSmallCategoryInput,
  type ProjectCategoryMaster,
  type ProjectClassificationDraft,
} from '../../lib/projectClassification';
import {
  getProjectSmallCategoryProposals,
  submitSmallCategoryProposal,
  type SmallCategoryProposal,
} from '../../lib/projectChanges';
import { formatUserFacingError, sanitizeClassificationNameForDisplay } from '../../lib/presentationLabels';
import SmallCategoryProposalStatusList from './SmallCategoryProposalStatusList';

type ProjectClassificationSectionProps = {
  projectId: string;
  master: ProjectCategoryMaster;
  draft: ProjectClassificationDraft;
  onChange: (draft: ProjectClassificationDraft) => void;
};

export default function ProjectClassificationSection({
  projectId,
  master,
  draft,
  onChange,
}: ProjectClassificationSectionProps) {
  const [query, setQuery] = useState('');
  const [proposalName, setProposalName] = useState('');
  const [proposalReason, setProposalReason] = useState('');
  const [submittingProposal, setSubmittingProposal] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [proposals, setProposals] = useState<SmallCategoryProposal[]>([]);
  const [proposalsLoading, setProposalsLoading] = useState(true);
  const [proposalsError, setProposalsError] = useState<string | null>(null);

  const loadProposals = useCallback(async () => {
    setProposalsLoading(true);
    setProposalsError(null);
    try {
      setProposals(await getProjectSmallCategoryProposals(projectId));
    } catch (error) {
      setProposals([]);
      setProposalsError(formatUserFacingError(error, '소분류 제안 처리현황을 불러오지 못했습니다.'));
    } finally {
      setProposalsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadProposals();
  }, [loadProposals]);

  const selected = useMemo(() => {
    const ids = new Set(draft.smallCategoryIds);
    return master.smallCategories.filter((category) => ids.has(category.id));
  }, [draft.smallCategoryIds, master.smallCategories]);

  const recommended = useMemo(() => getRecommendedSmallCategories(master, draft, 8), [draft, master]);
  const allCategories = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('ko-KR');
    return getSmallCategoriesForDraft(master, draft).filter((category) => {
      if (!normalized) return true;
      const middle = master.middleCategories.find((item) => item.id === category.middle_category_id);
      const large = master.largeCategories.find((item) => item.id === category.large_category_id);
      return [category.name, sanitizeClassificationNameForDisplay(category.name), category.code, middle?.name, large?.name]
        .some((value) => value?.toLocaleLowerCase('ko-KR').includes(normalized));
    });
  }, [draft, master, query]);

  const middle = master.middleCategories.find((category) => category.id === draft.middleCategoryId);
  const large = master.largeCategories.find((category) => category.id === draft.largeCategoryId);

  const toggle = (categoryId: string, checked: boolean) => {
    onChange(toggleSmallCategorySelection(master, draft, categoryId, checked));
    setMessage(null);
  };

  const submitProposal = async () => {
    const inputError = validateCustomSmallCategoryInput(proposalName);
    if (inputError) {
      setMessage(inputError);
      return;
    }
    if (proposalReason.trim().length < 5) {
      setMessage('제안 사유를 5자 이상 입력하세요.');
      return;
    }
    if (proposals.some((item) => item.status === 'SUBMITTED'
      && item.proposed_name.trim().toLocaleLowerCase('ko-KR') === proposalName.trim().toLocaleLowerCase('ko-KR'))) {
      setMessage('같은 소분류 제안이 이미 검토 대기 중입니다. 아래 처리현황을 확인해 주세요.');
      return;
    }
    setSubmittingProposal(true);
    setMessage(null);
    try {
      await submitSmallCategoryProposal(projectId, proposalName, proposalReason);
      setProposalName('');
      setProposalReason('');
      setMessage('소분류 제안을 제출했습니다. 승인 전에는 공식 분류통계에 반영되지 않습니다.');
      await loadProposals();
    } catch (error) {
      setMessage(formatUserFacingError(error, '소분류 제안을 제출하지 못했습니다.'));
    } finally {
      setSubmittingProposal(false);
    }
  };

  const categoryLabel = (category: ProjectCategoryMaster['smallCategories'][number]) => {
    const middleCategory = master.middleCategories.find((item) => item.id === category.middle_category_id);
    const largeCategory = master.largeCategories.find((item) => item.id === category.large_category_id);
    return `${sanitizeClassificationNameForDisplay(largeCategory?.name, '-')} > ${sanitizeClassificationNameForDisplay(middleCategory?.name, '-')} · ${sanitizeClassificationNameForDisplay(category.name)}`;
  };

  return (
    <section className="my-project-section" aria-labelledby="my-project-classification-title">
      <div className="my-project-section-heading">
        <span className="my-project-section-number">2</span>
        <div>
          <h2 id="my-project-classification-title">사업분류</h2>
          <p>대표 소분류 1개만 공식 금액통계에 사용하고, 관련 소분류는 검색·분석에만 활용합니다.</p>
        </div>
      </div>

      <div className="my-project-classification-grid">
        <div className="my-project-field">
          <span>대분류</span>
          <div className="readonly-category">{large?.name ?? '대표 소분류를 선택하세요.'}</div>
        </div>
        <div className="my-project-field">
          <span>중분류</span>
          <div className="readonly-category">{middle?.name ?? '대표 소분류를 선택하세요.'}</div>
        </div>
      </div>

      <div className="my-project-field my-project-classification-small">
        <span>선택된 소분류 <em>대표 1개 필수</em></span>
        <div className="selected-category-chips" aria-live="polite">
          {selected.map((category) => (
            <span key={category.id} className={`category-chip ${draft.primarySmallCategoryId === category.id ? 'category-chip-primary' : ''}`}>
              <label>
                <input
                  type="radio"
                  name={`primary-small-category-${projectId}`}
                  checked={draft.primarySmallCategoryId === category.id}
                  onChange={() => onChange(setPrimarySmallCategory(master, draft, category.id))}
                />
                {draft.primarySmallCategoryId === category.id ? '대표' : '대표로 지정'} · {sanitizeClassificationNameForDisplay(category.name)}
              </label>
              <button type="button" onClick={() => toggle(category.id, false)} aria-label={`${sanitizeClassificationNameForDisplay(category.name)} 선택 해제`}>×</button>
            </span>
          ))}
          {selected.length === 0 && <span className="classification-empty">소분류를 선택하세요.</span>}
        </div>
      </div>

      <div className="classification-ranked-groups">
        <section>
          <h3>추천 소분류</h3>
          <p>현재 대표 분류와 가까운 순서입니다. 추천은 선택 범위를 제한하지 않습니다.</p>
          <div className="small-category-options" role="group" aria-label="추천 소분류">
            {recommended.map((category) => (
              <label key={category.id} className="small-category-option">
                <input
                  type="checkbox"
                  checked={draft.smallCategoryIds.includes(category.id)}
                  onChange={(event) => toggle(category.id, event.target.checked)}
                />
                <span>{categoryLabel(category)}</span>
              </label>
            ))}
          </div>
        </section>

        <section>
          <h3>전체 소분류</h3>
          <p>승인된 모든 소분류를 검색하고 복수 선택할 수 있습니다.</p>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="소분류·중분류·대분류 검색"
            aria-label="전체 소분류 검색"
          />
          <div className="small-category-options all-small-category-options" role="group" aria-label="전체 소분류">
            {allCategories.map((category) => (
              <label key={category.id} className="small-category-option">
                <input
                  type="checkbox"
                  checked={draft.smallCategoryIds.includes(category.id)}
                  onChange={(event) => toggle(category.id, event.target.checked)}
                />
                <span>{categoryLabel(category)}</span>
              </label>
            ))}
            {allCategories.length === 0 && <span className="classification-empty">검색 결과가 없습니다.</span>}
          </div>
        </section>
      </div>

      <div className="custom-small-category-input small-category-proposal-form">
        <div className="custom-small-category-heading">
          <strong>목록에 없는 소분류 직접 입력</strong>
          <small>입력 즉시 정식 분류가 되지 않으며 관리자의 승인·매핑을 거칩니다.</small>
        </div>
        <label className="my-project-field">
          <span>제안 소분류명 <em>필수</em></span>
          <input value={proposalName} onChange={(event) => setProposalName(event.target.value)} maxLength={100} />
        </label>
        <label className="my-project-field">
          <span>제안 사유 <em>필수</em></span>
          <textarea value={proposalReason} onChange={(event) => setProposalReason(event.target.value)} rows={3} maxLength={1000} />
        </label>
        <button type="button" className="small-btn" onClick={() => void submitProposal()} disabled={submittingProposal}>
          {submittingProposal ? '제출 중...' : '소분류 제안 제출'}
        </button>
      </div>
      {message && <div className={message.includes('제출했습니다') ? 'toast-message' : 'my-project-field-error'}>{message}</div>}
      <SmallCategoryProposalStatusList items={proposals} loading={proposalsLoading} error={proposalsError} />
    </section>
  );
}
