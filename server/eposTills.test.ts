import { describe, expect, it } from 'vitest';
import { tradingDays } from '../src/engine/epos';
import { LightspeedProvider, lightspeedNetSales } from './integrations/epos/lightspeed';
import { ToastProvider, toastNetSales } from './integrations/epos/toast';
import { MemoryStore } from './store';
import { enrol, kit, TODAY } from './testkit';

const NOW = new Date('2026-10-22T09:00:00Z');
const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake Toast with one restaurant: logs every request, answers ordersBulk a page at a time. */
function fakeToast(orders: Record<string, unknown[]> = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    if (url.endsWith('/authentication/v1/authentication/login')) {
      const body = JSON.parse(String(init.body));
      if (body.clientSecret !== 'toast-secret-9876') return json(401, { message: 'bad credentials' });
      return json(200, { token: { accessToken: 'toast-access', expiresIn: 3600 } });
    }
    if (headers.authorization !== 'Bearer toast-access') return json(401, {});
    if (url.endsWith('/partners/v1/restaurants')) return json(200, [{ restaurantGuid: 'R-MAR', restaurantName: 'West End Dining', locationName: 'Marylebone' }]);
    if (url.includes('/restaurants/v1/restaurants/R-MAR')) return json(200, { general: { timeZone: 'Europe/London' } });
    const m = /ordersBulk\?businessDate=(\d+)&pageSize=100&page=(\d+)/.exec(url);
    if (m) return json(200, m[2] === '1' ? orders[m[1]] ?? [] : []);
    return json(404, {});
  }) as typeof fetch;
  return { impl, calls };
}

const toastOrder = (guid: string, businessDate: number, closedDate: string, amount: number, extra: Record<string, unknown> = {}) => ({
  guid,
  businessDate,
  closedDate,
  numberOfGuests: 2,
  checks: [{ amount, taxAmount: amount * 0.2 }],
  ...extra,
});

describe('Toast', () => {
  it('counts the check after discounts, without tax, service charge, refunds or anything voided', () => {
    expect(toastNetSales({ guid: 'a', checks: [{ amount: 100, taxAmount: 20, appliedServiceCharges: [{ chargeAmount: 12.5 }], payments: [{ refund: { refundAmount: 10 } }] }] })).toBe(77.5);
    expect(toastNetSales({ guid: 'b', checks: [{ amount: 50 }, { amount: 30, voided: true }] })).toBe(50);
    expect(toastNetSales({ guid: 'c', voided: true, checks: [{ amount: 50 }] })).toBe(0);
  });

  it('signs in, reads each business date for each restaurant with its header, and keeps guests and the business date', async () => {
    const t = fakeToast({ '20261019': [toastOrder('1', 20261019, '2026-10-19T12:30:00.000+0000', 80), toastOrder('2', 20261019, '2026-10-20T00:40:00.000+0000', 40)] });
    const toast = new ToastProvider({ clientId: 'id', clientSecret: 'toast-secret-9876', environment: 'sandbox', fetch: t.impl });
    expect(await toast.listLocations()).toEqual([{ id: 'R-MAR', name: 'West End Dining, Marylebone', timeZone: 'Europe/London' }]);
    const orders = await toast.fetchOrders(['R-MAR'], '2026-10-19T00:00:00Z', '2026-10-20T00:00:00Z');
    expect(orders).toHaveLength(2);
    expect(orders[1]).toMatchObject({ covers: 2, tradingDate: '2026-10-19' });
    expect(t.calls.find((c) => c.url.includes('ordersBulk'))!.headers['toast-restaurant-external-id']).toBe('R-MAR');
    expect(t.calls.filter((c) => c.url.endsWith('/login'))).toHaveLength(1); // the token is reused
    // The 00:40 order (01:40 local) stays on Monday, as Toast filed it, at hour 25.
    const day = tradingDays(orders, 'Europe/London').get('2026-10-19')!;
    expect(day).toMatchObject({ netSales: 120, orders: 2, covers: 4 });
    expect(day.hours.map((h) => h.hour)).toEqual([13, 25]);
  });

  it('says plainly when Toast refuses the credentials', async () => {
    const toast = new ToastProvider({ clientId: 'id', clientSecret: 'wrong', environment: 'production', fetch: fakeToast().impl });
    await expect(toast.listLocations()).rejects.toThrow(/refused the client ID and secret/);
  });
});

