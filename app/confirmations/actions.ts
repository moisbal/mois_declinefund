"use server";

import { createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { isPublicDemoMode, PUBLIC_DEMO_DISABLED_MESSAGE } from '../../lib/demo-mode';
import { formatUserFacingError } from '../../lib/presentationLabels';
import {
  normalizePostCheckRequest,
  normalizeSystemNotification,
  type PostCheckCenter,
  type PostCheckSubjectType,
} from '../../lib/postChecks';

type ActionResult<T> = { data?: T; error?: string };
type AuthenticatedInput = { accessToken: string };

function clientFor(accessToken: string) {
  if (isPublicDemoMode) throw new Error(PUBLIC_DEMO_DISABLED_MESSAGE);
  if (!accessToken || accessToken.length > 8_000) throw new Error('로그인 세션을 다시 확인해 주세요.');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Supabase 환경변수가 설정되지 않았습니다.');
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function action<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { data: await work() };
  } catch (error) {
    return { error: formatUserFacingError(error, '확인요청 처리 중 오류가 발생했습니다.') };
  }
}

function uuid(value: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label}이(가) 올바르지 않습니다.`);
  }
}

function required(value: string, max: number, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}을(를) 입력해 주세요.`);
  if (normalized.length > max) throw new Error(`${label}은(는) ${max}자 이하여야 합니다.`);
  return normalized;
}

function refresh() {
  revalidatePath('/confirmations');
  revalidatePath('/admin/funding');
  revalidatePath('/my-projects');
}

export async function getPostCheckCenterAction(
  input: AuthenticatedInput & { unreadOnly?: boolean },
): Promise<ActionResult<PostCheckCenter>> {
  return action(async () => {
    const client = clientFor(input.accessToken);
    const [requests, notifications] = await Promise.all([
      client.rpc('get_financial_post_check_requests', { p_status: null }),
      client.rpc('get_financial_notifications', { p_unread_only: input.unreadOnly ?? false }),
    ]);
    if (requests.error) throw requests.error;
    if (notifications.error) throw notifications.error;
    
    const normalizedNotifications = ((notifications.data ?? []) as Array<Record<string, unknown>>)
      .map(normalizeSystemNotification);

    // [2단계 핵심] normalizePostCheckRequest에서 감지된 삭제 플래그(is_deleted)를 기준으로
    // 삭제된 사업 관련 확인요청을 활성 업무함에서 필터링하여 제외 처리합니다.
    const normalizedRequests = ((requests.data ?? []) as Array<Record<string, unknown>>)
      .map(normalizePostCheckRequest)
      .filter((item) => !item.is_deleted);

    return {
      requests: normalizedRequests,
      notifications: normalizedNotifications,
      unreadCount: normalizedNotifications.filter((item) => item.read_at === null).length,
    };
  });
}

export async function createPostCheckRequestAction(input: AuthenticatedInput & {
  subjectType: PostCheckSubjectType;
  subjectId: string;
  message: string;
  dueDate?: string;
  parentRequestId?: string;
}): Promise<ActionResult<{ requestId: string }>> {
  return action(async () => {
    uuid(input.subjectId, '확인요청 대상');
    if (input.parentRequestId) uuid(input.parentRequestId, '이전 확인요청');
    if (input.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) {
      throw new Error('회신기한을 확인해 주세요.');
    }
    const client = clientFor(input.accessToken);
    const { data, error } = await client.rpc('financial_create_post_check_request', {
      p_subject_type: input.subjectType,
      p_subject_id: input.subjectId,
      p_message: required(input.message, 2000, '확인요청 내용'),
      p_due_date: input.dueDate || null,
      p_parent_request_id: input.parentRequestId || null,
    });
    if (error) throw error;
    refresh();
    return { requestId: String(data) };
  });
}

export async function replyPostCheckRequestAction(input: AuthenticatedInput & {
  requestId: string;
  replyMessage: string;
}): Promise<ActionResult<{ status: string }>> {
  return action(async () => {
    uuid(input.requestId, '확인요청');
    const client = clientFor(input.accessToken);
    const { data, error } = await client.rpc('financial_reply_post_check_request', {
      p_request_id: input.requestId,
      p_reply_message: required(input.replyMessage, 2000, '조치내용 또는 설명'),
    });
    if (error) throw error;
    refresh();
    return { status: String(data) };
  });
}

export async function completePostCheckRequestAction(input: AuthenticatedInput & {
  requestId: string;
}): Promise<ActionResult<{ status: string }>> {
  return action(async () => {
    uuid(input.requestId, '확인요청');
    const client = clientFor(input.accessToken);
    const { data, error } = await client.rpc('financial_complete_post_check_request', {
      p_request_id: input.requestId,
    });
    if (error) throw error;
    refresh();
    return { status: String(data) };
  });
}

export async function markNotificationReadAction(input: AuthenticatedInput & {
  notificationId: string;
}): Promise<ActionResult<{ readAt: string }>> {
  return action(async () => {
    uuid(input.notificationId, '알림');
    const client = clientFor(input.accessToken);
    const { data, error } = await client.rpc('financial_mark_notification_read', {
      p_notification_id: input.notificationId,
    });
    if (error) throw error;
    revalidatePath('/confirmations');
    return { readAt: String(data) };
  });
}