"use client";

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Header from '../common/Header';
import { getCurrentSession, getCurrentUserProfile, type UserProfile } from '../../lib/auth';
import {
  completePostCheckRequestAction,
  createPostCheckRequestAction,
  getPostCheckCenterAction,
  markNotificationReadAction,
  replyPostCheckRequestAction,
} from '../../app/confirmations/actions';
import {
  POST_CHECK_STATUS_LABELS,
  POST_CHECK_SUBJECT_LABELS,
  type PostCheckCenter,
  type PostCheckRequest,
} from '../../lib/postChecks';
import { formatStoredUserText, sanitizeProjectNameForDisplay } from '../../lib/presentationLabels';

function formatDate(value: string | null, dateOnly = false) {
  if (!value) return '없음';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit' }),
  }).format(date);
}

function formatWon(value: string | null) {
  if (!value || !/^-?\d+$/.test(value)) return '금액 없음';
  return `${BigInt(value).toLocaleString('ko-KR')}원`;
}

function displayProjectName(request: Pick<PostCheckRequest, 'project_name' | 'fiscal_year'>) {
  return sanitizeProjectNameForDisplay(request.project_name, request.fiscal_year);
}

function displayActor(value: string | null, roleLabel: string) {
  return value ? roleLabel : '담당자 정보 없음';
}

