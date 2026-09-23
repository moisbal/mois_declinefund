type Environment = Record<string, string | undefined>;

function valueOf(environment: Environment, name: string) {
  return environment[name]?.trim() ?? '';
}

/** Extracts only a project reference from a normal Supabase URL. */
export function projectRefFromSupabaseUrl(value: string | undefined) {
  if (!value) return null;

  try {
    const url = new URL(value);
    const match = /^([a-z0-9-]+)\.supabase\.co$/i.exec(url.hostname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Ledger mutations and cutover administration are intentionally TEST-only in
 * this phase.  It never returns a reference or a credential in an error.
 */
export function assertLedgerTestTarget(environment: Environment = process.env) {
  const targetEnv = valueOf(environment, 'TARGET_ENV');
  const productionRef = valueOf(environment, 'PROD_PROJECT_REF');
  const testRef = valueOf(environment, 'TEST_PROJECT_REF');
  const currentRef = projectRefFromSupabaseUrl(valueOf(environment, 'NEXT_PUBLIC_SUPABASE_URL'));

  if (targetEnv !== 'TEST') {
    throw new Error('재정원장 작업은 명시적으로 검증된 TEST 환경에서만 수행할 수 있습니다.');
  }
  if (!productionRef || !testRef || productionRef === testRef) {
    throw new Error('재정원장 TEST/Production 프로젝트 분리가 검증되지 않았습니다.');
  }
  if (!currentRef || currentRef !== testRef) {
    throw new Error('현재 Supabase 대상이 검증된 TEST 프로젝트와 일치하지 않습니다.');
  }
}

/** Monetary Ledger writes need the separate DB TEST mode as well. */
export function assertLedgerTestWriteEnabled(environment: Environment = process.env) {
  assertLedgerTestTarget(environment);
  if (valueOf(environment, 'LEDGER_MODE').toLowerCase() !== 'test') {
    throw new Error('재정원장 쓰기 기능은 TEST 모드에서만 명시적으로 활성화할 수 있습니다.');
  }
}
