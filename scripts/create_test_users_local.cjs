#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');

const repoRoot = path.resolve(__dirname, '..');
dotenv.config({
  path: path.join(repoRoot, '.env.ledger-test.local'),
  override: true,
});

const targetEnv = process.env.TARGET_ENV;
const testProjectRef = process.env.TEST_PROJECT_REF;
const prodProjectRef = process.env.PROD_PROJECT_REF;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const testAdminKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const credentialsPath = path.join(repoRoot, '.env.ledger-uat-credentials.local');
const credentialsTempPath = `${credentialsPath}.tmp`;

const requiredValues = {
  TARGET_ENV: targetEnv,
  TEST_PROJECT_REF: testProjectRef,
  PROD_PROJECT_REF: prodProjectRef,
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  TEST_SUPABASE_SERVICE_ROLE_KEY: testAdminKey,
};

for (const [name, value] of Object.entries(requiredValues)) {
  if (!value) {
    throw new Error(`Missing required TEST environment variable: ${name}`);
  }
}

if (targetEnv !== 'TEST' || testProjectRef === prodProjectRef) {
  throw new Error('TEST environment/ref safety gate failed.');
}

const apiHost = new URL(supabaseUrl).hostname;
if (!apiHost.includes(testProjectRef) || apiHost.includes(prodProjectRef)) {
  throw new Error('TEST Supabase URL does not match TEST_PROJECT_REF.');
}

const isSecretKey = testAdminKey.startsWith('sb_secret_');
const isLegacyJwt = testAdminKey.split('.').length === 3;
if (!isSecretKey && !isLegacyJwt) {
  throw new Error('TEST admin key is not a supported secret/service-role key.');
}

if (fs.existsSync(credentialsPath) || fs.existsSync(credentialsTempPath)) {
  throw new Error('UAT credentials file already exists; stop to avoid overwriting credentials.');
}

const supabase = createClient(supabaseUrl, testAdminKey, {
  auth: {
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: false,
  },
});

const accounts = [
  {
    account: 'admin_a',
    email: 'review-user-1@example.invalid',
    name: 'Ledger UAT Admin A',
    role: 'admin',
    regionCode: null,
  },
  {
    account: 'admin_b',
    email: 'review-user-2@example.invalid',
    name: 'Ledger UAT Admin B',
    role: 'admin',
    regionCode: null,
  },
  {
    account: 'local_a',
    email: 'review-user-3@example.invalid',
    name: 'Ledger UAT Local A',
    role: 'local_user',
    regionCode: '52-770',
  },
  {
    account: 'local_b',
    email: 'review-user-4@example.invalid',
    name: 'Ledger UAT Local B',
    role: 'local_user',
    regionCode: '26-140',
  },
  {
    account: 'local_c',
    email: 'review-user-5@example.invalid',
    name: 'Ledger UAT Local C',
    role: 'local_user',
    regionCode: '51-800',
  },
];

function generatePassword() {
  return `Ua9!${crypto.randomBytes(18).toString('base64url')}Z7!`;
}

async function rollback(created) {
  const errors = [];
  for (const item of [...created].reverse()) {
    const { error: profileError } = await supabase
      .from('profiles')
      .delete()
      .eq('id', item.userId);
    if (profileError) {
      errors.push(`${item.account} profile rollback: ${profileError.message}`);
    }

    const { error: authError } = await supabase.auth.admin.deleteUser(item.userId);
    if (authError) {
      errors.push(`${item.account} Auth rollback: ${authError.message}`);
    }
  }
  return errors;
}

