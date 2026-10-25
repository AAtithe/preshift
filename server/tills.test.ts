import { describe, expect, it } from 'vitest';
import { parseTillFeed } from '../src/engine/tillFeed';
import { LightspeedProvider, lightspeedOrder } from './integrations/epos/lightspeed';
import { MemoryStore } from './store';
import { enrol, kit, TODAY } from './testkit';

const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };
const NOW = new Date('2026-10-22T09:00:00Z'); // Thursday morning: Monday to Wednesday have finished trading
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const LS_ENV = {
  LIGHTSPEED_CLIENT_ID: 'preshift',
  LIGHTSPEED_CLIENT_SECRET: 'shh',
  LIGHTSPEED_AUTH_BASE: 'https://auth.example/realms/k-series',
  LIGHTSPEED_API_BASE: 'https://api.example',
  PRESHIFT_APP_URL: 'https://app.preshift.example',
};

const sale = (closed: string, net: string, extra: Record<string, unknown> = {}) => ({
  accountReference: `A-${closed}`,
  type: 'SALE',
  timeClosed: closed,
  salesLines: [{ totalNetAmountWithoutTax: net, serviceCharge: '0', currency: 'GBP' }],
  payments: [{ tip: '0' }],
  ...extra,
});

/** A fake Lightspeed: sign-in, one business with two locations, and sales by page. */
function fakeLightspeed(sales: Record<string, unknown[][]> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  let issued = 0;
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === `${LS_ENV.LIGHTSPEED_AUTH_BASE}/protocol/openid-connect/token`) {
      const form = new URLSearchParams(String(init.body));
      if (form.get('grant_type') === 'authorization_code' && form.get('code') !== 'good-code') return json(400, { error: 'invalid_grant' });
      issued++;
      return json(200, { access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 300 });
    }
    if (!String((init.headers as Record<string, string>).authorization).startsWith('Bearer access-')) return json(401, {});
    if (url.startsWith(`${LS_ENV.LIGHTSPEED_API_BASE}/f/data/businesses`)) {
      return json(200, { _embedded: { businessList: [{ businessName: 'West End Dining', businessLocations: [{ blID: 101, blName: 'Marylebone', timezone: 'Europe/London' }, { blID: 102, blName: 'Fitzrovia', timezone: 'Europe/London' }] }] } });
    }
    const m = /\/f\/v2\/business-location\/(\d+)\/sales\?(.*)$/.exec(url);
    if (m) {
      const pages = sales[m[1]] ?? [[]];
      const q = new URLSearchParams(m[2]);
      const page = Number(q.get('nextPageToken') || 0);
      return json(200, { sales: pages[page] ?? [], ...(page + 1 < pages.length ? { nextPageToken: String(page + 1) } : {}) });
    }
    return json(404, {});
  }) as typeof fetch;
  return { impl, calls };
}

async function boot(fetchImpl: typeof fetch, env: NodeJS.ProcessEnv = {}) {
  const k = await kit({ store: new MemoryStore(['demo'], TODAY), accounts: false, fetch: fetchImpl, now: () => NOW, env });
  const setup = await k.form('/auth/setup', { email: OWNER.email, password: OWNER.password, confirm: OWNER.password, next: '/app/' });
  const cookie = (await enrol(k, setup.cookie!)).cookie;
  const call = (method: string, url: string, body?: unknown) => k.call(method, url, cookie, body);
  return { k, call };
}

