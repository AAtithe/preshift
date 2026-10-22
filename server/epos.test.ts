import { describe, expect, it } from 'vitest';
import { SQUARE_VERSION, SquareProvider, squareNetSales, squareServiceCharge, squareTips } from './integrations/epos/square';
import { MemoryStore } from './store';
import { enrol, kit, TODAY } from './testkit';

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

/**
 * The demo group with its owner signed in and holding an authenticator, as anyone changing
 * settings must, plus a system integration key for the routes a till feed or script would call.
 */
async function boot(fetchImpl: typeof fetch = fakeSquare().impl) {
  const k = await kit({ store: new MemoryStore(['demo'], TODAY), accounts: false, keys: [{ key: 'integration', orgId: 'demo', name: 'Integration', scopes: ['*'] }], fetch: fetchImpl, now: () => NOW });
  const setup = await k.form('/auth/setup', { email: OWNER.email, password: OWNER.password, confirm: OWNER.password, next: '/app/' });
  const cookie = (await enrol(k, setup.cookie!)).cookie;
  const call = async (method: string, url: string, body?: unknown, as: 'admin' | 'key' = 'admin') => {
    const res = await k.call(method, url, as === 'admin' ? cookie : { key: 'integration' }, body);
    return { status: res.status, body: res.body };
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

describe('card tips from Square', () => {
  it('takes each order’s card tips, less any refunded, apart from takings', () => {
    expect(squareTips({ id: 'a', location_id: 'L', total_money: { amount: 6000 }, total_tip_money: { amount: 500 } })).toBe(5);
    expect(squareTips({ id: 'b', location_id: 'L', net_amounts: { total_money: { amount: 4800 }, tip_money: { amount: 300 } } })).toBe(3);
    expect(squareTips({ id: 'c', location_id: 'L', total_money: { amount: 1000 } })).toBe(0);
  });

  it('never touches a figure payroll has paid, and says where the till now disagrees', async () => {
    const square = fakeSquare({
      orders: [
        order('1', 'LMAR', '2026-10-19T11:30:00Z', 1000, { total_tip_money: { amount: 4500, currency: 'GBP' } }),
        order('2', 'LMAR', '2026-10-19T23:30:00Z', 200, { total_tip_money: { amount: 1250, currency: 'GBP' } }), // Monday night
        order('3', 'LMAR', '2026-10-20T18:00:00Z', 800, { total_tip_money: { amount: 3000, currency: 'GBP' } }),
        order('4', 'LMAR', '2026-10-21T18:00:00Z', 500, { total_tip_money: { amount: 2000, currency: 'GBP' } }),
        order('5', 'LMAR', '2026-10-22T08:30:00Z', 50, { total_tip_money: { amount: 500, currency: 'GBP' } }), // today
      ],
    });
    const { call } = await boot(square.impl);
    await call('PUT', '/v1/integrations/epos', { environment: 'production', accessToken: 'EAAA-good-token-1234' });
    await call('PUT', '/v1/integrations/epos/mapping', { sites: { mar: 'LMAR' } });
    // Tuesday was cashed up by hand; Wednesday's card tips were already paid.
    await call('PUT', '/v1/tronc/tips', { siteId: 'mar', date: '2026-10-20', source: 'card-tip', amount: 31 }, 'key');
    await call('PUT', '/v1/tronc/tips', { siteId: 'mar', date: '2026-10-21', source: 'card-tip', amount: 18 }, 'key');
    await call('POST', '/v1/tronc/tips/paid', { siteId: 'mar', weekStart: '2026-10-19', paidOn: '2026-10-21' }, 'key');

    const res = await call('POST', '/v1/integrations/epos/sync', { from: '2026-10-19', to: '2026-10-22' }, 'key');
    expect(res.body.tips).toMatchObject({
      written: 1,
      kept: [],
      paidDiffers: [
        { siteId: 'mar', date: '2026-10-20', paid: 31, till: 30 },
        { siteId: 'mar', date: '2026-10-21', paid: 18, till: 20 },
      ],
    });
    // Monday had no figure when payroll paid, so nothing of it was paid: the till fills it in, unpaid.
    const tips = (await call('GET', '/v1/tronc')).body.tips as { date: string; source: string; amount: number; fromTill?: boolean; paidOn?: string }[];
    const card = (d: string) => tips.find((t) => t.date === d && t.source === 'card-tip');
    expect(card('2026-10-19')).toMatchObject({ amount: 57.5, fromTill: true });
    expect(card('2026-10-19')?.paidOn).toBeUndefined();
    // The paid days stand as paid.
    expect(card('2026-10-20')).toMatchObject({ amount: 31, paidOn: '2026-10-21' });
    expect(card('2026-10-21')).toMatchObject({ amount: 18, paidOn: '2026-10-21' });
  });

  it('fills in days nobody has cashed up, follows its own figures, and leaves a hand-keyed one', async () => {
    const square = fakeSquare({
      orders: [
        order('1', 'LMAR', '2026-10-19T11:30:00Z', 1000, { total_tip_money: { amount: 4500, currency: 'GBP' } }),
        order('2', 'LMAR', '2026-10-19T23:30:00Z', 200, { total_tip_money: { amount: 1250, currency: 'GBP' } }),
        order('3', 'LMAR', '2026-10-20T18:00:00Z', 800, { total_tip_money: { amount: 3000, currency: 'GBP' } }),
        order('4', 'LMAR', '2026-10-22T08:30:00Z', 50, { total_tip_money: { amount: 500, currency: 'GBP' } }), // today
      ],
    });
    const { call } = await boot(square.impl);
    await call('PUT', '/v1/integrations/epos', { environment: 'production', accessToken: 'EAAA-good-token-1234' });
    await call('PUT', '/v1/integrations/epos/mapping', { sites: { mar: 'LMAR' } });
    await call('PUT', '/v1/tronc/tips', { siteId: 'mar', date: '2026-10-20', source: 'card-tip', amount: 31 }, 'key');

    const res = await call('POST', '/v1/integrations/epos/sync', { from: '2026-10-19', to: '2026-10-22' }, 'key');
    expect(res.body.tips).toMatchObject({ written: 1, kept: [{ siteId: 'mar', date: '2026-10-20' }], paidDiffers: [], total: 87.5 });
    const tips = (await call('GET', '/v1/tronc')).body.tips as { date: string; source: string; amount: number; fromTill?: boolean }[];
    const card = (d: string) => tips.find((t) => t.date === d && t.source === 'card-tip');
    // Monday's lunch and its night after midnight, as one trading day.
    expect(card('2026-10-19')).toMatchObject({ amount: 57.5, fromTill: true });
    expect(card('2026-10-20')).toMatchObject({ amount: 31 });
    expect(card('2026-10-20')?.fromTill).toBeUndefined();
    expect(card('2026-10-22')).toBeUndefined();

    // A manager correcting the till's figure makes it theirs: the next sync leaves it.
    await call('PUT', '/v1/tronc/tips', { siteId: 'mar', date: '2026-10-19', source: 'card-tip', amount: 60 }, 'key');
    const again = await call('POST', '/v1/integrations/epos/sync', { from: '2026-10-19', to: '2026-10-21' }, 'key');
    expect(again.body.tips.kept).toEqual(expect.arrayContaining([{ siteId: 'mar', date: '2026-10-19' }]));
    const after = (await call('GET', '/v1/tronc')).body.tips as { date: string; source: string; amount: number }[];
    expect(after.find((t) => t.date === '2026-10-19' && t.source === 'card-tip')?.amount).toBe(60);
  });
});

describe('service charge from Square', () => {
  it('takes what was collected: nothing for a charge taken off the bill, net of one refunded after', () => {
    expect(squareServiceCharge({ id: 'a', location_id: 'L', total_money: { amount: 6750 }, total_service_charge_money: { amount: 750 } })).toBe(7.5);
    expect(squareServiceCharge({ id: 'b', location_id: 'L', total_money: { amount: 6000 } })).toBe(0);
    expect(squareServiceCharge({ id: 'c', location_id: 'L', net_amounts: { total_money: { amount: 6000 }, service_charge_money: { amount: 0 } }, total_service_charge_money: { amount: 750 } })).toBe(0);
  });

  it('brings each finished day’s service charge in beside the card tips, even one the scheme does not expect', async () => {
    const charge = (pounds: number) => ({ total_service_charge_money: { amount: Math.round(pounds * 100), currency: 'GBP' } });
    const square = fakeSquare({
      orders: [
        order('1', 'LMAR', '2026-10-19T11:30:00Z', 1000, { ...charge(125), total_tip_money: { amount: 1000, currency: 'GBP' } }),
        order('2', 'LMAR', '2026-10-20T18:00:00Z', 800, charge(100)),
        order('3', 'LFITZ', '2026-10-20T18:00:00Z', 400, charge(50)),
      ],
    });
    const { call } = await boot(square.impl);
    await call('PUT', '/v1/integrations/epos', { environment: 'production', accessToken: 'EAAA-good-token-1234' });
    await call('PUT', '/v1/integrations/epos/mapping', { sites: { mar: 'LMAR', fitz: 'LFITZ' } });
    await call('PUT', '/v1/tronc/schemes/fitz', { troncmaster: 'Rachel Adams', independent: true, pointsPerHour: { server: 10 }, serviceCharge: 'none' }, 'key');

    const res = await call('POST', '/v1/integrations/epos/sync', { from: '2026-10-19', to: '2026-10-21' }, 'key');
    expect(res.body.serviceCharge).toMatchObject({ written: 3, kept: [], paidDiffers: [], total: 275 });
    expect(res.body.tips).toMatchObject({ written: 1, total: 10 });
    const tips = (await call('GET', '/v1/tronc')).body.tips as { siteId: string; date: string; source: string; amount: number; fromTill?: boolean }[];
    const sc = (site: string, d: string) => tips.find((t) => t.siteId === site && t.date === d && t.source === 'service-charge');
    expect(sc('mar', '2026-10-19')).toMatchObject({ amount: 125, fromTill: true });
    expect(sc('mar', '2026-10-20')).toMatchObject({ amount: 100, fromTill: true });
    // Fitzrovia's scheme says no service charge, but the till took one: it is written, not dropped.
    expect(sc('fitz', '2026-10-20')).toMatchObject({ amount: 50, fromTill: true });
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
    expect(ok.body.connection).toMatchObject({ provider: 'square', environment: 'production', accountName: 'West End Dining', connectedBy: 'owner' });
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
    // The simulated till carries card tips too, for the tronc.
    expect(res.body.tips.total).toBeGreaterThan(0);
    expect(res.body.tips.written).toBeGreaterThan(0);
    expect((await call('DELETE', '/v1/integrations/epos')).status).toBe(200);
    const sales = (await call('GET', '/v1/sales?from=2026-10-19&to=2026-10-21')).body as { source: string }[];
    expect(sales.filter((s) => s.source === 'till')).toHaveLength(9);
    expect((await call('POST', '/v1/integrations/epos/sync', {})).status).toBe(409);
  });
});

describe('who may do what with the till', () => {
  /** Seeded people with real sessions, and a simulated till already connected with the given sites matched. */
  async function people(matched: string[]) {
    const k = await kit({ now: () => NOW });
    const org = await k.store.load('demo');
    org.epos = { provider: 'square', environment: 'simulator', connectedAt: NOW.toISOString(), connectedBy: 'Olivia Grant' };
    for (const s of org.state.sites) if (matched.includes(s.id)) s.eposLocationId = `sim-${s.id}`;
    await k.store.save(org);
    return k;
  }

  it('lets a GM sync their own site but not one they do not run, and keeps settings from them', async () => {
    const gm = 'priya@marylebonegroup.example'; // general manager at Marylebone only
    const own = await people(['mar']);
    expect((await own.call('POST', '/v1/integrations/epos/sync', await own.as(gm), { from: '2026-10-19', to: '2026-10-21' })).status).toBe(200);
    expect((await own.call('PUT', '/v1/integrations/epos', await own.as(gm), { environment: 'simulator' })).status).toBe(403);

    const group = await people(['mar', 'shd']);
    const res = await group.call('POST', '/v1/integrations/epos/sync', await group.as(gm), {});
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Shoreditch/);
  });

  it('refuses a sync from someone without the right to change takings', async () => {
    const k = await people(['mar']);
    // A head chef rotas the kitchen but does not change forecasts or takings.
    expect((await k.call('POST', '/v1/integrations/epos/sync', await k.as('marco@marylebonegroup.example'), {})).status).toBe(403);
  });
});
