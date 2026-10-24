import { beforeEach, describe, expect, it } from 'vitest';
import { AccountingSimulator } from './integrations/accounting/simulator';
import { MemoryStore } from './store';
import { enrol, kit, TODAY } from './testkit';

const WEEK = '2026-10-19';
const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };
const person = (key: string, userId: string) => ({ key, orgId: 'demo', name: `${key} key`, scopes: ['*'] as ['*'], userId, mfa: true });

async function boot(options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; now?: () => Date } = {}) {
  const store = new MemoryStore(['demo'], TODAY);
  const k = await kit({
    store,
    accounts: false,
    keys: [person('fd', 'usr_fd'), person('ma', 'usr_ws_ma'), person('gm', 'usr_gm_mar')],
    env: options.env,
    fetch: options.fetch,
    now: options.now ?? (() => new Date(`${TODAY}T09:00:00Z`)),
  });
  // Connecting Xero is a settings change: a person signed in with an authenticator, never a key.
  const setup = await k.form('/auth/setup', { email: OWNER.email, password: OWNER.password, confirm: OWNER.password, next: '/app/' });
  const cookie = (await enrol(k, setup.cookie!)).cookie;
  const as = (key: string) => (method: string, url: string, body?: unknown) => k.call(method, url, { key }, body);
  return { k, store, cookie, owner: (method: string, url: string, body?: unknown) => k.call(method, url, cookie, body), fd: as('fd'), ma: as('ma'), gm: as('gm') };
}

beforeEach(() => AccountingSimulator.reset('demo'));