describe('Lightspeed takings', () => {
  it('counts sales and refunds net of VAT, keeps tips and service charge apart, and skips voids and bookkeeping records', () => {
    const o = lightspeedOrder(
      sale('2026-10-19T20:15:00Z', '40.000000', {
        salesLines: [
          { totalNetAmountWithoutTax: '25.500000', serviceCharge: '3.19', currency: 'GBP' },
          { totalNetAmountWithoutTax: '14.500000', serviceCharge: '1.81', currency: 'GBP' },
        ],
        payments: [{ tip: '4.00' }, { tip: '1.50' }],
      }),
      '101',
    );
    expect(o).toMatchObject({ locationId: '101', netSales: 40, serviceCharge: 5, tips: 5.5, closedAt: '2026-10-19T20:15:00.000Z' });
    expect(lightspeedOrder(sale('2026-10-19T21:00:00Z', '-12.000000', { type: 'REFUND' }), '101')!.netSales).toBe(-12);
    for (const type of ['VOID', 'SPLIT', 'TRANSFER', 'UPDATE', 'CANCEL']) expect(lightspeedOrder(sale('2026-10-19T21:00:00Z', '10', { type }), '101')).toBeNull();
    expect(lightspeedOrder(sale('2026-10-19T21:00:00Z', '10', { cancelled: true }), '101')).toBeNull();
    expect(() => lightspeedOrder(sale('2026-10-19T21:00:00Z', '10', { salesLines: [{ totalNetAmountWithoutTax: '10', currency: 'EUR' }] }), '101')).toThrow(/EUR/);
  });

  it('swaps the refresh token for an access token, saves the rotated one, and follows every page of sales', async () => {
    const fake = fakeLightspeed({ '101': [[sale('2026-10-19T12:00:00Z', '50')], [sale('2026-10-19T13:00:00Z', '30')]] });
    const saved: string[] = [];
    const ls = new LightspeedProvider({
      config: { clientId: 'preshift', clientSecret: 'shh', authBase: LS_ENV.LIGHTSPEED_AUTH_BASE, apiBase: LS_ENV.LIGHTSPEED_API_BASE },
      tokens: { refreshToken: 'refresh-0' },
      fetch: fake.impl,
      now: () => NOW,
      onTokens: async (t) => void saved.push(t.refreshToken),
    });
    const orders = await ls.fetchOrders(['101'], '2026-10-19T00:00:00Z', '2026-10-20T00:00:00Z');
    expect(orders.map((o) => o.netSales)).toEqual([50, 30]);
    expect(saved).toEqual(['refresh-1']);
    const salesCalls = fake.calls.filter((c) => c.url.includes('/sales?'));
    expect(salesCalls).toHaveLength(2);
    expect(new URL(salesCalls[0].url).searchParams.get('include')).toBe('payments');
    expect(new URL(salesCalls[1].url).searchParams.get('nextPageToken')).toBe('1');
    // The access token is reused while it lasts: one swap for every call above.
    expect(fake.calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
    expect((await ls.listLocations()).map((l) => [l.id, l.name])).toEqual([['101', 'Marylebone'], ['102', 'Fitzrovia']]);
  });

  it('connects through Lightspeed sign-in, only from a state Preshift issued, and brings takings in', async () => {
    const fake = fakeLightspeed({ '101': [[sale('2026-10-19T19:00:00Z', '120'), sale('2026-10-20T00:30:00Z', '30')]] });
    const { k, call } = await boot(fake.impl, LS_ENV);
    expect((await call('GET', '/v1/integrations/epos')).body.providers.map((p: { id: string }) => p.id)).toContain('lightspeed');

    const start = await call('PUT', '/v1/integrations/epos', { provider: 'lightspeed' });
    expect(start.status).toBe(200);
    const authorize = new URL(start.body.authorizeUrl);
    expect(authorize.origin + authorize.pathname).toBe(`${LS_ENV.LIGHTSPEED_AUTH_BASE}/protocol/openid-connect/auth`);
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${LS_ENV.PRESHIFT_APP_URL}/auth/lightspeed/callback`);
    expect(authorize.searchParams.get('scope')).toBe('financial-api');
    const state = authorize.searchParams.get('state')!;
    // Nothing is connected until Lightspeed sends them back.
    expect((await call('GET', '/v1/integrations/epos')).body.connection).toBeNull();

    // A made-up state connects nothing.
    const forged = await k.call('GET', `/auth/lightspeed/callback?code=good-code&state=made-up`, null);
    expect(forged.location).toContain('epos=expired');

    const back = await k.call('GET', `/auth/lightspeed/callback?code=good-code&state=${state}`, null);
    expect(back.status).toBe(302);
    expect(back.location).toBe('/app/?view=settings&epos=connected');
    const status = (await call('GET', '/v1/integrations/epos')).body;
    expect(status.connection).toMatchObject({ provider: 'lightspeed', accountName: 'West End Dining', connectedBy: expect.any(String) });
    expect(status.tokenEndsWith).toBeNull();
    // The state is spent: the same link again connects nothing new.
    expect((await k.call('GET', `/auth/lightspeed/callback?code=good-code&state=${state}`, null)).location).toContain('epos=expired');

    expect((await call('PUT', '/v1/integrations/epos/mapping', { sites: { mar: '101' } })).status).toBe(200);
    const synced = await call('POST', '/v1/integrations/epos/sync', { from: '2026-10-19', to: '2026-10-19' });
    expect(synced.body).toMatchObject({ ok: true, written: 1 });
    const monday = (await call('GET', '/v1/sales?from=2026-10-19&to=2026-10-19')).body.find((d: { siteId: string }) => d.siteId === 'mar');
    // 00:30 on Tuesday morning is Monday night.
    expect(monday.netSales).toBe(150);
  });

  it('is not offered until Preshift has a Lightspeed app', async () => {
    const { call } = await boot(fakeLightspeed().impl);
    expect((await call('GET', '/v1/integrations/epos')).body.providers.map((p: { id: string }) => p.id)).not.toContain('lightspeed');
    expect((await call('PUT', '/v1/integrations/epos', { provider: 'lightspeed' })).status).toBe(409);
  });
});

describe('Zonal and Tevalis file feeds', () => {
  it('reads either till’s export by its column names, UK dates, pounds and refunds, and skips the totals line', () => {
    const zonal = parseTillFeed(
      [
        'Site Ref,Site Name,Trading Date,Hour,Net Sales,Gratuity,Service Charge,Checks',
        '0042,Marylebone,19/10/2026,19,"£1,250.40",42.00,156.30,31',
        '0042,Marylebone,19/10/2026,01,(20.00),0,0,1',
        'Total,,,,"£1,230.40",42.00,156.30,32',
      ].join('\n'),
    );
    expect(zonal.problems).toEqual([]);
    expect(zonal.rows).toEqual([
      { locationId: '0042', locationName: 'Marylebone', date: '2026-10-19', hour: 19, netSales: 1250.4, tips: 42, serviceCharge: 156.3, orders: 31 },
      { locationId: '0042', locationName: 'Marylebone', date: '2026-10-19', hour: 1, netSales: -20, tips: 0, serviceCharge: 0, orders: 1 },
    ]);
    const tevalis = parseTillFeed('Site,Date,Net,Tips,Service\nShoreditch,2026-10-19,980.00,12.50,0\n');
    expect(tevalis.rows[0]).toMatchObject({ locationId: 'Shoreditch', date: '2026-10-19', netSales: 980, tips: 12.5 });
    expect(tevalis.rows[0].hour).toBeUndefined();
    expect(parseTillFeed('Name,Amount\nx,1').problems[0].message).toMatch(/site reference, trading date, net sales/);
    expect(parseTillFeed('Site,Date,Net\n1,someday,10').problems[0]).toMatchObject({ line: 2 });
  });

  it('takes a feed only with its key, maps its sites, and writes finished days with the small hours on the night before', async () => {
    const { k, call } = await boot(fakeLightspeed().impl, { PRESHIFT_APP_URL: 'https://app.preshift.example' });
    const connected = await call('PUT', '/v1/integrations/epos', { provider: 'zonal' });
    expect(connected.status).toBe(200);
    const key: string = connected.body.feedKey;
    expect(key).toMatch(/^psf_/);
    expect(connected.body.feedUrl).toBe('https://app.preshift.example/v1/integrations/epos/feed/demo');
    // The key is never shown again.
    expect(JSON.stringify((await call('GET', '/v1/integrations/epos')).body)).not.toContain(key);

    const post = (body: string, auth = `Bearer ${key}`) =>
      k.app.inject({ method: 'POST', url: '/v1/integrations/epos/feed/demo', headers: { authorization: auth, 'content-type': 'text/csv' }, payload: body });
    const csv = (rows: string[]) => ['Site Ref,Site Name,Trading Date,Hour,Net Sales,Gratuity,Service Charge,Checks', ...rows].join('\n');
    const monday = csv(['0042,Marylebone,19/10/2026,19,1000,40,120,25', '0042,Marylebone,19/10/2026,01,200,10,0,5', '0042,Marylebone,22/10/2026,12,500,0,0,10']);

    expect((await post(monday, 'Bearer psf_wrong')).statusCode).toBe(401);
    expect((await post(monday, '')).statusCode).toBe(401);
    expect((await k.app.inject({ method: 'POST', url: '/v1/integrations/epos/feed/nobody', headers: { authorization: `Bearer ${key}`, 'content-type': 'text/csv' }, payload: monday })).statusCode).toBe(401);

    // Before any site is matched, the rows are kept and the site reference offered for matching.
    const first = await post(monday);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ received: 3, problems: [], sync: null });
    const locations = (await call('GET', '/v1/integrations/epos/locations')).body;
    expect(locations).toEqual([expect.objectContaining({ id: '0042', name: 'Marylebone' })]);
    expect((await call('PUT', '/v1/integrations/epos/mapping', { sites: { mar: '0042' } })).status).toBe(200);

    // Sent again, the same rows replace what was sent rather than adding to it.
    const again = await post(monday);
    expect(again.json().sync).toMatchObject({ ok: true, written: 1 });
    const sales = (await call('GET', '/v1/sales?from=2026-10-19&to=2026-10-22')).body.filter((d: { siteId: string }) => d.siteId === 'mar');
    const mon = sales.find((d: { date: string }) => d.date === '2026-10-19');
    expect(mon).toMatchObject({ netSales: 1200, orders: 30, source: 'till' });
    expect(mon.hours.map((h: { hour: number }) => h.hour)).toEqual([19, 25]);
    // Thursday is still trading: not written.
    expect(sales.some((d: { date: string }) => d.date === '2026-10-22')).toBe(false);

    // A manager can upload the same export by hand.
    const uploaded = await call('POST', '/v1/integrations/epos/feed-upload', { csv: csv(['0042,Marylebone,20/10/2026,,800,0,0,20']) });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.sync).toMatchObject({ ok: true });
    const tue = (await call('GET', '/v1/sales?from=2026-10-20&to=2026-10-20')).body.find((d: { siteId: string }) => d.siteId === 'mar');
    expect(tue).toMatchObject({ netSales: 800, hours: [] });
  });
});
