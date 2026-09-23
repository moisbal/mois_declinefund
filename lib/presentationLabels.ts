export const SYSTEM_TERM_LABELS: Record<string, string> = {
  LEDGER: '재정원장',
  CUTOVER: '운영전환',
  BASELINE: '기준잔액',
  LEGACY: '과거자료',
  NATIVE: '신규 운영거래',
  RECONSTRUCTION: '과거거래 복원',
  VERIFIED: '검증완료',
  LINEAGE: '사업 연계관계',
  MAKER_CHECKER: '요청·승인 분리',
  SOURCE_OF_TRUTH: '기준 원장',
  APPLY: '적용',
  APPLIED: '적용완료',
  CONFIRMED: '확정',
  CONFIRMED_LEDGER: '원장확정',
  WALLET: '재원잔액',
  LOT: '대기재원 건',
  FLOW: '누적 발생액',
  STOCK: '현재잔액',
  RETURN_UNALLOCATED: '대기재원 반환',
  ALLOCATE_UNALLOCATED_EXISTING: '기존사업 재배분',
  CREATE_UNALLOCATED_LOT: '대기재원 생성',
  CARRYOVER: '이월',
  MYEONGSI: '명시이월',
  SAGO: '사고이월',
  REJECTED: '반려',
  CANCELLED: '취소',
  DUPLICATE: '중복 요청',
  SUBMITTED: '승인대기',
  APPROVED: '승인',
  PENDING_APPROVAL: '승인 대기',
  EXCLUDED: '제외',
  SYSTEM_NATIVE: '시스템 운영',
  LEGACY_EXCEL: '과거자료',
  REVERSED: '취소',
  ACTIVE: '처리 중',
  REQUEST: '요청',
  DRAFT: '임시저장',
  PENDING: '확인 대기',
  PENDING_REVIEW: '검토 대기',
  REVIEWED: '검토 완료',
  COMPLETED: '처리 완료',
  MAPPED: '기존분류 연결',
  OPEN: '처리 가능',
  CLOSED: '종료',
  DISABLED: '사용 중지',
  RECONCILIATION: '과거자료 검수',
  PRODUCTION: '운영 환경',
  TEST: '시험 환경',
  APPROVE: '승인',
  REJECT: '반려',
  VERIFY: '검증',
  CREATE_NOW: '신규사업 즉시 작성',
  FUNDING_ONLY: '예정재원만 확보',
  LINK: '연결',
  UNLINKED: '미연결',
  EXISTING: '기존',
  NEW: '신규',
  HW: '시설·기반 조성',
  SW: '프로그램·서비스',
  COMPOSITE: '시설·프로그램 복합',
  RAW: '원시 시험자료',
  GOLDEN: '기준 시험자료',
  MONETARY_GAP: '금액 차이',
  GROUP: '요청 묶음',
  REVIEW_REQUIRED: '확인 필요',
  BUDGET_REALLOCATION: '예산 조정',
  BUDGET_REALLOCATION_SUBMITTED: '예산 조정 승인요청',
  BUDGET_REALLOCATION_DRAFTED: '예산 조정 작성',
  BUDGET_REALLOCATION_APPLIED: '예산 조정 적용',
  BUDGET_REALLOCATION_REJECTED: '예산 조정 반려',
  TEST_UAT_BOOTSTRAP: '기준재원 자동 연결',
  EXISTING_PROJECT: '기존사업',
  PENDING_NEW_PROJECT: '신규사업 예정',
  WAITING: '연결 대기',
  LINKED: '사업 연결완료',
  PENDING_NEW_PROJECT_LINK_SUBMITTED: '신규사업 예정재원 연결 승인요청',
  PENDING_NEW_PROJECT_FUND_LINKED: '신규사업 예정재원 연결완료',
  TRANSFER: '사업간 예산조정',
  IN: '유입',
  OUT: '유출',
  INFO: '정보',
};

