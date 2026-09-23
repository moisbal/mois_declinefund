export type FinancialBudgetYear = {
  budget_year_id: string;
  project_id: string;
  project_code: string | null;
  project_name: string;
  sido: string | null;
  sigungu: string | null;
  fiscal_year: number;
  budget_cohort_id: string;
  origin_project_id: string;
  origin_fiscal_year: number;
  initial_allocation: string;
  allocation_type: 'INITIAL' | 'EXTERNAL_INCREASE';
  accounting_balance: string;
  reserved_amount: string;
  available_to_commit: string;
};

export type TransferDestinationProject = {
  project_id: string;
  project_code: string | null;
  project_name: string;
  sido: string | null;
  sigungu: string | null;
  fiscal_year: number;
};

export type FinancialActionResult<T> =
  | { data: T; error?: never }
  | { data?: never; error: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BIGINT = BigInt('9223372036854775807');

export function isUuid(value: string) {
  return UUID_PATTERN.test(value);
}

export function normalizeLedgerAmount(value: string) {
  const digits = value.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
  return digits || '0';
}

export function isPositiveBigIntString(value: string) {
  if (!POSITIVE_INTEGER_PATTERN.test(value)) {
    return false;
  }
  return BigInt(value) <= MAX_BIGINT;
}

export function isIsoDate(value: string) {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function toOptionalTrimmedText(value: string, maxLength: number, label: string) {
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new Error(`${label}은(는) ${maxLength.toLocaleString('ko-KR')}자 이하여야 합니다.`);
  }
  return trimmed || null;
}
