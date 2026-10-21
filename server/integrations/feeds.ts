import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { parseIcs } from '../../src/engine/events';
import { addDays } from '../../src/engine/time';
import type { DailyWeather, LocalEvent, Site } from '../../src/engine/types';

// Outside data the forecast uses: the weather from Open-Meteo, and local events
// from iCal feeds (stadiums, venues and councils publish these) or Ticketmaster.
// Every call is made through an injected fetch with a timeout and a size cap,
// so tests run on recorded responses and a slow provider cannot hang a request.

export type Fetch = typeof fetch;

export interface FeedConfig {
  /**
   * Open-Meteo's free API is for non-commercial use. A paying customer key moves calls to the
   * customer endpoints; set OPEN_METEO_API_KEY before charging clients for the product.
   */
  openMeteoKey?: string;
  /** Ticketmaster Discovery API key, for events near each site. */
  ticketmasterKey?: string;
}

/** A feed's address for showing to people: private calendar links carry secret tokens, so only the host is shown. */
export function maskFeedUrl(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    return `${new URL(raw).hostname}/…`;
  } catch {
    return undefined;
  }
}

export interface EventFeed {
  id: string;
  siteId: string;
  kind: 'ics' | 'ticketmaster';
  label: string;
  /** The iCal address, for an ics feed. */
  url?: string;
  /** Search radius around the site, for Ticketmaster. */
  radiusKm?: number;
  lastRefreshedAt?: string;
  lastError?: string;
}

export class FeedError extends Error {}

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2_000_000;

