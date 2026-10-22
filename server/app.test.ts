import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Change, Command } from '../src/shared/commands';
import type { RotaState } from '../src/engine/types';
import { buildApp } from './app';
import { withOrg, type Db } from './db';
import { testDatabase } from './testdb';

const ADMIN_URL = process.env.TEST_DATABASE_URL;
// 17:00 UTC on 21 October is 18:00 in London, the demo's clock.
const NOW = new Date('2026-10-21T17:00:00Z');
const PASSWORD = 'correct horse battery';

type App = ReturnType<typeof buildApp>;

/** A browser: keeps its session cookie between requests. */
function browser(app: App) {
  let cookie = '';
  const call = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
    const res = await app.inject({
      method,
      url,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers['set-cookie'];
    if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(';')[0];
    return { status: res.statusCode, body: res.body ? res.json() : null, raw: res };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, body: unknown = {}) => call('POST', url, body),
    command: (cmd: Command) => call('POST', '/api/commands', cmd),
    state: async () => (await call('GET', '/api/state')).body.state as RotaState,
  };
}

describe.skipIf(!ADMIN_URL)('server', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let app: App;

  beforeAll(async () => {
    ({ db, drop } = await testDatabase(ADMIN_URL!));
    app = buildApp({ db, allowSignup: true, allowDemoSeed: true, secureCookies: false, now: () => NOW });
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await drop?.();
  });

  async function owner(org: string, email: string) {
    const b = browser(app);
    expect((await b.post('/api/auth/signup', { organisationName: org, name: 'Owner', email, password: PASSWORD })).status).toBe(200);
    return b;
  }

  async function invited(by: ReturnType<typeof browser>, email: string, role: string, siteIds: string[] | null, employeeId: string | null = null) {
    const { body } = await by.post('/api/invites', { email, role, siteIds, employeeId });
    const b = browser(app);
    expect((await b.post('/api/auth/accept-invite', { token: body.token, name: email, password: PASSWORD })).status).toBe(200);
    return b;
  }

  describe('accounts and sessions', () => {
    it('signs up, stores only hashes, and signs in and out', async () => {
      const b = await owner('Hash Test Ltd', 'hash@example.com');
      const me = await b.get('/api/me');
      expect(me.body.membership.role).toBe('owner');
      const { rows } = await db.query("select password_hash from users where email = 'hash@example.com'");
      expect(rows[0].password_hash).toMatch(/^scrypt\$/);
      expect(rows[0].password_hash).not.toContain(PASSWORD);

      await b.post('/api/auth/logout');
      expect((await b.get('/api/me')).status).toBe(401);
      expect((await b.post('/api/auth/login', { email: 'HASH@example.com', password: 'wrong password!!' })).status).toBe(401);
      expect((await b.post('/api/auth/login', { email: 'HASH@example.com', password: PASSWORD })).status).toBe(200);
      expect((await b.get('/api/me')).status).toBe(200);
    });

    it('refuses short passwords, duplicate emails and non-JSON writes', async () => {
      const b = browser(app);
      expect((await b.post('/api/auth/signup', { organisationName: 'X', name: 'X', email: 'short@example.com', password: 'short' })).status).toBe(400);
      await owner('Dup Ltd', 'dup@example.com');
      expect((await b.post('/api/auth/signup', { organisationName: 'Y', name: 'Y', email: 'dup@example.com', password: PASSWORD })).status).toBe(409);
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'text/plain' }, payload: 'x' });
      expect(res.statusCode).toBe(415);
    });

    it('locks an email out after ten wrong passwords', async () => {
      await owner('Lock Ltd', 'lock@example.com');
      const b = browser(app);
      for (let i = 0; i < 10; i++) await b.post('/api/auth/login', { email: 'lock@example.com', password: 'not the password' });
      expect((await b.post('/api/auth/login', { email: 'lock@example.com', password: PASSWORD })).status).toBe(429);
    });
  });

  describe('tenancy', () => {
    it('round-trips the whole demo through the database exactly', async () => {
      const b = await owner('Round Trip Ltd', 'round@example.com');
      const saved = (await b.command({ type: 'seedDemo' })).body.changes[0].state as RotaState;
      // Built for the server's date and time.
      expect(saved.clocks.some((c) => c.date === '2026-10-21' && c.clockOut === undefined)).toBe(true);
      expect(await b.state()).toEqual(sorted(saved));
    }, 60_000);

    it('keeps one organisation out of another, even with no filter in the query', async () => {
      const a = await owner('Alpha Ltd', 'alpha@example.com');
      await a.command({ type: 'seedDemo' });
      const b = await owner('Beta Ltd', 'beta@example.com');
      const beta = await b.state();
      expect(beta.shifts).toEqual([]);
      expect(beta.employees).toEqual([]);
      // With no organisation set, the app role sees no tenant rows at all.
      expect((await db.query('select count(*)::int as n from shifts')).rows[0].n).toBe(0);
    }, 60_000);

    it('keeps the audit trail append-only for the app', async () => {
      const b = await owner('Audit Ltd', 'audit@example.com');
      await b.command({ type: 'seedDemo' });
      const me = (await b.get('/api/me')).body;
      await expect(withOrg(db, me.organisation.id, (tx) => tx.query('delete from audit_events'))).rejects.toThrow(/permission denied/);
      const events = (await b.get('/api/audit')).body.events;
      expect(events[0]).toMatchObject({ action: 'seedDemo', user_name: 'Owner' });
    }, 60_000);
  });

  describe('roles', () => {
    let own: ReturnType<typeof browser>;
    let demo: RotaState;
    beforeAll(async () => {
      own = await owner('Roles Ltd', 'roles@example.com');
      demo = (await own.command({ type: 'seedDemo' })).body.changes[0].state;
    }, 60_000);

    const marShift = () => demo.shifts.find((s) => s.siteId === 'mar' && s.date === '2026-10-23')!;
    const shdShift = () => demo.shifts.find((s) => s.siteId === 'shd' && s.date === '2026-10-23')!;

    it('lets a GM run their own site and nothing else', async () => {
      const gm = await invited(own, 'gm@example.com', 'gm', ['mar']);
      const seen = await gm.state();
      expect(new Set(seen.shifts.map((s) => s.siteId))).toEqual(new Set(['mar']));
      expect((await gm.command({ type: 'upsertShift', shift: { ...marShift(), endMinute: marShift().endMinute - 60 } })).status).toBe(200);
      expect((await gm.command({ type: 'upsertShift', shift: { ...shdShift(), endMinute: shdShift().endMinute - 60 } })).status).toBe(403);
      expect((await gm.command({ type: 'seedDemo' })).status).toBe(403);
    });

    it('saves an auto-built week as a draft', async () => {
      const draft = demo.shifts
        .filter((s) => s.siteId === 'mar' && s.date >= '2026-10-19' && s.date <= '2026-10-25')
        .map(({ published: _published, ...s }) => s);
      const res = await own.command({ type: 'replaceWeek', siteId: 'mar', weekStart: '2026-10-19', shifts: draft });
      expect(res.status).toBe(200);
      const saved = (await own.state()).shifts.filter((s) => s.siteId === 'mar' && s.date >= '2026-10-19' && s.date <= '2026-10-25');
      expect(saved).toHaveLength(draft.length);
      expect(saved.every((s) => s.published === false)).toBe(true);
    });

    it('lets finance approve clockings but not touch the rota', async () => {
      const fin = await invited(own, 'finance@example.com', 'finance', null);
      const pending = demo.clocks.filter((c) => c.clockOut !== undefined && !c.approved).slice(0, 3).map((c) => c.id);
      const res = await fin.command({ type: 'approveClocks', ids: pending });
      const change = (res.body.changes as Change[])[0] as { type: string; ids: string[] };
      expect(change.type).toBe('approveClocks');
      expect([...change.ids].sort()).toEqual([...pending].sort());
      expect((await fin.command({ type: 'deleteShift', id: marShift().id })).status).toBe(403);
    });

    it('gives the tronc scheme to the troncmaster alone, and records every change', async () => {
      const tm = await invited(own, 'tm@example.com', 'troncmaster', ['mar'], 'mar-8');
      const scheme = demo.troncSchemes.find((t) => t.siteId === 'mar')!;
      const changed = { ...scheme, pointsPerHour: { ...scheme.pointsPerHour, kp: 7 } };
      expect((await own.command({ type: 'updateTroncScheme', scheme: changed })).status).toBe(403);
      expect((await tm.command({ type: 'updateTroncScheme', scheme: changed })).status).toBe(200);
      // The service charge is the business's call, not the troncmaster's.
      const discretionary = { ...changed, serviceCharge: 'mandatory' as const };
      expect((await tm.command({ type: 'updateTroncScheme', scheme: discretionary })).status).toBe(403);
      expect((await own.command({ type: 'updateTroncScheme', scheme: discretionary })).status).toBe(200);
      const events = (await own.get('/api/audit')).body.events.filter((e: { action: string }) => e.action === 'updateTroncScheme');
      const event = events[events.length - 1];
      expect(event.detail.before.pointsPerHour.kp).toBe(6);
      expect(event.detail.after.pointsPerHour.kp).toBe(7);
      // The troncmaster sees who worked, never what anyone is paid.
      const seen = await tm.state();
      expect(seen.employees.filter((e) => e.id !== 'mar-8').every((e) => e.hourlyRate === 0 && e.annualSalary === 0)).toBe(true);
    });

    it('shows staff only their own published shifts and record', async () => {
      const staff = await invited(own, 'staff@example.com', 'staff', ['mar'], 'mar-13');
      const seen = await staff.state();
      expect(seen.employees.map((e) => e.id)).toEqual(['mar-13']);
      expect(seen.shifts.every((s) => s.employeeId === 'mar-13' && s.published)).toBe(true);
      expect(seen.actuals).toEqual([]);
      expect((await staff.get('/api/audit')).status).toBe(403);
    });

    it('clocks staff in on the server clock, on site, and only near their shift', async () => {
      const site = demo.sites.find((s) => s.id === 'mar')!;
      const today = demo.shifts.filter((s) => s.siteId === 'mar' && s.date === '2026-10-21');
      const later = today.find((s) => s.startMinute >= 19 * 60)!;
      const free = demo.employees.find((e) => e.siteId === 'mar' && e.payBasis === 'hourly' && !today.some((s) => s.employeeId === e.id))!;

      const early = await invited(own, 'early@example.com', 'staff', ['mar'], later.employeeId);
      expect((await early.command({ type: 'clockIn', employeeId: later.employeeId, siteId: 'mar' })).status).toBe(400);
      const away = await early.command({ type: 'clockIn', employeeId: later.employeeId, siteId: 'mar', position: { lat: site.location!.lat + 0.01, lng: site.location!.lng } });
      expect(away.status).toBe(409);
      expect(away.body.error).toMatch(/m from Marylebone/);
      const tooSoon = await early.command({ type: 'clockIn', employeeId: later.employeeId, siteId: 'mar', position: site.location });
      expect(tooSoon.status).toBe(409);
      expect(tooSoon.body.error).toMatch(/Clock in from/);
      // Someone else's clocking is a manager's job.
      expect((await early.command({ type: 'clockIn', employeeId: free.id, siteId: 'mar', position: site.location })).status).toBe(403);

      const walkIn = await invited(own, 'walkin@example.com', 'staff', ['mar'], free.id);
      const ok = await walkIn.command({ type: 'clockIn', employeeId: free.id, siteId: 'mar', position: site.location, demoAt: { date: '2030-01-01', minute: 1 } });
      expect(ok.status).toBe(200);
      // The server's clock, not the one the browser claimed, and held for approval as it was not on the rota.
      expect(ok.body.changes[0].clock).toMatchObject({ date: '2026-10-21', clockIn: 18 * 60, source: 'geofence' });
      expect(ok.body.changes[0].clock.shiftId).toBeUndefined();
    });

    it('refuses to publish a rota with a blocking compliance issue', async () => {
      const someone = demo.employees.find((e) => e.siteId === 'mar' && e.payBasis === 'hourly')!;
      // A shift that ends when it starts: saved as a draft, but it can never be published.
      const shift = { id: 'bad-1', employeeId: someone.id, roleId: someone.roleIds[0], siteId: 'mar', date: '2026-10-28', startMinute: 600, endMinute: 600, breakMinutes: 0 };
      expect((await own.command({ type: 'upsertShift', shift })).status).toBe(200);
      const res = await own.command({ type: 'publishWeek', siteId: 'mar', weekStart: '2026-10-26' });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('blocking');
    });
  });
});

/** The database returns rows in key order; sort the expected state the same way. */
function sorted(state: RotaState): RotaState {
  const by = (...keys: string[]) => (a: Record<string, unknown>, b: Record<string, unknown>) => {
    for (const k of keys) {
      const x = a[k] as string | number;
      const y = b[k] as string | number;
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  };
  const s = <T,>(rows: T[], ...keys: string[]) => [...rows].sort(by(...keys) as never);
  return {
    sites: s(state.sites, 'id'),
    roles: s(state.roles, 'id'),
    employees: s(state.employees, 'id'),
    shifts: s(state.shifts, 'id'),
    clocks: s(state.clocks, 'id'),
    forecast: s(state.forecast, 'siteId', 'date', 'hour'),
    actuals: s(state.actuals, 'siteId', 'date', 'hour'),
    demandRules: s(state.demandRules, 'siteId', 'roleId'),
    tips: s(state.tips, 'id'),
    troncSchemes: s(state.troncSchemes, 'siteId'),
    dishes: s(state.dishes, 'id'),
    dishSales: s(state.dishSales, 'siteId', 'date', 'dishId'),
    purchases: s(state.purchases, 'id'),
    stockCounts: s(state.stockCounts, 'siteId', 'date', 'category'),
  };
}
