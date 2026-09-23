"use client";

import type { MyProjectEditDraft } from '../../lib/myProjectEdit';
import {
  PROJECT_NAME_CHANGE_BASIS_LABELS,
  PROJECT_NAME_CHANGE_BASIS_VALUES,
  PROJECT_NAME_CHANGE_REASON_HELP,
  PROJECT_NAME_CHANGE_REASON_LABELS,
  PROJECT_NAME_CHANGE_REASON_VALUES,
  toggleProjectNameChangeReason,
} from '../../lib/projectChange';
import { ReadonlyField } from '../common/WorkUi';
import ProjectExecutionStatusFields from './ProjectExecutionStatusFields';
import ProjectLifecycleOptions from './ProjectLifecycleOptions';

type ProjectBasicInfoSectionProps = {
  draft: Pick<
    MyProjectEditDraft,
    'detailProjectName' | 'nameChange' | 'projectPeriod' | 'projectStartYear' | 'status' | 'executionStatusReason'
  >;
  currentProjectName: string;
  projectYear: number | null;
  onChange: (changes: Partial<MyProjectEditDraft>) => void;
};

export default function ProjectBasicInfoSection({
  draft,
  currentProjectName,
  projectYear,
  onChange,
}: ProjectBasicInfoSectionProps) {
  const isContinuingProject = projectYear !== null && draft.projectStartYear !== projectYear;
  const isNameChanged = draft.detailProjectName.trim() !== currentProjectName.trim();
  const selectableYears = projectYear === null
    ? []
    : Array.from({ length: Math.min(30, Math.max(1, projectYear - 1899)) }, (_, index) => projectYear - index);

  return (
    <section className="my-project-section" aria-labelledby="my-project-basic-title">
      <div className="my-project-section-heading">
        <span className="my-project-section-number">1</span>
        <div>
          <h2 id="my-project-basic-title">기본정보</h2>
          <p>사업의 기본 식별정보와 현재 추진 상태를 입력합니다.</p>
        </div>
      </div>

      <div className="my-project-form-grid">
        <div className="my-project-field-wide"><ReadonlyField label="현재 사업명">{currentProjectName}</ReadonlyField></div>

        <label className="my-project-field my-project-field-wide">
          <span>변경 사업명 <em>필수</em></span>
          <input
            type="text"
            value={draft.detailProjectName}
            onChange={(event) => onChange({ detailProjectName: event.target.value })}
            maxLength={250}
            required
          />
        </label>

        {isNameChanged && (
          <div className="project-name-change-fields my-project-field-wide">
            <fieldset>
              <legend>사업명 변경 근거 <em>필수</em></legend>
              <div className="segmented-options">
                {PROJECT_NAME_CHANGE_BASIS_VALUES.map((basis) => (
                  <label key={basis}>
                    <input
                      type="radio"
                      name="project-name-change-basis"
                      checked={draft.nameChange.basisCode === basis}
                      onChange={() => onChange({
                        nameChange: { ...draft.nameChange, basisCode: basis },
                      })}
                    />
                    {PROJECT_NAME_CHANGE_BASIS_LABELS[basis]}
                  </label>
                ))}
              </div>
            </fieldset>
            {draft.nameChange.basisCode === 'OTHER' && (
              <label className="my-project-field">
                <span>기타 변경 근거 <em>필수</em></span>
                <input
                  type="text"
                  value={draft.nameChange.otherBasis}
                  onChange={(event) => onChange({
                    nameChange: { ...draft.nameChange, otherBasis: event.target.value },
                  })}
                  maxLength={500}
                />
              </label>
            )}
            <fieldset>
              <legend>사업명 변경 사유 <em>필수 · 복수선택 가능</em></legend>
              <div className="project-name-change-reasons">
                {PROJECT_NAME_CHANGE_REASON_VALUES.map((reason) => (
                  <label key={reason}>
                    <input
                      type="checkbox"
                      checked={draft.nameChange.reasonCodes.includes(reason)}
                      onChange={() => onChange({
                        nameChange: {
                          ...draft.nameChange,
                          reasonCodes: toggleProjectNameChangeReason(draft.nameChange.reasonCodes, reason),
                        },
                      })}
                    />
                    <span>
                      {PROJECT_NAME_CHANGE_REASON_LABELS[reason]}
                      {PROJECT_NAME_CHANGE_REASON_HELP[reason] && <small>{PROJECT_NAME_CHANGE_REASON_HELP[reason]}</small>}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {draft.nameChange.reasonCodes.includes('OTHER') && (
              <label className="my-project-field">
                <span>기타 변경 사유 <em>필수</em></span>
                <input
                  type="text"
                  value={draft.nameChange.otherReason}
                  onChange={(event) => onChange({
                    nameChange: { ...draft.nameChange, otherReason: event.target.value },
                  })}
                  maxLength={500}
                />
              </label>
            )}
            <label className="my-project-field">
              <span>상세 변경내용</span>
              <textarea
                value={draft.nameChange.detail}
                onChange={(event) => onChange({
                  nameChange: { ...draft.nameChange, detail: event.target.value },
                })}
                rows={4}
                maxLength={2000}
                placeholder="변경 전후의 구체적인 차이를 입력하세요."
              />
            </label>
          </div>
        )}

        <label className="my-project-field">
          <span>사업기간 <em>필수</em></span>
          <input
            type="text"
            value={draft.projectPeriod}
            onChange={(event) => onChange({ projectPeriod: event.target.value })}
            placeholder="예: 2025. 1. ~ 2025. 12."
            maxLength={120}
          />
        </label>

        <div className="my-project-field">
          <span>신규사업 / 계속사업 <em>필수</em></span>
          <ProjectLifecycleOptions
            fiscalYear={projectYear}
            projectStartYear={draft.projectStartYear}
            onChange={(projectStartYear) => onChange({ projectStartYear })}
            name="project-lifecycle"
          />
          {isContinuingProject && (
            <label className="my-project-conditional-field">
              <span>시작연도</span>
              <select
                value={draft.projectStartYear ?? ''}
                onChange={(event) => onChange({ projectStartYear: Number(event.target.value) || null })}
              >
                <option value="">시작연도 선택</option>
                {selectableYears.slice(1).map((year) => <option key={year} value={year}>{year}</option>)}
              </select>
            </label>
          )}
        </div>

        <div className="my-project-field-wide">
          <ProjectExecutionStatusFields
            status={draft.status}
            reason={draft.executionStatusReason}
            onChange={(status, executionStatusReason) => onChange({ status, executionStatusReason })}
            fieldClassName="my-project-field"
            namePrefix="my-project-execution"
          />
        </div>
      </div>
    </section>
  );
}
