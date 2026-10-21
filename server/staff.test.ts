import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { weekStart } from '../src/engine/time';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
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
    return Object.fromEntries(new URL(res.body.path, 'https://x').searchParams) as { org: string; person: string; invite: string };
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
    expect((await t.call('GET', `/v1/staff/invite?${new URLSearchParams(link)}`)).body.name).toBeTruthy();

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
    expect(shifts).toEqual([{ id: expect.any(String), date: today.today, startMinute: 1020, endMinute: 1380, breakMinutes: 30, siteName: 'Marylebone', roleName: expect.any(String) }]);
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

  it('signs in, locks after five wrong passwords, and a new invite resets the password', async () => {
    const t = await boot();
    const first = (await t.join('mar-1', 'priya@example.com')).cookie;
    expect((await t.call('POST', '/v1/staff/login', { email: 'priya@example.com', password: 'wrong password!' })).status).toBe(401);
    const ok = await t.call('POST', '/v1/staff/login', { email: ' PRIYA@example.com', password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.cookie).toMatch(new RegExp(`^${STAFF_COOKIE}=`));

    for (let i = 0; i < 5; i++) await t.call('POST', '/v1/staff/login', { email: 'priya@example.com', password: 'wrong password!' });
    expect((await t.call('POST', '/v1/staff/login', { email: 'priya@example.com', password: PASSWORD })).body.error).toBe('locked');

    // Forgotten password: the manager sends a new invite. Old sessions end once it is used.
    const reset = await t.call('POST', '/v1/staff/join', { ...(await t.invite('mar-1')), email: 'priya@example.com', password: 'a brand new password' });
    expect(reset.status).toBe(200);
    expect((await t.call('GET', '/v1/staff/me', undefined, first)).status).toBe(401);
    expect((await t.call('GET', '/v1/staff/me', undefined, reset.cookie)).status).toBe(200);
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