/** A fake Lightspeed: token endpoint, one business with two locations, a day of receipts. */
function fakeLightspeed() {
  const calls: { url: string; body?: string; headers: Record<string, string> }[] = [];
  let issued = 0;
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, body: init.body ? String(init.body) : undefined, headers });
    if (url.endsWith('/oauth/token')) {
      const form = new URLSearchParams(String(init.body));
      if (headers.authorization !== `Basic ${Buffer.from('ls-client:ls-secret').toString('base64')}`) return json(401, {});
      if (form.get('grant_type') === 'authorization_code' && form.get('code') !== 'good-code') return json(400, {});
      issued++;
      return json(200, { access_token: `ls-access-${issued}`, refresh_token: `ls-refresh-${issued}`, expires_in: 3600 });
    }
    if (!headers.authorization?.startsWith('Bearer ls-access-')) return json(401, {});
    if (url.endsWith('/f/data/businesses')) return json(200, [{ businessName: 'East Canteen', businessLocations: [{ blName: 'Shoreditch', blId: 4501 }, { blName: 'Old pop-up', blId: 4502 }] }]);
    if (url.includes('/f/finance/4501/financials/2026-10-19T00:00:00.000Z/')) {
      return json(200, {
        sales: [
          { receiptId: 'a', timeOfCloseAndPaid: '2026-10-19T19:00:00Z', nbCovers: 4, salesLines: [{ totalNetAmountWithoutTax: '100.00' }, { totalNetAmountWithoutTax: 12.5, serviceCharge: true }] },
          { receiptId: 'b', timeOfCloseAndPaid: '2026-10-19T20:00:00Z', cancelled: true, salesLines: [{ totalNetAmountWithoutTax: 70 }] },
        ],
      });
    }
    if (url.includes('/f/finance/')) return json(200, { sales: [] });
    return json(404, {});
  }) as typeof fetch;
  return { impl, calls };
}

describe('Lightspeed', () => {
  it('counts lines net of tax, never the service charge line or a cancelled receipt', () => {
    expect(lightspeedNetSales({ salesLines: [{ totalNetAmountWithoutTax: '40.50' }, { totalNetAmountWithoutTax: -10 }, { totalNetAmountWithoutTax: 5, serviceCharge: true }] })).toBe(30.5);
    expect(lightspeedNetSales({ cancelled: true, salesLines: [{ totalNetAmountWithoutTax: 40 }] })).toBe(0);
  });

  it('refreshes an expiring token, hands the new pair back to be saved, and reads covers', async () => {
    const l = fakeLightspeed();
    const saved: unknown[] = [];
    const provider = new LightspeedProvider({
      app: { clientId: 'ls-client', clientSecret: 'ls-secret' },
      environment: 'production',
      tokens: { accessToken: 'old', refreshToken: 'ls-refresh-0', expiresAt: NOW.getTime() + 10_000 },
      fetch: l.impl,
      onTokens: async (t) => void saved.push(t),
      now: () => NOW.getTime(),
    });
    const orders = await provider.fetchOrders(['4501'], '2026-10-19T00:00:00.000Z', '2026-10-20T00:00:00.000Z');
    expect(orders).toEqual([{ locationId: '4501', closedAt: '2026-10-19T19:00:00.000Z', netSales: 100, covers: 4 }]);
    expect(saved).toHaveLength(1);
    expect(new URLSearchParams(l.calls.find((c) => c.url.endsWith('/oauth/token'))!.body).get('refresh_token')).toBe('ls-refresh-0');
  });
});

/** The demo group with its owner signed in and enrolled, plus a system key. */
async function boot(fetchImpl: typeof fetch, env: Record<string, string> = {}) {
  const k = await kit({ store: new MemoryStore(['demo'], TODAY), accounts: false, keys: [{ key: 'integration', orgId: 'demo', name: 'Integration', scopes: ['*'] }], fetch: fetchImpl, now: () => NOW, env });
  const setup = await k.form('/auth/setup', { email: OWNER.email, password: OWNER.password, confirm: OWNER.password, next: '/app/' });
  const cookie = (await enrol(k, setup.cookie!)).cookie;
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await k.call(method, url, cookie, body);
    return { status: res.status, body: res.body, location: res.location };
  };
  return { call, k };
}

