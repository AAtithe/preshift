import type { RotaState } from './types';
import { shiftPaidHours, weekCost, type WeekCost } from './cost';
import { forecastSalesForDay } from './demand';
import { weekDates } from './time';

export interface DayMetrics {
  date: string;
  forecastSales: number;
  labourCost: number;
  paidHours: number;
  labourPct: number;
  splh: number;
}

export interface WeekMetrics {
  days: DayMetrics[];
  forecastSales: number;
  labourCost: number;
  paidHours: number;
  labourPct: number;
  splh: number;
  targetPct: number;
  /** Labour spend that keeps the week on target. */
  targetCost: number;
  /** Positive = over target. */
  varianceToTarget: number;
  cost: WeekCost;
}

const pct = (num: number, den: number) => (den > 0 ? num / den : 0);

export function weekMetrics(state: RotaState, siteId: string, start: string): WeekMetrics {
  const site = state.sites.find((s) => s.id === siteId);
  const cost = weekCost(state, start, siteId);
  const dates = weekDates(start);
  // People paid but not rostered still cost money; spread them evenly over the week.
  const dailyUnallocated = cost.unallocated / 7;

  const days = dates.map((date) => {
    const dayShifts = state.shifts.filter((s) => s.siteId === siteId && s.date === date);
    const labourCost =
      dayShifts.reduce((sum, s) => sum + (cost.shifts.get(s.id)?.total ?? 0), 0) + dailyUnallocated;
    const paidHours = dayShifts.reduce((sum, s) => sum + shiftPaidHours(s), 0);
    const forecastSales = forecastSalesForDay(state, siteId, date);
    return {
      date,
      forecastSales,
      labourCost,
      paidHours,
      labourPct: pct(labourCost, forecastSales),
      splh: pct(forecastSales, paidHours),
    };
  });

  const forecastSales = days.reduce((s, d) => s + d.forecastSales, 0);
  const labourCost = days.reduce((s, d) => s + d.labourCost, 0);
  const paidHours = days.reduce((s, d) => s + d.paidHours, 0);
  const targetPct = site?.labourTargetPct ?? 0;
  const targetCost = forecastSales * targetPct;
  return {
    days,
    forecastSales,
    labourCost,
    paidHours,
    labourPct: pct(labourCost, forecastSales),
    splh: pct(forecastSales, paidHours),
    targetPct,
    targetCost,
    varianceToTarget: labourCost - targetCost,
    cost,
  };
}

export interface SiteWeekMetrics extends WeekMetrics {
  siteId: string;
}

export interface ScopeMetrics extends WeekMetrics {
  sites: SiteWeekMetrics[];
}

/**
 * Consolidates any set of sites: an entity, the whole group, or one site. Each
 * site is costed on its own (so a person who works two sites is split by hours)
 * and the totals are summed, which means the scope reconciles to its sites. The
 * consolidated target is the sum of each site's target spend, not an average
 * of percentages, so a big site weighs more than a small one.
 */
export function scopeMetrics(state: RotaState, siteIds: string[], start: string): ScopeMetrics {
  const sites = siteIds.map((siteId) => ({ siteId, ...weekMetrics(state, siteId, start) }));
  const days = weekDates(start).map((date, i) => {
    const forecastSales = sites.reduce((s, m) => s + m.days[i].forecastSales, 0);
    const labourCost = sites.reduce((s, m) => s + m.days[i].labourCost, 0);
    const paidHours = sites.reduce((s, m) => s + m.days[i].paidHours, 0);
    return { date, forecastSales, labourCost, paidHours, labourPct: pct(labourCost, forecastSales), splh: pct(forecastSales, paidHours) };
  });
  const cost: WeekCost = {
    employees: new Map(),
    shifts: new Map(),
    total: 0,
    unallocated: 0,
    parts: { gross: 0, holiday: 0, employerNi: 0, pension: 0 },
    travel: { hours: 0, cost: 0 },
  };
  for (const m of sites) {
    m.cost.employees.forEach((v, k) => cost.employees.set(k, v));
    m.cost.shifts.forEach((v, k) => cost.shifts.set(k, v));
    cost.total += m.cost.total;
    cost.unallocated += m.cost.unallocated;
    // Each site's parts are already scoped to it, so they sum to the scope without double counting.
    cost.parts.gross += m.cost.parts.gross;
    cost.parts.holiday += m.cost.parts.holiday;
    cost.parts.employerNi += m.cost.parts.employerNi;
    cost.parts.pension += m.cost.parts.pension;
    cost.travel.hours += m.cost.travel.hours;
    cost.travel.cost += m.cost.travel.cost;
  }
  const forecastSales = sites.reduce((s, m) => s + m.forecastSales, 0);
  const labourCost = sites.reduce((s, m) => s + m.labourCost, 0);
  const paidHours = sites.reduce((s, m) => s + m.paidHours, 0);
  const targetCost = sites.reduce((s, m) => s + m.targetCost, 0);
  return {
    sites,
    days,
    forecastSales,
    labourCost,
    paidHours,
    labourPct: pct(labourCost, forecastSales),
    splh: pct(forecastSales, paidHours),
    // Sales-weighted across sites; with no forecast there is nothing to weight by, so the sites' own
    // targets stand rather than reading as 0%.
    targetPct: forecastSales > 0 ? pct(targetCost, forecastSales) : sites.reduce((s, m) => s + m.targetPct, 0) / (sites.length || 1),
    targetCost,
    varianceToTarget: labourCost - targetCost,
    cost,
  };
}
