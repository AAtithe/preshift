import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { weekStart } from '../src/engine/time';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { emailSetting } from './mail';
import { COOKIE, STAFF_COOKIE } from './session';
import { MemoryStore, PgStore, type Query, type Store } from './store';

const SITE = { lat: 51.5205, lng: -0.1517 };
const AT_SITE = { ...SITE, accuracyMetres: 10 };
const AWAY = { lat: SITE.lat + 400 / 111_195, lng: SITE.lng, accuracyMetres: 10 };
const PASSWORD = 'pint of best bitter';

function pglite(): Query {
  const db = new PGlite();
  return async (text, params) => (await db.query(text, params)).rows as Record<string, unknown>[];
}

async function boot(store: Store = new MemoryStore(['demo'], '2026-10-21')) {
  const { app } = await buildApp({
    apiKeys: [{ key: 'manager', orgId: 'demo', name: 'GM', scopes: ['*'] }],
    store,
    provider: new TeamPaySimulator(),
    autoDispatch: false,
  });
  const call = async (method: string, url: string, body?: unknown, cookie?: string) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = String(res.headers['set-cookie'] ?? '').split(';')[0];
    return { status: res.statusCode, body: res.body ? res.json() : undefined, cookie: setCookie.endsWith('=') ? '' : setCookie };
  };
  const manager = (method: string, url: string, body?: unknown) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: 'Bearer manager', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    }).then((r) => ({ status: r.statusCode, body: r.body ? r.json() : undefined }));

  async function invite(person: string) {
    const res = await manager('POST', `/v1/staff-logins/${person}/invite`);
    expect(res.status).toBe(201);
    // The details ride after #, never in the address a server sees.
    const url = new URL(res.body.path, 'https://x');
    expect(url.search).toBe('');
    return Object.fromEntries(new URLSearchParams(url.hash.slice(1))) as { org: string; person: string; invite: string };
  }
  async function join(person: string, email: string) {
    return call('POST', '/v1/staff/join', { ...(await invite(person)), email, password: PASSWORD });
  }
  return { app, call, manager, invite, join };
}

