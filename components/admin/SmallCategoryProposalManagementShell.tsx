"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Header from '../common/Header';
import { EmptyState, ErrorState, PageHeader, StatusBadge } from '../common/WorkUi';
import { getCurrentSession, getCurrentUserProfile } from '../../lib/auth';
import { getProjectCategoryMaster } from '../../lib/projects';
import type { ProjectCategoryMaster } from '../../lib/projectClassification';
import {
  getSmallCategoryProposals,
  reviewSmallCategoryProposal,
  type SmallCategoryProposal,
} from '../../lib/projectChanges';
import {
  formatStoredUserText,
  formatProjectReference,
  sanitizeClassificationNameForDisplay,
  formatSmallCategoryProposalStatus,
  formatUserFacingError,
} from '../../lib/presentationLabels';

export default function SmallCategoryProposalManagementShell() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [master, setMaster] = useState<ProjectCategoryMaster | null>(null);
  const [items, setItems] = useState<SmallCategoryProposal[]>([]);
  const [middleByItem, setMiddleByItem] = useState<Record<string, string>>({});
  const [mappingByItem, setMappingByItem] = useState<Record<string, string>>({});
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = async () => {
    setMessage(null);
    setLoadError(null);
    setLoading(true);
    try {
      const [categoryMaster, proposals] = await Promise.all([
        getProjectCategoryMaster(),
        getSmallCategoryProposals(),
      ]);
      setMaster(categoryMaster);
      setItems(proposals);
      setMiddleByItem(Object.fromEntries(proposals.map((item) => [
        item.id,
        item.recommended_middle_category_id ?? '',
      ])));
    } catch (error) {
      setItems([]);
      setLoadError(formatUserFacingError(error, '소분류 제안을 불러오지 못했습니다.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const initialize = async () => {
      try {
        const session = await getCurrentSession();
        if (!session.data.session?.user) return router.replace('/');
        const profile = await getCurrentUserProfile();
        if (!profile) return router.replace('/');
        if (profile.first_login) return router.replace('/password-reset');
        if (profile.role !== 'admin') return router.replace('/dashboard');
        setReady(true);
        await load();
      } catch (error) {
        setReady(true);
        setLoading(false);
        setLoadError(formatUserFacingError(error, '관리자 권한을 확인하지 못했습니다.'));
      }
    };
    void initialize();
  }, [router]);

  const review = async (item: SmallCategoryProposal, action: 'APPROVE' | 'MAP' | 'REJECT') => {
    let rejectionReason: string | undefined;
    if (action === 'REJECT') {
      const value = window.prompt('반려 사유를 입력하세요.');
      if (value === null) return;
      rejectionReason = value;
    }
    setWorkingId(item.id);
    setMessage(null);
    try {
      await reviewSmallCategoryProposal({
        proposalId: item.id,
        action,
        middleCategoryId: middleByItem[item.id] || null,
        existingSmallCategoryId: mappingByItem[item.id] || null,
        rejectionReason,
      });
      await load();
      setMessage(action === 'APPROVE' ? '신규 소분류로 승인했습니다.' : action === 'MAP' ? '기존 소분류와 매핑했습니다.' : '소분류 제안을 반려했습니다.');
    } catch (error) {
      setMessage(formatUserFacingError(error, '소분류 제안을 처리하지 못했습니다.'));
    } finally {
      setWorkingId(null);
    }
  };

  if (!ready) return <div className="loading-shell">관리자 권한을 확인하는 중입니다...</div>;

  return <div className="dashboard-shell">
    <Header title="소분류 제안 관리" />
    <main aria-busy={loading || workingId !== null}>
      <PageHeader eyebrow="분류 검토 업무" title="소분류 제안 관리" description="지자체 제안을 검토해 신규 승인, 기존 분류 연결 또는 반려 처리합니다." meta={<StatusBadge label={`전체 ${items.length}건`} tone="info" />} />
      <div className="admin-page-navigation"><button type="button" className="small-btn" onClick={() => router.push('/admin')}>관리자 메뉴</button><button type="button" className="small-btn" onClick={() => router.push('/admin/project-changes')}>사업변경 관리</button><button type="button" className="small-btn" disabled={loading} onClick={() => void load()}>{loading ? '불러오는 중...' : '새로고침'}</button></div>
      {message && <div className="toast-message">{message}</div>}
      {loading ? <EmptyState title="소분류 제안을 불러오는 중입니다." description="잠시만 기다려 주세요." /> : loadError || !master ? <ErrorState>
        <strong>{loadError ?? '분류 기준정보를 불러오지 못했습니다.'}</strong>
        <button type="button" className="small-btn" onClick={() => void load()}>다시 시도</button>
      </ErrorState> : <section className="panel">
        <div className="section-title">소분류 제안 관리</div>
        <p className="panel-sub">승인대기 제안은 공식 재정 분류통계에 포함되지 않습니다. 신규 승인에는 중분류 확정이 필수입니다.</p>
        {items.length === 0 ? <EmptyState title="등록된 소분류 제안이 없습니다." description="새 제안이 접수되면 이곳에 표시됩니다." /> : <div className="table-scroll"><table className="small-category-proposal-table"><thead><tr><th>제안 소분류명</th><th>신청 지자체</th><th>사업명</th><th>연도</th><th>현재 대표/관련 소분류</th><th>제안사유</th><th>추천 중분류</th><th>유사 기존 소분류</th><th>처리상태</th><th>관리자 처리</th></tr></thead>
          <tbody>{items.map((item) => <tr key={item.id}>
            <td><strong>{sanitizeClassificationNameForDisplay(item.proposed_name)}</strong></td>
            <td>{item.regions?.display_name ?? '-'}</td>
            <td>{formatProjectReference({
              project_name: item.projects?.detail_project_name
                || item.projects?.fund_project_name
                || item.projects?.project_name,
              project_code: item.project_code,
              status: 'APPLIED',
            })}</td>
            <td>{item.projects?.year ?? '-'}</td>
            <td><div><strong>대표:</strong> {item.currentPrimarySmallCategoryName ? sanitizeClassificationNameForDisplay(item.currentPrimarySmallCategoryName) : '미지정'}</div><div><strong>관련:</strong> {item.currentRelatedSmallCategoryNames?.map((name) => sanitizeClassificationNameForDisplay(name)).join(', ') || '없음'}</div></td>
            <td>{formatStoredUserText(item.proposal_reason, '제안 사유 미입력')}</td>
            <td>{sanitizeClassificationNameForDisplay(item.middle_categories?.name, '중분류 확인 필요')}</td>
            <td>{item.similar_small_categories.length > 0 ? item.similar_small_categories.map((category) => `${sanitizeClassificationNameForDisplay(category.name)}(${Math.round(Number(category.similarity) * 100)}%)`).join(', ') : '-'}</td>
            <td>{formatSmallCategoryProposalStatus(item.status)}</td>
            <td>{item.status === 'SUBMITTED' ? <div className="small-category-review-controls">
              <label><span>신규 승인 중분류</span><select value={middleByItem[item.id] ?? ''} onChange={(event) => setMiddleByItem((current) => ({ ...current, [item.id]: event.target.value }))}><option value="">중분류 선택</option>{master.middleCategories.map((middle) => <option key={middle.id} value={middle.id}>{sanitizeClassificationNameForDisplay(master.largeCategories.find((large) => large.id === middle.large_category_id)?.name, '-')} &gt; {sanitizeClassificationNameForDisplay(middle.name, '중분류 확인 필요')}</option>)}</select></label>
              <button type="button" className="small-btn" disabled={workingId !== null || !middleByItem[item.id]} onClick={() => void review(item, 'APPROVE')}>{workingId === item.id ? '처리 중...' : '신규 승인'}</button>
              <label><span>기존 소분류 매핑</span><select value={mappingByItem[item.id] ?? ''} onChange={(event) => setMappingByItem((current) => ({ ...current, [item.id]: event.target.value }))}><option value="">기존 소분류 선택</option>{master.smallCategories.map((small) => <option key={small.id} value={small.id}>{sanitizeClassificationNameForDisplay(small.name)}</option>)}</select></label>
              <button type="button" className="small-btn" disabled={workingId !== null || !mappingByItem[item.id]} onClick={() => void review(item, 'MAP')}>{workingId === item.id ? '처리 중...' : '기존분류 매핑'}</button>
              <button type="button" className="small-btn custom-category-reject-btn" disabled={workingId !== null} onClick={() => void review(item, 'REJECT')}>{workingId === item.id ? '처리 중...' : '반려'}</button>
            </div> : <span>{formatStoredUserText(item.rejection_reason, '처리 완료')}</span>}</td>
          </tr>)}</tbody></table></div>}
      </section>}
    </main>
  </div>;
}
