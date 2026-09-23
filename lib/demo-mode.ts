/**
 * Public-demo builds must never communicate with the real Supabase project.
 * This value is intentionally derived from a build-time public variable so it
 * can be used by middleware, server code, and browser bundles alike.
 */
export const isPublicDemoMode = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

export const PUBLIC_DEMO_DISABLED_MESSAGE =
  '공개 데모에서는 실제 데이터 조회·입력·관리 기능을 사용할 수 없습니다.';
