import { supabase } from './supabaseClient';
import type { Database } from '../types/supabase';
import { getTestAccountDisplayName } from './testLoginAliases';

export type UserProfile = Database['public']['Tables']['profiles']['Row'];

export async function getCurrentSession() {
  return await supabase.auth.getSession();
}

const SESSION_READY_RETRY_DELAYS_MS = [150, 350, 750, 1_250] as const;

/**
 * 로그인 직후 브라우저 저장소와 Supabase 클라이언트의 세션 반영 사이에 생길 수 있는
 * 짧은 공백을 흡수한다. 실제 로그아웃 상태는 제한된 재시도 뒤 그대로 반환한다.
 */
export async function getCurrentSessionWithRetry(expectedUserId?: string) {
  let result = await supabase.auth.getSession();
  const isReady = () => Boolean(
    result.data.session?.user?.id
    && result.data.session.access_token
    && (!expectedUserId || result.data.session.user.id === expectedUserId),
  );

  if (isReady()) return result;
  for (const delayMs of SESSION_READY_RETRY_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    result = await supabase.auth.getSession();
    if (isReady()) return result;
  }
  return result;
}

export async function getCurrentTestAccountDisplayName(
  session?: Awaited<ReturnType<typeof supabase.auth.getSession>>['data']['session'],
) {
  const currentSession = session ?? (await supabase.auth.getSession()).data.session;
  return getTestAccountDisplayName(currentSession?.user.email, '');
}

export async function signInWithPassword(email: string, password: string) {
  return await supabase.auth.signInWithPassword({ email, password });
}

export async function signOut() {
  return await supabase.auth.signOut();
}

export async function getProfileByUserId(userId: string) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) {
    throw error;
  }

  return data as UserProfile;
}

export async function updateUserPassword(password: string) {
  return await supabase.auth.updateUser({ password });
}

export async function setFirstLoginComplete(userId: string) {
  const { data, error } = await supabase
    .from('profiles')
    .update({ first_login: false, updated_at: new Date().toISOString() })
    .eq('id', userId)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data as UserProfile;
}

export async function getCurrentUserProfile() {
  const { data } = await supabase.auth.getSession();
  const user = data.session?.user;

  if (!user?.id) {
    return null;
  }

  return getProfileByUserId(user.id);
}
