// Benchmarks across the WS client base: how a site's labour compares with
// similar sites run by other operators. Only figures that cannot be traced back
// to one business leave the cohort: quartiles, never a site, a name or a
// value from a single operator. A cohort too small or too dominated by one
// operator to hide who is in it returns nothing at all.

export type BenchmarkMetric = 'labourPct' | 'splh' | 'overstaffedShare' | 'forecastWape';

export interface SiteSample {
  orgId: string;
  labourPct: number | null;
  splh: number | null;
  overstaffedShare: number | null;
  forecastWape: number | null;
}

export interface Distribution {
  p25: number;
  median: number;
  p75: number;
  sites: number;
}

export interface Benchmark {
  available: boolean;
  /** Why there is nothing to show, when there is not. */
  reason?: string;
  sites: number;
  operators: number;
  metrics: Partial<Record<BenchmarkMetric, Distribution>>;
}

/** Fewest sites and operators a figure can be drawn from. Ten sites keeps the quartiles from being one site's own figure. */
export const MIN_SITES = 10;
export const MIN_OPERATORS = 3;
/** No one operator may supply more than this share of a cohort, or the quartiles describe them. */
export const MAX_OPERATOR_SHARE = 0.5;

const METRICS: BenchmarkMetric[] = ['labourPct', 'splh', 'overstaffedShare', 'forecastWape'];

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * The cohort for one operator, built from every other opted-in operator's
 * sites. The asking operator is always left out, so it never sees itself in
 * the figures and cannot work backwards from them.
 */
export function cohortBenchmark(samples: SiteSample[], askingOrgId: string): Benchmark {
  const cohort = samples.filter((s) => s.orgId !== askingOrgId);
  const operators = new Map<string, number>();
  for (const s of cohort) operators.set(s.orgId, (operators.get(s.orgId) ?? 0) + 1);
  const base = { sites: cohort.length, operators: operators.size, metrics: {} };
  if (cohort.length < MIN_SITES || operators.size < MIN_OPERATORS) {
    return { ...base, available: false, reason: `Benchmarks need at least ${MIN_SITES} sites from ${MIN_OPERATORS} other operators who share their figures.` };
  }
  if (Math.max(...operators.values()) / cohort.length > MAX_OPERATOR_SHARE) {
    return { ...base, available: false, reason: 'One operator makes up most of the cohort, so the figures would describe them. Held back until the cohort is broader.' };
  }
  const metrics: Benchmark['metrics'] = {};
  for (const m of METRICS) {
    const values = cohort.filter((s) => s[m] !== null).map((s) => s[m] as number).sort((a, b) => a - b);
    // The same tests again for each figure: only some operators report some figures.
    const contributors = new Map<string, number>();
    for (const s of cohort) if (s[m] !== null) contributors.set(s.orgId, (contributors.get(s.orgId) ?? 0) + 1);
    if (values.length < MIN_SITES || contributors.size < MIN_OPERATORS) continue;
    if (Math.max(...contributors.values()) / values.length > MAX_OPERATOR_SHARE) continue;
    metrics[m] = { p25: quantile(values, 0.25), median: quantile(values, 0.5), p75: quantile(values, 0.75), sites: values.length };
  }
  return { ...base, available: true, metrics };
}

/** Where a value sits against a distribution, in words. `lowerIsBetter` for costs and errors. */
export function quartileOf(value: number, d: Distribution, lowerIsBetter: boolean): 'top quartile' | 'better than median' | 'worse than median' | 'bottom quartile' {
  const better = lowerIsBetter ? value <= d.p25 : value >= d.p75;
  const worse = lowerIsBetter ? value >= d.p75 : value <= d.p25;
  if (better) return 'top quartile';
  if (worse) return 'bottom quartile';
  const aboveMedian = lowerIsBetter ? value < d.median : value > d.median;
  return aboveMedian ? 'better than median' : 'worse than median';
}
