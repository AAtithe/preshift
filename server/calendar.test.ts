import { describe, expect, it } from 'vitest';
import { addDays } from '../src/engine/time';
import { buildApp } from './app';
import { checkFeedUrl, isPrivateAddress, mergeWeather, publicFetch } from './integrations/feeds';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

const TODAY = '2026-10-21';
const KEYS = [{ key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*' as const] }];

/** What Open-Meteo answers, in its own shape: hot and dry on the 24th, wet on the 25th. */
function openMeteo(from: string, days: number) {
  const time = Array.from({ length: days }, (_, i) => addDays(from, i));
  return {
    daily: {
      time,
      temperature_2m_max: time.map((d) => (d === '2026-10-24' ? 24 : 14)),
      temperature_2m_min: time.map(() => 8),
      precipitation_sum: time.map((d) => (d === '2026-10-25' ? 12 : 0)),
      weather_code: time.map(() => 1),
    },
  };
}

const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT', 'UID:g1', 'DTSTART:20261031T150000Z', 'SUMMARY:Home v Rovers', 'LOCATION:The Ground', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:g0', 'DTSTART:20260919T140000Z', 'SUMMARY:Home v Town', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function recorded(calls: string[]) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/v1/forecast')) return json(openMeteo(addDays(TODAY, -7), 23));
    if (url.includes('/v1/archive')) {
      const start = new URL(url).searchParams.get('start_date')!;
      const end = new URL(url).searchParams.get('end_date')!;
      let n = 0;
      for (let d = start; d <= end; d = addDays(d, 1)) n++;
      return json(openMeteo(start, n));
    }
    if (url.startsWith('https://fixtures.example/club.ics')) return new Response(ICS, { status: 200 });
    if (url.startsWith('https://broken.example/')) return new Response('nope', { status: 500 });
    throw new Error(`Unexpected call to ${url}`);
  }) as typeof fetch;
}

