import { createClient } from '@supabase/supabase-js';
import { isPublicDemoMode } from './demo-mode';

const supabaseUrl = isPublicDemoMode ? 'https://demo.invalid' : process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = isPublicDemoMode ? 'public-demo-no-service-role-connection' : process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY 및 NEXT_PUBLIC_SUPABASE_URL이 .env에 설정되어야 합니다.');
}

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
  },
  global: {
    // Dashboard and Analytics are authenticated live views. Next's server-side
    // fetch cache must not reuse an earlier PostgREST page after TEST users
    // create or update a project while a separate count query is already fresh.
    fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }),
  },
});
