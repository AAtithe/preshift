import { estimateMinutes, haversineKm, siteLocation } from '../../../src/engine/travel';
import type { Site, SiteLocation, SiteTravel } from '../../../src/engine/types';

export type Fetch = typeof fetch;

/** Modes a hospitality worker would use between London sites: no cabs, no cycle hire. */
const MODES = 'walking,tube,bus,overground,elizabeth-line,dlr,national-rail,tram';
/** Journeys are planned for a weekday at 17:00, the usual changeover between a lunch and an evening shift. */
const PLAN_TIME = '1700';

/** Looks a UK postcode up on postcodes.io. Returns null when it does not exist. */
export async function geocodePostcode(postcode: string, fetchImpl: Fetch): Promise<SiteLocation | null> {
  const clean = postcode.replace(/\s+/g, '').toUpperCase();
  const res = await fetchImpl(`https://api.postcodes.io/postcodes/${encodeURIComponent(clean)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Postcode lookup failed (${res.status})`);
  const body = (await res.json()) as { result?: { latitude: number; longitude: number; postcode: string } };
  if (!body.result) return null;
  return { lat: body.result.latitude, lng: body.result.longitude, postcode: body.result.postcode };
}

/** The next weekday from a date, as TfL's yyyyMMdd, so a weekend refresh still plans a working day. */
export function nextWeekday(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** The quickest public transport or walking journey TfL plans between two points. */
export async function tflJourney(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  fetchImpl: Fetch,
  date: string,
  appKey?: string,
): Promise<{ minutes: number; mode: string } | null> {
  const point = (p: { lat: number; lng: number }) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  const params = new URLSearchParams({ mode: MODES, timeIs: 'Departing', time: PLAN_TIME, date: nextWeekday(date) });
  if (appKey) params.set('app_key', appKey);
  const res = await fetchImpl(`https://api.tfl.gov.uk/Journey/JourneyResults/${point(from)}/to/${point(to)}?${params}`);
  if (!res.ok) throw new Error(`TfL journey planner failed (${res.status})`);
  const body = (await res.json()) as { journeys?: { duration: number; legs: { mode: { name: string } }[] }[] };
  const best = (body.journeys ?? []).sort((a, b) => a.duration - b.duration)[0];
  if (!best) return null;
  const modes = [...new Set(best.legs.map((l) => l.mode.name).filter((m) => m !== 'walking'))];
  return { minutes: best.duration, mode: modes.length ? modes.join(', ') : 'walking' };
}

/**
 * Fills in journey times between every pair of located sites, each way round. Times set by hand
 * are kept. TfL is asked first; if it cannot be reached or has no journey, a straight-line
 * estimate is stored and labelled as one, so the rota still checks moves between sites.
 */
export async function refreshTravel(sites: Site[], fetchImpl: Fetch, today: string, appKey?: string) {
  const located = sites.filter((s) => siteLocation(s));
  let fromTfl = 0;
  let estimated = 0;
  const failures: string[] = [];
  const updated: Site[] = [];
  for (const site of sites) {
    const travel: Record<string, SiteTravel> = { ...(site.travel ?? {}) };
    const from = siteLocation(site);
    for (const other of located) {
      if (other.id === site.id || !from) continue;
      if (travel[other.id]?.source === 'manual') continue;
      const to = siteLocation(other)!;
      try {
        const journey = await tflJourney(from, to, fetchImpl, today, appKey);
        if (journey) {
          travel[other.id] = { minutes: journey.minutes, source: 'tfl', mode: journey.mode, checkedAt: today };
          fromTfl++;
          continue;
        }
      } catch (e) {
        failures.push(`${site.name} to ${other.name}: ${(e as Error).message}`);
      }
      travel[other.id] = { minutes: estimateMinutes(haversineKm(from, to)), source: 'estimate', checkedAt: today };
      estimated++;
    }
    updated.push(Object.keys(travel).length ? { ...site, travel } : site);
  }
  return { sites: updated, fromTfl, estimated, failures };
}

/** How long a planned journey is trusted before the daily check plans it again. */
export const TFL_REFRESH_DAYS = 30;
/** An estimate stands in for TfL only until the next daily check can reach it. */
const ESTIMATE_REFRESH_DAYS = 1;

/**
 * Whether any journey between located sites is missing or due to be planned again: TfL times
 * after a month, as timetables and routes change, and estimates after a day. Times set by hand
 * are never due.
 */
export function travelIsStale(sites: Site[], today: string): boolean {
  const located = sites.filter((s) => siteLocation(s));
  const age = (from: string) => (Date.parse(today) - Date.parse(from)) / 86_400_000;
  return located.some((site) =>
    located.some((other) => {
      if (other.id === site.id) return false;
      const held = site.travel?.[other.id];
      if (!held) return true;
      if (held.source === 'manual') return false;
      return age(held.checkedAt) >= (held.source === 'tfl' ? TFL_REFRESH_DAYS : ESTIMATE_REFRESH_DAYS);
    }),
  );
}
