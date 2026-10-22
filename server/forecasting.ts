import { bookingAdjustments, clipAround, compactBookings, type BookingAdjustment } from '../src/engine/bookings';
import { baselineForecast, mergeModelForecast, type BaselineResult } from '../src/engine/forecast';
import { siteHistory } from '../src/engine/history';
import { autoAdjustmentsFor, historyWeatherFactors, planAhead, unusualDays, type AutoAdjustment } from '../src/engine/plan';
import { addDays, weekDates, weekStart } from '../src/engine/time';
import type { DailyWeather, LocalEvent } from '../src/engine/types';
import { learnWeatherEffect } from '../src/engine/weather';
import type { AppContext } from './context';
import { fetchFeedEvents, fetchWeather, mergeFeedEvents, mergeWeather, siteLocation, type FeedConfig } from './integrations/feeds';
import { audit, type OrgData } from './store';

/**
 * Runs the forecast model for some of a site's dates with everything it knows:
 * the site's own history with unusual days left out and the weather taken out,
 * then the occasions, local events and weather ahead applied automatically.
 * People's own adjustments win, and hours someone overrode keep their figure.
 */
export function modelDates(org: OrgData, siteId: string, dates: string[], today: string): BaselineResult & { automatic: AutoAdjustment[]; bookings: BookingAdjustment[] } {
  const state = org.state;
  const sorted = [...dates].sort();
  const plan = planAhead(state, siteId, sorted[0], sorted[sorted.length - 1], today);
  const unusual = unusualDays(state, siteId);
  const effect = learnWeatherEffect(siteHistory(state.actuals ?? [], siteId), state.weather ?? [], siteId, unusual);
  const people = (state.forecastAdjustments ?? []).filter((a) => a.siteId === siteId);
  const options = { unusualDays: unusual, historyFactors: historyWeatherFactors(state, siteId, effect) };
  // First pass: the model's own covers with only people's adjustments, the base the bookings are set against.
  // Nothing from it is kept.
  const base = baselineForecast(state.actuals ?? [], siteId, dates, { ...options, adjustments: state.forecastAdjustments ?? [] });
  const bookings = bookingAdjustments(plan.bookingSignals.filter((s) => dates.includes(s.date)), base.rows, people, siteId);
  // Second pass: the bookings speak for their hours, so other automatic effects keep only the hours they do not.
  const automatic = clipAround(autoAdjustmentsFor(plan, dates), bookings);
  const result = baselineForecast(state.actuals ?? [], siteId, dates, { ...options, adjustments: [...(state.forecastAdjustments ?? []), ...automatic, ...bookings] });
  state.forecast = mergeModelForecast(state.forecast, result.rows);
  return { ...result, automatic, bookings };
}

export const feedConfig = (env: NodeJS.ProcessEnv): FeedConfig => ({
  openMeteoKey: env.OPEN_METEO_API_KEY || undefined,
  ticketmasterKey: env.TICKETMASTER_API_KEY || undefined,
});

export interface RefreshOutcome {
  siteId: string;
  weatherDays?: number;
  events?: number;
  modelled?: number;
  errors: string[];
}

/** The first day of till history with no measured weather, so the backfill only asks for what is missing. */
function backfillFrom(org: OrgData, siteId: string, today: string): string | undefined {
  const measured = new Set((org.state.weather ?? []).filter((w) => w.siteId === siteId && w.observed).map((w) => w.date));
  const limit = addDays(today, -400);
  const missing = (org.state.actuals ?? []).filter((a) => a.siteId === siteId && a.date >= limit && !measured.has(a.date)).map((a) => a.date).sort();
  return missing[0];
}

/** What was fetched for an organisation, kept apart from it so it can be laid over a fresh copy. */
export interface Fetched {
  weather: Map<string, DailyWeather[]>;
  events: Map<string, LocalEvent[]>;
  feedErrors: Map<string, string>;
  weatherErrors: Map<string, string>;
  siteIds: string[];
  at: string;
}

