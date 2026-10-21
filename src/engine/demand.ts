import type { DemandRule, HourForecast, RotaState, Shift, Site } from './types';
import { addDays } from './time';

export interface HourDemand {
  hour: number;
  sales: number;
  covers: number;
  required: number;
  scheduled: number;
  gap: number; // positive = short, negative = over
}

export function isOpenHour(site: Site, hour: number): boolean {
  const start = hour * 60;
  return start >= site.openMinute && start < site.closeMinute;
}

export function requiredHeadcount(rule: DemandRule, site: Site, f: HourForecast | undefined, hour: number): number {
  if (!isOpenHour(site, hour)) return 0;
  const sales = f?.sales ?? 0;
  const covers = f?.covers ?? 0;
  const bySales = rule.salesPerLabourHour ? Math.ceil(sales / rule.salesPerLabourHour) : 0;
  const byCovers = rule.coversPerHour ? Math.ceil(covers / rule.coversPerHour) : 0;
  return Math.min(rule.maximum, Math.max(rule.minimumWhileOpen, bySales, byCovers));
}

/** People on shift for a given clock hour, counting shifts that ran over from the night before. */
export function headcountAt(shifts: Shift[], date: string, hour: number, roleId: string, siteId: string): number {
  const from = hour * 60;
  const to = from + 60;
  const yesterday = addDays(date, -1);
  return shifts.filter((s) => {
    if (s.roleId !== roleId || s.siteId !== siteId) return false;
    if (s.date === date) return s.startMinute < to && s.endMinute > from;
    if (s.date === yesterday) return s.endMinute - 1440 > from;
    return false;
  }).length;
}

export function dayDemand(state: RotaState, siteId: string, roleId: string, date: string): HourDemand[] {
  const site = state.sites.find((s) => s.id === siteId);
  const rule = state.demandRules.find((r) => r.siteId === siteId && r.roleId === roleId);
  if (!site || !rule) return [];
  const forecast = new Map(
    state.forecast.filter((f) => f.date === date && f.siteId === siteId).map((f) => [f.hour, f]),
  );
  return Array.from({ length: 24 }, (_, hour) => {
    const f = forecast.get(hour);
    const required = requiredHeadcount(rule, site, f, hour);
    const scheduled = headcountAt(state.shifts, date, hour, roleId, siteId);
    return { hour, sales: f?.sales ?? 0, covers: f?.covers ?? 0, required, scheduled, gap: required - scheduled };
  });
}

export function forecastSalesForDay(state: RotaState, siteId: string, date: string): number {
  return state.forecast
    .filter((f) => f.date === date && f.siteId === siteId)
    .reduce((sum, f) => sum + f.sales, 0);
}
