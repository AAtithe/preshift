import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { SQUARE_VERSION, SquareProvider, squareNetSales } from './integrations/epos/square';
import { MemoryStore } from './store';

const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };
const NOW = new Date('2026-10-22T09:00:00Z'); // Thursday morning: Monday to Wednesday have finished trading

/** A fake Square: two locations, a few orders, and a record of every request made to it. */
function fakeSquare(opts: { token?: string; orders?: unknown[] } = {}) {
  const calls: { url: string; init: RequestInit; body?: Record<string, unknown> }[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, init, body });
    const auth = (init.headers as Record<string, string>).authorization;
    if (auth !== `Bearer ${opts.token ?? 'EAAA-good-token-1234'}`) return json(401, { errors: [{ code: 'UNAUTHORIZED', detail: 'bad token' }] });
    if (url.endsWith('/v2/merchants')) return json(200, { merchant: [{ business_name: 'West End Dining' }] });
    if (url.endsWith('/v2/locations')) {
      return json(200, {
        locations: [
          { id: 'LMAR', name: 'Marylebone', timezone: 'Europe/London', status: 'ACTIVE' },
          { id: 'LFITZ', name: 'Fitzrovia', timezone: 'Europe/London', status: 'ACTIVE' },
          { id: 'LOLD', name: 'Closed pop-up', timezone: 'Europe/London', status: 'INACTIVE' },
        ],
      });
    }
    if (url.endsWith('/v2/orders/search')) return json(200, { orders: opts.orders ?? [] });
    return json(404, { errors: [{ code: 'NOT_FOUND' }] });
  }) as typeof fetch;
  return { impl, calls };
}

const order = (id: string, location: string, closedAt: string, pounds: number, extra: Record<string, unknown> = {}) => ({
  id,
  location_id: location,
  state: 'COMPLETED',
  closed_at: closedAt,
  total_money: { amount: Math.round(pounds * 120), currency: 'GBP' },
  total_tax_money: { amount: Math.round(pounds * 20), currency: 'GBP' },
  ...extra,
});

async function boot(fetchImpl: typeof fetch = fakeSquare().impl) {
  const { app } = await buildApp({
    apiKeys: [{ key: 'integration', orgId: 'demo', name: 'Integration', scopes: ['*'] }],
    store: new MemoryStore(['demo'], '2026-10-21'),
    provider: new TeamPaySimulator(),
    autoDispatch: false,
    fetch: fetchImpl,
    now: () => NOW,
  });
  const setup = await app.inject({
    method: 'POST',
    url: '/auth/setup',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ email: OWNER.email, password: OWNER.password, confirm: OWNER.password, next: '/app/' }).toString(),
  });
  const cookie = String(setup.headers['set-cookie']).split(';')[0];
  const call = async (method: string, url: string, body?: unknown, as: 'admin' | 'key' = 'admin') => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { ...(as === 'admin' ? { cookie } : { authorization: 'Bearer integration' }), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  return { call };
}

