import { createClient } from '@supabase/supabase-js';
import { isPublicDemoMode } from './demo-mode';

const supabaseUrl = isPublicDemoMode ? 'https://demo.invalid' : process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = isPublicDemoMode ? 'public-demo-no-supabase-connection' : process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Supabase 환경변수가 설정되어야 합니다. .env.local 파일을 확인하세요.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: {
    fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }),
  },
});
