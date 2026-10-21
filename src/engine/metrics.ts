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
