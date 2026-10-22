import type { Concept, RotaState, Shift } from './types';
import { actualShifts, weekFlash } from './actuals';
import { requiredBreakMinutes } from './compliance';
import { forecastSalesForDay } from './demand';
import { troncRun } from './tronc';
import { ageOn, weekDates } from './time';

export type MetricId =
  | 'labourPct'
  | 'splh'
  | 'rotaToPayrollPct'
  | 'overrunMinutesPerShift'
  | 'earlyStartMinutesPerShift'
  | 'missedBreakRate'
  | 'forecastErrorPct'
  | 'tipsPerHour'
  | 'flexibleHoursShare';

export interface MetricDefinition {
  id: MetricId;
  label: string;
  unit: 'pct' | 'money' | 'minutes';
  /** Which way is better. Context metrics describe the site without ranking it. */
  better: 'lower' | 'higher' | 'context';
  meaning: string;
}

export const METRICS: MetricDefinition[] = [
  { id: 'labourPct', label: 'Labour %', unit: 'pct', better: 'lower', meaning: 'Clocked, loaded labour over actual net sales.' },
  { id: 'splh', label: 'Sales per labour hour', unit: 'money', better: 'higher', meaning: 'Actual net sales per clocked hour.' },
  { id: 'rotaToPayrollPct', label: 'Rota to payroll gap', unit: 'pct', better: 'lower', meaning: 'How far clocked labour landed from the rota, either way.' },
  { id: 'overrunMinutesPerShift', label: 'Overrun per shift', unit: 'minutes', better: 'lower', meaning: 'Minutes clocked past the rostered finish.' },
  { id: 'earlyStartMinutesPerShift', label: 'Early clock-in per shift', unit: 'minutes', better: 'lower', meaning: 'Minutes clocked before the rostered start.' },
  { id: 'missedBreakRate', label: 'Breaks missed', unit: 'pct', better: 'lower', meaning: 'Share of shifts needing a break where the break was not taken.' },
  { id: 'forecastErrorPct', label: 'Forecast error', unit: 'pct', better: 'lower', meaning: 'Average daily miss between forecast and actual sales.' },
  { id: 'tipsPerHour', label: 'Tips per hour', unit: 'money', better: 'higher', meaning: 'Tips and service charge per clocked hour: what the team takes home on top.' },
  { id: 'flexibleHoursShare', label: 'Hours on flexible contracts', unit: 'pct', better: 'context', meaning: 'Share of hours worked by staff contracted under 16 hours.' },
];

export type SizeBand = 'under £20k' | '£20k to £40k' | 'over £40k';

export function sizeBandFor(weeklySales: number): SizeBand {
  return weeklySales < 20_000 ? 'under £20k' : weeklySales < 40_000 ? '£20k to £40k' : 'over £40k';
}

/**
 * One site's week as it leaves the site for the benchmark: no names, no
 * people, no site or client identity beyond opaque keys, and only for a week
 * that has fully traded with clocked hours and actual sales on every day.
 */
export interface BenchmarkContribution {
  siteKey: string;
  clientKey: string;
  weekStartDate: string;
  concept: Concept;
  region: string;
  sizeBand: SizeBand;
  metrics: Partial<Record<MetricId, number>>;
}

