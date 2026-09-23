import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function readSource(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

const passwordResetPage = readSource('app/password-reset/page.tsx');
const header = readSource('components/common/Header.tsx');

test('password reset blocks anonymous access but permits an existing signed-in user', () => {
  assert.match(
    passwordResetPage,
    /if \(!session\.data\.session\?\.user\) \{\s*router\.replace\('\/'\);/,
  );
  assert.doesNotMatch(passwordResetPage, /if \(!profileFirstLogin\)/);
});

test('password reset keeps the 10-character and confirmation checks', () => {
  assert.match(passwordResetPage, /if \(password\.length < 10\)/);
  assert.match(passwordResetPage, /if \(password !== confirmPassword\)/);
  assert.match(passwordResetPage, /updateUserPassword\(password\)/);
});

test('first-login completion is preserved without rewriting an existing profile', () => {
  assert.match(
    passwordResetPage,
    /if \(profileFirstLogin\) \{\s*await setFirstLoginComplete\(userId\);\s*\}/,
  );
  assert.match(passwordResetPage, /router\.push\('\/dashboard'\)/);
});

test('the shared header exposes one password-change route for every signed-in role', () => {
  assert.equal((header.match(/비밀번호 변경/g) ?? []).length, 1);
  assert.match(
    header,
    /onClick=\{\(\) => router\.push\('\/password-reset'\)\}[\s\S]*?>\s*비밀번호 변경\s*<\/button>/,
  );

  const passwordChange = header.indexOf("router.push('/password-reset')");
  const adminMenu = header.indexOf("profile?.role === 'admin'");
  const logout = header.lastIndexOf('handleLogout');
  assert.ok(passwordChange > adminMenu);
  assert.ok(passwordChange < logout);
});

test('all authenticated application shells preserve the first-login redirect', () => {
  for (const relativePath of [
    'components/dashboard/DashboardShell.tsx',
    'components/my-projects/MyProjectsShell.tsx',
    'components/my-projects/MyProjectEditShell.tsx',
    'components/analytics/AnalyticsShell.tsx',
    'components/admin/AdminShell.tsx',
    'components/admin/LedgerCutoverShell.tsx',
  ]) {
    const source = readSource(relativePath);
    assert.match(source, /\.first_login/);
    assert.match(source, /router\.(?:push|replace)\('\/password-reset'\)/);
  }
});
