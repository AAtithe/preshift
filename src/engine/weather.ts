import type { DailyWeather } from './types';
import { addDays } from './time';
import { normalSales, type SiteHistory } from './history';

// How the weather moves a site's trade, learnt from the site's own history:
// a terrace in Shoreditch and a basement in Fitzrovia react very differently
// to a hot Saturday, so no national rule of thumb is used. Until there is
// enough history to learn from, the weather is shown but nothing is adjusted.

export interface WeatherEffect {
  /** Change in trade per degree warmer than normal for the time of year. */
  perDegree: number;
  /** Change in trade on a wet day (2mm or more). */
  wet: number;
  /** Days learnt from. */
  days: number;
  /** Whether there was enough history to trust it. */
  usable: boolean;
}

export const WET_MM = 2;
export const MIN_DAYS = 28;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Normal top temperature for the time of year: measured days within a
 * fortnight either side of the date in earlier years where there are enough,
 * so a heatwave does not raise its own normal; otherwise measured days around
 * the date this year.
 */
export function seasonalTemp(weather: DailyWeather[], date: string): number | null {
  const measured = weather.filter((w) => w.observed);
  const md = (d: string) => Number(d.slice(5, 7)) * 31 + Number(d.slice(8, 10));
  const target = md(date);
  const year = date.slice(0, 4);
  const near = (d: string) => Math.min(Math.abs(md(d) - target), 403 - Math.abs(md(d) - target)) <= 15;
  const earlier = measured.filter((w) => w.date.slice(0, 4) < year && near(w.date));
  const pool = earlier.length >= 20 ? earlier : measured.filter((w) => w.date >= addDays(date, -15) && w.date <= addDays(date, 15));
  return pool.length >= 7 ? pool.reduce((s, w) => s + w.tempMax, 0) / pool.length : null;
}

/** Solves a 3x3 linear system by Cramer's rule; null if it is singular. */
function solve3(m: number[][], v: number[]): number[] | null {
  const det = (a: number[][]) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det(m);
  if (Math.abs(d) < 1e-9) return null;
  return [0, 1, 2].map((c) => det(m.map((row, r) => row.map((x, k) => (k === c ? v[r] : x)))) / d);
}

/**
 * Fits the site's sales against a normal day on two things: how much warmer
 * than normal the day was, and whether it rained. Days that were unusual for
 * other reasons (occasions, events, closures) are left out. The fitted effects
 * are capped so one freak week cannot run away with the forecast.
 */
export function learnWeatherEffect(h: SiteHistory, weather: DailyWeather[], siteId: string, unusual: Set<string>): WeatherEffect {
  const mine = weather.filter((w) => w.siteId === siteId);
  const observed = mine.filter((w) => w.observed);
  const rows: { x1: number; x2: number; y: number }[] = [];
  for (const w of observed) {
    if (unusual.has(w.date) || !h.days.has(w.date)) continue;
    const normal = normalSales(h, w.date, unusual);
    const seasonal = seasonalTemp(mine, w.date);
    if (!normal || seasonal === null) continue;
    rows.push({ x1: w.tempMax - seasonal, x2: w.precipitationMm >= WET_MM ? 1 : 0, y: (h.days.get(w.date)! / normal) - 1 });
  }
  const none = { perDegree: 0, wet: 0, days: rows.length, usable: false };
  if (rows.length < MIN_DAYS) return none;
  // Least squares for y = c + a*x1 + b*x2; the constant soaks up any general drift and is not used.
  const s = (f: (r: (typeof rows)[number]) => number) => rows.reduce((t, r) => t + f(r), 0);
  const n = rows.length;
  const m = [
    [n, s((r) => r.x1), s((r) => r.x2)],
    [s((r) => r.x1), s((r) => r.x1 * r.x1), s((r) => r.x1 * r.x2)],
    [s((r) => r.x2), s((r) => r.x1 * r.x2), s((r) => r.x2 * r.x2)],
  ];
  const v = [s((r) => r.y), s((r) => r.x1 * r.y), s((r) => r.x2 * r.y)];
  const fit = solve3(m, v);
  if (!fit) return none;
  return { perDegree: clamp(fit[1], -0.03, 0.03), wet: clamp(fit[2], -0.25, 0.25), days: n, usable: true };
}

/** What the weather on a day does to its trade, from the learnt effect. 1 means no change. */
export function weatherFactor(effect: WeatherEffect, day: DailyWeather, seasonal: number | null): number {
  if (!effect.usable) return 1;
  const warm = seasonal === null ? 0 : day.tempMax - seasonal;
  const wet = day.precipitationMm >= WET_MM ? 1 : 0;
  return clamp(1 + effect.perDegree * warm + effect.wet * wet, 0.7, 1.3);
}

/** Plain words for a day's weather, without icons. */
export function describeWeather(day: DailyWeather): string {
  const rain = day.precipitationMm >= 10 ? 'heavy rain' : day.precipitationMm >= WET_MM ? 'rain' : day.precipitationMm > 0 ? 'showers possible' : 'dry';
  return `${Math.round(day.tempMax)}°C, ${rain}`;
}