/** Fetches the weather for every site with a location and every event feed. Changes nothing. */
export async function fetchOutside(ctx: AppContext, org: OrgData, today: string, siteIds?: string[]): Promise<Fetched> {
  const sites = org.state.sites.filter((s) => !siteIds || siteIds.includes(s.id));
  const out: Fetched = { weather: new Map(), events: new Map(), feedErrors: new Map(), weatherErrors: new Map(), siteIds: sites.map((s) => s.id), at: ctx.now().toISOString() };
  for (const site of sites) {
    if (siteLocation(site)) {
      try {
        out.weather.set(site.id, await fetchWeather(ctx.fetch, ctx.feeds, site, today, backfillFrom(org, site.id, today)));
      } catch (e) {
        out.weatherErrors.set(site.id, (e as Error).message);
      }
    }
    for (const feed of org.eventFeeds.filter((f) => f.siteId === site.id)) {
      try {
        out.events.set(feed.id, await fetchFeedEvents(ctx.fetch, ctx.feeds, feed, site, today));
      } catch (e) {
        out.feedErrors.set(feed.id, (e as Error).message);
      }
    }
  }
  return out;
}

/**
 * Lays fetched results over an organisation with the same merges a refresh
 * uses, then refreshes the forecast ahead. Safe to run on a fresh copy after
 * a conflicting save: it only adds what was fetched, so nobody's change is lost.
 */
export function applyOutside(org: OrgData, fetched: Fetched, today: string, actor: string): RefreshOutcome[] {
  const out: RefreshOutcome[] = [];
  // Yesterday's bookings become pace history, so booking detail is kept for a day or two at most.
  const compacted = compactBookings(org.state.bookings ?? [], org.state.bookingPace ?? [], today);
  org.state.bookings = compacted.bookings;
  org.state.bookingPace = compacted.pace;
  for (const siteId of fetched.siteIds) {
    if (!org.state.sites.some((s) => s.id === siteId)) continue;
    const r: RefreshOutcome = { siteId, errors: [] };
    const rows = fetched.weather.get(siteId);
    if (rows) {
      org.state.weather = mergeWeather(org.state.weather ?? [], rows);
      r.weatherDays = rows.length;
    }
    const werr = fetched.weatherErrors.get(siteId);
    if (werr) r.errors.push(`Weather: ${werr}`);
    let events = 0;
    for (const feed of org.eventFeeds.filter((f) => f.siteId === siteId)) {
      const incoming = fetched.events.get(feed.id);
      const err = fetched.feedErrors.get(feed.id);
      if (incoming) {
        org.state.localEvents = mergeFeedEvents(org.state.localEvents ?? [], feed.id, incoming, today);
        feed.lastRefreshedAt = fetched.at;
        feed.lastError = undefined;
        events += incoming.length;
      } else if (err) {
        feed.lastError = err;
        r.errors.push(`${feed.label}: ${err}`);
      }
    }
    r.events = events;
    if ((org.state.actuals ?? []).some((a) => a.siteId === siteId)) {
      const ws = weekStart(today);
      const dates = [...weekDates(ws), ...weekDates(addDays(ws, 7))].filter((d) => d >= today);
      r.modelled = modelDates(org, siteId, dates, today).rows.length;
    }
    out.push(r);
  }
  audit(org, actor, 'outside.refreshed', { sites: out.map((o) => ({ siteId: o.siteId, errors: o.errors.length })) });
  return out;
}

/**
 * Brings one organisation up to date: weather for every site with a location,
 * every event feed, then the forecast for the rest of this week and next week
 * for sites with till history. One site or feed failing never stops the rest.
 */
export async function refreshOutside(ctx: AppContext, org: OrgData, today: string, actor: string, siteIds?: string[]): Promise<RefreshOutcome[]> {
  return applyOutside(org, await fetchOutside(ctx, org, today, siteIds), today, actor);
}
