import type { AnalyticsKpis, AnalyticsRateBasis } from './types';

export type AnalyticsProjectValue = {
  allocText: string | null;
  execText: string | null;
  originalAllocText: string | null;
};

type Totals = {
  projectCount: number;
  adjustedAllocation: bigint;
  cumulativeExecution: bigint;
  unexecutedAmount: bigint;
  adjustedRateNumerator: bigint;
  adjustedRateDenominator: bigint;
  originalAllocation: bigint;
  originalRateNumerator: bigint;
  originalRateDenominator: bigint;
  unknownAdjustedAmountCount: number;
  unknownExecutionCount: number;
  unknownOriginalAmountCount: number;
};

function amount(value: string | null) {
  if (value === null || !/^-?\d+$/.test(value)) return null;
  return BigInt(value);
}

function emptyTotals(): Totals {
  return {
    projectCount: 0,
    adjustedAllocation: BigInt(0),
    cumulativeExecution: BigInt(0),
    unexecutedAmount: BigInt(0),
    adjustedRateNumerator: BigInt(0),
    adjustedRateDenominator: BigInt(0),
    originalAllocation: BigInt(0),
    originalRateNumerator: BigInt(0),
    originalRateDenominator: BigInt(0),
    unknownAdjustedAmountCount: 0,
    unknownExecutionCount: 0,
    unknownOriginalAmountCount: 0,
  };
}

export function getProjectRate(project: AnalyticsProjectValue, basis: AnalyticsRateBasis) {
  const denominator = amount(basis === 'adjusted' ? project.allocText : project.originalAllocText);
  const numerator = amount(project.execText);
  if (denominator === null || numerator === null || denominator <= BigInt(0)) return null;
  return Number(numerator) / Number(denominator) * 100;
}

export function calculateKpis(projects: AnalyticsProjectValue[], rateBasis: AnalyticsRateBasis): AnalyticsKpis {
  const totals = emptyTotals();

  for (const project of projects) {
    totals.projectCount += 1;
    const adjusted = amount(project.allocText);
    const execution = amount(project.execText);
    const original = amount(project.originalAllocText);

    if (adjusted === null) totals.unknownAdjustedAmountCount += 1;
    else totals.adjustedAllocation += adjusted;
    if (execution === null) totals.unknownExecutionCount += 1;
    else totals.cumulativeExecution += execution;
    if (original === null) totals.unknownOriginalAmountCount += 1;
    else totals.originalAllocation += original;

    if (adjusted !== null && execution !== null) {
      totals.unexecutedAmount += adjusted - execution;
      if (adjusted > BigInt(0)) {
        totals.adjustedRateNumerator += execution;
        totals.adjustedRateDenominator += adjusted;
      }
    }
    if (original !== null && execution !== null && original > BigInt(0)) {
      totals.originalRateNumerator += execution;
      totals.originalRateDenominator += original;
    }
  }

  const adjustedRate = totals.adjustedRateDenominator > BigInt(0)
    ? Number(totals.adjustedRateNumerator) / Number(totals.adjustedRateDenominator) * 100
    : null;
  // A group containing an unknown original allocation must not be represented as
  // a zero-valued original-allocation result.
  const originalRate = totals.unknownOriginalAmountCount === 0 && totals.originalRateDenominator > BigInt(0)
    ? Number(totals.originalRateNumerator) / Number(totals.originalRateDenominator) * 100
    : null;

  return {
    projectCount: totals.projectCount,
    adjustedAllocation: totals.adjustedAllocation.toString(),
    cumulativeExecution: totals.cumulativeExecution.toString(),
    unexecutedAmount: totals.unexecutedAmount.toString(),
    executionRate: rateBasis === 'adjusted' ? adjustedRate : originalRate,
    originalAllocation: totals.unknownOriginalAmountCount === 0 ? totals.originalAllocation.toString() : null,
    originalExecutionRate: originalRate,
    unknownAdjustedAmountCount: totals.unknownAdjustedAmountCount,
    unknownExecutionCount: totals.unknownExecutionCount,
    unknownOriginalAmountCount: totals.unknownOriginalAmountCount,
  };
}
