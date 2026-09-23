export type AnalyticsRegionLabels = {
  sido: string | null;
  sigungu: string | null;
};

export function resolveAnalyticsRegionLabels(
  project: AnalyticsRegionLabels,
  region: AnalyticsRegionLabels | undefined,
): AnalyticsRegionLabels {
  return {
    sido: project.sido ?? region?.sido ?? null,
    sigungu: project.sigungu ?? region?.sigungu ?? null,
  };
}