describe('posting the labour journal to Xero', () => {
  it('connects, matches each company to its Xero organisation by name, and posts a draft with its reversal', async () => {
    const t = await boot();
    expect((await t.fd('POST', '/v1/integrations/xero/connect', { environment: 'simulator' })).status).toBe(403);
    const connected = await t.owner('POST', '/v1/integrations/xero/connect', { environment: 'simulator' });
    expect(connected.status).toBe(200);
    expect(connected.body.ledgers).toEqual([
      expect.objectContaining({ entityId: 'wdl', tenantId: 'sim-wdl', tenantName: 'West End Dining Ltd', status: 'DRAFT', reverse: true }),
      expect.objectContaining({ entityId: 'eck', tenantId: 'sim-eck', status: 'DRAFT', reverse: true }),
    ]);

    const check = await t.fd('GET', `/v1/journal/xero/check?weekStart=${WEEK}&entityId=wdl`);
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({ problems: [], posting: null, changed: false, ledger: { tenantName: 'West End Dining Ltd' } });
    expect(check.body.debits).toBeGreaterThan(0);

    const posted = await t.ma('POST', '/v1/journal/xero', { weekStart: WEEK, entityId: 'wdl' });
    expect(posted.status).toBe(200);
    expect(posted.body).toMatchObject({ entityId: 'wdl', tenantId: 'sim-wdl', date: '2026-10-25', reversalDate: '2026-10-26', status: 'DRAFT', postedBy: 'Leah Turner', debits: check.body.debits });
    const books = AccountingSimulator.journals('demo');
    const accrual = books.find((j) => j.id === posted.body.journalId)!;
    const back = books.find((j) => j.id === posted.body.reversalId)!;
    expect(accrual).toMatchObject({ tenantId: 'sim-wdl', status: 'DRAFT', journal: { date: '2026-10-25' } });
    expect(accrual.journal.lines.reduce((s, l) => s + l.amount, 0)).toBeCloseTo(0, 2);
    expect(back.journal.lines.map((l) => l.amount)).toEqual(accrual.journal.lines.map((l) => -l.amount));
    expect(accrual.journal.lines.some((l) => l.tracking?.name === 'Site')).toBe(true);
    expect((await t.store.load('demo')).audit.some((a) => a.action === 'journal.posted')).toBe(true);
  });

  it('never posts a week twice, and replaces it only when asked, voiding the one before', async () => {
    const t = await boot();
    await t.owner('POST', '/v1/integrations/xero/connect', { environment: 'simulator' });
    await t.owner('PUT', '/v1/integrations/xero/ledgers/wdl', { tenantId: 'sim-wdl', status: 'POSTED' });
    // On the rota, so the shift added below changes the journal.
    const first = await t.fd('POST', '/v1/journal/xero', { weekStart: WEEK, entityId: 'wdl', basis: 'rota' });
    expect(first.body.status).toBe('POSTED');

    const again = await t.fd('POST', '/v1/journal/xero', { weekStart: WEEK, entityId: 'wdl', basis: 'rota' });
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/Already posted to Xero on 2026-10-21 by Nadia Rahman, and nothing has changed since/);

    // A shift added after posting changes the journal.
    const org = await t.store.load('demo');
    const e = org.state.employees.find((x) => x.siteId === 'mar' && x.payBasis === 'hourly' && !x.leaveDate)!;
    org.state.shifts.push({ id: 'late-extra', employeeId: e.id, roleId: e.roleIds[0], siteId: 'mar', date: '2026-10-20', startMinute: 600, endMinute: 1080, breakMinutes: 30 });
    expect((await t.fd('GET', `/v1/journal/xero/check?weekStart=${WEEK}&entityId=wdl&basis=rota`)).body.changed).toBe(true);
    const changed = await t.fd('POST', '/v1/journal/xero', { weekStart: WEEK, entityId: 'wdl', basis: 'rota' });
    expect(changed.status).toBe(409);
    expect(changed.body.message).toMatch(/has changed since. Post again with replace/);

    const replaced = await t.fd('POST', '/v1/journal/xero', { weekStart: WEEK, entityId: 'wdl', basis: 'rota', replace: true });
    expect(replaced.status).toBe(200);
    expect(replaced.body.fingerprint).not.toBe(first.body.fingerprint);
    const books = AccountingSimulator.journals('demo');
    expect(books.find((j) => j.id === first.body.journalId)!.status).toBe('VOIDED');
    expect(books.find((j) => j.id === first.body.reversalId)!.status).toBe('VOIDED');
    const history = (await t.fd('GET', '/v1/journal/xero/postings?entityId=wdl')).body.postings;
    expect(history.map((p: { id: string; replacedBy?: string }) => [p.id, p.replacedBy ?? null])).toEqual([[replaced.body.id, null], [first.body.id, replaced.body.id]]);

    // Taken out by hand: the week can be posted fresh.
    const removed = await t.fd('POST', `/v1/journal/xero/postings/${replaced.body.id}/remove`);
    expect(removed.body.removedBy).toBe('Nadia Rahman');
    expect(books.find((j) => j.id === replaced.body.journalId)!.status).toBe('VOIDED');
    expect((await t.fd('POST', `/v1/journal/xero/postings/${replaced.body.id}/remove`)).status).toBe(409);
    expect((await t.fd('POST', '/v1/journal/xero', { weekStart: WEEK, entityId: 'wdl' })).status).toBe(200);
  });

  it('refuses to post where the ledger is not ready, and keeps it from people outside the close', async () => {
    const t = await boot();
    const before = await t.fd('POST', '/v1/journal/xero', { weekStart: WEEK, entityId: 'wdl' });
    expect(before.status).toBe(422);
    expect(before.body.details).toEqual(['Xero is not connected. Connect it from Integrations.']);
    await t.owner('POST', '/v1/integrations/xero/connect', { environment: 'simulator' });
    await t.owner('PUT', '/v1/integrations/xero/ledgers/wdl', { tenantId: null });
    expect((await t.fd('POST', '/v1/journal/xero', { weekStart: WEEK, entityId: 'wdl' })).body.details).toEqual(['Choose which Xero organisation West End Dining Ltd posts to, under Integrations.']);
    // One set of books per company.
    const clash = await t.owner('PUT', '/v1/integrations/xero/ledgers/wdl', { tenantId: 'sim-eck' });
    expect(clash.status).toBe(409);
    expect(clash.body.message).toMatch(/East Canteen & Kitchen Ltd already posts to that Xero organisation/);
    // A role with no code in the chart is caught before Xero sees it.
    await t.owner('PUT', '/v1/integrations/xero/ledgers/wdl', { tenantId: 'sim-wdl' });
    expect((await t.fd('GET', `/v1/journal/xero/check?weekStart=${WEEK}&entityId=wdl`)).body.problems).toEqual([]);
    const org = await t.store.load('demo');
    org.state.roles = org.state.roles.map((r) => ({ ...r, nominalCode: '9999' }));
    const unknown = await t.fd('POST', '/v1/journal/xero', { weekStart: WEEK, entityId: 'wdl' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.details.join(' ')).toMatch(/Account 9999 \(Wages - .*\) is not in the chart of accounts/);

    expect((await t.gm('POST', '/v1/journal/xero', { weekStart: WEEK, entityId: 'wdl' })).status).toBe(403);
    expect((await t.gm('GET', `/v1/journal/xero/check?weekStart=${WEEK}&entityId=wdl`)).status).toBe(403);
    expect((await t.fd('POST', '/v1/journal/xero', { weekStart: '2026-10-20', entityId: 'wdl' })).status).toBe(400);
    expect((await t.fd('POST', '/v1/journal/xero', { weekStart: WEEK, entityId: 'nope' })).status).toBe(404);
    expect(AccountingSimulator.journals('demo')).toEqual([]);
  });
});

