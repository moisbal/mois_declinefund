"use client";

import { useEffect, useRef, useState } from 'react';
import {
  deleteNewProjectAction,
  getNewProjectDeletionEligibilityAction,
  type NewProjectDeletionEligibility,
  type NewProjectDeletionResult,
  type NewProjectDeletionTargetKind,
} from '../../app/my-projects/workspace-actions';
import { sanitizeProjectNameForDisplay } from '../../lib/presentationLabels';

type Props = {
  accessToken: string;
  targetKind: NewProjectDeletionTargetKind;
  targetId: string;
  fallbackName: string;
  fallbackYear: number;
  onCancel: () => void;
  onDeleted: (result: NewProjectDeletionResult) => void | Promise<void>;
};

export default function NewProjectDeleteDialog({
  accessToken,
  targetKind,
  targetId,
  fallbackName,
  fallbackYear,
  onCancel,
  onDeleted,
}: Props) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const deletingRef = useRef(false);
  const onCancelRef = useRef(onCancel);
  const [eligibility, setEligibility] = useState<NewProjectDeletionEligibility | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getNewProjectDeletionEligibilityAction({ accessToken, targetKind, targetId }).then((result) => {
      if (cancelled) return;
      if ('error' in result) setError(result.error ?? '신규사업 삭제 가능 여부를 확인하지 못했습니다.');
      else setEligibility(result.data);
      setLoading(false);
      requestAnimationFrame(() => cancelButtonRef.current?.focus());
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !deletingRef.current) onCancelRef.current();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      cancelled = true;
      document.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, [accessToken, targetId, targetKind]);

  const confirmDelete = async () => {
    if (!eligibility?.can_delete || deleting) return;
    deletingRef.current = true;
    setDeleting(true);
    setError(null);
    const result = await deleteNewProjectAction({ accessToken, targetKind, targetId });
    if ('error' in result) {
      setError(result.error ?? '신규사업을 삭제하지 못했습니다.');
      deletingRef.current = false;
      setDeleting(false);
      const refreshed = await getNewProjectDeletionEligibilityAction({ accessToken, targetKind, targetId });
      if (!('error' in refreshed)) setEligibility(refreshed.data);
      return;
    }
    await onDeleted(result.data);
  };

  const year = eligibility?.fiscal_year ?? fallbackYear;
  const name = eligibility?.project_name
    ? sanitizeProjectNameForDisplay(eligibility.project_name, year)
    : fallbackName;

  return (
    <div className="new-project-delete-overlay" role="presentation">
      <section
        className="new-project-delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-delete-title"
        aria-describedby="new-project-delete-description"
      >
        <p className="work-eyebrow">삭제 전 최종 확인</p>
        <h2 id="new-project-delete-title">{targetKind === 'DRAFT' ? '신규사업 초안 삭제' : '등록 완료 신규사업 삭제'}</h2>
        <div className="new-project-delete-target">
          <span>사업</span><strong>{name}</strong>
          <span>사업연도</span><strong>{year}년</strong>
        </div>
        <p id="new-project-delete-description">
          {eligibility?.impact ?? (targetKind === 'DRAFT'
            ? '초안만 삭제하며 공식 사업 수와 재정 금액에는 영향을 주지 않습니다.'
            : '재정거래가 없는 신규사업만 논리 삭제하며 과거 이력은 보존합니다.')}
        </p>
        {loading && <p className="new-project-delete-check" role="status">삭제 조건과 거래 이력을 확인하는 중입니다...</p>}
        {!loading && eligibility && !eligibility.can_delete && (
          <p className="new-project-delete-blocked" role="alert"><strong>삭제할 수 없습니다.</strong>{eligibility.reason}</p>
        )}
        {error && <p className="financial-ledger-error" role="alert">{error}</p>}
        <div className="funding-inline-actions">
          <button ref={cancelButtonRef} type="button" className="small-btn" disabled={deleting} onClick={onCancel}>취소</button>
          <button
            type="button"
            className="danger-action-button"
            disabled={loading || deleting || !eligibility?.can_delete}
            onClick={() => void confirmDelete()}
          >
            {deleting ? '삭제 처리 중...' : '삭제'}
          </button>
        </div>
      </section>
    </div>
  );
}
