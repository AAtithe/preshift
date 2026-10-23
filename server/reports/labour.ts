import { weekMetrics } from '../../src/engine/metrics';
import { salesEstimate } from '../../src/engine/reports';
import { weekDates } from '../../src/engine/time';
import type { RotaState } from '../../src/engine/types';

/** One site's week for the labour dataset: sales on takings where recorded, rota labour, target and hours. */
export interface SiteWeek {
  week: string;
  siteId: string;
  forecastSales: number;
  sales: number;
  labourCost: number;
  targetCost: number;
  paidHours: number;
}

/** Each site's figures for each week given. Weeks with neither shifts nor sales are left out. */
export function metricsFor(state: RotaState, weeks: string[], _today: string): SiteWeek[] {
  const out: SiteWeek[] = [];
  for (const week of weeks) {
    const dates = weekDates(week);
    for (const site of state.sites) {
      const busy = state.shifts.some((s) => s.siteId === site.id && dates.includes(s.date)) || (state.sales ?? []).some((s) => s.siteId === site.id && dates.includes(s.date));
      if (!busy) continue;
      const m = weekMetrics(state, site.id, week);
      const sales = salesEstimate(state, site.id, dates).estimate;
      out.push({ week, siteId: site.id, forecastSales: m.forecastSales, sales, labourCost: m.labourCost, targetCost: sales * site.labourTargetPct, paidHours: m.paidHours });
    }
  }
  return out;
}
