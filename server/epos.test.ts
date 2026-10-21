import { describe, expect, it } from 'vitest';
import { forecastFromHistory, replaceDays, salesVsForecast } from '../src/engine/sales';
import { parseSalesCsv } from '../src/engine/salesCsv';
import { seedState } from '../src/engine/seed';
import { addDays, weekStart } from '../src/engine/time';
import type { HourSales } from '../src/engine/types';
import { buildApp } from './app';
import { londonParts } from './context';
import { bucketSales } from './integrations/epos/aggregate';
import { SquareProvider } from './integrations/epos/square';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { londonMidnight, syncAllTills } from './routes/sales';
import { MemoryStore } from './store';

const row = (date: string, hour: number, sales: number, covers?: number): HourSales => ({ siteId: 'mar', date, hour, sales, covers, transactions: 1, source: 'test' });

describe('forecast from till history', () => {
  // Mondays: 2026-10-12, 10-05, 09-28. Forecasting Monday 2026-10-19.
  const history = [row('2026-10-12', 12, 300, 6), row('2026-10-05', 12, 200, 4), row('2026-10-05', 13, 100, 2), row('2026-09-28', 12, 100, 2)];

  it('weights recent weeks most and counts an open hour with no sales as zero', () => {
    const { rows, days } = forecastFromHistory(history, 'mar', ['2026-10-19'], { weeks: 3 });
    // Weights 3, 2, 1: (300*3 + 200*2 + 100*1) / 6.
    expect(rows.find((r) => r.hour === 12)).toMatchObject({ sales: 233.33, covers: 5 });
    // 13:00 traded only on 10-05; the other two Mondays were open and took nothing in that hour.
    expect(rows.find((r) => r.hour === 13)?.sales).toBe(33.33);
    expect(days).toEqual([{ date: '2026-10-19', weeksUsed: 3 }]);
  });

  it('skips a day with too little history rather than guessing, and leaves closed days out', () => {
    const { skipped, days } = forecastFromHistory(history, 'mar', ['2026-10-19', '2026-10-20'], { weeks: 3, minWeeks: 2 });
    expect(skipped).toEqual(['2026-10-20']);
    expect(days.map((d) => d.date)).toEqual(['2026-10-19']);
  });

  it('derives covers from spend per head when the till records none', () => {
    const noCovers = [row('2026-10-12', 12, 420), row('2026-10-05', 12, 420)];
    const { rows } = forecastFromHistory(noCovers, 'mar', ['2026-10-19'], { spendPerHead: 42 });
    expect(rows[0]).toMatchObject({ sales: 420, covers: 10 });
  });

  it('replaces whole days on a sync, so a refunded hour disappears', () => {
    const held = [row('2026-10-12', 12, 300), row('2026-10-12', 13, 50), row('2026-10-11', 12, 99)];
    const next = replaceDays(held, [row('2026-10-12', 12, 280)], ['mar'], ['2026-10-12']);
    expect(next.filter((r) => r.date === '2026-10-12')).toEqual([row('2026-10-12', 12, 280)]);
    expect(next).toContainEqual(row('2026-10-11', 12, 99));
  });

  it('compares actual to forecast by day, with no actual until the till has the day', () => {
    const vs = salesVsForecast([{ siteId: 'mar', date: '2026-10-12', hour: 12, sales: 250, covers: 5 }], [row('2026-10-12', 12, 280)], 'mar', ['2026-10-12', '2026-10-13']);
    expect(vs).toEqual([
      { date: '2026-10-12', forecast: 250, actual: 280, variance: 30 },
      { date: '2026-10-13', forecast: 0, actual: null, variance: null },
    ]);
  });

  it('compares the day still trading only up to the hours already closed', () => {
    const forecast = [12, 13, 19].map((hour) => ({ siteId: 'mar', date: '2026-10-21', hour, sales: 100, covers: 2 }));
    const vs = salesVsForecast(forecast, [row('2026-10-21', 12, 90), row('2026-10-21', 13, 120), row('2026-10-21', 14, 5)], 'mar', ['2026-10-21'], { date: '2026-10-21', hour: 14 });
    expect(vs).toEqual([{ date: '2026-10-21', forecast: 200, actual: 210, variance: 10, throughHour: 14 }]);
  });
});

