"use client";

import { useState } from 'react';
import {
  SIMILARITY_RELATIONSHIP_LABELS,
  type SimilarityRelationship,
} from '../../lib/projectChange';
import type { SimilarProjectCandidate } from '../../lib/projectChanges';
import { formatProjectReference, sanitizeClassificationNameForDisplay, sanitizeProjectNameForDisplay } from '../../lib/presentationLabels';

type SimilarProjectDialogProps = {
  sourceProjectName: string;
  candidates: SimilarProjectCandidate[];
  onDecision: (relationship: SimilarityRelationship, candidate: SimilarProjectCandidate | null) => void;
  onClose: () => void;
};

export default function SimilarProjectDialog({
  sourceProjectName,
  candidates,
  onDecision,
  onClose,
}: SimilarProjectDialogProps) {
  const [selectedId, setSelectedId] = useState(candidates[0]?.candidateProjectId ?? '');
  const selected = candidates.find((candidate) => candidate.candidateProjectId === selectedId) ?? null;

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="similar-project-dialog" role="dialog" aria-modal="true" aria-labelledby="similar-project-title">
        <div className="similar-project-dialog-heading">
          <div>
            <h2 id="similar-project-title">유사한 사업이 확인되었습니다.</h2>
            <p>“{sanitizeProjectNameForDisplay(sourceProjectName)}”과 유사한 후보입니다. 시스템은 후보만 추천하며 사업을 합치거나 확정하지 않습니다.</p>
          </div>
          <button type="button" className="small-btn" onClick={onClose}>닫기</button>
        </div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>선택</th><th>사업명</th><th>연도</th><th>분류</th><th>유사도</th></tr></thead>
            <tbody>
              {candidates.map((candidate) => (
                <tr key={candidate.candidateProjectId}>
                  <td><input type="radio" name="similar-project-candidate" checked={selectedId === candidate.candidateProjectId} onChange={() => setSelectedId(candidate.candidateProjectId)} /></td>
                  <td><strong>{formatProjectReference({ project_name: candidate.projectName, project_code: candidate.projectCode, status: 'APPLIED' })}</strong><small>{candidate.regionName ?? '-'}</small></td>
                  <td>{candidate.fiscalYear ?? '-'}</td>
                  <td>{sanitizeClassificationNameForDisplay(candidate.classificationName, '-')}</td>
                  <td>{Math.round(candidate.similarityScore * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="similar-project-actions">
          <button type="button" className="my-project-save-button" disabled={!selected} onClick={() => onDecision('SAME_LOGICAL_PROJECT', selected)}>
            {SIMILARITY_RELATIONSHIP_LABELS.SAME_LOGICAL_PROJECT}
          </button>
          <button type="button" className="small-btn" disabled={!selected} onClick={() => onDecision('SUBPROJECT', selected)}>
            {SIMILARITY_RELATIONSHIP_LABELS.SUBPROJECT}
          </button>
          <button type="button" className="small-btn" onClick={() => onDecision('SEPARATE', null)}>
            {SIMILARITY_RELATIONSHIP_LABELS.SEPARATE}
          </button>
          <button type="button" className="small-btn" onClick={() => onDecision('UNDECIDED', null)}>
            {SIMILARITY_RELATIONSHIP_LABELS.UNDECIDED}
          </button>
        </div>
        <p className="financial-ledger-notice">판단 결과는 사업정보 관계로만 기록되며 재정금액과 연도별 사업 자료는 그대로 유지됩니다.</p>
      </section>
    </div>
  );
}
