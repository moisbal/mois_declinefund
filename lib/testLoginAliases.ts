const TEST_PROJECT_REF = 'reviewtestxxxxxxxxxx';

export const TEST_LOGIN_ALIASES = Object.freeze({
  review_user_1: 'review-user-1@example.invalid',
  review_user_2: 'review-user-2@example.invalid',
  review_user_3: 'review-user-3@example.invalid',
  review_user_4: 'review-user-4@example.invalid',
  review_user_5: 'review-user-5@example.invalid',
});

const TEST_ACCOUNT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'review-user-1@example.invalid': '테스트 관리자 A',
  'review-user-2@example.invalid': '테스트 관리자 B',
  'review-user-3@example.invalid': '전북 순창군 담당자',
  'review-user-4@example.invalid': '부산 서구 담당자',
  'review-user-5@example.invalid': '강원 양구군 담당자',
});

function projectRefFromUrl(value: string | undefined) {
  if (!value) return null;
  try {
    return new URL(value).hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function isTestLoginAliasEnabled(
  supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
) {
  return projectRefFromUrl(supabaseUrl) === TEST_PROJECT_REF;
}

export function resolveTestLoginIdentifier(
  identifier: string,
  supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
) {
  const normalized = identifier.trim();
  if (!isTestLoginAliasEnabled(supabaseUrl)) return normalized;
  return TEST_LOGIN_ALIASES[
    normalized.toLocaleLowerCase('en-US') as keyof typeof TEST_LOGIN_ALIASES
  ] ?? normalized;
}

export function getTestAccountDisplayName(
  email: string | null | undefined,
  fallback: string,
  supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
) {
  if (!email || !isTestLoginAliasEnabled(supabaseUrl)) return fallback;
  return TEST_ACCOUNT_NAMES[email.toLocaleLowerCase('en-US')] ?? fallback;
}