/** FNV-1a: a stable opaque key, so the same site is the same peer week to week without being named. */
export function opaqueKey(prefix: string, value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${prefix}-${h.toString(16).padStart(8, '0')}`;
}

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;
const FLEXIBLE_BELOW_HOURS = 16;

export interface SiteWeek {
  sales: number;
  labourCost: number;
  hours: number;
  shifts: number;
  contribution: BenchmarkContribution;
}

/**
 * Works out the benchmark metrics for one closed week at one site, from the
 * same engines that run the flash, the variance and the tronc, so a number in
 * the benchmark is the same number the GM sees everywhere else. Returns null
 * for a week that has not fully traded or has no clocked hours: the benchmark
 * only takes reconciled data.
 */
export function siteWeek(state: RotaState, siteId: string, weekStartDate: string, asOf: string, clientKey: string): SiteWeek | null {
  const site = state.sites.find((s) => s.id === siteId);
  const dates = weekDates(weekStartDate);
  if (!site || dates.some((d) => d >= asOf)) return null;
  const flash = weekFlash(state, siteId, weekStartDate, asOf);
  const tradedEveryDay = flash.days.every((d) => d.actualSales > 0);
  if (!tradedEveryDay || flash.actualHours === 0) return null;

  const clocked = actualShifts(state).filter((s) => s.siteId === siteId && dates.includes(s.date));
  const shifts = clocked.length;
  const v = flash.variance;

  const breakNeeded = (s: Shift) => {
    const dob = state.employees.find((e) => e.id === s.employeeId)?.dateOfBirth;
    return dob ? requiredBreakMinutes(s.endMinute - s.startMinute, ageOn(dob, s.date)) : 0;
  };
  const needingBreak = clocked.filter((s) => breakNeeded(s) > 0);
  const missed = needingBreak.filter((s) => s.breakMinutes < breakNeeded(s));

  const forecastMiss = dates.reduce((sum, d) => sum + Math.abs(flash.days.find((x) => x.date === d)!.actualSales - forecastSalesForDay(state, siteId, d)), 0);
  const flexibleHours = clocked
    .filter((s) => {
      const e = state.employees.find((x) => x.id === s.employeeId);
      return e?.payBasis === 'hourly' && e.contractedHours < FLEXIBLE_BELOW_HOURS;
    })
    .reduce((sum, s) => sum + (s.endMinute - s.startMinute - s.breakMinutes) / 60, 0);
  const tips = troncRun(state, siteId, weekStartDate, asOf).received;

  const metrics: Partial<Record<MetricId, number>> = {
    labourPct: round(flash.actualPct, 4),
    splh: round(flash.splh, 2),
    rotaToPayrollPct: round(Math.abs(v.pct), 4),
    overrunMinutesPerShift: round(v.byKind.overrun.minutes / shifts, 1),
    earlyStartMinutesPerShift: round(v.byKind['early-start'].minutes / shifts, 1),
    missedBreakRate: needingBreak.length ? round(missed.length / needingBreak.length, 4) : undefined,
    forecastErrorPct: flash.forecastSales > 0 ? round(forecastMiss / flash.forecastSales, 4) : undefined,
    tipsPerHour: round(tips / flash.actualHours, 2),
    flexibleHoursShare: round(flexibleHours / flash.actualHours, 4),
  };
  return {
    sales: flash.actualSales,
    labourCost: flash.actualCost,
    hours: flash.actualHours,
    shifts,
    contribution: {
      siteKey: opaqueKey('S', `${clientKey}|${siteId}`),
      clientKey: opaqueKey('C', clientKey),
      weekStartDate,
      concept: site.concept ?? 'restaurant',
      region: site.region ?? 'Unknown',
      sizeBand: sizeBandFor(flash.actualSales),
      metrics,
    },
  };
}

/** A peer group is only shown with at least this many sites from this many separate businesses. */
export const MIN_PEER_SITES = 5;
export const MIN_PEER_CLIENTS = 3;

export interface Cohort {
  label: string;
  /** 0 is the closest match; each step widens the group to keep it large enough to be anonymous. */
  level: number;
  peers: BenchmarkContribution[];
  clients: number;
}

/**
 * The closest peer group large enough to keep every business in it
 * anonymous: same concept, region and size first, widening one step at a time.
 * Your own sites are never in your peer group: the point is the market.
 */
export function chooseCohort(you: BenchmarkContribution, panel: BenchmarkContribution[]): Cohort | null {
  const others = panel.filter((p) => p.clientKey !== you.clientKey);
  const steps: { label: string; match: (p: BenchmarkContribution) => boolean }[] = [
    { label: `${you.region} ${you.concept}s, ${you.sizeBand} a week`, match: (p) => p.concept === you.concept && p.region === you.region && p.sizeBand === you.sizeBand },
    { label: `${you.region} ${you.concept}s`, match: (p) => p.concept === you.concept && p.region === you.region },
    { label: `${you.concept}s across the UK`, match: (p) => p.concept === you.concept },
    { label: 'All hospitality sites', match: () => true },
  ];
  for (const [level, step] of steps.entries()) {
    const peers = others.filter(step.match);
    const clients = new Set(peers.map((p) => p.clientKey)).size;
    if (peers.length >= MIN_PEER_SITES && clients >= MIN_PEER_CLIENTS) return { label: step.label, level, peers, clients };
  }
  return null;
}

export interface MetricComparison {
  metric: MetricDefinition;
  you: number | undefined;
  peers: number;
  p25: number;
  median: number;
  p75: number;
  /** Share of peers you do better than; null for context metrics or too few values. */
  betterThan: number | null;
  /** Value of reaching the median in pounds a week, where the metric has a direct cost. */
  valueAtMedian: number | null;
  /** Value of reaching the top quartile in pounds a week. */
  valueAtTopQuartile: number | null;
  suppressed: boolean;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Where the site stands against its peers on each metric, and what closing the
 * gap is worth. Pounds are given only where the metric is a cost the site
 * controls directly; they overlap (overruns are part of labour %) so they are
 * not added up.
 */
export function compare(you: SiteWeek, cohort: Cohort): MetricComparison[] {
  const loadedRate = you.labourCost / you.hours;
  return METRICS.map((metric) => {
    const values = cohort.peers.map((p) => p.metrics[metric.id]).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
    const mine = you.contribution.metrics[metric.id];
    const suppressed = values.length < MIN_PEER_SITES;
    const p25 = suppressed ? 0 : quantile(values, 0.25);
    const median = suppressed ? 0 : quantile(values, 0.5);
    const p75 = suppressed ? 0 : quantile(values, 0.75);
    let betterThan: number | null = null;
    if (!suppressed && mine !== undefined && metric.better !== 'context') {
      const worse = values.filter((v) => (metric.better === 'lower' ? v > mine : v < mine)).length;
      const ties = values.filter((v) => v === mine).length;
      betterThan = (worse + ties / 2) / values.length;
    }
    const top = metric.better === 'lower' ? p25 : p75;
    const worth = (target: number): number | null => {
      if (suppressed || mine === undefined) return null;
      switch (metric.id) {
        case 'labourPct':
          return Math.max(0, (mine - target) * you.sales);
        case 'overrunMinutesPerShift':
        case 'earlyStartMinutesPerShift':
          return Math.max(0, ((mine - target) * you.shifts * loadedRate) / 60);
        default:
          return null;
      }
    };
    return {
      metric,
      you: mine,
      peers: values.length,
      p25,
      median,
      p75,
      betterThan,
      valueAtMedian: worth(median),
      valueAtTopQuartile: worth(top),
      suppressed,
    };
  });
}
