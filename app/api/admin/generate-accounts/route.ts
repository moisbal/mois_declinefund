import { NextResponse } from 'next/server';
import { supabaseAdmin } from '../../../../lib/supabaseAdmin';
import { generateSecurePassword, normalizeLoginId } from '../../../../lib/password';
import { isPublicDemoMode, PUBLIC_DEMO_DISABLED_MESSAGE } from '../../../../lib/demo-mode';

export async function POST(request: Request) {
  if (isPublicDemoMode) {
    return NextResponse.json({ message: PUBLIC_DEMO_DISABLED_MESSAGE }, { status: 403 });
  }

  const authorization = request.headers.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const token = authorization.replace('Bearer ', '');
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user?.id) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const userId = userData.user.id;
  const { data: profileData, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single();

  if (profileError || profileData?.role !== 'admin') {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 });
  }

  const { data: regions, error: regionsError } = await supabaseAdmin
    .from('regions')
    .select('id, display_name, region_code')
    .order('display_name', { ascending: true });

  if (regionsError) {
    return NextResponse.json({ message: regionsError.message }, { status: 500 });
  }

  const { data: existingProfiles } = await supabaseAdmin
    .from('profiles')
    .select('region_id');

  const existingRegionIds = new Set((existingProfiles || []).map((item: any) => item.region_id));
  const accounts: Array<{ region_name: string | null; region_id: string; login_id: string; password: string; created_at: string }> = [];
  const failures: Array<{ region_id: string; error: string }> = [];

  for (let index = 0; index < (regions || []).length; index += 1) {
    const region = regions[index];
    if (!region || !region.id) continue;
    if (existingRegionIds.has(region.id)) {
      continue;
    }

    const loginId = normalizeLoginId(region.display_name || `region-${index + 1}`) || `region-${index + 1}`;
    const email = `${loginId}@declinefund.local`;
    const password = generateSecurePassword(14);

    const { data: authUser, error: createUserError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        login_id: loginId,
        region_id: region.id,
      },
    });

    if (createUserError || !authUser?.user?.id) {
      failures.push({ region_id: region.id, error: createUserError?.message ?? '사용자 생성 실패' });
      continue;
    }

    const profileInsert = {
      id: authUser.user.id,
      email,
      login_id: loginId,
      region_id: region.id,
      region_name: region.display_name,
      role: 'local_user',
      first_login: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { error: profileInsertError } = await supabaseAdmin.from('profiles').insert(profileInsert);
    if (profileInsertError) {
      failures.push({ region_id: region.id, error: profileInsertError.message });
      continue;
    }

    accounts.push({
      region_name: region.display_name,
      region_id: region.id,
      login_id: loginId,
      password,
      created_at: new Date().toISOString(),
    });
  }

  return NextResponse.json({ accounts, failures });
}