async function getText(f: Fetch, url: string): Promise<string> {
  let res: Response;
  try {
    res = await f(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
  } catch (e) {
    // Say why only when it is ours to say; never echo network detail that would map someone's network.
    throw e instanceof FeedError ? e : new FeedError('Could not reach the feed');
  }
  if (!res.ok) throw new FeedError(`${new URL(url).hostname} answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new FeedError('The feed is too large to read');
  return text;
}

/** Whether an address is anywhere but the public internet: loopback, private, link-local, shared, reserved, multicast. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b < 128) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b < 32) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    // An IPv4 address carried inside IPv6 (mapped, or NAT64) is judged as the IPv4 address it is.
    const embedded = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(x)?.[1];
    if (embedded) return isPrivateAddress(embedded);
    const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
    if (hex) {
      const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
      return isPrivateAddress([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x);
  }
  return true;
}

/**
 * Resolves a host and refuses it unless every address is public. Used as the
 * connection's own lookup, so the address checked is the address connected
 * to: a name that resolves differently a second time (DNS rebinding) cannot
 * slip through between the check and the fetch.
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as unknown as LookupAddress[];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      return callback(new FeedError('Feeds must be on the public internet'), '', 0);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

/**
 * The server's own fetch for outside data: https only, public addresses only
 * (checked at connection time), no redirects, a timeout, and a size cap read
 * as the body arrives rather than after.
 */
export const publicFetch: Fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.protocol !== 'https:') throw new FeedError('Feeds must use https');
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, { method: 'GET', lookup: guardedLookup, timeout: TIMEOUT_MS, headers: { 'user-agent': 'Preshift/1.0', accept: '*/*' } }, (res) => {
      const status = res.statusCode ?? 0;
      // No redirects: a public address must not be able to bounce the server inwards.
      if (status >= 300 && status < 400) {
        res.resume();
        return resolve(new Response(null, { status: 502 }));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) {
          req.destroy(new FeedError('The feed is too large to read'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status })));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new FeedError('The feed took too long to answer')));
    req.on('error', reject);
    init?.signal?.addEventListener('abort', () => req.destroy(new FeedError('The feed took too long to answer')));
    req.end();
  });
}) as Fetch;

/** Where the site is: its own location, or the centre of its clock-in geofence. */
export function siteLocation(site: Site): { lat: number; lng: number } | null {
  return site.location ?? (site.geofence ? { lat: site.geofence.lat, lng: site.geofence.lng } : null);
}

interface OpenMeteoDaily {
  daily?: { time: string[]; temperature_2m_max: (number | null)[]; temperature_2m_min: (number | null)[]; precipitation_sum: (number | null)[]; weather_code?: (number | null)[] };
  error?: boolean;
  reason?: string;
}

function rowsFrom(body: OpenMeteoDaily, siteId: string, today: string, fetchedAt: string, observed?: boolean): DailyWeather[] {
  if (body.error || !body.daily) throw new FeedError(`Open-Meteo: ${body.reason ?? 'no daily data'}`);
  const d = body.daily;
  const rows: DailyWeather[] = [];
  d.time.forEach((date, i) => {
    const tempMax = d.temperature_2m_max[i];
    const tempMin = d.temperature_2m_min[i];
    if (tempMax === null || tempMin === null) return;
    rows.push({
      siteId,
      date,
      tempMax,
      tempMin,
      precipitationMm: d.precipitation_sum[i] ?? 0,
      weatherCode: d.weather_code?.[i] ?? undefined,
      observed: observed ?? date < today,
      fetchedAt,
    });
  });
  return rows;
}

const DAILY = 'temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code';

/**
 * The next sixteen days and the last week for a site, plus a backfill of past
 * weather for the days the site has till history but no weather yet, so the
 * model can learn how this site trades in it.
 */
export async function fetchWeather(f: Fetch, cfg: FeedConfig, site: Site, today: string, backfillFrom?: string): Promise<DailyWeather[]> {
  const at = siteLocation(site);
  if (!at) throw new FeedError(`${site.name} has no location. Set it, or set a clock-in geofence.`);
  const fetchedAt = new Date().toISOString();
  const keyed = cfg.openMeteoKey ? `&apikey=${encodeURIComponent(cfg.openMeteoKey)}` : '';
  const host = cfg.openMeteoKey ? 'https://customer-api.open-meteo.com' : 'https://api.open-meteo.com';
  const archiveHost = cfg.openMeteoKey ? 'https://customer-archive-api.open-meteo.com' : 'https://archive-api.open-meteo.com';
  const where = `latitude=${at.lat.toFixed(4)}&longitude=${at.lng.toFixed(4)}&timezone=Europe%2FLondon&daily=${DAILY}`;
  const forecast = JSON.parse(await getText(f, `${host}/v1/forecast?${where}&past_days=7&forecast_days=16${keyed}`)) as OpenMeteoDaily;
  const rows = rowsFrom(forecast, site.id, today, fetchedAt);
  // The archive runs a few days behind; the forecast's past days cover the gap.
  const archiveTo = addDays(today, -6);
  if (backfillFrom && backfillFrom <= archiveTo) {
    const past = JSON.parse(await getText(f, `${archiveHost}/v1/archive?${where}&start_date=${backfillFrom}&end_date=${archiveTo}${keyed}`)) as OpenMeteoDaily;
    rows.push(...rowsFrom(past, site.id, today, fetchedAt, true));
  }
  return rows;
}

/**
 * Lays fresh weather over what is held: one row per site and day, the newest
 * fetch winning, except that a measured day is never replaced by a forecast.
 */
export function mergeWeather(existing: DailyWeather[], incoming: DailyWeather[]): DailyWeather[] {
  const key = (w: DailyWeather) => `${w.siteId}|${w.date}`;
  const out = new Map(existing.map((w) => [key(w), w]));
  for (const w of incoming) {
    const held = out.get(key(w));
    if (held?.observed && !w.observed) continue;
    out.set(key(w), w);
  }
  return [...out.values()].sort((a, b) => a.siteId.localeCompare(b.siteId) || a.date.localeCompare(b.date));
}

/**
 * Refuses addresses that would point the server at itself or a private
 * network: only public https hosts may be fetched. Redirects are refused at
 * fetch time too, so a public address cannot bounce inwards.
 */
export function checkFeedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.replace(/^webcal:/i, 'https:'));
  } catch {
    throw new FeedError('That is not a web address');
  }
  if (url.protocol !== 'https:') throw new FeedError('Feeds must use https');
  if (url.username || url.password) throw new FeedError('Feeds cannot carry a username or password');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const literal = isIP(host) !== 0;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local') || (literal && isPrivateAddress(host)) || (!literal && !host.includes('.'))) {
    throw new FeedError('Feeds must be on the public internet');
  }
  // Names are checked again, against what they resolve to, when the server connects (publicFetch).
  return url;
}

/** Events from one feed for one site, from roughly a year back to a year ahead. */
export async function fetchFeedEvents(f: Fetch, cfg: FeedConfig, feed: EventFeed, site: Site, today: string): Promise<LocalEvent[]> {
  const from = addDays(today, -400);
  const to = addDays(today, 365);
  if (feed.kind === 'ics') {
    if (!feed.url) throw new FeedError('No feed address');
    const text = await getText(f, checkFeedUrl(feed.url).toString());
    return parseIcs(text)
      .filter((e) => e.date >= from && e.date <= to)
      .map((e) => ({ id: `${feed.id}:${e.uid}`, siteId: site.id, feedId: feed.id, date: e.date, startMinute: e.startMinute, name: e.summary, venue: e.location, source: 'ics' as const }));
  }
  if (!cfg.ticketmasterKey) throw new FeedError('Ticketmaster is not set up for this deployment');
  const at = siteLocation(site);
  if (!at) throw new FeedError(`${site.name} has no location`);
  // Ticketmaster only lists what is on sale, so this looks forward; past events come from earlier refreshes.
  const url =
    `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${encodeURIComponent(cfg.ticketmasterKey)}` +
    `&latlong=${at.lat.toFixed(4)},${at.lng.toFixed(4)}&radius=${feed.radiusKm ?? 2}&unit=km&size=100&sort=date,asc` +
    `&startDateTime=${today}T00:00:00Z&endDateTime=${addDays(today, 90)}T23:59:59Z`;
  const body = JSON.parse(await getText(f, url)) as {
    _embedded?: { events?: { id: string; name: string; dates?: { start?: { localDate?: string; localTime?: string } }; _embedded?: { venues?: { name?: string }[] } }[] };
  };
  return (body._embedded?.events ?? [])
    .filter((e) => e.dates?.start?.localDate)
    .map((e) => {
      const time = e.dates!.start!.localTime;
      const [hh, mm] = (time ?? '').split(':').map(Number);
      return {
        id: `${feed.id}:${e.id}`,
        siteId: site.id,
        feedId: feed.id,
        date: e.dates!.start!.localDate!,
        startMinute: time ? hh * 60 + (mm || 0) : undefined,
        name: e.name,
        venue: e._embedded?.venues?.[0]?.name,
        source: 'ticketmaster' as const,
      };
    });
}

/**
 * Replaces a feed's events from today on with what the feed says now, and
 * keeps its past events: they are the history the model learns the feed's
 * effect from, even after the feed stops listing them.
 */
export function mergeFeedEvents(existing: LocalEvent[], feedId: string, incoming: LocalEvent[], today: string): LocalEvent[] {
  const ids = new Set(incoming.map((e) => e.id));
  const kept = existing.filter((e) => e.feedId !== feedId || (e.date < today && !ids.has(e.id)));
  return [...kept, ...incoming];
}
