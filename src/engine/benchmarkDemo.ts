import type { Concept } from './types';
import { opaqueKey, sizeBandFor, type BenchmarkContribution, type MetricId } from './benchmark';
import { random } from './simulate';

/**
 * An illustrative peer panel standing in for the WS client base until real
 * contributions are collected server-side. The shapes are plausible, the
 * numbers are invented, and nothing built on them should be quoted to a
 * client as a market figure.
 */
const CONCEPTS: { concept: Concept; weight: number; sales: [number, number] }[] = [
  { concept: 'restaurant', weight: 0.5, sales: [18_000, 55_000] },
  { concept: 'bar', weight: 0.2, sales: [12_000, 45_000] },
  { concept: 'pub', weight: 0.15, sales: [10_000, 35_000] },
  { concept: 'cafe', weight: 0.15, sales: [5_000, 18_000] },
];
const REGIONS: [string, number][] = [
  ['London', 0.55],
  ['South East', 0.2],
  ['Manchester', 0.15],
  ['Edinburgh', 0.1],
];

// Mean and spread by concept for each metric.
const SHAPE: Record<MetricId, Record<Concept, [number, number]>> = {
  labourPct: { restaurant: [0.3, 0.035], bar: [0.24, 0.03], pub: [0.27, 0.03], cafe: [0.33, 0.04] },
  splh: { restaurant: [68, 11], bar: [95, 15], pub: [80, 12], cafe: [45, 8] },
  rotaToPayrollPct: { restaurant: [0.028, 0.014], bar: [0.03, 0.015], pub: [0.025, 0.012], cafe: [0.02, 0.01] },
  overrunMinutesPerShift: { restaurant: [9, 4], bar: [11, 5], pub: [8, 4], cafe: [4, 2] },
  earlyStartMinutesPerShift: { restaurant: [4, 2], bar: [3.5, 2], pub: [3.5, 2], cafe: [3, 1.5] },
  missedBreakRate: { restaurant: [0.14, 0.08], bar: [0.18, 0.09], pub: [0.12, 0.07], cafe: [0.08, 0.05] },
  forecastErrorPct: { restaurant: [0.1, 0.035], bar: [0.14, 0.05], pub: [0.12, 0.04], cafe: [0.09, 0.03] },
  tipsPerHour: { restaurant: [9, 2.5], bar: [5, 1.8], pub: [3, 1.2], cafe: [2, 0.8] },
  flexibleHoursShare: { restaurant: [0.5, 0.15], bar: [0.65, 0.15], pub: [0.55, 0.15], cafe: [0.45, 0.15] },
};

export function demoPeerPanel(weekStartDate: string, clients = 60, seed = 11): BenchmarkContribution[] {
  const rnd = random(seed);
  const pick = <T,>(items: [T, number][]): T => {
    let r = rnd();
    for (const [item, w] of items) if ((r -= w) <= 0) return item;
    return items[items.length - 1][0];
  };
  // Box-Muller, for a bell-shaped spread around each mean.
  const normal = (mean: number, sd: number) => mean + sd * Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());

  const panel: BenchmarkContribution[] = [];
  for (let c = 0; c < clients; c++) {
    const clientKey = opaqueKey('C', `panel-${c}`);
    const concept = pick(CONCEPTS.map((x) => [x.concept, x.weight] as [Concept, number]));
    const region = pick(REGIONS);
    const [lo, hi] = CONCEPTS.find((x) => x.concept === concept)!.sales;
    // A group's sites share its habits: one draw per group, a little variation per site.
    const habit = normal(0, 1);
    const sites = 1 + Math.floor(rnd() * 4);
    for (let s = 0; s < sites; s++) {
      const sales = lo + rnd() * (hi - lo);
      const metrics: Partial<Record<MetricId, number>> = {};
      for (const [id, byConcept] of Object.entries(SHAPE) as [MetricId, Record<Concept, [number, number]>][]) {
        const [mean, sd] = byConcept[concept];
        // Well-run groups are better on cost and control metrics alike; habit carries that.
        const direction = id === 'splh' || id === 'tipsPerHour' ? -1 : 1;
        const value = mean + sd * (0.6 * habit * direction + 0.8 * normal(0, 1));
        metrics[id] = Math.max(0, Math.round(value * 10_000) / 10_000);
      }
      panel.push({
        siteKey: opaqueKey('S', `panel-${c}-${s}`),
        clientKey,
        weekStartDate,
        concept,
        region,
        sizeBand: sizeBandFor(sales),
        metrics,
      });
    }
  }
  return panel;
}