describe('Square takings', () => {
  it('counts what the business keeps: net of VAT, tips, service charge and refunds', () => {
    expect(squareNetSales({ id: 'a', location_id: 'L', total_money: { amount: 6000 }, total_tax_money: { amount: 900 }, total_tip_money: { amount: 500 }, total_service_charge_money: { amount: 600 } })).toBe(40);
    // A refund-only order nets negative, so it comes off the day it was refunded.
    expect(squareNetSales({ id: 'b', location_id: 'L', total_money: { amount: 0 }, net_amounts: { total_money: { amount: -1200 }, tax_money: { amount: -200 } } })).toBe(-10);
  });

  it('asks Square for completed orders by close time, follows every page and sends the version and token', async () => {
    const pages = [
      { orders: [order('1', 'LMAR', '2026-10-19T12:00:00Z', 50)], cursor: 'next' },
      { orders: [order('2', 'LMAR', '2026-10-19T13:00:00Z', 30)] },
    ];
    const calls: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init: RequestInit = {}) => {
      expect((init.headers as Record<string, string>)['square-version']).toBe(SQUARE_VERSION);
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(pages[calls.length - 1]), { status: 200 });
    }) as typeof fetch;
    const square = new SquareProvider({ accessToken: 'tok', environment: 'production', fetch: fetchImpl });
    const orders = await square.fetchOrders(['LMAR'], '2026-10-19T00:00:00Z', '2026-10-20T00:00:00Z');
    expect(orders.map((o) => o.netSales)).toEqual([50, 30]);
    expect(calls[0]).toMatchObject({
      location_ids: ['LMAR'],
      query: { filter: { state_filter: { states: ['COMPLETED'] }, date_time_filter: { closed_at: { start_at: '2026-10-19T00:00:00Z', end_at: '2026-10-20T00:00:00Z' } } }, sort: { sort_field: 'CLOSED_AT' } },
    });
    expect(calls[1].cursor).toBe('next');
  });

  it('refuses orders that are not in pounds rather than adding euros to sterling', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ orders: [order('1', 'L', '2026-10-19T12:00:00Z', 10, { total_money: { amount: 1000, currency: 'EUR' } })] }))) as unknown as typeof fetch;
    const square = new SquareProvider({ accessToken: 't', environment: 'sandbox', fetch: fetchImpl });
    await expect(square.fetchOrders(['L'], 'a', 'b')).rejects.toThrow(/EUR/);
  });
});

describe('connecting a till', () => {
  it('checks the token with Square before saving it, and never returns it', async () => {
    const { call } = await boot();
    expect((await call('GET', '/v1/integrations/epos')).body.connection).toBeNull();
    const bad = await call('PUT', '/v1/integrations/epos', { environment: 'production', accessToken: 'EAAA-typo' });
    expect(bad.status).toBe(422);
    expect(bad.body.message).toMatch(/refused the access token/);
    expect((await call('GET', '/v1/integrations/epos')).body.connection).toBeNull();

    const ok = await call('PUT', '/v1/integrations/epos', { environment: 'production', accessToken: 'EAAA-good-token-1234' });
    expect(ok.status).toBe(200);
    expect(ok.body.connection).toMatchObject({ provider: 'square', environment: 'production', accountName: 'West End Dining', connectedBy: OWNER.email });
    const status = (await call('GET', '/v1/integrations/epos')).body;
    expect(status.tokenEndsWith).toBe('1234');
    expect(JSON.stringify(status)).not.toContain('good-token');
    // An integration key can read the status but never sees even the end of the token, nor change it.
    expect((await call('GET', '/v1/integrations/epos', undefined, 'key')).body.tokenEndsWith).toBeNull();
    expect((await call('PUT', '/v1/integrations/epos', { environment: 'sandbox' }, 'key')).status).toBe(403);
    // Inactive locations are not offered.
    const locations = (await call('GET', '/v1/integrations/epos/locations')).body;
    expect(locations.map((l: { id: string }) => l.id)).toEqual(['LMAR', 'LFITZ']);
  });

  it('matches each till location to one site only', async () => {
    const { call } = await boot();
    await call('PUT', '/v1/integrations/epos', { environment: 'production', accessToken: 'EAAA-good-token-1234' });
    expect((await call('PUT', '/v1/integrations/epos/mapping', { sites: { mar: 'LMAR', fitz: 'LMAR' } })).status).toBe(422);
    expect((await call('PUT', '/v1/integrations/epos/mapping', { sites: { mar: 'NOPE' } })).status).toBe(422);
    const mapped = await call('PUT', '/v1/integrations/epos/mapping', { sites: { mar: 'LMAR', fitz: 'LFITZ' } });
    expect(mapped.status).toBe(200);
    expect(mapped.body.find((s: { siteId: string }) => s.siteId === 'mar').locationId).toBe('LMAR');
  });
});

