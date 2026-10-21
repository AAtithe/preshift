import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { nextWeekday } from './integrations/travel/journeys';
import { MemoryStore } from './store';

const KEYS = [{ key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*' as const] }];

/** A stand-in for postcodes.io and TfL. */
function stubFetch(opts: { tflDown?: boolean } = {}) {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://api.postcodes.io/postcodes/')) {
      const pc = decodeURIComponent(url.split('/').pop()!);
      if (pc === 'W1D3QF') return json({ status: 200, result: { latitude: 51.5136, longitude: -0.1318, postcode: 'W1D 3QF' } });
      return json({ status: 404, error: 'Postcode not found' }, 404);
    }
    if (url.startsWith('https://api.tfl.gov.uk/Journey/JourneyResults/')) {
      if (opts.tflDown) return json({ message: 'down' }, 503);
      // Any journey to or from Shoreditch (east of -0.1) takes 41 minutes; the West End pair 17.
      const [from, rest] = url.split('/JourneyResults/')[1].split('/to/');
      const lngs = [from, rest.split('?')[0]].map((p) => Number(p.split(',')[1]));
      const minutes = lngs.some((l) => l > -0.1) ? 41 : 17;
      return json({ journeys: [{ duration: minutes + 3, legs: [{ mode: { name: 'walking' } }] }, { duration: minutes, legs: [{ mode: { name: 'walking' } }, { mode: { name: 'tube' } }, { mode: { name: 'bus' } }] }] });
    }
    throw new Error(`Unexpected fetch ${url}`);
  }) as typeof fetch;
  return { impl, calls };
}

async function setup(fetchImpl: typeof fetch) {
  const { app } = await buildApp({ apiKeys: KEYS, store: new MemoryStore(['demo'], '2026-10-21'), provider: new TeamPaySimulator(), autoDispatch: false, fetch: fetchImpl });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: 'Bearer admin', ...(body ? { 'content-type': 'application/json' } : {}) },
      payload: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  return call;
}

describe('travel between sites', () => {
  it('plans TfL journeys between every pair of sites, each way, on a weekday', async () => {
    const stub = stubFetch();
    const call = await setup(stub.impl);
    const res = await call('POST', '/v1/sites/travel/refresh');
    expect(res.status).toBe(200);
    expect(res.body.fromTfl).toBe(6);
    const mar = res.body.sites.find((s: { id: string }) => s.id === 'mar');
    expect(mar.travel.shd).toMatchObject({ minutes: 41, source: 'tfl', mode: 'tube, bus' });
    expect(mar.travel.fitz).toMatchObject({ minutes: 17, source: 'tfl' });
    expect(stub.calls.every((u) => !u.startsWith('https://api.tfl.gov.uk') || /time=1700/.test(u))).toBe(true);
    expect(nextWeekday('2026-10-24')).toBe('20261026');
  });

  it('keeps times set by hand through a refresh, and falls back to labelled estimates when TfL is down', async () => {
    const call = await setup(stubFetch({ tflDown: true }).impl);
    expect((await call('PUT', '/v1/sites/mar/travel/shd', { minutes: 35 })).status).toBe(200);
    const res = await call('POST', '/v1/sites/travel/refresh');
    expect(res.body.fromTfl).toBe(0);
    expect(res.body.failures.length).toBeGreaterThan(0);
    const mar = res.body.sites.find((s: { id: string }) => s.id === 'mar');
    expect(mar.travel.shd).toMatchObject({ minutes: 35, source: 'manual' });
    expect(mar.travel.fitz.source).toBe('estimate');
    const shd = res.body.sites.find((s: { id: string }) => s.id === 'shd');
    expect(shd.travel.mar).toMatchObject({ minutes: 35, source: 'manual' });
    expect((await call('DELETE', '/v1/sites/mar/travel/shd')).body.find((s: { id: string }) => s.id === 'mar').travel.shd).toBeUndefined();
  });

  it('sets a location from a postcode, refuses an unknown one, and forgets journeys from the old spot', async () => {
    const call = await setup(stubFetch().impl);
    await call('POST', '/v1/sites/travel/refresh');
    expect((await call('PUT', '/v1/sites/mar/location', { postcode: 'XX1 1XX' })).status).toBe(422);
    const moved = await call('PUT', '/v1/sites/mar/location', { postcode: 'w1d 3qf' });
    expect(moved.status).toBe(200);
    expect(moved.body.location).toEqual({ lat: 51.5136, lng: -0.1318, postcode: 'W1D 3QF' });
    expect(moved.body.travel).toEqual({});
    const sites = (await call('GET', '/v1/sites')).body;
    expect(sites.find((s: { id: string }) => s.id === 'shd').travel.mar).toBeUndefined();
    expect(sites.find((s: { id: string }) => s.id === 'shd').travel.fitz.source).toBe('tfl');
  });

  it('reports a move between sites that cannot be made in time when a shift is saved', async () => {
    const call = await setup(stubFetch().impl);
    await call('POST', '/v1/sites/travel/refresh');
    const employees = (await call('GET', '/v1/employees')).body as { id: string; name: string }[];
    const dev = employees.find((e) => e.name === 'Dev Kapoor')!;
    await call('POST', '/v1/shifts', { employeeId: dev.id, roleId: 'bar', siteId: 'shd', date: '2026-10-20', startMinute: 12 * 60, endMinute: 17 * 60, breakMinutes: 0 });
    const res = await call('POST', '/v1/shifts', { employeeId: dev.id, roleId: 'bar', siteId: 'mar', date: '2026-10-20', startMinute: 17 * 60 + 20, endMinute: 21 * 60, breakMinutes: 0 });
    expect(res.status).toBeLessThan(300);
    expect(res.body.issues.find((i: { code: string }) => i.code === 'travel')?.message).toMatch(/20 minutes, the journey takes about 41 \(TfL, tube, bus\)/);
  });
});