export const SMALL_CATEGORY_PROPOSAL_STATUS_LABELS: Record<string, string> = {
  SUBMITTED: '검토 대기',
  APPROVED: '신규분류 승인',
  MAPPED: '기존분류 연결',
  REJECTED: '반려',
};

export function formatSmallCategoryProposalStatus(value: string | null | undefined) {
  if (!value) return '상태 확인 필요';
  return SMALL_CATEGORY_PROPOSAL_STATUS_LABELS[value.trim().toUpperCase()]
    ?? formatSystemTerm(value, '상태 확인 필요');
}

export function formatSystemTerm(value: string | null | undefined, fallback = '-') {
  if (!value) return fallback;
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
  const known = SYSTEM_TERM_LABELS[normalized];
  if (known) return known;
  return /[A-Za-z]/.test(value.trim()) ? (fallback === '-' ? '확인 필요' : fallback) : value;
}

type UserFacingError = {
  code?: string | null;
  message?: string | null;
};

const DATABASE_ERROR_LABELS: Record<string, string> = {
  '22023': '입력값을 다시 확인해 주세요.',
  '23505': '같은 내용의 요청이 이미 등록되어 있습니다.',
  '23514': '입력값, 현재 상태 또는 처리 가능 금액을 확인해 주세요.',
  '42501': '이 작업을 수행할 권한이 없습니다.',
  '55000': '현재 상태에서는 이 작업을 처리할 수 없습니다.',
  P0002: '처리할 항목을 찾을 수 없습니다.',
  PGRST116: '요청한 정보를 찾을 수 없습니다.',
};

const DATABASE_MESSAGE_LABELS: Array<[RegExp, string]> = [
  [/invalid login credentials|invalid email or password|user not found/i, '이메일 또는 비밀번호가 올바르지 않습니다.'],
  [/email not confirmed/i, '이메일 확인이 완료되지 않은 계정입니다. 관리자에게 문의해 주세요.'],
  [/password should be at least|password must be at least/i, '비밀번호 길이 조건을 확인해 주세요.'],
  [/new password should be different|same password/i, '현재 비밀번호와 다른 새 비밀번호를 입력해 주세요.'],
  [/duplicate key|unique constraint|already exists/i, '같은 내용의 요청이 이미 등록되어 있습니다.'],
  [/row.level security|permission denied|not authorized|forbidden/i, '이 작업을 수행할 권한이 없습니다.'],
  [/jwt.*expired|invalid refresh token|not authenticated|auth\.uid/i, '로그인 세션이 만료되었습니다. 다시 로그인해 주세요.'],
  [/failed to fetch|networkerror|network request failed/i, '서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'],
  [/only (?:a|an) submitted .* can be approved/i, '승인 대기 상태의 요청만 승인할 수 있습니다.'],
  [/only (?:a|an) approved .* can be applied/i, '승인된 요청만 적용할 수 있습니다.'],
  [/requester cannot (?:approve|apply) their own/i, '요청자는 자신의 요청을 승인하거나 적용할 수 없습니다.'],
  [/could not find the function|function .* does not exist|relation .* does not exist/i, '서버 기능이 아직 준비되지 않았습니다. 관리자에게 문의해 주세요.'],
];

export function formatUserFacingError(error: unknown, fallback: string) {
  const candidate = error && typeof error === 'object' ? error as UserFacingError : null;
  const message = candidate?.message?.trim()
    || (typeof error === 'string' ? error.trim() : '');
  if (message) {
    const translated = DATABASE_MESSAGE_LABELS.find(([pattern]) => pattern.test(message));
    if (translated) return translated[1];
    if (!/[A-Za-z]/.test(message)) return message;
  }
  const code = candidate?.code?.trim();
  if (code && DATABASE_ERROR_LABELS[code]) return DATABASE_ERROR_LABELS[code];
  return fallback;
}

