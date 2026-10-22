import { describe, expect, it } from 'vitest';
import {
  chooseCohort,
  compare,
  MIN_PEER_CLIENTS,
  MIN_PEER_SITES,
  opaqueKey,
  siteWeek,
  sizeBandFor,
  type BenchmarkContribution,
  type SiteWeek,
} from './benchmark';
import { demoPeerPanel } from './benchmarkDemo';
import { seedDemo } from './simulate';
import { addDays } from './time';

const WEEK = '2026-10-19'; // a Monday
const LAST = addDays(WEEK, -7);

const peer = (i: number, over: Partial<BenchmarkContribution> = {}, labourPct = 0.3): BenchmarkContribution => ({
  siteKey: `S-${i}`,
  clientKey: `C-${i}`,
  weekStartDate: LAST,
  concept: 'restaurant',
  region: 'London',
  sizeBand: '£20k to £40k',
  metrics: { labourPct, overrunMinutesPerShift: 10, splh: 60 },
  ...over,
});

const you: SiteWeek = {
  sales: 30_000,
  labourCost: 9_600,
  hours: 600,
  shifts: 120,
  contribution: peer(99, { clientKey: 'C-you', metrics: { labourPct: 0.32, overrunMinutesPerShift: 16, splh: 50 } }),
};

describe('anonymity', () => {
  it('keys are stable and reveal nothing', () => {
    expect(opaqueKey('S', 'group|mar')).toBe(opaqueKey('S', 'group|mar'));
    expect(opaqueKey('S', 'group|mar')).not.toBe(opaqueKey('S', 'group|shd'));
    expect(opaqueKey('S', 'group|mar')).toMatch(/^S-[0-9a-f]{8}$/);
  });

  it('never shows a group smaller than the threshold, widening until it is safe', () => {
    const tight = Array.from({ length: MIN_PEER_SITES }, (_, i) => peer(i));
    expect(chooseCohort(you.contribution, tight)!.level).toBe(0);
    // Enough sites but too few separate businesses: widen to the region.
    const oneOwner = tight.map((p) => ({ ...p, clientKey: 'C-big' }));
    const others = Array.from({ length: MIN_PEER_CLIENTS }, (_, i) => peer(50 + i, { sizeBand: 'over £40k' }));
    const c = chooseCohort(you.contribution, [...oneOwner, ...others])!;
    expect(c.level).toBe(1);
    expect(c.clients).toBeGreaterThanOrEqual(MIN_PEER_CLIENTS);
    expect(chooseCohort(you.contribution, tight.slice(0, MIN_PEER_SITES - 1))).toBeNull();
  });

  it('keeps your own sites out of your peer group', () => {
    const mine = Array.from({ length: 10 }, (_, i) => peer(i, { clientKey: 'C-you' }));
    expect(chooseCohort(you.contribution, mine)).toBeNull();
  });
});

describe('comparison', () => {
  const values = [0.26, 0.28, 0.3, 0.32, 0.34, 0.36];
  const cohort = chooseCohort(you.contribution, values.map((v, i) => peer(i, {}, v)))!;
  const rows = Object.fromEntries(compare(you, cohort).map((r) => [r.metric.id, r]));

  it('places the site in the spread and counts ties as half', () => {
    const l = rows.labourPct;
    expect(l.median).toBeCloseTo(0.31, 5);
    expect(l.p25).toBeCloseTo(0.285, 5);
    // Better than 0.34 and 0.36, level with 0.32.
    expect(l.betterThan).toBeCloseTo(2.5 / 6, 5);
  });

  it('prices the gap to the median and the top quartile', () => {
    expect(rows.labourPct.valueAtMedian).toBeCloseTo((0.32 - 0.31) * 30_000, 2);
    expect(rows.labourPct.valueAtTopQuartile).toBeCloseTo((0.32 - 0.285) * 30_000, 2);
    // 6 minutes a shift over the median, 120 shifts, at £16 an hour loaded.
    expect(rows.overrunMinutesPerShift.valueAtMedian).toBeCloseTo((6 * 120 * 16) / 60, 2);
    expect(rows.splh.valueAtMedian).toBeNull();
  });

  it('says nothing about a metric too few peers report', () => {
    expect(rows.missedBreakRate.suppressed).toBe(true);
    expect(rows.missedBreakRate.betterThan).toBeNull();
  });
});

describe('demo', () => {
  const demo = seedDemo('2026-10-21');

  it('builds a contribution only for a fully traded week, with no names in it', () => {
    expect(siteWeek(demo, 'mar', WEEK, '2026-10-21', 'group')).toBeNull();
    const w = siteWeek(demo, 'mar', LAST, WEEK, 'group')!;
    expect(w.contribution.sizeBand).toBe(sizeBandFor(w.sales));
    expect(w.contribution.metrics.labourPct).toBeGreaterThan(0.15);
    const text = JSON.stringify(w.contribution);
    for (const word of ['Marylebone', 'mar-', 'Priya', 'group']) expect(text).not.toContain(word);
  });

  it('finds a peer group for both sites in the illustrative panel', () => {
    const panel = demoPeerPanel(LAST);
    for (const site of ['mar', 'shd']) {
      const w = siteWeek(demo, site, LAST, WEEK, 'group')!;
      const c = chooseCohort(w.contribution, panel)!;
      expect(c.peers.length).toBeGreaterThanOrEqual(MIN_PEER_SITES);
      expect(compare(w, c).some((r) => r.betterThan !== null)).toBe(true);
    }
  });
});
