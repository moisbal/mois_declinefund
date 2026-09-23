"use client";

import { useEffect, useState } from 'react';
import { getProjectChangeEvents, type ProjectChangeEvent } from '../../lib/projectChanges';
import { SIMILARITY_RELATIONSHIP_LABELS } from '../../lib/projectChange';
import {
  formatSystemTerm,
  formatUserFacingError,
  sanitizeClassificationNameForDisplay,
  sanitizeProjectNameForDisplay,
} from '../../lib/presentationLabels';

export default function ProjectChangeHistoryPanel({ projectId, sectionNumber = 6 }: { projectId: string; sectionNumber?: number }) {
  const [events, setEvents] = useState<ProjectChangeEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getProjectChangeEvents(projectId)
      .then((rows) => { if (!cancelled) setEvents(rows); })
      .catch((loadError) => { if (!cancelled) setError(formatUserFacingError(loadError, '변경이력을 불러오지 못했습니다.')); });
    return () => { cancelled = true; };
  }, [projectId]);

  return (
    <section className="my-project-section" aria-labelledby="project-change-history-title">
      <div className="my-project-section-heading">
        <span className="my-project-section-number">{sectionNumber}</span>
        <div><h2 id="project-change-history-title">사업변경 이력</h2><p>사업명과 분류의 과거 상태를 추적합니다.</p></div>
      </div>
      {error && <div className="my-project-field-error">{error}</div>}
      {!error && events.length === 0 && <div className="empty-state">저장된 변경이력이 없습니다.</div>}
      {events.length > 0 && <div className="table-scroll"><table>
        <thead><tr><th>변경일시</th><th>사업명 전 → 후</th><th>근거·사유</th><th>분류 전 → 후</th><th>유사사업</th><th>변경자</th><th>재정 영향</th></tr></thead>
        <tbody>{events.map((event) => <tr key={event.id}>
          <td>{new Date(event.changed_at).toLocaleString('ko-KR')}</td>
          <td>{sanitizeProjectNameForDisplay(event.old_name, event.fiscal_year)} → {sanitizeProjectNameForDisplay(event.new_name, event.fiscal_year)}</td>
          <td>{event.change_basis_label ?? '-'}<small>{event.change_reason_labels.join(', ') || '-'}</small></td>
          <td>{sanitizeClassificationNameForDisplay(event.old_classification.primary_small_category_name, '-')} → {sanitizeClassificationNameForDisplay(event.new_classification.primary_small_category_name, '-')}</td>
          <td>{event.similarity_result ? SIMILARITY_RELATIONSHIP_LABELS[event.similarity_result as keyof typeof SIMILARITY_RELATIONSHIP_LABELS] ?? formatSystemTerm(event.similarity_result, '관계 확인 필요') : '해당 없음'}</td>
          <td>{event.actorLabel ?? '사용자 정보 없음'}</td>
          <td>재정금액 영향 없음</td>
        </tr>)}</tbody>
      </table></div>}
    </section>
  );
}