const INTERNAL_TEST_MARKER = /(?:^|[\[\]·_\s-])(UAT|TEST(?:-(?:OPS|UAT))?|AUTO(?:-(?:BUDGET|INT))?-UAT|AUTO-INT|GENERIC(?:-BUDGET)?-UAT)(?=$|[-_\s])/i;
const INTERNAL_FIXTURE_NAME = /^(?:RAW(?:\s+[A-Z0-9]+)?|GOLDEN|REJECTED)$/i;
const LEADING_TEST_RUN = /^((?:AUTO(?:-BUDGET)?|GENERIC(?:-BUDGET)?)-UAT|UAT)(?:-(\d{8})(?:-(\d{6}))?)?(?:\s+|$)/i;
const INTEGRATION_TEST_RUN = /\bAUTO-INT-(\d{8})-(\d{6})\b/i;
const MANAGED_TEST_RUN = /\[?TEST-(OPS|UAT)-(\d{8})(?:-?(\d{4,6}))?\]?/gi;
const INTERNAL_TEST_TOKEN = /\b(?:AUTO|BUDGET|GENERIC|INT|UAT|RAW|GOLDEN|REJECTED)\b/gi;
const PROJECT_CODE_SHAPE = /^(?:\d{4}[-_.\/])?[A-Z0-9]+(?:[-_.\/][A-Z0-9]+){2,}$/i;
const LATIN_DISPLAY_TOKEN = /[A-Za-z]+(?:[A-Za-z0-9_-]*[A-Za-z0-9])?/g;
const FIXTURE_SCENARIOS: Record<string, string> = {
  A: '가',
  B: '나',
  C: '다',
  D: '라',
};

function localizeResearchAbbreviation(value: string) {
  return value.replace(/R\s*&\s*D/gi, '연구개발');
}

function localizeManagedTestRuns(value: string) {
  return value.replace(MANAGED_TEST_RUN, (_, kind: string, date: string, time?: string) => {
    const label = kind.toUpperCase() === 'OPS' ? '시험 업무 검증' : '시험 사용자 검증';
    return `${label} · 실행 ${[date, time].filter(Boolean).join('-')}`;
  });
}