describe('hourly sales export', () => {
  const sites = seedState('2026-10-21').sites;

  it('reads UK dates, clock times, pound signs, and sites by name or tracking code', () => {
    const csv = 'Date,Hour,Site,Net sales,Covers\n19/10/2026,12:00,Marylebone,"£1,204.50",28\n2026-10-19,13,shoreditch,300,\n';
    expect(parseSalesCsv(csv, sites)).toEqual({
      rows: [
        { siteId: 'mar', date: '2026-10-19', hour: 12, sales: 1204.5, covers: 28 },
        { siteId: 'shd', date: '2026-10-19', hour: 13, sales: 300, covers: undefined },
      ],
      errors: [],
    });
  });

  it('names the line and the field that is wrong, and needs the column headings', () => {
    expect(parseSalesCsv('date,hour,site,sales\n2026-10-19,25,Marylebone,10\n2026-10-19,12,Paris,10\n2026-10-19,12,Fitzrovia', sites).errors).toEqual([
      'Line 2: hour not recognised.',
      'Line 3: site "Paris" not recognised.',
      'Line 4: sales not recognised.',
    ]);
    expect(parseSalesCsv('a,b,c\n1,2,3', sites).errors[0]).toMatch(/must name the columns/);
  });
});

describe('bills into UK clock hours', () => {
  it('uses BST and GMT correctly, including the night the clocks go back', () => {
    const hours = bucketSales(
      [
        // 23:30 UTC on 24 October is 00:30 BST on Sunday 25 October.
        { id: 'a', locationId: 'L1', closedAt: '2026-10-24T23:30:00Z', netSales: 40, covers: 2 },
        // 01:30 UTC on 25 October is 01:30 GMT, after the clocks went back at 02:00 BST.
        { id: 'b', locationId: 'L1', closedAt: '2026-10-25T01:30:00Z', netSales: 10 },
        { id: 'c', locationId: 'L1', closedAt: '2026-01-10T23:30:00Z', netSales: 25.5, covers: 1 },
        { id: 'd', locationId: 'unmapped', closedAt: '2026-01-10T23:30:00Z', netSales: 999 },
      ],
      (id) => (id === 'L1' ? 'mar' : undefined),
      'test',
    );
    expect(hours).toContainEqual({ siteId: 'mar', date: '2026-10-25', hour: 0, sales: 40, covers: 2, transactions: 1, source: 'test' });
    expect(hours).toContainEqual({ siteId: 'mar', date: '2026-10-25', hour: 1, sales: 10, covers: undefined, transactions: 1, source: 'test' });
    expect(hours).toContainEqual({ siteId: 'mar', date: '2026-01-10', hour: 23, sales: 25.5, covers: 1, transactions: 1, source: 'test' });
    expect(hours).toHaveLength(3);
  });

  it('starts a UK day at local midnight in summer and winter', () => {
    expect(londonMidnight('2026-07-01').toISOString()).toBe('2026-06-30T23:00:00.000Z');
    expect(londonMidnight('2026-12-01').toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});

describe('Square client', () => {
  it('pages completed orders by close time and takes net sales after VAT, tips, service charge and refunds', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/locations')) return Response.json({ locations: [{ id: 'L1', name: 'Marylebone', status: 'ACTIVE' }] });
      const body = JSON.parse(init.body as string);
      const money = (amount: number) => ({ amount, currency: 'GBP' });
      if (!body.cursor) {
        return Response.json({
          cursor: 'next',
          orders: [
            {
              id: 'o1',
              location_id: 'L1',
              state: 'COMPLETED',
              closed_at: '2026-10-20T12:10:00Z',
              // £60 total: £9 VAT, £3 tip, £5 service charge, so £43 net. Net amounts are already after refunds.
              net_amounts: { total_money: money(6000), tax_money: money(900), tip_money: money(300), service_charge_money: money(500) },
            },
          ],
        });
      }
      return Response.json({ orders: [{ id: 'o2', location_id: 'L1', state: 'COMPLETED', closed_at: '2026-10-20T12:40:00Z', net_amounts: { total_money: money(1200), tax_money: money(200) } }] });
    }) as unknown as typeof fetch;

    const square = new SquareProvider({ accessToken: 'EAAA-token', environment: 'production', fetchImpl });
    expect(await square.listLocations()).toEqual([{ id: 'L1', name: 'Marylebone', active: true }]);
    const sales = await square.closedSales(['L1'], new Date('2026-10-20T00:00:00Z'), new Date('2026-10-21T00:00:00Z'));
    expect(sales.map((s) => s.netSales)).toEqual([43, 10]);
    expect(sales[0].covers).toBeUndefined();

    const search = calls.filter((c) => c.url.endsWith('/orders/search'));
    expect(search).toHaveLength(2);
    expect(search[0].url).toBe('https://connect.squareup.com/v2/orders/search');
    const headers = search[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer EAAA-token');
    expect(headers['square-version']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const q = JSON.parse(search[0].init.body as string);
    expect(q.query.filter.state_filter.states).toEqual(['COMPLETED']);
    expect(q.query.sort.sort_field).toBe('CLOSED_AT');
    expect(JSON.parse(search[1].init.body as string).cursor).toBe('next');
  });

  it('explains a refused token in words an operator can act on', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    const square = new SquareProvider({ accessToken: 'bad', environment: 'sandbox', fetchImpl });
    await expect(square.listLocations()).rejects.toThrow(/refused the access token/);
  });
});

describe('till API', () => {
  const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };

  async function boot(eposFetch?: typeof fetch) {
    const { app } = await buildApp({
      apiKeys: [{ key: 'integration', orgId: 'demo', name: 'Data warehouse', scopes: ['rota:read', 'sales:write'] }],
      store: new MemoryStore(['demo']),
      provider: new TeamPaySimulator(),
      autoDispatch: false,
      eposFetch,
    });
    const setup = await app.inject({
      method: 'POST',
      url: '/auth/setup',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ email: OWNER.email, password: OWNER.password, confirm: OWNER.password, next: '/app/' }).toString(),
    });
    const cookie = String(setup.headers['set-cookie']).split(';')[0];
    const call = async (method: string, url: string, body?: unknown, auth: 'owner' | 'integration' = 'owner') => {
      const res = await app.inject({
        method: method as 'GET',
        url,
        headers: { ...(auth === 'owner' ? { cookie } : { authorization: 'Bearer integration' }), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        payload: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.statusCode, body: res.json() };
    };
    return { call };
  }

  const today = londonParts(new Date()).date;

  it('connects the demo till, matches sites by name, syncs, and forecasts next week from the history', async () => {
    const { call } = await boot();
    const connected = await call('PUT', '/v1/integrations/epos', { provider: 'demo' });
    expect(connected.status).toBe(200);
    expect(connected.body.sites.map((s: { locationId: string }) => s.locationId)).toEqual(['demo-mar', 'demo-fitz', 'demo-shd']);

    for (const back of [28, 14]) {
      const res = await call('POST', '/v1/integrations/epos/sync', { from: addDays(today, -back - 13), to: addDays(today, -back) });
      expect(res.status).toBe(200);
    }
    const res = await call('POST', '/v1/integrations/epos/sync', { from: addDays(today, -13), to: today });
    expect(res.body.bills).toBeGreaterThan(0);

    const actuals = (await call('GET', `/v1/sales/actuals?siteId=mar&from=${addDays(today, -7)}&to=${addDays(today, -1)}`)).body as HourSales[];
    expect(actuals.length).toBeGreaterThan(30);
    expect(actuals.every((r) => r.source === 'demo' && r.covers! > 0)).toBe(true);

    const next = weekStart(addDays(today, 7));
    const built = await call('POST', '/v1/forecast/from-history', { siteId: 'mar', weekStart: next });
    expect(built.status).toBe(200);
    expect(built.body.sites[0].days).toHaveLength(7);
    expect(built.body.sites[0].sales).toBeGreaterThan(30000);
    const forecast = (await call('GET', `/v1/forecast?siteId=mar&from=${next}&to=${addDays(next, 6)}`)).body as { sales: number }[];
    expect(Math.round(forecast.reduce((s, f) => s + f.sales, 0))).toBe(built.body.sites[0].sales);

    // Re-syncing the same days changes nothing: the till is the truth for the days it covers.
    const before = (await call('GET', '/v1/sales/actuals?siteId=mar')).body;
    await call('POST', '/v1/integrations/epos/sync', { from: addDays(today, -13), to: today });
    expect((await call('GET', '/v1/sales/actuals?siteId=mar')).body).toHaveLength(before.length);
  });

  it('refuses a location feeding two sites, and an integration key changing the connection', async () => {
    const { call } = await boot();
    await call('PUT', '/v1/integrations/epos', { provider: 'demo' });
    expect((await call('PUT', '/v1/integrations/epos/sites/fitz', { locationId: 'demo-mar' })).body.message).toMatch(/already feeds Marylebone/);
    expect((await call('PUT', '/v1/integrations/epos', { provider: 'demo' }, 'integration')).status).toBe(403);
    expect((await call('POST', '/v1/integrations/epos/sync', { from: addDays(today, 1) }, 'integration')).status).toBe(400);
    expect((await call('POST', '/v1/integrations/epos/sync', { from: addDays(today, -40), to: today }, 'integration')).body.error).toBe('range_too_long');
  });

  it('checks a Square token on connect and never hands it back', async () => {
    let ok = false;
    const fetchImpl = (async () => (ok ? Response.json({ locations: [{ id: 'SQ1', name: 'Marylebone W1', status: 'ACTIVE' }] }) : new Response('{}', { status: 401 }))) as unknown as typeof fetch;
    const { call } = await boot(fetchImpl);
    const refused = await call('PUT', '/v1/integrations/epos', { provider: 'square', accessToken: 'EAAA-wrong' });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/refused the access token/);
    ok = true;
    const res = await call('PUT', '/v1/integrations/epos', { provider: 'square', accessToken: 'EAAA-right-token' });
    expect(res.body).toMatchObject({ provider: 'square', connected: true, environment: 'production' });
    expect(res.body.sites.find((s: { siteId: string }) => s.siteId === 'mar').locationId).toBe('SQ1');
    expect(JSON.stringify(res.body)).not.toContain('EAAA-right-token');
  });

  it('reads every connected till overnight and records a failure where the Integrations page shows it', async () => {
    const store = new MemoryStore(['demo', 'acme']);
    const { ctx } = await buildApp({ apiKeys: [], store, provider: new TeamPaySimulator(), autoDispatch: false });
    const demo = await store.load('demo');
    demo.epos = { provider: 'demo', locations: { mar: 'demo-mar' } };
    const acme = await store.load('acme');
    acme.epos = { provider: 'square', environment: 'production', locations: { x: 'SQ1' } }; // no token saved, so it cannot sync
    expect(await syncAllTills(ctx)).toEqual({ synced: 1, failed: 1 });
    expect((await store.load('demo')).salesActuals.some((r) => r.date >= addDays(today, -1))).toBe(true);
    expect((await store.load('acme')).epos?.lastError).toBeUndefined(); // refused before reaching a till: nothing to report against it
  });

  it('takes hourly takings pushed from any other till', async () => {
    const { call } = await boot();
    const day = addDays(today, -2);
    const pushed = await call('PUT', '/v1/sales/actuals', { source: 'tevalis', rows: [{ siteId: 'shd', date: day, hour: 19, sales: 1234.5, covers: 30 }] }, 'integration');
    expect(pushed.body).toMatchObject({ upserted: 1 });
    expect((await call('GET', `/v1/sales/actuals?siteId=shd`)).body).toEqual([{ siteId: 'shd', date: day, hour: 19, sales: 1234.5, covers: 30, transactions: 0, source: 'tevalis' }]);
    expect((await call('PUT', '/v1/sales/actuals', { rows: [{ siteId: 'nowhere', date: day, hour: 1, sales: 1 }] }, 'integration')).body.error).toBe('unknown_site');
  });
});
