import { describe, expect, it } from 'vitest';
import { cohortBenchmark, quartileOf, type SiteSample } from './benchmark';

const site = (orgId: string, labourPct: number, over: Partial<SiteSample> = {}): SiteSample => ({
  orgId,
  labourPct,
  splh: 50,
  overstaffedShare: 0.05,
  forecastWape: null,
  ...over,
});

describe('benchmarks', () => {
  const ten = (pcts: number[]) => pcts.map((p, i) => site('abcde'[i % 5], p));

  it('returns quartiles from other operators only', () => {
    const samples = [...ten([0.26, 0.27, 0.28, 0.29, 0.3, 0.31, 0.32, 0.33, 0.34, 0.35]), site('me', 0.9)];
    const b = cohortBenchmark(samples, 'me');
    expect(b.available).toBe(true);
    expect(b.sites).toBe(10);
    expect(b.metrics.labourPct!.median).toBeCloseTo(0.305);
    expect(b.metrics.labourPct!.sites).toBe(10);
    // Nobody shared forecast error, so no figure for it rather than a figure from nothing.
    expect(b.metrics.forecastWape).toBeUndefined();
  });

  it('holds everything back from a cohort too small to hide who is in it', () => {
    const small = cohortBenchmark([site('a', 0.3), site('b', 0.3), site('c', 0.3), site('a', 0.3)], 'me');
    expect(small.available).toBe(false);
    expect(small.metrics).toEqual({});
    const twoOperators = cohortBenchmark([site('a', 0.3), site('a', 0.3), site('a', 0.3), site('b', 0.3), site('b', 0.3), site('b', 0.3)], 'me');
    expect(twoOperators.available).toBe(false);
  });

  it('holds back a cohort one operator dominates', () => {
    const samples = [...Array(6).fill(0).map(() => site('a', 0.3)), ...ten([0.3, 0.3, 0.3, 0.3]).map((s, i) => ({ ...s, orgId: 'bcde'[i] }))];
    const b = cohortBenchmark(samples, 'me');
    expect(b.available).toBe(false);
    expect(b.reason).toMatch(/One operator/);
  });

  it('holds back a figure one operator dominates even when the cohort is broad', () => {
    // Twenty sites from five operators pass the cohort tests, but only operator a (six sites)
    // and four sites elsewhere report forecast error, so that one figure would describe a.
    const samples = Array.from({ length: 20 }, (_, i) => {
      const orgId = i < 6 ? 'a' : 'bcde'[i % 4];
      return site(orgId, 0.3, { forecastWape: i < 10 ? 0.1 : null });
    });
    const b = cohortBenchmark(samples, 'me');
    expect(b.available).toBe(true);
    expect(b.metrics.labourPct).toBeDefined();
    expect(b.metrics.forecastWape).toBeUndefined();
  });

  it('describes a site against the cohort', () => {
    const d = { p25: 0.28, median: 0.3, p75: 0.32, sites: 5 };
    expect(quartileOf(0.27, d, true)).toBe('top quartile');
    expect(quartileOf(0.29, d, true)).toBe('better than median');
    expect(quartileOf(0.31, d, true)).toBe('worse than median');
    expect(quartileOf(0.33, d, true)).toBe('bottom quartile');
    expect(quartileOf(60, { p25: 40, median: 50, p75: 55, sites: 5 }, false)).toBe('top quartile');
  });
});