describe('staff logins', () => {
  it('invite, set up, clock in and out on the phone inside the site fence', async () => {
    const t = await boot();
    const link = await t.invite('mar-1');
    expect((await t.call('POST', '/v1/staff/invite', link)).body.name).toBeTruthy();
    // Asking with the token in the address is not offered at all.
    expect((await t.call('GET', `/v1/staff/invite?${new URLSearchParams(link)}`)).status).toBe(404);

    const joined = await t.call('POST', '/v1/staff/join', { ...link, email: 'Priya@Example.com', password: PASSWORD });
    expect(joined.status).toBe(200);
    expect(joined.cookie.startsWith(`${STAFF_COOKIE}=`)).toBe(true);
    expect(joined.body.email).toBe('priya@example.com');
    const me = joined.cookie;

    // The link works once.
    expect((await t.call('POST', '/v1/staff/join', { ...link, email: 'x@example.com', password: PASSWORD })).status).toBe(410);

    // No site location set: a phone cannot prove where it is, so phone clocking is closed.
    expect((await t.call('POST', '/v1/staff/clock-in', { location: AT_SITE }, me)).body.error).toBe('site_not_set_up');

    await t.manager('PUT', '/v1/sites/mar/geofence', { ...SITE, radiusMetres: 100 });
    expect((await t.call('POST', '/v1/staff/clock-in', {}, me)).body.error).toBe('location_required');
    expect((await t.call('POST', '/v1/staff/clock-in', { location: AWAY }, me)).body.error).toBe('outside_site');

    const clockedIn = await t.call('POST', '/v1/staff/clock-in', { location: AT_SITE }, me);
    expect(clockedIn.status).toBe(200);
    expect(clockedIn.body.open).toMatchObject({ siteId: 'mar', method: 'phone', status: 'open' });

    const entries = await t.manager('GET', '/v1/time-entries?siteId=mar');
    expect(entries.body.find((e: { id: string }) => e.id === clockedIn.body.open.id).clockInLocation.distanceMetres).toBe(0);

    expect((await t.call('POST', '/v1/staff/clock-out', { location: AWAY }, me)).body.error).toBe('outside_site');
    const out = await t.call('POST', '/v1/staff/clock-out', { location: AT_SITE }, me);
    expect(out.body.open).toBeNull();
    expect(out.body.recent[0]).toMatchObject({ status: 'submitted', method: 'phone' });

    expect((await t.manager('GET', '/v1/staff-logins')).body[0]).toMatchObject({ employeeId: 'mar-1', status: 'active', email: 'priya@example.com' });
  });

  it("shows the team's notes for the day beside the shift, never the managers' own", async () => {
    const t = await boot();
    const me = (await t.join('mar-1', 'priya@example.com')).cookie;
    const { body: first } = await t.call('GET', '/v1/staff/me', undefined, me);
    const day = first.today;
    await t.manager('POST', '/v1/shifts', { employeeId: 'mar-1', roleId: 'bar', siteId: 'mar', date: day, startMinute: 1020, endMinute: 1380, breakMinutes: 30 });
    const told = await t.manager('POST', '/v1/day-notes', { siteId: 'mar', date: day, kind: 'booking', startMinute: 1170, text: 'Party of 24, set menu.', team: true });
    const kept = await t.manager('POST', '/v1/day-notes', { siteId: 'mar', date: day, kind: 'staffing', text: 'Talk to Priya about her hours.' });
    const elsewhere = await t.manager('POST', '/v1/day-notes', { siteId: 'shd', date: day, kind: 'event', text: 'Gig next door.', team: true });
    await t.manager('POST', '/v1/rota/publish', { siteId: 'mar', weekStart: weekStart(day) });
    const [shift] = (await t.call('GET', '/v1/staff/me', undefined, me)).body.shifts;
    const ids = shift.notes.map((n: { id: string }) => n.id);
    expect(shift.notes.find((n: { id: string }) => n.id === told.body.id)).toEqual({ id: told.body.id, kind: 'Booking', startMinute: 1170, text: 'Party of 24, set menu.' });
    expect(ids).not.toContain(kept.body.id);
    expect(ids).not.toContain(elsewhere.body.id);
  });

  it('shows only the person their own published shifts', async () => {
    const t = await boot();
    const me = (await t.join('mar-1', 'priya@example.com')).cookie;
    const { body: today } = await t.call('GET', '/v1/staff/me', undefined, me);
    const shift = { roleId: 'bar', siteId: 'mar', date: today.today, startMinute: 1020, endMinute: 1380, breakMinutes: 30 };
    await t.manager('POST', '/v1/shifts', { ...shift, employeeId: 'mar-1' });
    await t.manager('POST', '/v1/shifts', { ...shift, employeeId: 'mar-2' });
    expect((await t.call('GET', '/v1/staff/me', undefined, me)).body.shifts).toEqual([]);
    const pub = await t.manager('POST', '/v1/rota/publish', { siteId: 'mar', weekStart: weekStart(today.today) });
    expect(pub.status).toBe(200);
    const shifts = (await t.call('GET', '/v1/staff/me', undefined, me)).body.shifts;
    expect(shifts).toEqual([{ id: expect.any(String), date: today.today, startMinute: 1020, endMinute: 1380, breakMinutes: 30, siteName: 'Marylebone', roleName: expect.any(String), notes: expect.any(Array) }]);
    expect(JSON.stringify((await t.call('GET', '/v1/staff/me', undefined, me)).body)).not.toMatch(/mar-2/);
  });

  it('never lets a staff session into the manager app or API', async () => {
    const t = await boot();
    const staff = (await t.join('mar-1', 'priya@example.com')).cookie;
    const token = staff.split('=').slice(1).join('=');
    expect((await t.call('GET', '/v1/employees', undefined, staff)).status).toBe(401);
    expect((await t.call('GET', '/v1/employees', undefined, `${COOKIE}=${token}`)).status).toBe(401);
    expect((await t.call('GET', '/auth/me', undefined, `${COOKIE}=${token}`)).status).toBe(401);
    expect((await t.call('GET', '/v1/staff-logins', undefined, staff)).status).toBe(401);
  });

  it('signs in, locks after five wrong passwords, and never hands over a link to a login someone has set up', async () => {
    const t = await boot();
    const first = (await t.join('mar-1', 'priya@example.com')).cookie;
    expect((await t.call('POST', '/v1/staff/login', { email: 'priya@example.com', password: 'wrong password!' })).status).toBe(401);
    const ok = await t.call('POST', '/v1/staff/login', { email: ' PRIYA@example.com', password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.cookie).toMatch(new RegExp(`^${STAFF_COOKIE}=`));

    for (let i = 0; i < 5; i++) await t.call('POST', '/v1/staff/login', { email: 'priya@example.com', password: 'wrong password!' });
    expect((await t.call('POST', '/v1/staff/login', { email: 'priya@example.com', password: PASSWORD })).body.error).toBe('locked');

    // Forgotten password: a new link opens her clocking, so it only ever goes to her own email.
    // Without email set up it is refused, and no link is made.
    const refused = await t.manager('POST', '/v1/staff-logins/mar-1/invite');
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('email_only');
    expect(JSON.stringify(refused.body)).not.toMatch(/invite=/);
    expect((await t.call('GET', '/v1/staff/me', undefined, first)).status).toBe(200);
  }, 60_000);

  it('ends access when the login is closed or the person leaves', async () => {
    const t = await boot();
    const a = (await t.join('mar-1', 'priya@example.com')).cookie;
    const b = (await t.join('mar-2', 'sam@example.com')).cookie;
    expect((await t.manager('DELETE', '/v1/staff-logins/mar-1')).status).toBe(204);
    expect((await t.call('GET', '/v1/staff/me', undefined, a)).status).toBe(401);

    await t.manager('POST', '/v1/employees/mar-2/leaver', { leaveDate: '2026-10-21' });
    expect((await t.call('GET', '/v1/staff/me', undefined, b)).status).toBe(401);
    expect((await t.call('POST', '/v1/staff/login', { email: 'sam@example.com', password: PASSWORD })).body.error).toBe('closed');
    expect((await t.manager('POST', '/v1/staff-logins/mar-2/invite')).status).toBe(409);
  });

  it('keeps one email to one staff login, in Postgres too', async () => {
    const t = await boot(new PgStore(pglite(), ['demo'], '2026-10-21'));
    expect((await t.join('mar-1', 'priya@example.com')).status).toBe(200);
    const clash = await t.join('mar-2', 'priya@example.com');
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe('email_taken');
    expect((await t.call('POST', '/v1/staff/login', { email: 'priya@example.com', password: PASSWORD })).status).toBe(200);
  }, 60_000);

  it('records breaks on the phone without a location, and says what the shift is owed', async () => {
    const t = await boot();
    const me = (await t.join('mar-1', 'priya@example.com')).cookie;
    await t.manager('PUT', '/v1/sites/mar/geofence', { ...SITE, radiusMetres: 100 });
    expect((await t.call('POST', '/v1/staff/break-start', undefined, me)).body.error).toBe('not_clocked_in');

    const { body: before } = await t.call('GET', '/v1/staff/me', undefined, me);
    await t.manager('POST', '/v1/shifts', { employeeId: 'mar-1', roleId: 'bar', siteId: 'mar', date: before.today, startMinute: 0, endMinute: 420, breakMinutes: 30 });
    await t.manager('POST', '/v1/rota/publish', { siteId: 'mar', weekStart: weekStart(before.today) });

    await t.call('POST', '/v1/staff/clock-in', { location: AT_SITE }, me);
    const onBreak = await t.call('POST', '/v1/staff/break-start', undefined, me);
    expect(onBreak.status).toBe(200);
    expect(onBreak.body.open).toMatchObject({ onBreak: true, breaks: [{ start: expect.any(Number) }] });
    expect(onBreak.body.breakEntitlement).toEqual({ minutes: 20, planned: 30, under18: false });
    expect((await t.call('POST', '/v1/staff/break-start', undefined, me)).body.error).toBe('already_on_break');

    const back = await t.call('POST', '/v1/staff/break-end', undefined, me);
    expect(back.body.open.onBreak).toBe(false);
    expect(back.body.open.breaks[0].end).toEqual(expect.any(Number));

    const out = await t.call('POST', '/v1/staff/clock-out', { location: AT_SITE }, me);
    expect(out.body.recent[0].breaks).toHaveLength(1);
  });
});

describe('staff app invitation emails', () => {
  const EMAIL = { resendApiKey: 're_test_abcd', from: 'Preshift <rota@ws.example>', appUrl: 'https://rota.ws.example' };
  let sent: { to: string[]; subject: string; text: string; html: string }[] = [];
  let refuse = false;
  afterEach(() => vi.unstubAllGlobals());
  function stubResend() {
    sent = [];
    refuse = false;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      if (url !== 'https://api.resend.com/emails') throw new Error(`unexpected fetch ${url}`);
      if (refuse) return new Response('{"message":"domain not verified"}', { status: 403 });
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: `mail-${sent.length}` }), { status: 200 });
    });
  }
  async function withEmail(address?: string) {
    stubResend();
    const store = new MemoryStore(['demo'], '2026-10-21');
    await store.setSetting(emailSetting('demo'), JSON.stringify(EMAIL));
    const org = await store.load('demo');
    org.state.employees.find((e) => e.id === 'mar-1')!.email = address;
    return { ...(await boot(store)), store };
  }
  const linkIn = (text: string) => text.match(/https:\/\/rota\.ws\.example\/staff\/#\S+/)![0];

  it("emails the invite to the person's own address and keeps the link out of the answer", async () => {
    const t = await withEmail('Priya@Example.com');
    const res = await t.manager('POST', '/v1/staff-logins/mar-1/invite');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ emailed: true, to: 'priya@example.com' });
    expect(JSON.stringify(res.body)).not.toMatch(/invite=/);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['priya@example.com']);
    expect(sent[0].subject).toBe('GM invited you to the Preshift staff app');
    expect(sent[0].text).toMatch(/Marylebone/);

    // The emailed link is the one that works.
    const link = Object.fromEntries(new URLSearchParams(new URL(linkIn(sent[0].text)).hash.slice(1)));
    expect((await t.call('POST', '/v1/staff/join', { ...link, email: 'priya@example.com', password: PASSWORD })).status).toBe(200);

    // The list says what became of the email; a bounce reported later shows against the person.
    const listed = (await t.manager('GET', '/v1/staff-logins')).body[0];
    expect(listed.lastEmail).toMatchObject({ kind: 'staff_invite', to: 'priya@example.com', status: 'sent', employeeId: 'mar-1' });
    const org = await t.store.load('demo');
    org.mail['mail-1'].events.push({ id: 'evt-1', type: 'bounced', at: new Date().toISOString(), detail: 'Mailbox does not exist' });
    expect((await t.manager('GET', '/v1/staff-logins')).body[0].lastEmail).toMatchObject({ status: 'bounced', detail: 'Mailbox does not exist' });
  });

  it('sends a reset only to the address the person signed up with, never to the manager', async () => {
    const t = await withEmail('old@example.com');
    const first = await t.manager('POST', '/v1/staff-logins/mar-1/invite');
    expect(first.body.emailed).toBe(true);
    const link = Object.fromEntries(new URLSearchParams(new URL(linkIn(sent[0].text)).hash.slice(1)));
    const joined = await t.call('POST', '/v1/staff/join', { ...link, email: 'priya@example.com', password: PASSWORD });

    // Asking to hand it over is refused, and makes no link.
    const handed = await t.manager('POST', '/v1/staff-logins/mar-1/invite', { handOver: true });
    expect(handed.status).toBe(409);
    expect(handed.body.error).toBe('email_only');
    expect(handed.body.message).toContain('priya@example.com');
    expect(sent).toHaveLength(1);

    // The reset goes to her own address. Old sessions end once she uses it.
    const again = await t.manager('POST', '/v1/staff-logins/mar-1/invite');
    expect(again.body).toMatchObject({ emailed: true, to: 'priya@example.com' });
    expect(sent[1].subject).toBe('Your new Preshift staff app link');
    const resetLink = Object.fromEntries(new URLSearchParams(new URL(linkIn(sent[1].text)).hash.slice(1)));
    const reset = await t.call('POST', '/v1/staff/join', { ...resetLink, email: 'priya@example.com', password: 'a brand new password' });
    expect(reset.status).toBe(200);
    expect((await t.call('GET', '/v1/staff/me', undefined, joined.cookie)).status).toBe(401);
    expect((await t.call('GET', '/v1/staff/me', undefined, reset.cookie)).status).toBe(200);

    // When Resend refuses, the link still never comes back.
    refuse = true;
    const failed = await t.manager('POST', '/v1/staff-logins/mar-1/invite');
    expect(failed.body).toMatchObject({ emailed: false, reason: 'send_failed' });
    expect(failed.body.path).toBeUndefined();
  }, 60_000);

  it('lets a manager start again by closing the login, which signs the person out everywhere', async () => {
    const t = await withEmail();
    const link = (await t.manager('POST', '/v1/staff-logins/mar-1/invite')).body;
    const params = Object.fromEntries(new URLSearchParams(link.path.split('#')[1]));
    const me = (await t.call('POST', '/v1/staff/join', { ...params, email: 'priya@example.com', password: PASSWORD })).cookie;
    expect((await t.manager('DELETE', '/v1/staff-logins/mar-1')).status).toBe(204);
    expect((await t.call('GET', '/v1/staff/me', undefined, me)).status).toBe(401);
    // A fresh login, which the person sets up anew, may be handed over like any first invite.
    expect((await t.manager('POST', '/v1/staff-logins/mar-1/invite', { handOver: true })).body).toMatchObject({ emailed: false, reason: 'handed_over' });
  });

  it('hands the link back when asked, with no address, or when Resend refuses', async () => {
    const t = await withEmail('priya@example.com');
    const handed = await t.manager('POST', '/v1/staff-logins/mar-1/invite', { handOver: true });
    expect(handed.body).toMatchObject({ emailed: false, reason: 'handed_over' });
    expect(handed.body.path).toMatch(/^\/staff\/#/);
    expect(sent).toHaveLength(0);

    expect((await t.manager('POST', '/v1/staff-logins/mar-2/invite')).body).toMatchObject({ emailed: false, reason: 'no_address' });

    refuse = true;
    const failed = await t.manager('POST', '/v1/staff-logins/mar-1/invite');
    expect(failed.body).toMatchObject({ emailed: false, reason: 'send_failed' });
    expect(failed.body.path).toMatch(/^\/staff\/#/);
  });

  it('hands the link back where email is not set up, as before', async () => {
    const t = await boot();
    expect((await t.manager('POST', '/v1/staff-logins/mar-1/invite')).body).toMatchObject({ emailed: false, reason: 'email_not_set_up' });
  });
});

