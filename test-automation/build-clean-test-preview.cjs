const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');

const TEST_REF = 'reviewtestxxxxxxxxxx';
const PROD_REF = 'reviewprodxxxxxxxxxx';
const ROOT = path.resolve(__dirname, '..');
const CLEAN_ROOT = path.join(ROOT, '.codex-tmp', 'localization-clean');
const useCurrentWorktree = process.argv.includes('--current');
const buildRoot = useCurrentWorktree ? ROOT : CLEAN_ROOT;
const testEnv = {
  ...dotenv.config({ path: path.join(ROOT, '.env.ledger-test.local') }).parsed,
  ...dotenv.config({ path: path.join(ROOT, '.env.ledger-uat-credentials.local') }).parsed,
};

const apiRef = String(testEnv.NEXT_PUBLIC_SUPABASE_URL ?? '')
  .match(/^https:\/\/([a-z0-9-]+)\.supabase\.co\/?$/i)?.[1];
if (String(testEnv.TARGET_ENV).toUpperCase() !== 'TEST'
    || testEnv.TEST_PROJECT_REF !== TEST_REF
    || testEnv.PROD_PROJECT_REF !== PROD_REF
    || apiRef !== TEST_REF) {
  throw new Error('clean build의 TEST 대상 확인에 실패했습니다. 빌드를 시작하지 않습니다.');
}

process.stdout.write(`[안전확인] ${useCurrentWorktree ? '현재 소스' : 'clean Preview'} build 대상=TEST · Supabase=${TEST_REF} · Production 접근/변경=없음\n`);
const result = spawnSync('npm', ['run', 'build'], {
  cwd: buildRoot,
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
process.exitCode = result.status ?? 1;
