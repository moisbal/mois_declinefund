"use client";

import { useEffect, useState } from 'react';
import {
  getCustomSmallCategoryReviewItems,
  reviewCustomSmallCategory,
  type CustomSmallCategoryReviewItem,
} from '../../lib/customSmallCategories';
import {
  formatProjectReference,
  formatSystemTerm,
  formatUserFacingError,
  sanitizeClassificationNameForDisplay,
} from '../../lib/presentationLabels';

function getProjectDisplayName(item: CustomSmallCategoryReviewItem) {
  const name = item.projects?.detail_project_name?.trim()
    || item.projects?.fund_project_name?.trim()
    || item.projects?.project_name?.trim()
    || null;
  return formatProjectReference({
    project_name: name,
    project_code: item.projects?.project_code,
    status: 'APPLIED',
  });
}

function getMethodLabel(item: CustomSmallCategoryReviewItem) {
  const labels: Record<string, string> = {
    EXACT_MASTER: '표준명 일치',
    ALIAS_EXACT: '등록 별칭 일치',
    ALIAS_CONTAINS: '등록 별칭 포함',
    SIMILAR_NAME: '유사도 추천',
    MANUAL_CONTEXT: '사용자 문맥 지정',
  };
  return labels[item.classification_method] ?? '기타 분류 방식';
}

export default function CustomSmallCategoryReviewPanel() {
  const [items, setItems] = useState<CustomSmallCategoryReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setMessage(null);
    try {
      setItems(await getCustomSmallCategoryReviewItems());
    } catch (loadError) {
      setItems([]);
      setMessage(formatUserFacingError(loadError, '사용자 입력 소분류 검토 목록을 불러오지 못했습니다.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const review = async (
    item: CustomSmallCategoryReviewItem,
    action: 'CONFIRM' | 'REJECT' | 'PROMOTE',
  ) => {
    let standardSmallCategoryName: string | undefined;
    if (action === 'REJECT' && !window.confirm(`“${item.input_value}” 입력값을 반려하시겠습니까?`)) {
      return;
    }
    if (action === 'PROMOTE') {
      const input = window.prompt(
        '표준 소분류명을 입력하세요. 비워 두면 사용자 입력값을 그대로 사용합니다.',
        item.input_value,
      );
      if (input === null) {
        return;
      }
      standardSmallCategoryName = input;
    }

    setWorkingId(item.id);
    setMessage(null);
    try {
      await reviewCustomSmallCategory(item.id, action, standardSmallCategoryName);
      await load();
      setMessage(
        action === 'PROMOTE'
          ? '표준 소분류로 승격하고 이후 자동 분류에 사용할 별칭을 등록했습니다.'
          : action === 'CONFIRM'
            ? '사용자 입력 소분류를 확정했습니다.'
            : '사용자 입력 소분류를 반려했습니다.',
      );
    } catch (reviewError) {
      setMessage(formatUserFacingError(reviewError, '사용자 입력 소분류 검토를 저장하지 못했습니다.'));
    } finally {
      setWorkingId(null);
    }
  };

  return (
    <section className="panel custom-category-review-panel">
      <div className="custom-category-review-header">
        <div>
          <div className="section-title">사용자 입력 소분류 검토</div>
          <p className="panel-sub">
            직접 입력된 값은 표준 분류와 분리되어 저장됩니다. 필요 시 표준 소분류와 자동 분류 별칭으로 승격하세요.
          </p>
        </div>
        <button type="button" className="small-btn" onClick={() => void load()} disabled={loading}>
          새로고침
        </button>
      </div>

      {message && <div className="toast-message">{message}</div>}
      {loading && <div className="classification-loading">검토 목록을 불러오는 중입니다...</div>}
      {!loading && items.length === 0 && (
        <div className="classification-empty">검토할 사용자 입력 소분류가 없습니다.</div>
      )}
      {!loading && items.length > 0 && (
        <div className="table-scroll custom-category-review-table">
          <table>
            <thead>
              <tr>
                <th>사용자 입력</th>
                <th>사업</th>
                <th>판정 분류</th>
                <th>검증 결과</th>
                <th>등록일</th>
                <th>검토</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{sanitizeClassificationNameForDisplay(item.input_value)}</strong>
                    <div className="custom-category-normalized">{sanitizeClassificationNameForDisplay(item.normalized_value)}</div>
                  </td>
                  <td>
                    <div>{getProjectDisplayName(item)}</div>
                  </td>
                  <td>
                    <div>{sanitizeClassificationNameForDisplay(item.large_categories?.name, '-')} &gt; {sanitizeClassificationNameForDisplay(item.middle_categories?.name, '-')}</div>
                    <div className="custom-category-normalized">추천: {sanitizeClassificationNameForDisplay(item.small_categories?.name, '-')}</div>
                  </td>
                  <td>
                    <div className={`custom-category-status custom-category-status-${item.validation_status.toLowerCase()}`}>
                      {formatSystemTerm(item.validation_status, '상태 확인 필요')}
                    </div>
                    <div className="custom-category-normalized">
                      {getMethodLabel(item)} · {Math.round(item.confidence * 100)}%
                    </div>
                  </td>
                  <td>{item.created_at ? new Date(item.created_at).toLocaleDateString('ko-KR') : '-'}</td>
                  <td>
                    <div className="custom-category-review-actions">
                      <button
                        type="button"
                        className="small-btn"
                        onClick={() => void review(item, 'CONFIRM')}
                        disabled={workingId === item.id || item.validation_status === 'CONFIRMED'}
                      >
                        확정
                      </button>
                      <button
                        type="button"
                        className="small-btn"
                        onClick={() => void review(item, 'PROMOTE')}
                        disabled={workingId === item.id}
                      >
                        표준 승격
                      </button>
                      <button
                        type="button"
                        className="small-btn custom-category-reject-btn"
                        onClick={() => void review(item, 'REJECT')}
                        disabled={workingId === item.id}
                      >
                        반려
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