describe('the review of staff logins closed and opened again', () => {
  async function bootPeople() {
    const person = (key: string, userId: string) => ({ key, orgId: 'demo', name: `${key} key`, scopes: ['*' as const], userId, mfa: true });
    const store = new MemoryStore(['demo'], '2026-10-21');
    const { app } = await buildApp({
      apiKeys: [{ key: 'system', orgId: 'demo', name: 'System', scopes: ['*'] }, person('owner', 'usr_owner'), person('gm', 'usr_gm_mar'), person('fd', 'usr_fd')],
      store,
      provider: new TeamPaySimulator(),
      autoDispatch: false,
    });
    const as = (key: string) => (method: string, url: string, body?: unknown) =>
      app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, payload: body !== undefined ? JSON.stringify(body) : undefined })
        .then((r) => ({ status: r.statusCode, body: r.body ? r.json() : undefined }));
    const join = async (by: (m: string, u: string, b?: unknown) => Promise<{ body: { path: string } }>, person: string, email: string) => {
      const link = (await by('POST', `/v1/staff-logins/${person}/invite`, { handOver: true })).body;
      const params = Object.fromEntries(new URLSearchParams(link.path.split('#')[1]));
      const res = await app.inject({ method: 'POST', url: '/v1/staff/join', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ ...params, email, password: PASSWORD }) });
      expect(res.statusCode).toBe(200);
    };
    return { store, owner: as('owner'), gm: as('gm'), fd: as('fd'), system: as('system'), join };
  }
  const PERIOD = '/v1/staff-logins/review?from=2020-01-01&to=2099-12-31';

  it('shows a close, re-invite and re-join with a new address as high risk, to those who audit, and lets someone else sign it off', async () => {
    const t = await bootPeople();
    await t.join(t.gm, 'mar-2', 'sam@example.com');
    expect((await t.gm('DELETE', '/v1/staff-logins/mar-2')).status).toBe(204);
    await t.join(t.gm, 'mar-2', 'sam.other@example.com');

    // The finance director audits across the organisation; the GM's audit right is one site's, and a key is nobody.
    const seen = await t.fd('GET', PERIOD);
    expect(seen.status).toBe(200);
    expect(seen.body.summary).toEqual({ closed: 1, needsReview: 1, highRisk: 1 });
    const [c] = seen.body.cases;
    expect(c).toMatchObject({ employeeId: 'mar-2', status: 'rejoined', previousEmail: 'sam@example.com', newEmail: 'sam.other@example.com', risk: 'high', needsReview: true });
    expect(c.flags).toEqual(['same_person', 'handed_over', 'new_address']);
    expect((await t.gm('GET', PERIOD)).status).toBe(403);
    expect((await t.system('GET', PERIOD)).status).toBe(403);

    // A sign-off needs a reason, is made once, and is recorded in the audit trail.
    expect((await t.fd('POST', '/v1/staff-logins/review', { caseId: c.id, outcome: 'concern', note: 'short' })).status).toBe(400);
    const signed = await t.fd('POST', '/v1/staff-logins/review', { caseId: c.id, outcome: 'concern', note: 'Sam did not ask for this. Raised with HR.' });
    expect(signed.status).toBe(201);
    expect(signed.body.review).toMatchObject({ by: 'Nadia Rahman', outcome: 'concern' });
    expect((await t.owner('POST', '/v1/staff-logins/review', { caseId: c.id, outcome: 'genuine', note: 'Looked at it again.' })).status).toBe(409);
    expect((await t.fd('GET', PERIOD)).body.summary.needsReview).toBe(0);
    const org = await t.store.load('demo');
    expect(org.audit.some((a) => a.action === 'staff.login_reviewed' && a.actor === 'Nadia Rahman')).toBe(true);
  });

  it('never lets whoever closed or re-invited a login sign it off, and keeps the record after the audit log is trimmed', async () => {
    const t = await bootPeople();
    await t.join(t.owner, 'mar-3', 'kit@example.com');
    await t.owner('DELETE', '/v1/staff-logins/mar-3');
    await t.join(t.owner, 'mar-3', 'kit@example.com');
    const [c] = (await t.owner('GET', PERIOD)).body.cases;
    const own = await t.owner('POST', '/v1/staff-logins/review', { caseId: c.id, outcome: 'genuine', note: 'Kit lost their phone.' });
    expect(own.status).toBe(409);
    expect(own.body.error).toBe('review_refused');

    // A month of phone clock-ins can push a close off the audit log; the review reads its own record.
    const org = await t.store.load('demo');
    for (let i = 0; i < 6000; i++) org.audit.push({ at: new Date().toISOString(), actor: 'x', action: 'time.phone_clock_in' });
    org.audit.splice(0, org.audit.length - 5000);
    expect(org.audit.some((a) => a.action === 'staff.login_closed')).toBe(false);
    expect((await t.fd('GET', PERIOD)).body.cases).toHaveLength(1);
    expect((await t.fd('POST', '/v1/staff-logins/review', { caseId: c.id, outcome: 'genuine', note: 'Kit lost their phone; confirmed with Kit.' })).status).toBe(201);
  });

  it('counts only a login that was there as closed', async () => {
    const t = await bootPeople();
    expect((await t.gm('DELETE', '/v1/staff-logins/mar-4')).status).toBe(204);
    expect((await t.fd('GET', PERIOD)).body.cases).toEqual([]);
  });
});
