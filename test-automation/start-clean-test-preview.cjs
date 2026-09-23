const path = require('node:path');
const { spawn } = require('node:child_process');
const dotenv = require('dotenv');

const root = path.resolve(__dirname, '..');
const cleanWorktree = path.join(root, '.codex-tmp', 'localization-clean');
const useCurrentWorktree = process.argv.includes('--current');
const previewWorktree = useCurrentWorktree ? root : cleanWorktree;
const testEnv = dotenv.config({ path: path.join(root, '.env.ledger-test.local') }).parsed ?? {};

if (String(testEnv.TARGET_ENV).toUpperCase() !== 'TEST'
    || testEnv.TEST_PROJECT_REF !== 'reviewtestxxxxxxxxxx'
    || !String(testEnv.NEXT_PUBLIC_SUPABASE_URL).includes('reviewtestxxxxxxxxxx.supabase.co')) {
  throw new Error('clean Preview 실행 전에 TEST 대상 확인에 실패했습니다.');
}

const child = spawn('npm.cmd', ['run', useCurrentWorktree ? 'dev' : 'start', '--', '-p', '3010', '-H', '127.0.0.1'], {
  cwd: previewWorktree,
  env: {
    ...process.env,
    ...testEnv,
    SUPABASE_SERVICE_ROLE_KEY: testEnv.TEST_SUPABASE_SERVICE_ROLE_KEY,
    LEDGER_MODE: 'test',
    NEXT_PUBLIC_FINANCIAL_LEDGER_UI: 'true',
  },
  stdio: 'inherit',
  shell: true,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => { process.exitCode = code ?? 1; });