async function main() {
  const { data: authList, error: authListError } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 50,
  });
  if (authListError) {
    throw new Error(`TEST Admin Auth gate failed: ${authListError.message}`);
  }
  if (authList.users.length !== 0) {
    throw new Error(`Expected zero TEST Auth users; found ${authList.users.length}.`);
  }

  const { data: existingProfiles, error: profilesError } = await supabase
    .from('profiles')
    .select('id,email,login_id');
  if (profilesError) {
    throw new Error(`Failed to inspect existing profiles: ${profilesError.message}`);
  }
  if (existingProfiles.length !== 4) {
    throw new Error(`Expected four cloned profiles; found ${existingProfiles.length}.`);
  }

  const requestedEmails = new Set(accounts.map((account) => account.email));
  const requestedLoginIds = new Set(accounts.map((account) => account.account));
  if (
    existingProfiles.some(
      (profile) =>
        requestedEmails.has(profile.email) || requestedLoginIds.has(profile.login_id),
    )
  ) {
    throw new Error('A requested UAT email or login_id conflicts with an existing profile.');
  }

  const regionCodes = accounts
    .map((account) => account.regionCode)
    .filter((regionCode) => regionCode !== null);
  const { data: regions, error: regionsError } = await supabase
    .from('regions')
    .select('id,region_code,display_name,sido,sigungu')
    .in('region_code', regionCodes);
  if (regionsError) {
    throw new Error(`Failed to resolve TEST regions: ${regionsError.message}`);
  }
  if (regions.length !== regionCodes.length) {
    throw new Error('One or more selected TEST regions were not found.');
  }

  const regionByCode = new Map(
    regions.map((region) => [
      region.region_code,
      {
        id: region.id,
        name:
          region.display_name ||
          [region.sido, region.sigungu].filter(Boolean).join(' '),
      },
    ]),
  );

  const created = [];
  const credentials = [];

  try {
    for (const account of accounts) {
      const password = generatePassword();
      const region = account.regionCode
        ? regionByCode.get(account.regionCode)
        : null;

      const { data: authData, error: authError } =
        await supabase.auth.admin.createUser({
          email: account.email,
          password,
          email_confirm: true,
          user_metadata: {
            uat_account: account.account,
            region_code: account.regionCode,
            region_name: region?.name ?? null,
          },
        });
      if (authError || !authData.user?.id) {
        throw new Error(
          `${account.account} Auth creation failed: ${authError?.message || 'missing user id'}`,
        );
      }

      const userId = authData.user.id;
      created.push({ account: account.account, userId });

      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .insert({
          id: userId,
          email: account.email,
          login_id: account.account,
          name: account.name,
          role: account.role,
          region_id: region?.id ?? null,
          region_name: region?.name ?? null,
          first_login: false,
        })
        .select('id')
        .single();
      if (profileError || profile?.id !== userId) {
        throw new Error(
          `${account.account} profile creation failed: ${profileError?.message || 'id mismatch'}`,
        );
      }

      credentials.push({ ...account, password, regionName: region?.name ?? 'ADMIN' });
      console.log(
        `UAT_USER=${account.account}|${account.role}|${region?.name ?? 'ADMIN'}|${account.regionCode ?? 'NONE'}|linked:true`,
      );
    }

    const credentialLines = ['# TEST-only Ledger UAT credentials. Do not commit or share.'];
    for (const credential of credentials) {
      const prefix = `UAT_${credential.account.toUpperCase()}`;
      credentialLines.push(`${prefix}_EMAIL=${credential.email}`);
      credentialLines.push(`${prefix}_PASSWORD=${credential.password}`);
    }
    fs.writeFileSync(credentialsTempPath, `${credentialLines.join('\n')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(credentialsTempPath, credentialsPath);

    console.log('UAT_USER_CREATION=PASS');
    console.log('CREDENTIALS_FILE=.env.ledger-uat-credentials.local');
  } catch (error) {
    if (fs.existsSync(credentialsTempPath)) {
      fs.unlinkSync(credentialsTempPath);
    }
    const rollbackErrors = await rollback(created);
    if (rollbackErrors.length > 0) {
      throw new Error(`${error.message}; rollback errors: ${rollbackErrors.join('; ')}`);
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(`UAT_USER_CREATION=FAIL: ${error.message}`);
  process.exit(1);
});
