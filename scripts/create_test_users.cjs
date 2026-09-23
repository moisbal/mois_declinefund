const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error('환경변수가 설정되지 않았습니다. NEXT_PUBLIC_SUPABASE_URL 및 SUPABASE_SERVICE_ROLE_KEY를 확인하세요.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false } });

const users = [
  {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'review-account-12@example.invalid',
    password: 'REPLACE_WITH_TEST_PASSWORD',
    region_id: 'ADMIN',
    region_name: 'Administrator',
    role: 'admin'
  },
  {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'review-account-13@example.invalid',
    password: 'REPLACE_WITH_TEST_PASSWORD',
    region_id: 'GW-A',
    region_name: '강원 A군',
    role: 'local_user'
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    email: 'review-account-14@example.invalid',
    password: 'REPLACE_WITH_TEST_PASSWORD',
    region_id: 'JN-B',
    region_name: '전남 B군',
    role: 'local_user'
  },
  {
    id: '33333333-3333-3333-3333-333333333333',
    email: 'review-account-15@example.invalid',
    password: 'REPLACE_WITH_TEST_PASSWORD',
    region_id: 'CB-C',
    region_name: '충북 C군',
    role: 'local_user'
  }
];

(async () => {
  try {
    for (const u of users) {
      console.log(`Creating user ${u.email} (id=${u.id})`);
      // Create Auth user via Admin API
      const { data: userData, error: createErr } = await supabase.auth.admin.createUser({
        id: u.id,
        email: u.email,
        password: u.password,
        email_confirm: true,
        user_metadata: { region_id: u.region_id, region_name: u.region_name }
      });

      if (createErr) {
        // If user already exists, log and continue
        console.error('createUser error:', createErr);
      } else {
        console.log('Created user:', userData?.user?.id || userData);
      }

      // Upsert profile row
      const profileRow = {
        id: u.id,
        region_id: u.region_id,
        region_name: u.region_name,
        role: u.role,
        first_login: false
      };

      const { data: upsertData, error: upsertErr } = await supabase.from('profiles').upsert(profileRow).select();
      if (upsertErr) {
        console.error('profiles upsert error:', upsertErr);
      } else {
        console.log('profiles upserted:', upsertData);
      }
    }

    console.log('Test users creation finished.');
    process.exit(0);
  } catch (err) {
    console.error('Unexpected error:', err);
    process.exit(1);
  }
})();
