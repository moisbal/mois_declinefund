import type { SmallCategoryProposal } from '../../lib/projectChanges';
import {
  formatSmallCategoryProposalStatus,
  formatStoredUserText,
  sanitizeClassificationNameForDisplay,
} from '../../lib/presentationLabels';

type Props = {
  items: SmallCategoryProposal[];
  loading: boolean;
  error?: string | null;
};

function resultText(item: SmallCategoryProposal) {
  if (item.status === 'REJECTED') {
    return item.rejection_reason ? `반려 사유: ${formatStoredUserText(item.rejection_reason, '사유 미입력')}` : '반려 사유를 확인해 주세요.';
  }
  if (item.status === 'APPROVED') {
    return item.resolvedSmallCategoryName
      ? `신규 공식 소분류: ${sanitizeClassificationNameForDisplay(item.resolvedSmallCategoryName)}`
      : '신규 공식 소분류로 승인되었습니다.';
  }
  if (item.status === 'MAPPED') {
    return item.resolvedSmallCategoryName
      ? `연결된 기존 소분류: ${sanitizeClassificationNameForDisplay(item.resolvedSmallCategoryName)}`
      : '기존 공식 소분류에 연결되었습니다.';
  }
  return '관리자 검토 후 결과가 이 목록에 표시됩니다.';
}

export default function SmallCategoryProposalStatusList({ items, loading, error }: Props) {
  return (
    <section className="small-category-proposal-history" aria-live="polite" aria-busy={loading}>
      <div className="custom-small-category-heading">
        <strong>내 소분류 제안 처리현황</strong>
        <small>이 사업에서 제출한 제안만 표시됩니다.</small>
      </div>
      {loading && <div className="classification-loading">제안 처리현황을 불러오는 중입니다...</div>}
      {!loading && error && <div className="my-project-field-error" role="alert">{error}</div>}
      {!loading && !error && items.length === 0 && (
        <div className="classification-empty">이 사업에서 제출한 소분류 제안이 없습니다.</div>
      )}
      {!loading && !error && items.length > 0 && (
        <div className="small-category-proposal-status-list">
          {items.map((item) => (
            <article key={item.id} className="small-category-proposal-status-item">
              <div>
                <strong>{sanitizeClassificationNameForDisplay(item.proposed_name)}</strong>
                <span className={`custom-category-status custom-category-status-${item.status.toLowerCase()}`}>
                  {formatSmallCategoryProposalStatus(item.status)}
                </span>
              </div>
              <p>{formatStoredUserText(item.proposal_reason, '제안 사유 미입력')}</p>
              <small>{resultText(item)}</small>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