describe('connecting Toast and Lightspeed', () => {
  it('connects Toast with its client credentials and syncs covers into takings', async () => {
    const t = fakeToast({
      '20261019': [toastOrder('1', 20261019, '2026-10-19T12:30:00.000+0000', 80)],
      '20261020': [toastOrder('2', 20261020, '2026-10-20T19:00:00.000+0000', 60, { numberOfGuests: 3 })],
    });
    const { call } = await boot(t.impl);
    expect((await call('PUT', '/v1/integrations/epos', { provider: 'toast', environment: 'sandbox', clientId: 'id', clientSecret: 'nope' })).status).toBe(422);
    const ok = await call('PUT', '/v1/integrations/epos', { provider: 'toast', environment: 'sandbox', clientId: 'toast-client-1234', clientSecret: 'toast-secret-9876' });
    expect(ok.status).toBe(200);
    expect(ok.body.connection).toMatchObject({ provider: 'toast', environment: 'sandbox', accountName: 'West End Dining, Marylebone' });
    expect(ok.body.tokenEndsWith).toBe('1234');
    await call('PUT', '/v1/integrations/epos/mapping', { sites: { mar: 'R-MAR' } });
    const res = await call('POST', '/v1/integrations/epos/sync', { from: '2026-10-19', to: '2026-10-21' });
    expect(res.body).toMatchObject({ ok: true, written: 3 });
    const sales = (await call('GET', '/v1/sales?siteId=mar&from=2026-10-19&to=2026-10-21')).body as { date: string; netSales: number; covers?: number }[];
    expect(sales.find((s) => s.date === '2026-10-19')).toMatchObject({ netSales: 80, covers: 2 });
    expect(sales.find((s) => s.date === '2026-10-20')).toMatchObject({ netSales: 60, covers: 3 });
  });

  it('runs the Lightspeed sign-in: state checked, code exchanged, tokens kept, back to the app', async () => {
    const l = fakeLightspeed();
    const { call } = await boot(l.impl, { LIGHTSPEED_CLIENT_ID: 'ls-client', LIGHTSPEED_CLIENT_SECRET: 'ls-secret', PRESHIFT_PUBLIC_URL: 'https://app.preshift.example' });
    expect((await call('GET', '/v1/integrations/epos')).body.providers.lightspeed).toBe(true);
    // Lightspeed is never connected by pasting a secret.
    expect((await call('PUT', '/v1/integrations/epos', { provider: 'lightspeed', environment: 'production' })).status).toBe(400);

    const start = await call('POST', '/v1/integrations/epos/lightspeed/start', { environment: 'production', next: '/app/' });
    const url = new URL(start.body.url);
    expect(url.origin).toBe('https://api.lsk.lightspeed.app');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.preshift.example/v1/integrations/epos/lightspeed/callback');
    const state = url.searchParams.get('state')!;

    expect((await call('GET', `/v1/integrations/epos/lightspeed/callback?code=good-code&state=forged`)).status).toBe(400);
    const back = await call('GET', `/v1/integrations/epos/lightspeed/callback?code=good-code&state=${state}`);
    expect(back.status).toBe(303);
    expect(back.location).toBe('/app/?epos=connected');
    const status = (await call('GET', '/v1/integrations/epos')).body;
    expect(status.connection).toMatchObject({ provider: 'lightspeed', environment: 'production', accountName: '2 Lightspeed locations' });
    expect(JSON.stringify(status)).not.toContain('ls-access');
    // The state works once only.
    expect((await call('GET', `/v1/integrations/epos/lightspeed/callback?code=good-code&state=${state}`)).status).toBe(400);
    const locations = (await call('GET', '/v1/integrations/epos/locations')).body as { id: string }[];
    expect(locations.map((x) => x.id)).toEqual(['4501', '4502']);
  });

  it('does not offer Lightspeed on a server with no Lightspeed app', async () => {
    const { call } = await boot(fakeLightspeed().impl);
    expect((await call('GET', '/v1/integrations/epos')).body.providers.lightspeed).toBe(false);
    expect((await call('POST', '/v1/integrations/epos/lightspeed/start', {})).status).toBe(409);
  });
});

describe('backfill', () => {
  it('defaults to thirteen months, so a forecast can work from the same week last year', async () => {
    const { call } = await boot(fakeToast().impl);
    await call('PUT', '/v1/integrations/epos', { provider: 'toast', environment: 'simulator' });
    expect((await call('POST', '/v1/integrations/epos/backfill', {})).body).toMatchObject({ from: '2025-09-17', to: '2026-10-21', next: '2025-09-17', written: 0 });
  });

  it('works a fortnight at a time, and knows when it has finished', async () => {
    const { call } = await boot(fakeToast().impl);
    await call('PUT', '/v1/integrations/epos', { provider: 'toast', environment: 'simulator' });
    await call('POST', '/v1/integrations/epos/backfill', { from: '2026-09-01' }); // 51 days to yesterday
    const step = await call('POST', '/v1/integrations/epos/backfill/step');
    expect(step.body).toMatchObject({ next: '2026-09-15', written: 42 }); // three sites, fourteen days
    let last = step.body;
    for (let i = 0; i < 10 && !last.finishedAt; i++) last = (await call('POST', '/v1/integrations/epos/backfill/step')).body;
    expect(last.finishedAt).toBeDefined();
    expect(last.written).toBe(3 * 51);
    // Finished, a further step changes nothing.
    expect((await call('POST', '/v1/integrations/epos/backfill/step')).body.written).toBe(3 * 51);
  });
});

describe('covers from a booking system', () => {
  it('sets covers on days that have takings, and lists the days that do not', async () => {
    const { call } = await boot(fakeToast().impl);
    await call('PUT', '/v1/sales', { rows: [{ siteId: 'mar', date: '2026-10-19', netSales: 4000, source: 'till' }] });
    const res = await call('PUT', '/v1/sales/covers', { rows: [{ siteId: 'mar', date: '2026-10-19', covers: 96 }, { siteId: 'mar', date: '2026-10-25', covers: 40 }] });
    expect(res.body).toEqual({ updated: 1, missing: [{ siteId: 'mar', date: '2026-10-25' }] });
    const day = ((await call('GET', '/v1/sales?siteId=mar&from=2026-10-19&to=2026-10-19')).body as { covers?: number; netSales: number }[])[0];
    expect(day).toMatchObject({ netSales: 4000, covers: 96 });
  });
});
