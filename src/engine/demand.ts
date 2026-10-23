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

/** Latest closing time set-up accepts: four in the morning, after a late licence. */
export const LATEST_CLOSE = 28 * 60;

/**
 * Hours in a site's trading day. A site closing at 02:00 trades to hour 26: hours 24 and 25 are the
 * next calendar date's 00:00 and 01:00, still the evening that began the day before.
 */
export const tradingDayHours = (site: Pick<Site, 'closeMinute'>) => Math.max(24, Math.ceil(site.closeMinute / 60));

/** Where an hour of the trading day is stored: forecast rows are by calendar date and hour 0 to 23. */
export const calendarHour = (date: string, hour: number) => (hour < 24 ? { date, hour } : { date: addDays(date, 1), hour: hour - 24 });

/**
 * The trading day and hour a stored forecast row belongs to: 01:00 on Saturday is hour 25 of Friday
 * at a site still open from Friday night. Every other row is its own date.
 */
export function tradingHour(site: Pick<Site, 'openMinute' | 'closeMinute'>, date: string, hour: number) {
  return hour * 60 + 1440 < site.closeMinute && hour * 60 < site.openMinute ? { date: addDays(date, -1), hour: hour + 24 } : { date, hour };
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
  // A closure set on the forecast closes the floor too, so nobody is rostered to a shut site.
  const closures = (state.forecastAdjustments ?? []).filter((a) => a.siteId === siteId && a.date === date && a.factor === 0);
  const closed = (hour: number) => closures.some((a) => (a.fromHour === undefined || hour >= a.fromHour) && (a.toHour === undefined || hour < a.toHour));
  // Past midnight the trading day reads the next calendar date's early hours.
  const next = addDays(date, 1);
  const late = tradingDayHours(site) > 24 ? state.forecast.filter((f) => f.date === next && f.siteId === siteId) : [];
  const lateClosures = (state.forecastAdjustments ?? []).filter((a) => a.siteId === siteId && a.date === next && a.factor === 0);
  const closedLate = (hour: number) => lateClosures.some((a) => (a.fromHour === undefined || hour >= a.fromHour) && (a.toHour === undefined || hour < a.toHour));
  return Array.from({ length: tradingDayHours(site) }, (_, hour) => {
    const f = hour < 24 ? forecast.get(hour) : late.find((x) => x.hour === hour - 24);
    const shut = hour < 24 ? closed(hour) : closedLate(hour - 24);
    const required = shut ? 0 : requiredHeadcount(rule, site, f, hour);
    const scheduled = hour < 24 ? headcountAt(state.shifts, date, hour, roleId, siteId) : headcountAt(state.shifts, next, hour - 24, roleId, siteId);
    // Early hours that belong to the night before are shown, and counted, under that night.
    const own = hour >= 24 || tradingHour(site, date, hour).date === date;
    return { hour, sales: own ? f?.sales ?? 0 : 0, covers: own ? f?.covers ?? 0 : 0, required, scheduled, gap: required - scheduled };
  });
}

export function forecastSalesForDay(state: RotaState, siteId: string, date: string): number {
  return state.forecast
    .filter((f) => f.date === date && f.siteId === siteId)
    .reduce((sum, f) => sum + f.sales, 0);
}
