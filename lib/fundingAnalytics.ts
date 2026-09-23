import { createClient } from '@supabase/supabase-js';
import type { AnalyticsFilters } from './analytics/types';
import type { BudgetChangeStatistics } from './budgetChanges';

export const FUNDING_ANALYTICS_RPC = 'get_financial_funding_analytics';

export type FundingAnalyticsRpcRow = {
  scope_key: string;
  label: string;
  region_id: string | null;
  sido: string | null;
  sigungu: string | null;
  fiscal_year: number | null;
  budget_cohort_id: string | null;
  initial_allocation_amount: string | number | bigint;
  confirmed_execution_amount: string | number | bigint;
  current_wallet_balance: string | number | bigint;
  unclassified_decrease_amount: string | number | bigint;
  unclassified_decrease_count: string | number | bigint;
  decrease_flow_amount: string | number | bigint;
  reallocated_amount: string | number | bigint;
  returned_amount: string | number | bigint;
  waiting_stock_amount: string | number | bigint;
  waiting_stock_count: string | number | bigint;
  myeongsi_flow_amount: string | number | bigint;
  myeongsi_flow_count: string | number | bigint;
  sago_flow_amount: string | number | bigint;
  sago_flow_count: string | number | bigint;
  current_carryover_stock: string | number | bigint;
  second_sequence_amount: string | number | bigint;
};

export type FundingAnalyticsBucket = {
  key: string;
  label: string;
  regionId: string | null;
  sido: string | null;
  sigungu: string | null;
  fiscalYear: number | null;
  budgetCohortId: string | null;
  initialAllocationAmount: string;
  confirmedExecutionAmount: string;
  currentWalletBalance: string;
  unclassifiedDecreaseAmount: string;
  unclassifiedDecreaseCount: number;
  decreaseFlowAmount: string;
  reallocatedAmount: string;
  returnedAmount: string;
  waitingStockAmount: string;
  waitingLotCount: number;
  myeongsiFlowAmount: string;
  myeongsiCount: number;
  sagoFlowAmount: string;
  sagoCount: number;
  currentCarryoverStock: string;
  secondSequenceAmount: string;
  cohortExecutionRate: number | null;
};

export type FundingAnalyticsTotals = Omit<FundingAnalyticsBucket,
  'key' | 'label' | 'regionId' | 'sido' | 'sigungu' | 'fiscalYear' | 'budgetCohortId'> & {
    cohortCount: number;
  };

export type FundingAnalyticsResult = {
  source: 'confirmed_financial_ledger';
  grain: 'region_fiscal_year_cohort';
  totals: FundingAnalyticsTotals;
  buckets: FundingAnalyticsBucket[];
};

type RpcInvoker = (
  functionName: string,
  args: { p_fiscal_year: number | null; p_sido: string | null; p_sigungu: string | null },
) => Promise<{ data: unknown; error: { message?: string } | null }>;

function integerText(value: unknown, field: string) {
  const text = typeof value === 'bigint' ? value.toString() : String(value);
  if (!/^\d+$/.test(text)) throw new Error(`${field} must be a non-negative integer.`);
  return BigInt(text).toString();
}

