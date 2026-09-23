"use client";

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Header from '../common/Header';
import { EmptyState, PageHeader, StatusBadge } from '../common/WorkUi';
import { formatSystemTerm, formatUserFacingError } from '../../lib/presentationLabels';
import { getCurrentSession, getCurrentUserProfile } from '../../lib/auth';
import {
  createLedgerCutoverAction,
  getLedgerCutoverAction,
  prepareLegacyBaselinesAction,
  type BaselinePreparationResult,
  type LedgerCutover,
} from '../../app/admin/ledger-cutover/actions';

const DEFAULT_OPERATING_START_DATE = '2026-09-01';
const DEFAULT_MEMO = '2026-09-01 재정원장 운영전환';

function previousIsoDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return '';

  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function formatDate(value: string | null) {
  if (!value) return '-';
  return value;
}

export default function LedgerCutoverShell() {
  const router = useRouter();
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [cutover, setCutover] = useState<LedgerCutover | null>(null);
  const [operatingStartDate, setOperatingStartDate] = useState(DEFAULT_OPERATING_START_DATE);
  const [memo, setMemo] = useState(DEFAULT_MEMO);
  const [preparationResult, setPreparationResult] = useState<BaselinePreparationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<'create' | 'prepare' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const baselineAsOf = useMemo(() => previousIsoDate(operatingStartDate), [operatingStartDate]);
  const isPreparing = cutover?.status === 'PREPARING';

  useEffect(() => {
    let active = true;

    const initialize = async () => {
      try {
        const sessionResult = await getCurrentSession();
        const session = sessionResult.data.session;
        if (!session?.user || !session.access_token) {
          router.replace('/');
          return;
        }

        const profile = await getCurrentUserProfile();
        if (!profile) {
          router.replace('/');
          return;
        }
        if (profile.first_login) {
          router.replace('/password-reset');
          return;
        }
        if (profile.role !== 'admin') {
          router.replace('/dashboard');
          return;
        }

        const result = await getLedgerCutoverAction({ accessToken: session.access_token });
        if ('error' in result) throw new Error(result.error);
        if (!active) return;

        setAccessToken(session.access_token);
        setCutover(result.data);
        if (result.data) {
          setOperatingStartDate(result.data.operating_start_date);
          setMemo(result.data.memo ?? '');
        }
      } catch (loadError: unknown) {
        if (active) {
          setError(formatUserFacingError(loadError, '운영전환 상태를 불러오지 못했습니다.'));
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    void initialize();
    return () => { active = false; };
  }, [router]);

  const startCutover = async () => {
    if (!accessToken || cutover || !baselineAsOf) return;

    setSubmitting('create');
    setError(null);
    setNotice(null);
    const result = await createLedgerCutoverAction({
      accessToken,
      operatingStartDate,
      memo,
    });

    if ('error' in result) {
      setError(formatUserFacingError(result.error, '운영전환 준비를 시작하지 못했습니다.'));
      setSubmitting(null);
      return;
    }

    setCutover({
      id: result.data.cutoverId,
      operating_start_date: operatingStartDate,
      baseline_as_of: baselineAsOf,
      status: 'PREPARING',
      memo: memo.trim() || null,
      created_at: null,
    });
    setNotice('운영전환 준비를 시작했습니다.');
    setSubmitting(null);
  };

  const prepareBaselines = async () => {
    if (!accessToken || !cutover || cutover.status !== 'PREPARING') return;

    setSubmitting('prepare');
    setError(null);
    setNotice(null);
    const result = await prepareLegacyBaselinesAction({ accessToken, cutoverId: cutover.id });

    if ('error' in result) {
      setError(formatUserFacingError(result.error, '기준잔액 초안을 생성하지 못했습니다.'));
      setSubmitting(null);
      return;
    }

    setPreparationResult(result.data);
    setCutover((current) => current ? { ...current, status: 'REVIEWING' } : current);
    setNotice('기준잔액 초안을 생성했습니다. 검토가 끝나기 전에는 운영전환을 확정할 수 없습니다.');
    setSubmitting(null);
  };

  if (loading) {
    return <div className="loading-shell">관리자 권한과 운영전환 상태를 확인하는 중입니다...</div>;
  }

  return (
    <div className="dashboard-shell">
      <Header title="재정원장 운영전환 관리" />
      <main style={{ maxWidth: 920, margin: '0 auto' }}>
        <PageHeader eyebrow="관리자 전환 업무" title="재정원장 운영전환" description="운영 시작일과 기준잔액을 준비하고 검토 상태를 확인합니다." meta={<StatusBadge label={cutover ? formatSystemTerm(cutover.status) : '작업 없음'} tone={cutover?.status === 'REVIEWING' ? 'warning' : cutover ? 'info' : 'neutral'} />} />
        <section className="panel">
          <div className="section-title">현재 운영전환 상태</div>
          {cutover ? (
            <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, auto) 1fr', gap: '10px 18px', margin: 0 }}>
              <dt>상태</dt><dd style={{ margin: 0, fontWeight: 700 }}>{formatSystemTerm(cutover.status)}</dd>
              <dt>운영 시작일</dt><dd style={{ margin: 0 }}>{formatDate(cutover.operating_start_date)}</dd>
              <dt>기준잔액 기준일</dt><dd style={{ margin: 0 }}>{formatDate(cutover.baseline_as_of)}</dd>
              <dt>메모</dt><dd style={{ margin: 0 }}>{cutover.memo || '-'}</dd>
            </dl>
          ) : (
            <EmptyState title="진행 중인 운영전환 작업이 없습니다." description="운영 시작일을 확인한 뒤 준비 작업을 시작하세요." />
          )}
        </section>

        <section className="panel">
          <div className="section-title">2026-09-01 재정원장 운영개시 준비</div>
          <p className="panel-sub">기준잔액 기준일은 운영 시작일 전날로 자동 계산되며 수정할 수 없습니다.</p>

          <div className="project-filter-form">
            <label>
              운영 시작일
              <input
                type="date"
                value={operatingStartDate}
                disabled={Boolean(cutover) || submitting !== null}
                onChange={(event) => setOperatingStartDate(event.target.value)}
              />
            </label>
            <label>
              기준잔액 기준일
              <input type="date" value={baselineAsOf} readOnly disabled aria-readonly="true" />
            </label>
            <label style={{ gridColumn: 'span 1' }}>
              메모
              <input
                value={memo}
                maxLength={1000}
                disabled={Boolean(cutover) || submitting !== null}
                onChange={(event) => setMemo(event.target.value)}
              />
            </label>
          </div>

          {!cutover && (
            <button className="my-project-save-button" type="button" disabled={submitting !== null || !baselineAsOf} onClick={() => void startCutover()}>
              {submitting === 'create' ? '운영전환 준비를 시작하는 중...' : '운영전환 준비 시작'}
            </button>
          )}

          {isPreparing && (
            <div style={{ marginTop: 16 }}>
              <button className="my-project-save-button" type="button" disabled={submitting !== null} onClick={() => void prepareBaselines()}>
                {submitting === 'prepare' ? '기준잔액 초안을 생성하는 중...' : '기준잔액 초안 생성'}
              </button>
            </div>
          )}

          {cutover?.status === 'REVIEWING' && (
            <p className="financial-ledger-status" style={{ marginTop: 16 }}>
              기준잔액 검토 진행 중입니다. 이 화면에서는 확정할 수 없으며, 검증완료/제외 검토가 모두 끝난 뒤에만 별도 절차로 확정할 수 있습니다.
            </p>
          )}

          {preparationResult && (
            <div className="financial-ledger-notice" role="status">
              <div>기준잔액 후보: {preparationResult.baseline_candidates.toLocaleString('ko-KR')}건</div>
              <div>자동 제외: {preparationResult.auto_excluded.toLocaleString('ko-KR')}건</div>
              <div>관리자 검토 필요: {preparationResult.needs_review.toLocaleString('ko-KR')}건</div>
            </div>
          )}
          {notice && <p className="financial-ledger-notice" role="status">{notice}</p>}
          {error && <p className="financial-ledger-error" role="alert">{error}</p>}
        </section>
      </main>
    </div>
  );
}
