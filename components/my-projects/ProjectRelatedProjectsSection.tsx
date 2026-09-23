"use client";

import { formatIntegerString, formatWonAsManwon } from '../../lib/amountFormat';
import { sanitizeProjectNameForDisplay } from '../../lib/presentationLabels';
import {
  createRelatedProjectDraft,
  getRelatedProjectsEmptyState,
  normalizeAmountInput,
  type RelatedProjectDraft,
} from '../../lib/myProjectEdit';

type RelatedAmountKey = 'totalBudget' | 'regionalFundAlloc' | 'localFundAlloc';

type ProjectRelatedProjectsSectionProps = {
  enabled?: boolean;
  rows: RelatedProjectDraft[];
  onEnabledChange?: (enabled: boolean) => void;
  onRowsChange?: (rows: RelatedProjectDraft[]) => void;
  sectionNumber?: number;
  readOnly?: boolean;
};

function AmountCell({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <input
      type="text"
      inputMode="numeric"
      value={formatIntegerString(value)}
      onChange={(event) => onChange(normalizeAmountInput(event.target.value))}
      aria-label={label}
    />
  );
}

export default function ProjectRelatedProjectsSection({
  enabled = false,
  rows,
  onEnabledChange,
  onRowsChange,
  sectionNumber = 5,
  readOnly = false,
}: ProjectRelatedProjectsSectionProps) {
  const updateRow = (clientId: string, changes: Partial<RelatedProjectDraft>) => {
    onRowsChange?.(rows.map((row) => (row.clientId === clientId ? { ...row, ...changes } : row)));
  };

  const removeRow = (clientId: string) => {
    const row = rows.find((item) => item.clientId === clientId);
    if (!row || window.confirm(`“${row.projectName || '이 연계사업'}” 항목을 삭제하시겠습니까?`)) {
      onRowsChange?.(rows.filter((item) => item.clientId !== clientId));
    }
  };

  const disableRelatedProjects = () => {
    if (rows.length > 0 && !window.confirm(
      '연계사업 없음을 선택하면 현재 입력값은 화면에서 숨겨지고, 저장 시 삭제됩니다. 계속하시겠습니까?',
    )) {
      return;
    }
    onEnabledChange?.(false);
  };

  const amountKeys: RelatedAmountKey[] = ['totalBudget', 'regionalFundAlloc', 'localFundAlloc'];
  const emptyState = getRelatedProjectsEmptyState(rows);

  return (
    <section className="my-project-section" aria-labelledby="my-project-related-title">
      <div className="my-project-section-heading">
        <span className="my-project-section-number">{sectionNumber}</span>
        <div>
          <h2 id="my-project-related-title">타 사업과의 연계</h2>
          <p>기금이 다른 사업과 함께 사용되는 경우에만 연계사업을 등록합니다.</p>
        </div>
      </div>

      {!readOnly && <div className="my-project-related-question">
        <span>기금이 다른 사업에 함께 사용되고 있습니까?</span>
        <div className="segmented-options" role="radiogroup" aria-label="타 사업 연계 여부">
          <label>
            <input type="radio" name="related-projects-enabled" checked={!enabled} onChange={disableRelatedProjects} />
            없음
          </label>
          <label>
            <input type="radio" name="related-projects-enabled" checked={enabled} onChange={() => onEnabledChange?.(true)} />
            있음
          </label>
        </div>
      </div>}

      {readOnly && emptyState && (
        <div className="empty-state">{emptyState}</div>
      )}

      {(readOnly ? rows.length > 0 : enabled) && (
        <div className="my-project-related-editor">
          <div className="my-project-related-toolbar">
            <strong>연계사업 목록</strong>
            {!readOnly && (
              <button type="button" className="small-btn" onClick={() => onRowsChange?.([...rows, createRelatedProjectDraft()])}>
                + 연계사업 추가
              </button>
            )}
          </div>
          <div className="table-scroll">
            <table className="my-project-related-table">
              <thead>
                <tr>
                  <th>타 사업명</th>
                  <th className="num">총사업비({readOnly ? '만원' : '원'})</th>
                  <th className="num">광역 기금 배분액({readOnly ? '만원' : '원'})</th>
                  <th className="num">기초 기금 배분액({readOnly ? '만원' : '원'})</th>
                  {!readOnly && <th>관리</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.clientId}>
                    <td>
                      {readOnly ? sanitizeProjectNameForDisplay(row.projectName) : (
                        <input
                          type="text"
                          value={row.projectName}
                          onChange={(event) => updateRow(row.clientId, { projectName: event.target.value })}
                          aria-label="타 사업명"
                          maxLength={200}
                        />
                      )}
                    </td>
                    {amountKeys.map((key) => (
                      <td key={key} className="num">
                        {readOnly ? <span className="amount-display" title={`${formatIntegerString(row[key])}원`}>{formatWonAsManwon(row[key])}</span> : (
                          <AmountCell
                            label={key}
                            value={row[key]}
                            onChange={(value) => updateRow(row.clientId, { [key]: value })}
                          />
                        )}
                      </td>
                    ))}
                    {!readOnly && <td>
                      <button type="button" className="small-btn" onClick={() => removeRow(row.clientId)}>삭제</button>
                    </td>}
                  </tr>
                ))}
                {!readOnly && rows.length === 0 && (
                  <tr><td colSpan={5} className="empty-state">연계사업을 추가해 주세요.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