function count(value: unknown, field: string) {
  const parsed = BigInt(integerText(value, field));
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${field} exceeds the safe count range.`);
  return Number(parsed);
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function optionalYear(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) throw new Error('fiscal_year must be an integer or null.');
  return parsed;
}

export function calculateCohortExecutionRate(execution: string, initialAllocation: string) {
  const denominator = BigInt(initialAllocation);
  if (denominator <= BigInt(0)) return null;
  // Preserve bigint precision and expose four decimal places of percentage.
  return Number((BigInt(execution) * BigInt(1_000_000)) / denominator) / 10_000;
}

export function mapFundingAnalyticsRows(rows: unknown): FundingAnalyticsBucket[] {
  if (!Array.isArray(rows)) throw new Error('Funding analytics RPC must return an array.');

  const seen = new Set<string>();
  return rows.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`Funding analytics row ${index} is invalid.`);
    const row = raw as Record<string, unknown>;
    const scopeKey = optionalText(row.scope_key);
    const scopeLabel = optionalText(row.label);
    if (!scopeKey || !scopeLabel) throw new Error(`Funding analytics row ${index} is missing its scope.`);

    const budgetCohortId = optionalText(row.budget_cohort_id);
    const fiscalYear = optionalYear(row.fiscal_year);
    const uniqueKey = `${scopeKey}:${fiscalYear ?? 'all'}:${budgetCohortId ?? 'unclassified'}`;
    if (seen.has(uniqueKey)) {
      throw new Error(`Funding analytics RPC returned a duplicate accounting bucket: ${uniqueKey}`);
    }
    seen.add(uniqueKey);

    const initialAllocationAmount = integerText(row.initial_allocation_amount, 'initial_allocation_amount');
    const confirmedExecutionAmount = integerText(row.confirmed_execution_amount, 'confirmed_execution_amount');

    return {
      key: uniqueKey,
      label: scopeLabel,
      regionId: optionalText(row.region_id),
      sido: optionalText(row.sido),
      sigungu: optionalText(row.sigungu),
      fiscalYear,
      budgetCohortId,
      initialAllocationAmount,
      confirmedExecutionAmount,
      currentWalletBalance: integerText(row.current_wallet_balance, 'current_wallet_balance'),
      unclassifiedDecreaseAmount: integerText(row.unclassified_decrease_amount, 'unclassified_decrease_amount'),
      unclassifiedDecreaseCount: count(row.unclassified_decrease_count, 'unclassified_decrease_count'),
      decreaseFlowAmount: integerText(row.decrease_flow_amount, 'decrease_flow_amount'),
      reallocatedAmount: integerText(row.reallocated_amount, 'reallocated_amount'),
      returnedAmount: integerText(row.returned_amount, 'returned_amount'),
      waitingStockAmount: integerText(row.waiting_stock_amount, 'waiting_stock_amount'),
      waitingLotCount: count(row.waiting_stock_count, 'waiting_stock_count'),
      myeongsiFlowAmount: integerText(row.myeongsi_flow_amount, 'myeongsi_flow_amount'),
      myeongsiCount: count(row.myeongsi_flow_count, 'myeongsi_flow_count'),
      sagoFlowAmount: integerText(row.sago_flow_amount, 'sago_flow_amount'),
      sagoCount: count(row.sago_flow_count, 'sago_flow_count'),
      currentCarryoverStock: integerText(row.current_carryover_stock, 'current_carryover_stock'),
      secondSequenceAmount: integerText(row.second_sequence_amount, 'second_sequence_amount'),
      cohortExecutionRate: calculateCohortExecutionRate(confirmedExecutionAmount, initialAllocationAmount),
    };
  });
}

const AMOUNT_FIELDS = [
  'initialAllocationAmount',
  'confirmedExecutionAmount',
  'currentWalletBalance',
  'unclassifiedDecreaseAmount',
  'decreaseFlowAmount',
  'reallocatedAmount',
  'returnedAmount',
  'waitingStockAmount',
  'myeongsiFlowAmount',
  'sagoFlowAmount',
  'currentCarryoverStock',
  'secondSequenceAmount',
] as const;

export function calculateFundingAnalyticsTotals(buckets: FundingAnalyticsBucket[]): FundingAnalyticsTotals {
  const amountTotals = Object.fromEntries(AMOUNT_FIELDS.map((field) => [field, BigInt(0)])) as Record<typeof AMOUNT_FIELDS[number], bigint>;
  let unclassifiedDecreaseCount = 0;
  let waitingLotCount = 0;
  let myeongsiCount = 0;
  let sagoCount = 0;

  for (const bucket of buckets) {
    for (const field of AMOUNT_FIELDS) amountTotals[field] += BigInt(bucket[field]);
    unclassifiedDecreaseCount += bucket.unclassifiedDecreaseCount;
    waitingLotCount += bucket.waitingLotCount;
    myeongsiCount += bucket.myeongsiCount;
    sagoCount += bucket.sagoCount;
  }

  const initialAllocationAmount = amountTotals.initialAllocationAmount.toString();
  const confirmedExecutionAmount = amountTotals.confirmedExecutionAmount.toString();
  return {
    ...Object.fromEntries(AMOUNT_FIELDS.map((field) => [field, amountTotals[field].toString()])) as Pick<FundingAnalyticsTotals, typeof AMOUNT_FIELDS[number]>,
    unclassifiedDecreaseCount,
    waitingLotCount,
    myeongsiCount,
    sagoCount,
    cohortCount: new Set(buckets.flatMap((bucket) => bucket.budgetCohortId ? [bucket.budgetCohortId] : [])).size,
    cohortExecutionRate: calculateCohortExecutionRate(confirmedExecutionAmount, initialAllocationAmount),
  };
}

export function buildFundingAnalyticsResult(rows: unknown): FundingAnalyticsResult {
  const buckets = mapFundingAnalyticsRows(rows);
  return {
    source: 'confirmed_financial_ledger',
    grain: 'region_fiscal_year_cohort',
    totals: calculateFundingAnalyticsTotals(buckets),
    buckets,
  };
}

export async function queryFundingAnalytics(
  accessToken: string,
  filters: Pick<AnalyticsFilters, 'year' | 'sido' | 'sigungu'>,
  invoke?: RpcInvoker,
): Promise<FundingAnalyticsResult> {
  let rpc = invoke;
  if (!rpc) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) throw new Error('Supabase public environment variables are required.');
    const client = createClient(url, anonKey, {
      auth: { persistSession: false },
      global: {
        headers: { Authorization: `Bearer ${accessToken}` },
        fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }),
      },
    });
    rpc = (functionName, args) => client.rpc(functionName, args) as unknown as ReturnType<RpcInvoker>;
  }

  const { data, error } = await rpc(FUNDING_ANALYTICS_RPC, {
    p_fiscal_year: filters.year,
    p_sido: filters.sido,
    p_sigungu: filters.sigungu,
  });
  if (error) throw new Error(error.message || '재원 통계를 불러오지 못했습니다.');
  return buildFundingAnalyticsResult(data ?? []);
}

export async function queryBudgetChangeStatistics(
  accessToken: string,
  filters: Pick<AnalyticsFilters, 'year' | 'sido' | 'sigungu'>,
): Promise<BudgetChangeStatistics> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Supabase public environment variables are required.');
  const client = createClient(url, anonKey, {
    auth: { persistSession: false },
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
      fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }),
    },
  });
  const { data, error } = await client.rpc('get_financial_budget_change_statistics_filtered', {
    p_year: filters.year,
    p_sido: filters.sido,
    p_sigungu: filters.sigungu,
  });
  if (error) throw new Error(error.message || '예산 조정 통계를 불러오지 못했습니다.');
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) throw new Error('Budget-change statistics RPC returned no row.');
  const keys = [
    'transfer_amount', 'transfer_count',
    'new_project_allocated_amount', 'new_project_allocated_count',
    'pending_new_project_amount', 'pending_new_project_count',
    'applied_request_count', 'transaction_gap_amount',
  ] as const;
  return Object.fromEntries(keys.map((key) => [key, integerText(row[key], key)])) as BudgetChangeStatistics;
}