export default function ConfirmationCenterShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedId = searchParams.get('request');
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [center, setCenter] = useState<PostCheckCenter | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(requestedId);
  const [tab, setTab] = useState<'INBOX' | 'REPLIES' | 'COMPLETED'>('INBOX');
  const [replyMessage, setReplyMessage] = useState('');
  const [recheckMessage, setRecheckMessage] = useState('');
  const [recheckDueDate, setRecheckDueDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const isAdmin = profile?.role === 'admin';

  const load = async (token: string) => {
    const result = await getPostCheckCenterAction({ accessToken: token });
    if (result.error) {
      setError(result.error);
      return;
    }
    setCenter(result.data ?? { requests: [], notifications: [], unreadCount: 0 });
  };

  useEffect(() => {
    const initialize = async () => {
      const [sessionResult, profileResult] = await Promise.all([
        getCurrentSession(), getCurrentUserProfile(),
      ]);
      const token = sessionResult.data.session?.access_token ?? null;
      if (!token || !profileResult) {
        router.replace('/');
        return;
      }
      setAccessToken(token);
      setProfile(profileResult);
      await load(token);
    };
    void initialize();
  }, [router]);

  useEffect(() => {
    if (requestedId) setSelectedId(requestedId);
  }, [requestedId]);

  const visibleRequests = useMemo(() => {
    const requests = center?.requests ?? [];
    if (isAdmin) {
      if (tab === 'INBOX') return requests.filter((item) => item.status === 'REQUESTED');
      if (tab === 'REPLIES') return requests.filter((item) => item.status === 'REPLIED');
      return requests.filter((item) => item.status === 'COMPLETED');
    }
    if (tab === 'INBOX') return requests.filter((item) => item.status === 'REQUESTED');
    return requests.filter((item) => item.status !== 'REQUESTED');
  }, [center, isAdmin, tab]);

  const selected = center?.requests.find((item) => item.id === selectedId)
    ?? visibleRequests[0]
    ?? null;

  const selectNotification = async (notificationId: string, requestId: string) => {
    if (!accessToken) return;
    setSelectedId(requestId);
    const notification = center?.notifications.find((item) => item.id === notificationId);
    if (notification?.read_at === null) {
      await markNotificationReadAction({ accessToken, notificationId });
      await load(accessToken);
    }
  };

  const perform = async (work: () => Promise<{ error?: string }>, success: string) => {
    if (!accessToken) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await work();
      if (result.error) {
        setError(result.error);
        return;
      }
      setNotice(success);
      setReplyMessage('');
      setRecheckMessage('');
      setRecheckDueDate('');
      await load(accessToken);
    } finally {
      setBusy(false);
    }
  };

  const relatedHref = (request: PostCheckRequest) => isAdmin
    ? `/admin/funding?subject=${request.subject_type}:${request.subject_id}`
    : request.project_id
      ? `/my-projects/${request.project_id}/edit?confirmation=${request.id}`
      : `/my-projects?tab=completed&rq=${encodeURIComponent(request.project_name ?? '')}`;

  return (
    <div className="confirmation-page">
      <Header title="확인요청 센터" />
      <main className="confirmation-shell">
        <header className="confirmation-heading">
          <div>
            <span className="confirmation-eyebrow">사후 점검</span>
            <h1>확인요청과 회신</h1>
            <p>확인요청은 등록·예산 처리를 차단하거나 금액을 변경하지 않습니다.</p>
          </div>
          <button type="button" disabled={!accessToken || busy} onClick={() => accessToken && void load(accessToken)}>새로고침</button>
        </header>

        {error && <div className="confirmation-message error" role="alert">{error}</div>}
        {notice && <div className="confirmation-message success" role="status">{notice}</div>}

        <section className="confirmation-notifications" aria-labelledby="notification-title">
          <div className="confirmation-section-title">
            <h2 id="notification-title">내 알림</h2>
            <span>{center?.unreadCount ?? 0}개 읽지 않음</span>
          </div>
          {(center?.notifications.length ?? 0) === 0 ? <p className="confirmation-empty">새 알림이 없습니다.</p> : (
            <div className="confirmation-notification-list">
              {center?.notifications.slice(0, 8).map((notification) => {
                const request = center.requests.find((item) => item.id === notification.related_post_check_id);
                const notificationTitle = request
                  ? `${notification.notification_type === 'POST_CHECK_REPLY' ? '확인요청 회신' : '확인요청'} · ${displayProjectName(request)}`
                  : formatStoredUserText(sanitizeProjectNameForDisplay(notification.title?.trim() || '확인요청 알림'));
                return (
                  <button
                    type="button"
                    key={notification.id}
                    className={notification.read_at ? 'read' : 'unread'}
                    onClick={() => void selectNotification(notification.id, notification.related_post_check_id)}
                  >
                    <span>{notification.read_at ? '조회함' : '새 알림'}</span>
                    <strong>{notificationTitle}</strong>
                    <p>{formatStoredUserText(notification.body, '알림 내용을 확인해 주세요.')}</p>
                    <small>요청일 {formatDate(notification.created_at)}{request?.due_date ? ` · 회신기한 ${formatDate(request.due_date, true)}` : ''}</small>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <div className="confirmation-workspace">
          <section className="confirmation-list-panel">
            <div className="confirmation-tabs" role="tablist" aria-label="확인요청 상태">
              <button type="button" role="tab" aria-selected={tab === 'INBOX'} className={tab === 'INBOX' ? 'active' : ''} onClick={() => setTab('INBOX')}>{isAdmin ? '요청 중' : '조회함'}</button>
              <button type="button" role="tab" aria-selected={tab === 'REPLIES'} className={tab === 'REPLIES' ? 'active' : ''} onClick={() => setTab('REPLIES')}>{isAdmin ? '회신됨' : '회신함'}</button>
              {isAdmin && <button type="button" role="tab" aria-selected={tab === 'COMPLETED'} className={tab === 'COMPLETED' ? 'active' : ''} onClick={() => setTab('COMPLETED')}>확인완료</button>}
            </div>
            {visibleRequests.length === 0 ? <p className="confirmation-empty">이 상태의 확인요청이 없습니다.</p> : (
              <div className="confirmation-request-list">
                {visibleRequests.map((request) => (
                  <button type="button" key={request.id} className={selected?.id === request.id ? 'active' : ''} onClick={() => setSelectedId(request.id)}>
                    <span>{POST_CHECK_SUBJECT_LABELS[request.subject_type]} · {request.region_name ?? '지자체'}</span>
                    <strong>{displayProjectName(request)}</strong>
                    <small>{POST_CHECK_STATUS_LABELS[request.status]} · {formatDate(request.requested_at)}</small>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="confirmation-detail-panel" aria-live="polite">
            {!selected ? <p className="confirmation-empty">확인요청을 선택해 주세요.</p> : (
              <>
                <header>
                  <div>
                    <span>{POST_CHECK_SUBJECT_LABELS[selected.subject_type]}</span>
                    <h2>{displayProjectName(selected)}</h2>
                  </div>
                  <span className={`confirmation-status ${selected.status.toLowerCase()}`}>{POST_CHECK_STATUS_LABELS[selected.status]}</span>
                </header>
                <dl className="confirmation-meta">
                  <div><dt>지자체</dt><dd>{selected.region_name ?? '지자체 확인 필요'}</dd></div>
                  <div><dt>사업연도</dt><dd>{selected.fiscal_year ? `${selected.fiscal_year}년` : '미확인'}</dd></div>
                  <div><dt>처리금액</dt><dd>{formatWon(selected.amount)}</dd></div>
                  <div><dt>요청일시</dt><dd>{formatDate(selected.requested_at)}</dd></div>
                  <div><dt>회신기한</dt><dd>{formatDate(selected.due_date, true)}</dd></div>
                  <div><dt>요청자</dt><dd>{displayActor(selected.requested_by, '관리자')}</dd></div>
                </dl>
                <article className="confirmation-copy"><h3>확인요청 내용</h3><p>{formatStoredUserText(selected.message, '확인요청 내용 없음')}</p></article>
                {selected.reply_message && <article className="confirmation-copy reply"><h3>조치내용·설명</h3><p>{formatStoredUserText(selected.reply_message, '회신 내용 없음')}</p><small>회신자 {displayActor(selected.replied_by, '지자체 담당자')} · {formatDate(selected.replied_at)}</small></article>}
                {selected.completed_at && <p className="confirmation-completed">관리자 확인완료 · {formatDate(selected.completed_at)} · 담당자 {displayActor(selected.completed_by, '관리자')}</p>}
                <div className="confirmation-detail-actions">
                  <button type="button" onClick={() => router.push(relatedHref(selected))}>관련 사업·예산연결 보기</button>
                  {!isAdmin && selected.status === 'REQUESTED' && (
                    <form onSubmit={(event) => { event.preventDefault(); void perform(
                      () => replyPostCheckRequestAction({ accessToken: accessToken!, requestId: selected.id, replyMessage }),
                      '회신을 보냈습니다. 알림 조회와 별도로 회신완료 상태가 저장되었습니다.',
                    ); }}>
                      <label><span>조치내용 또는 설명 <b>필수</b></span><textarea value={replyMessage} maxLength={2000} required onChange={(event) => setReplyMessage(event.target.value)} /></label>
                      <button type="submit" disabled={busy || !replyMessage.trim()}>회신 보내기</button>
                    </form>
                  )}
                  {isAdmin && selected.status === 'REPLIED' && <button type="button" disabled={busy} onClick={() => void perform(
                    () => completePostCheckRequestAction({ accessToken: accessToken!, requestId: selected.id }),
                    '확인완료로 기록했습니다. 예산과 원장 금액은 변경되지 않았습니다.',
                  )}>확인완료</button>}
                  {isAdmin && selected.status !== 'REQUESTED' && (
                    <form onSubmit={(event) => { event.preventDefault(); void perform(
                      () => createPostCheckRequestAction({
                        accessToken: accessToken!, subjectType: selected.subject_type,
                        subjectId: selected.subject_id, message: recheckMessage,
                        dueDate: recheckDueDate || undefined, parentRequestId: selected.id,
                      }),
                      '이전 이력을 보존하고 재확인을 요청했습니다.',
                    ); }}>
                      <label><span>추가 확인 내용 <b>필수</b></span><textarea value={recheckMessage} maxLength={2000} required onChange={(event) => setRecheckMessage(event.target.value)} /></label>
                      <label><span>회신기한 <i>선택</i></span><input type="date" value={recheckDueDate} onChange={(event) => setRecheckDueDate(event.target.value)} /></label>
                      <button type="submit" disabled={busy || !recheckMessage.trim()}>재확인 요청 보내기</button>
                    </form>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
