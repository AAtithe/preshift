import { baselineForecast, mergeModelForecast, type BaselineResult } from '../src/engine/forecast';
import { siteHistory } from '../src/engine/history';
import { autoAdjustmentsFor, historyWeatherFactors, planAhead, unusualDays, type AutoAdjustment } from '../src/engine/plan';
import { addDays, weekDates, weekStart } from '../src/engine/time';
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
export function modelDates(org: OrgData, siteId: string, dates: string[], today: string): BaselineResult & { automatic: AutoAdjustment[] } {
  const state = org.state;
  const sorted = [...dates].sort();
  const plan = planAhead(state, siteId, sorted[0], sorted[sorted.length - 1], today);
  const automatic = autoAdjustmentsFor(plan, dates);
  const unusual = unusualDays(state, siteId);
  const effect = learnWeatherEffect(siteHistory(state.actuals ?? [], siteId), state.weather ?? [], siteId, unusual);
  const result = baselineForecast(state.actuals ?? [], siteId, dates, {
    adjustments: [...(state.forecastAdjustments ?? []), ...automatic],
    unusualDays: unusual,
    historyFactors: historyWeatherFactors(state, siteId, effect),
  });
  state.forecast = mergeModelForecast(state.forecast, result.rows);
  return { ...result, automatic };
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

/**
 * Brings one organisation up to date: weather for every site with a location,
 * every event feed, then the forecast for the rest of this week and next week
 * for sites with till history. One site or feed failing never stops the rest.
 */
export async function refreshOutside(ctx: AppContext, org: OrgData, today: string, actor: string, siteIds?: string[]): Promise<RefreshOutcome[]> {
  const out: RefreshOutcome[] = [];
  for (const site of org.state.sites.filter((s) => !siteIds || siteIds.includes(s.id))) {
    const r: RefreshOutcome = { siteId: site.id, errors: [] };
    if (siteLocation(site)) {
      try {
        const rows = await fetchWeather(ctx.fetch, ctx.feeds, site, today, backfillFrom(org, site.id, today));
        org.state.weather = mergeWeather(org.state.weather ?? [], rows);
        r.weatherDays = rows.length;
      } catch (e) {
        r.errors.push(`Weather: ${(e as Error).message}`);
      }
    }
    let events = 0;
    for (const feed of org.eventFeeds.filter((f) => f.siteId === site.id)) {
      try {
        const incoming = await fetchFeedEvents(ctx.fetch, ctx.feeds, feed, site, today);
        org.state.localEvents = mergeFeedEvents(org.state.localEvents ?? [], feed.id, incoming, today);
        feed.lastRefreshedAt = ctx.now().toISOString();
        feed.lastError = undefined;
        events += incoming.length;
      } catch (e) {
        feed.lastError = (e as Error).message;
        r.errors.push(`${feed.label}: ${feed.lastError}`);
      }
    }
    r.events = events;
    if ((org.state.actuals ?? []).some((a) => a.siteId === site.id)) {
      const ws = weekStart(today);
      const dates = [...weekDates(ws), ...weekDates(addDays(ws, 7))].filter((d) => d >= today);
      r.modelled = modelDates(org, site.id, dates, today).rows.length;
    }
    out.push(r);
  }
  audit(org, actor, 'outside.refreshed', { sites: out.map((o) => ({ siteId: o.siteId, errors: o.errors.length })) });
  return out;
}
