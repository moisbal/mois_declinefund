const { readFileSync } = require('fs');
const { join } = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error('환경변수가 설정되지 않았습니다. NEXT_PUBLIC_SUPABASE_URL 및 SUPABASE_SERVICE_ROLE_KEY를 확인하세요.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false } });

(async () => {
  try {
    const sql = readFileSync(join(__dirname, '..', 'db', 'seed.sql'), 'utf8');
    const { data, error } = await supabase.rpc('run_sql', { sql });
    if (error) {
      throw error;
    }
    console.log('시드 SQL 실행 완료', data);
  } catch (error) {
    console.error('시드 실행 실패', error);
    process.exit(1);
  }
})();