describe('connecting real Xero', () => {
  const env = { XERO_CLIENT_ID: 'client', XERO_CLIENT_SECRET: 'secret', PRESHIFT_APP_URL: 'https://preshift.example' };

  /** Xero, as far as Preshift sees it: tokens, the two organisations, their chart and tracking, and journals. */
  function fakeXero(chart: () => Promise<{ codes: string[]; sites: string[] }>) {
    const sent: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
    let token = 0;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const fetch = (async (url: string, init: RequestInit = {}) => {
      const req = { url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body as string | undefined };
      sent.push(req);
      if (url === 'https://identity.xero.com/connect/token') {
        token += 1;
        return json({ access_token: `at${token}`, refresh_token: `rt${token}`, expires_in: 1800 });
      }
      if (url === 'https://api.xero.com/connections') {
        return json([
          { id: 'c1', tenantId: 't-wdl', tenantType: 'ORGANISATION', tenantName: 'West End Dining Ltd' },
          { id: 'c2', tenantId: 't-eck', tenantType: 'ORGANISATION', tenantName: 'East Canteen & Kitchen Ltd' },
        ]);
      }
      if (url.endsWith('/Accounts')) {
        // Every code the demo's journal uses, as the group's real chart would hold them.
        return json({ Accounts: (await chart()).codes.map((Code) => ({ Code, Name: Code, Status: 'ACTIVE' })) });
      }
      if (url.endsWith('/TrackingCategories')) return json({ TrackingCategories: [{ Name: 'Site', Status: 'ACTIVE', Options: (await chart()).sites.map((Name) => ({ Name, Status: 'ACTIVE' })) }] });
      if (url.endsWith('/ManualJournals')) return json({ ManualJournals: [{ ManualJournalID: `mj-${sent.length}` }] });
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;
    return { sent, fetch };
  }

  it('sends the person to Xero, takes them back, keeps the tokens and refreshes them when they run out', async () => {
    let store: MemoryStore | undefined;
    const x = fakeXero(async () => {
      const org = await store!.load('demo');
      return { codes: new AccountingSimulator('demo', org.state).chart().map((a) => a.code), sites: org.state.sites.map((x) => x.trackingCode) };
    });
    let now = new Date(`${TODAY}T09:00:00Z`);
    const t = await boot({ env, fetch: x.fetch, now: () => now });
    store = t.store as MemoryStore;
    const status = await t.owner('GET', '/v1/integrations/xero');
    expect(status.body).toMatchObject({ configured: true, connection: null });

    const owner = t.cookie;
    const start = await t.k.call('POST', '/v1/integrations/xero/connect', owner, {});
    const url = new URL(start.body.authorizeUrl);
    expect(url.searchParams.get('redirect_uri')).toBe('https://preshift.example/v1/integrations/xero/callback');
    const state = url.searchParams.get('state')!;

    // A made-up state goes nowhere.
    expect((await t.k.call('GET', '/v1/integrations/xero/callback?code=c&state=forged', owner)).location).toBe('/app/?view=close&xero=expired');
    const back = await t.k.call('GET', `/v1/integrations/xero/callback?code=the-code&state=${state}`, owner);
    expect(back.status).toBe(302);
    expect(back.location).toBe('/app/?view=close&xero=connected');
    // Used once only.
    expect((await t.k.call('GET', `/v1/integrations/xero/callback?code=the-code&state=${state}`, owner)).location).toBe('/app/?view=close&xero=expired');
    expect(JSON.parse((await t.store.getSetting('xero_tokens:demo'))!)).toMatchObject({ accessToken: 'at1', refreshToken: 'rt1' });

    const connected = (await t.owner('GET', '/v1/integrations/xero')).body;
    expect(connected.connection).toMatchObject({ environment: 'production', connectedBy: expect.any(String) });
    expect(connected.ledgers.map((l: { tenantId: string }) => l.tenantId)).toEqual(['t-wdl', 't-eck']);

    const posted = await t.fd('POST', '/v1/journal/xero', { weekStart: WEEK, entityId: 'wdl' });
    expect(posted.status, posted.raw).toBe(200);
    const journals = x.sent.filter((r) => r.url.endsWith('/ManualJournals'));
    expect(journals).toHaveLength(2);
    expect(journals[0].headers).toMatchObject({ authorization: 'Bearer at1', 'xero-tenant-id': 't-wdl', 'idempotency-key': `${posted.body.id}:accrual` });
    expect(journals[1].headers['idempotency-key']).toBe(`${posted.body.id}:reversal`);

    // Half an hour on, the access token has run out: refreshed, and the new refresh token kept.
    now = new Date(`${TODAY}T09:31:00Z`);
    expect((await t.fd('GET', `/v1/journal/xero/check?weekStart=${WEEK}&entityId=eck`)).status).toBe(200);
    expect(x.sent.filter((r) => r.url.endsWith('/Accounts')).at(-1)!.headers.authorization).toBe('Bearer at2');
    expect(JSON.parse((await t.store.getSetting('xero_tokens:demo'))!)).toMatchObject({ refreshToken: 'rt2' });

    // Disconnecting takes the app out of both organisations and forgets the tokens.
    await t.k.call('DELETE', '/v1/integrations/xero', owner);
    expect(x.sent.filter((r) => r.method === 'DELETE').map((r) => r.url)).toEqual(['https://api.xero.com/connections/c1', 'https://api.xero.com/connections/c2']);
    expect(await t.store.getSetting('xero_tokens:demo')).toBeNull();
  });

  it('offers only the simulator where Xero is not set up', async () => {
    const t = await boot();
    expect((await t.owner('GET', '/v1/integrations/xero')).body).toMatchObject({ configured: false, simulatorAllowed: true });
    const owner = t.cookie;
    expect((await t.k.call('POST', '/v1/integrations/xero/connect', owner, {})).status).toBe(409);
  });
});