async function setup(env: NodeJS.ProcessEnv = {}) {
  const calls: string[] = [];
  const store = new MemoryStore(['demo'], TODAY);
  const { app } = await buildApp({ apiKeys: KEYS, store, provider: new TeamPaySimulator(), autoDispatch: false, now: () => new Date(`${TODAY}T07:00:00Z`), fetch: recorded(calls), env });
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = { authorization: 'Bearer admin' }) => {
    const res = await app.inject({ method: method as 'GET', url, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  return { call, calls, store };
}

describe('weather and events, end to end', () => {
  it('fetches the weather and the feeds, backfills history, and refreshes the forecast ahead', async () => {
    const { call, calls, store } = await setup();
    expect((await call('PUT', '/v1/sites/mar/location', { lat: 51.5205, lng: -0.1545 })).status).toBe(200);
    const feed = await call('POST', '/v1/event-feeds', { siteId: 'mar', kind: 'ics', label: 'The club', url: 'webcal://fixtures.example/club.ics' });
    expect(feed.status).toBe(201);
    expect(feed.body.url).toBe('fixtures.example/…');
    expect((await store.load('demo')).eventFeeds[0].url).toBe('https://fixtures.example/club.ics');

    const res = await call('POST', '/v1/outside/refresh', { siteIds: ['mar'] });
    expect(res.status).toBe(200);
    const [mar] = res.body.sites;
    expect(mar.errors).toEqual([]);
    expect(mar.weatherDays).toBeGreaterThan(23);
    expect(mar.events).toBe(2);
    expect(mar.modelled).toBeGreaterThan(0);
    // The backfill asked only for the past the till covers, up to where the archive reaches.
    const archive = new URL(calls.find((c) => c.includes('/v1/archive'))!);
    expect(archive.searchParams.get('end_date')).toBe(addDays(TODAY, -6));
    expect(archive.searchParams.get('latitude')).toBe('51.5205');

    const org = await store.load('demo');
    expect(org.state.weather!.find((w) => w.siteId === 'mar' && w.date === '2026-10-20')!.observed).toBe(true);
    expect(org.state.weather!.find((w) => w.siteId === 'mar' && w.date === '2026-10-24')!.observed).toBe(false);
    expect(org.state.localEvents!.map((e) => e.name).sort()).toEqual(['Home v Rovers', 'Home v Town']);
    expect(org.eventFeeds[0].lastRefreshedAt).toBeDefined();

    const cal = await call('GET', '/v1/calendar?siteId=mar');
    const day = (d: string) => cal.body.days.find((x: { date: string }) => x.date === d);
    expect(day('2026-10-31').events[0]).toMatchObject({ name: 'Home v Rovers', startMinute: 15 * 60 });
    expect(day('2026-10-24').weatherText).toBe('24°C, dry');
    expect(day('2026-12-25').occasions.map((o: { key: string }) => o.key)).toContain('bh-christmas-day');
  });

  it('keeps going when one feed fails, and says which', async () => {
    const { call } = await setup();
    await call('POST', '/v1/event-feeds', { siteId: 'mar', kind: 'ics', label: 'Broken venue', url: 'https://broken.example/x.ics' });
    await call('POST', '/v1/event-feeds', { siteId: 'mar', kind: 'ics', label: 'The club', url: 'https://fixtures.example/club.ics' });
    const res = await call('POST', '/v1/outside/refresh', { siteIds: ['mar'] });
    const [mar] = res.body.sites;
    expect(mar.events).toBe(2);
    expect(mar.errors).toEqual(['Broken venue: broken.example answered 500']);
    const feeds = (await call('GET', '/v1/event-feeds')).body;
    expect(feeds.find((f: { label: string }) => f.label === 'Broken venue').lastError).toMatch(/500/);
  });

  it('refuses feed addresses that would point the server inwards', async () => {
    const { call } = await setup();
    for (const url of ['http://fixtures.example/a.ics', 'https://localhost/a.ics', 'https://10.0.0.5/a.ics', 'https://169.254.169.254/latest', 'https://intranet/a.ics', 'https://user:pw@fixtures.example/a.ics']) {
      const res = await call('POST', '/v1/event-feeds', { siteId: 'mar', kind: 'ics', label: 'x', url });
      expect(res.status, url).toBe(422);
    }
    expect(() => checkFeedUrl('https://[::1]/x')).toThrow();
    expect(checkFeedUrl('webcal://fixtures.example/club.ics').protocol).toBe('https:');
  });

  it('judges every kind of private address, including IPv4 inside IPv6', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['151.101.1.1', '8.8.8.8', '2a04:4e42::1', '::ffff:8.8.8.8']) expect(isPrivateAddress(ip), ip).toBe(false);
    expect(() => checkFeedUrl('https://[::ffff:127.0.0.1]/x')).toThrow();
  });

  it('refuses at connection time a name that resolves to a private address', async () => {
    // localhost passes no static rule by name here (the port makes it look ordinary), so this proves the lookup guard.
    await expect(publicFetch('https://localhost:9/x.ics')).rejects.toThrow(/public internet/);
  });

  it('never sends a feed address back in full', async () => {
    const { call } = await setup();
    const res = await call('POST', '/v1/event-feeds', { siteId: 'mar', kind: 'ics', label: 'Private', url: 'https://calendar.example/private-abc123secret/basic.ics' });
    expect(res.body.url).toBe('calendar.example/…');
    expect(JSON.stringify((await call('GET', '/v1/event-feeds')).body)).not.toContain('secret');
  });

  it('says Ticketmaster is not set up rather than failing later', async () => {
    const { call } = await setup();
    expect((await call('POST', '/v1/event-feeds', { siteId: 'mar', kind: 'ticketmaster', label: 'Nearby', radiusKm: 2 })).body.error).toBe('ticketmaster_not_set_up');
  });

  it('never lets a forecast overwrite a measured day', () => {
    const measured = { siteId: 'mar', date: '2026-10-20', tempMax: 15, tempMin: 9, precipitationMm: 1, observed: true, fetchedAt: 'a' };
    const merged = mergeWeather([measured], [{ ...measured, tempMax: 20, observed: false, fetchedAt: 'b' }]);
    expect(merged).toEqual([measured]);
  });
});