function localizeFixtureTerms(value: string) {
  return localizeResearchAbbreviation(value)
    .replace(/\bCONCURRENT_DRAFT_UAT\b/gi, '동시 임시저장 사용자 검증')
    .replace(/\bDRAFT_EXISTING\b/gi, '기존사업 임시저장')
    .replace(/\bDRAFT_NEW\b/gi, '신규사업 임시저장')
    .replace(/\bINCREASE_TARGET\b/gi, '증액 목적지')
    .replace(/\bREJECTION_UAT\b/gi, '반려 사용자 검증')
    .replace(/\bScenario\s+([A-D])\b/gi, (_, scenario: string) => `시나리오 ${FIXTURE_SCENARIOS[scenario.toUpperCase()]}`)
    .replace(/\bother\s+region\s*\/\s*year\b/gi, '타 지역·연도')
    .replace(/\bsame-year\b/gi, '동일연도')
    .replace(/\bnext-year\b/gi, '차년도')
    .replace(/\bexisting\s+destination\b/gi, '기존사업 목적지')
    .replace(/\bexisting\s+project\b/gi, '기존사업')
    .replace(/\bnew-project\b/gi, '신규사업')
    .replace(/\bnew\s+project\b/gi, '신규사업')
    .replace(/\bSunchang\b/gi, '순창')
    .replace(/\bgrouped\b/gi, '묶음')
    .replace(/\bmixed\b/gi, '혼합')
    .replace(/\bactual\b/gi, '실제')
    .replace(/\bgeneric\b/gi, '일반')
    .replace(/\btransfer\b/gi, '재배분')
    .replace(/\bdestination\b/gi, '목적지')
    .replace(/\bworkflow\b/gi, '처리 흐름')
    .replace(/\bupsert\b/gi, '등록·갱신')
    .replace(/\bambiguity\b/gi, '모호성')
    .replace(/\bstatus\b/gi, '상태')
    .replace(/\bRPC\b/gi, '처리 함수')
    .replace(/\bDB\b/gi, '데이터베이스')
    .replace(/\bautonomous\b/gi, '자동')
    .replace(/\brejection\b/gi, '반려')
    .replace(/\bresubmit(?:ted)?\b/gi, '재신청')
    .replace(/\bretry\b/gi, '재시도')
    .replace(/\bRAW\s+(\d+)W\b/gi, (_, amount: string) => `${Number(amount).toLocaleString('ko-KR')}원 경계값`)
    .replace(/\bRAW\b/gi, '원시 시험자료')
    .replace(/\bGOLDEN\b/gi, '기준 시험자료')
    .replace(/\bREJECTED\b/gi, '반려 확인')
    .replace(/\bDRAFT\b/gi, '임시저장')
    .replace(/\b([A-D])\b/g, (_, scenario: string) => `시나리오 ${FIXTURE_SCENARIOS[scenario]}`)
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const KNOWN_TEST_USER_TEXT_LABELS: Record<string, string> = {
  '반려 RPC status ambiguity 수정 검증': '반려 처리 함수 상태 모호성 수정 검증',
  'DRAFT upsert workflow 검증 후 금액 영향 없이 반려': '임시저장 갱신 처리 흐름 검증 후 금액 영향 없이 반려',
};

function fixtureRunLabel(kind: string) {
  const normalized = kind.toUpperCase();
  if (normalized === 'AUTO-UAT') return '자동 사용자 검증';
  if (normalized === 'AUTO-BUDGET-UAT') return '자동 예산 사용자 검증';
  if (normalized === 'GENERIC-BUDGET-UAT') return '일반 예산 사용자 검증';
  return '사용자 검증';
}

export type ProjectPresentationInput = {
  fiscal_year?: number | null;
  year?: number | null;
  project_name?: string | null;
  detail_project_name?: string | null;
  fund_project_name?: string | null;
  project_code?: string | null;
  status?: string | null;
  id?: string | null;
};

export function isInternalTestIdentifier(value: string | null | undefined) {
  return Boolean(value?.trim()
    && (INTERNAL_TEST_MARKER.test(value.trim()) || INTERNAL_FIXTURE_NAME.test(value.trim())));
}

const KNOWN_SYSTEM_PREFIX = /^\[(삭제된 사업|보관된 사업|변경 건)\]\s*/;
// 날짜가 붙은 내부 실행 식별자만 제거한다. TEST-DRIVE 같은 실제 이름은 보존한다.
const GENERAL_TEST_RUN_PATTERN = /\bTEST-(?:[A-Z][A-Z0-9]*[-_])+\d{8}(?:[-_]?\d{4,6})?(?:[-_][A-Z0-9]+)*\b/gi;

function stripGeneralTestRuns(value: string) {
  const cleaned = value.replace(GENERAL_TEST_RUN_PATTERN, '');
  if (cleaned === value) return value;
  return cleaned
    .replace(/\[\s*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s·]+|[\s·]+$/g, '')
    .trim();
}

export function sanitizeProjectNameForDisplay(
  value: string | null | undefined,
  fiscalYear?: number | null,
): string {
  const rawInput = value?.trim() ?? '';
  if (!rawInput) return '사업명 확인 필요';

  // 시스템 안내 문구는 사업명과 분리하여 보존한다.
  let systemPrefix = '';
  let raw = rawInput;
  const prefixMatch = raw.match(KNOWN_SYSTEM_PREFIX);
  if (prefixMatch && prefixMatch[1]) {
    systemPrefix = prefixMatch[0];
    raw = raw.replace(KNOWN_SYSTEM_PREFIX, '').trim();
  }

  // 기존 한글 변환을 먼저 적용해야 TEST-UAT/OPS 규칙이 사라지지 않는다.
  const managedRunName = localizeManagedTestRuns(raw);
  if (managedRunName !== raw) {
    const cleaned = localizeFixtureTerms(stripGeneralTestRuns(managedRunName).replace(/\bUAT\b/gi, '사용자 검증'));
    return `${systemPrefix}${cleaned}`.trim();
  }

  const cleanedRaw = stripGeneralTestRuns(raw);
  if (cleanedRaw !== raw) {
    return `${systemPrefix}${sanitizeProjectNameForDisplay(cleanedRaw, fiscalYear)}`.trim();
  }

  const integrationRun = raw.match(INTEGRATION_TEST_RUN);
  if (integrationRun) {
    const runIdentifier = `${integrationRun[1]}-${integrationRun[2]}`;
    const remainder = localizeFixtureTerms(raw.replace(integrationRun[0], '').trim());
    const projectLabel = /^자동 통합시험(?:\s|$)/.test(remainder)
      ? remainder
      : ['자동 통합시험', remainder].filter(Boolean).join(' · ');
    return `${systemPrefix}${projectLabel || '자동 통합시험'} · 실행 ${runIdentifier}`.trim();
  }

  if (/^TEST\s+시연(?:\s|$)/i.test(raw)) {
    return `${systemPrefix}${localizeResearchAbbreviation(raw.replace(/^TEST\s+/i, '시험 '))}`.trim();
  }

  const run = raw.match(LEADING_TEST_RUN);
  if (run) {
    let remainder = raw.slice(run[0].length).trim();
    if (fiscalYear) {
      remainder = remainder
        .replace(new RegExp(`(^|\\s)${fiscalYear}(?=\\s|$)`), '$1')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
    remainder = localizeFixtureTerms(remainder);
    const runIdentifier = [run[2], run[3]].filter(Boolean).join('-');
    const cleaned = [fixtureRunLabel(run[1]), runIdentifier, remainder || '신규사업 확인']
      .filter(Boolean)
      .join(' · ');
    return `${systemPrefix}${cleaned}`.trim();
  }

  if (INTERNAL_FIXTURE_NAME.test(raw)) {
    return `${systemPrefix}${localizeFixtureTerms(raw) || '시험자료 확인'}`.trim();
  }
  
  if (!/[가-힣]/.test(raw) && PROJECT_CODE_SHAPE.test(raw)) {
    return `${systemPrefix}사업명 확인 필요`.trim();
  }

  return `${systemPrefix}${localizeResearchAbbreviation(raw)}`.trim();
}

/**
 * 사용자 자유서술은 원문을 유지한다. 자동 시험자료임을 명확히 확인할 수 있는
 * 문자열과 의미가 고정된 연구개발 약어만 표시 단계에서 한글로 바꾼다.
 */
export function formatStoredUserText(
  value: string | null | undefined,
  fallback = '-',
) {
  const raw = value?.trim() ?? '';
  if (!raw) return fallback;
  const managedRunText = stripGeneralTestRuns(localizeManagedTestRuns(raw));
  if (managedRunText !== raw) {
    return localizeFixtureTerms(managedRunText
      .replace(/\bTEST\s*[-_ ]?UAT\b/gi, '시험 사용자 검증')
      .replace(/\bUAT\b/gi, '사용자 검증')) || fallback;
  }
  const integrationRun = raw.match(INTEGRATION_TEST_RUN);
  if (integrationRun) {
    const runIdentifier = `${integrationRun[1]}-${integrationRun[2]}`;
    const remainder = localizeFixtureTerms(raw.replace(integrationRun[0], '').trim())
      .replace(/^자동 통합시험(?:\s*[·-]?\s*)?/, '')
      .trim();
    return ['자동 통합시험', runIdentifier, remainder].filter(Boolean).join(' · ');
  }
  if (KNOWN_TEST_USER_TEXT_LABELS[raw]) return KNOWN_TEST_USER_TEXT_LABELS[raw];
  if (/^autonomous\s+UAT\s+rejection$/i.test(raw)) return '자동 사용자 검증 반려';
  const run = raw.match(LEADING_TEST_RUN);
  if (run) {
    const runIdentifier = [run[2], run[3]].filter(Boolean).join('-');
    const remainder = raw.slice(run[0].length)
      .replace(/\bautonomous\s+UAT\b/gi, '자동 사용자 검증')
      .replace(/\bUAT\b/gi, '사용자 검증')
      .replace(/\brejection\b/gi, '반려');
    return [fixtureRunLabel(run[1]), runIdentifier, localizeFixtureTerms(remainder)]
      .filter(Boolean)
      .join(' · ');
  }
  if (!isInternalTestIdentifier(raw) && !/^TEST\s+UAT(?:\s|$)/i.test(raw)) {
    return localizeResearchAbbreviation(raw);
  }
  return localizeFixtureTerms(raw
    .replace(/\bautonomous\s+UAT\b/gi, '자동 사용자 검증')
    .replace(/\bAUTO-UAT\b/gi, '자동 사용자 검증')
    .replace(/\bAUTO-BUDGET-UAT\b/gi, '자동 예산 사용자 검증')
    .replace(/\bGENERIC-BUDGET-UAT\b/gi, '일반 예산 사용자 검증')
    .replace(/\bTEST\s+UAT\b/gi, '시험 사용자 검증')
    .replace(/\bTEST\b/gi, '시험')
    .replace(/\bUAT\b/gi, '사용자 검증')
    .replace(/\brejection\b/gi, '반려'));
}

type BudgetChangeReasonDestination = {
  line_no?: number | null;
  destination_project_name?: string | null;
  current_destination_project_name?: string | null;
  materialized_project_name?: string | null;
  planned_project_name?: string | null;
};

export type BudgetChangeReasonPresentationInput = {
  reason?: string | null;
  fiscal_year?: number | null;
  source_project_name?: string | null;
  destinations?: BudgetChangeReasonDestination[] | null;
};

function formatEnglishMillionWon(amount: string) {
  const won = BigInt(amount) * BigInt(1_000_000);
  if (won === BigInt(0)) return '0원';
  if (won % BigInt(100_000_000) === BigInt(0)) {
    return `${(won / BigInt(100_000_000)).toLocaleString('ko-KR')}억원`;
  }
  if (won % BigInt(10_000) === BigInt(0)) {
    return `${(won / BigInt(10_000)).toLocaleString('ko-KR')}만원`;
  }
  return `${won.toLocaleString('ko-KR')}원`;
}

/**
 * 예산조정 문맥에서 과거 시험자료의 A/B/C/D 사업 별칭과 m 금액 단위를
 * 실제 사업명·한글 금액으로 표시한다. 저장된 사유 원문은 변경하지 않는다.
 */
export function formatBudgetChangeReasonForDisplay(
  input: BudgetChangeReasonPresentationInput,
  fallback = '사유 미입력',
) {
  const year = input.fiscal_year ?? null;
  const destinations = [...(input.destinations ?? [])].sort(
    (left, right) => (left.line_no ?? 0) - (right.line_no ?? 0),
  );
  const rawNames = [
    input.source_project_name,
    ...destinations.map((destination) => destination.current_destination_project_name
      ?? destination.materialized_project_name
      ?? destination.destination_project_name
      ?? destination.planned_project_name),
  ];
  const aliases = new Map(['A', 'B', 'C', 'D'].map((alias, index) => {
    const rawName = rawNames[index]?.trim();
    return [alias, rawName ? sanitizeProjectNameForDisplay(rawName, year) : `시나리오 ${FIXTURE_SCENARIOS[alias]}`];
  }));

  return formatStoredUserText(input.reason, fallback)
    .replace(/\b(\d+)\s*m\b/gi, (_, amount: string) => formatEnglishMillionWon(amount))
    .replace(/\b([A-D])\b/g, (_, alias: string) => aliases.get(alias) ?? `시나리오 ${FIXTURE_SCENARIOS[alias]}`);
}

export function sanitizeClassificationNameForDisplay(
  value: string | null | undefined,
  fallback = '분류명 확인 필요',
) {
  const raw = value?.trim() ?? '';
  if (!raw) return fallback;
  if (!isInternalTestIdentifier(raw) && !/^GENERIC\s+RAW(?:\s|$)/i.test(raw)) {
    return localizeResearchAbbreviation(raw);
  }
  const integrationRun = raw.match(INTEGRATION_TEST_RUN);
  const runLabel = integrationRun ? ` · 실행 ${integrationRun[1]}-${integrationRun[2]}` : '';
  const containedInternalToken = /[A-Za-z]/.test(raw);
  const name = raw.replace(integrationRun?.[0] ?? '', ' ')
    .replace(INTERNAL_TEST_TOKEN, ' ')
    .replace(LATIN_DISPLAY_TOKEN, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!name || !/[가-힣]/.test(name)) return fallback;
  if (containedInternalToken && name === '반려') return `사용자 검증 · 반려 검증 소분류${runLabel}`;
  if (containedInternalToken && name === '매핑') return `사용자 검증 · 기존분류 연결 소분류${runLabel}`;
  return `사용자 검증 · ${name}${runLabel}`;
}

export function getProjectPresentation(project: ProjectPresentationInput) {
  const year = project.fiscal_year ?? project.year ?? null;
  const rawName = project.detail_project_name?.trim()
    || project.fund_project_name?.trim()
    || project.project_name?.trim()
    || '';
  const rawCode = project.project_code?.trim() || null;
  const isTestProject = isInternalTestIdentifier(rawName) || isInternalTestIdentifier(rawCode);
  const name = sanitizeProjectNameForDisplay(rawName, year);
  const officialCode = rawCode && !isInternalTestIdentifier(rawCode) ? rawCode : null;
  const pendingOfficialCode = project.status === 'DRAFT' || project.status === 'SUBMITTED';
  const codeLabel = officialCode
    ?? (pendingOfficialCode ? '사업코드 승인 후 부여' : '사업코드 미부여');
  return {
    year,
    name,
    officialCode,
    codeLabel,
    isTestProject,
    badgeLabel: isTestProject ? '테스트' : null,
    searchText: [year, name, rawName, rawCode].filter(Boolean).join(' '),
  };
}

export function getProjectSearchText(project: ProjectPresentationInput) {
  return getProjectPresentation(project).searchText;
}

/**
 * 화면 표시명으로 검색해도 원본 시험 식별자와 의미가 명확한 약어를 찾도록
 * 서버 검색용 토큰을 만든다. 각 안쪽 배열은 같은 의미의 OR 검색어다.
 */
export function getRawProjectSearchTokens(displayQuery: string) {
  const normalized = displayQuery
    .replace(/자동 통합시험/g, 'AUTO-INT')
    .replace(/실행\s+(\d{8}-\d{6})/g, '$1')
    .replace(/자동 예산 사용자 검증/g, 'AUTO-BUDGET-UAT')
    .replace(/일반 예산 사용자 검증/g, 'GENERIC-BUDGET-UAT')
    .replace(/자동 사용자 검증/g, 'AUTO-UAT')
    .replace(/사용자 검증/g, 'UAT')
    .replace(/기준 시험자료/g, 'GOLDEN')
    .replace(/반려 확인/g, 'REJECTED')
    .replace(/원시 시험자료/g, 'RAW')
    .replace(/([\d,]+)원 경계값/g, (_, amount: string) => `${amount.replace(/,/g, '')}W`)
    .replace(/시나리오\s*([가나다라])/g, (_, scenario: string) => (
      ({ 가: 'A', 나: 'B', 다: 'C', 라: 'D' } as Record<string, string>)[scenario] ?? scenario
    ))
    .replace(/[,%()"'\\]/g, ' ')
    .replace(/[·\s]+/g, ' ')
    .trim();
  return normalized.split(' ').filter(Boolean).slice(0, 8)
    .map((token) => token === '연구개발' ? ['연구개발', 'R&D'] : [token]);
}

export function formatProjectReference(project: ProjectPresentationInput) {
  return getProjectPresentation(project).name;
}

export function formatProjectName(project: ProjectPresentationInput) {
  return getProjectPresentation(project).name;
}

export function formatProjectOption(project: ProjectPresentationInput) {
  const year = project.fiscal_year ?? project.year;
  const reference = formatProjectReference(project);
  return year ? `${year} · ${reference}` : reference;
}