describe('syncing takings', () => {
  it('writes finished trading days, keeps hand-keyed figures and leaves today alone', async () => {
    const square = fakeSquare({
      orders: [
        order('1', 'LMAR', '2026-10-19T11:30:00Z', 1000), // Monday lunch, local 12:30
        order('2', 'LMAR', '2026-10-19T23:30:00Z', 200), // 00:30 Tuesday morning: Monday night's trade
        order('3', 'LMAR', '2026-10-20T18:00:00Z', 800), // Tuesday
        order('4', 'LMAR', '2026-10-22T08:30:00Z', 50), // today, still trading
      ],
    });
    const { call } = await boot(square.impl);
    await call('PUT', '/v1/integrations/epos', { environment: 'production', accessToken: 'EAAA-good-token-1234' });
    await call('PUT', '/v1/integrations/epos/mapping', { sites: { mar: 'LMAR' } });
    await call('PUT', '/v1/sales', { rows: [{ siteId: 'mar', date: '2026-10-20', netSales: 999, source: 'manual' }] });

    const res = await call('POST', '/v1/integrations/epos/sync', { from: '2026-10-19', to: '2026-10-22' }, 'key');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, written: 2, kept: [{ siteId: 'mar', date: '2026-10-20' }] });

    const sales = (await call('GET', '/v1/sales?siteId=mar&from=2026-10-19&to=2026-10-22')).body as { date: string; netSales: number; source: string; hours?: { hour: number }[] }[];
    const day = (d: string) => sales.find((s) => s.date === d);
    expect(day('2026-10-19')).toMatchObject({ netSales: 1200, source: 'till', orders: 2 });
    expect(day('2026-10-19')!.hours!.map((h) => h.hour)).toEqual([12, 24]);
    expect(day('2026-10-20')).toMatchObject({ netSales: 999, source: 'manual' });
    expect(day('2026-10-21')).toMatchObject({ netSales: 0, source: 'till' });
    expect(day('2026-10-22')).toBeUndefined();

    const search = square.calls.find((c) => c.url.endsWith('/v2/orders/search'))!;
    expect(search.body!.location_ids).toEqual(['LMAR']);
    expect((await call('GET', '/v1/integrations/epos')).body.connection.lastSync).toMatchObject({ ok: true, written: 2 });
  });

  it('records a failed sync so the Integrations page can show it, without touching takings', async () => {
    const { call } = await boot();
    await call('PUT', '/v1/integrations/epos', { environment: 'production', accessToken: 'EAAA-good-token-1234' });
    const res = await call('POST', '/v1/integrations/epos/sync', {});
    expect(res.body).toMatchObject({ ok: false, error: 'No site is matched to a till location yet.' });
    expect((await call('POST', '/v1/integrations/epos/sync', { from: '2026-01-01', to: '2026-10-01' })).status).toBe(400);
  });

  it('runs end to end on the simulated till, and disconnecting keeps the takings', async () => {
    const { call } = await boot();
    const connected = await call('PUT', '/v1/integrations/epos', { environment: 'simulator' });
    expect(connected.status).toBe(200);
    const res = await call('POST', '/v1/integrations/epos/sync', { from: '2026-10-19', to: '2026-10-21' });
    expect(res.body.ok).toBe(true);
    expect(res.body.written).toBe(9); // three sites, three finished days
    expect(res.body.sites.every((s: { netSales: number }) => s.netSales > 0)).toBe(true);
    expect((await call('DELETE', '/v1/integrations/epos')).status).toBe(200);
    const sales = (await call('GET', '/v1/sales?from=2026-10-19&to=2026-10-21')).body as { source: string }[];
    expect(sales.filter((s) => s.source === 'till')).toHaveLength(9);
    expect((await call('POST', '/v1/integrations/epos/sync', {})).status).toBe(409);
  });
});