describe('reminders', () => {
  it('shows what is due, turns an expectation into a forecast adjustment, and stops showing it', async () => {
    const { call, store } = await setup();
    // Halloween is due 14 days ahead; the demo has no history for it, so it asks for a view.
    const due = await call('GET', '/v1/reminders?siteIds=mar');
    const halloween = due.body.find((r: { key: string }) => r.key === 'occasion:halloween:2026-10-31');
    expect(halloween).toMatchObject({ siteId: 'mar', status: 'open', needsInput: true, fromHour: 18, toHour: 24 });
    expect(due.body.some((r: { key: string }) => r.key.startsWith('occasion:mothering-sunday'))).toBe(false);

    const set = await call('POST', '/v1/reminders', { siteId: 'mar', key: halloween.key, action: 'expect', factor: 1.2, note: 'Fancy dress night booked' });
    expect(set.body.adjustment).toMatchObject({ date: '2026-10-31', factor: 1.2, reason: 'event', fromHour: 18, toHour: 24 });
    expect((await store.load('demo')).state.forecastAdjustments!.some((a) => a.date === '2026-10-31' && a.factor === 1.2)).toBe(true);
    const after = await call('GET', '/v1/reminders?siteIds=mar');
    expect(after.body.some((r: { key: string }) => r.key === halloween.key)).toBe(false);

    // A second answer replaces the first rather than stacking on it.
    await call('POST', '/v1/reminders', { siteId: 'mar', key: halloween.key, action: 'expect', factor: 1.5 });
    const halloweenAdj = (await store.load('demo')).state.forecastAdjustments!.filter((a) => a.date === '2026-10-31');
    expect(halloweenAdj.map((a) => a.factor)).toEqual([1.5]);
    expect((await call('POST', '/v1/reminders', { siteId: 'mar', key: 'occasion:bh-christmas-day:2026-12-25', action: 'expect', factor: 1.2 })).body.error).toBe('bank_holiday');
    expect((await call('POST', '/v1/reminders', { siteId: 'mar', key: 'occasion:nonsense', action: 'done' })).status).toBe(404);
    expect((await call('POST', '/v1/reminders', { siteId: 'mar', key: 'occasion:mad-friday:2026-12-18', action: 'expect' })).body.error).toBe('factor_required');
  });

  it('takes events entered by hand, and only those can be deleted by hand', async () => {
    const { call } = await setup();
    const ev = await call('POST', '/v1/local-events', { siteId: 'mar', date: '2026-10-29', name: 'Street food festival', startMinute: 12 * 60 });
    expect(ev.status).toBe(201);
    const due = await call('GET', '/v1/reminders?siteIds=mar');
    expect(due.body.find((r: { key: string }) => r.key === `event:${ev.body.id}`)).toMatchObject({ needsInput: true, fromHour: 9, toHour: 17 });
    expect((await call('DELETE', `/v1/local-events/${ev.body.id}`)).status).toBe(204);
  });
});

describe('the daily refresh', () => {
  it('refreshes every organisation with somewhere to look', async () => {
    const { call, store } = await setup({ CRON_SECRET: 'tick' });
    await call('PUT', '/v1/sites/shd/location', { lat: 51.5246, lng: -0.0794 });
    const res = await call('GET', '/internal/dispatch', undefined, { authorization: 'Bearer tick' });
    expect(res.body).toMatchObject({ ok: true, refreshed: 1, failed: 0 });
    expect((await store.load('demo')).state.weather!.some((w) => w.siteId === 'shd')).toBe(true);
    // The route ticks often; the outside data is fetched once a day.
    expect((await call('GET', '/internal/dispatch', undefined, { authorization: 'Bearer tick' })).body).toMatchObject({ refreshed: 0 });
  });

  it('carries on past an organisation that fails', async () => {
    const calls: string[] = [];
    const store = new MemoryStore(['demo', 'other'], TODAY);
    let broke = false;
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!broke) {
        broke = true;
        throw new TypeError('socket hang up');
      }
      return recorded(calls)(input, init);
    }) as typeof fetch;
    const { app } = await buildApp({ apiKeys: KEYS, store, provider: new TeamPaySimulator(), autoDispatch: false, now: () => new Date(`${TODAY}T07:00:00Z`), fetch: flaky, env: { CRON_SECRET: 'tick' } });
    for (const id of ['demo', 'other']) (await store.load(id)).state.sites[0].location = { lat: 51.5, lng: -0.1 };
    const res = await app.inject({ method: 'GET', url: '/internal/dispatch', headers: { authorization: 'Bearer tick' } });
    // A weather failure is caught inside the refresh and reported; both organisations complete.
    expect(res.json()).toMatchObject({ ok: true, refreshed: 2, failed: 0 });
  });
});
