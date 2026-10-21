import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

const WEEK = '2026-10-19';
const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };
const GM = { email: 'gm.marylebone@ws.example', password: 'marylebone gm pass' };

type Person = { id: string; name: string; siteId: string; restricted?: boolean; email?: string; dateOfBirth: string; rightToWork?: unknown; hr?: unknown };

/** An owner, and a Marylebone GM limited to Marylebone and West End Dining Ltd. */
async function boot() {
  const store = new MemoryStore(['demo'], '2026-10-21');
  const { app } = await buildApp({ store, provider: new TeamPaySimulator(), autoDispatch: false, apiKeys: [] });
  const form = (url: string, fields: Record<string, string>) =>
    app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(fields).toString() });
  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie'] ?? '').split(';')[0];
  const call = async (method: string, url: string, cookie: string, body?: unknown) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  const owner = cookieOf(await form('/auth/setup', { email: OWNER.email, password: OWNER.password, confirm: OWNER.password, next: '/app/' }));
  await call('POST', '/v1/users', owner, { email: GM.email, password: GM.password, role: 'member' });
  const limit = await call('PATCH', `/v1/users/${encodeURIComponent(GM.email)}`, owner, { access: { siteIds: ['mar'], entityIds: ['wdl'] } });
  expect(limit.status).toBe(200);
  const gm = cookieOf(await form('/auth/login', { email: GM.email, password: GM.password, next: '/app/' }));
  const people = (await call('GET', '/v1/employees', owner)).body as Person[];
  const byName = (name: string) => people.find((p) => p.name === name)!;
  return { call, owner, gm, byName };
}

describe('manager access by company and site', () => {
  it('validates and reports the scope, and admins are never limited', async () => {
    const t = await boot();
    expect((await t.call('GET', '/auth/me', t.gm)).body.access).toEqual({ siteIds: ['mar'], entityIds: ['wdl'] });
    expect((await t.call('GET', '/auth/me', t.owner)).body.access).toBeNull();
    const bad = await t.call('PATCH', `/v1/users/${encodeURIComponent(GM.email)}`, t.owner, { access: { siteIds: [], entityIds: ['wdl'] } });
    expect(bad.status).toBe(400);
    expect((await t.call('PATCH', `/v1/users/${encodeURIComponent(GM.email)}`, t.owner, { access: { siteIds: ['nowhere'], entityIds: ['wdl'] } })).status).toBe(400);
  });

  it('gives full records for their own staff, limited records for cover, and nothing else', async () => {
    const t = await boot();
    const seen = (await t.call('GET', '/v1/employees', t.gm)).body as Person[];
    const own = seen.find((p) => p.name === 'Marco Bianchi')!;
    expect(own.restricted).toBeUndefined();
    expect(own.dateOfBirth).toBe('1990-07-02');

    // Dev Kapoor works for East Canteen at Shoreditch and covers Marylebone.
    const cover = seen.find((p) => p.name === 'Dev Kapoor')!;
    expect(cover).toMatchObject({ restricted: true, dateOfBirth: '1999-12-31' });
    expect(cover.email).toBeUndefined();
    expect(cover.rightToWork).toBeUndefined();
    expect(cover.hr).toBeUndefined();

    // Same company, other site, not covering here: Marylebone's GM does not see them at all.
    expect(seen.some((p) => p.name === 'Pedro Alves')).toBe(false);
    expect((await t.call('GET', `/v1/employees/${t.byName('Pedro Alves').id}`, t.gm)).status).toBe(404);
    // Fitzrovia staff who cover Marylebone come through as cover, even in the same company.
    expect(seen.find((p) => p.name === 'Yusuf Demir')?.restricted).toBe(true);
  });

  it('refuses changes to records it does not hold, and to sites it does not run', async () => {
    const t = await boot();
    const cover = t.byName('Dev Kapoor');
    expect((await t.call('PATCH', `/v1/employees/${cover.id}`, t.gm, { maxWeeklyHours: 20 })).status).toBe(403);
    expect((await t.call('PUT', `/v1/employees/${cover.id}/hr`, t.gm, { jobTitle: 'Bartender' })).status).toBe(403);
    expect((await t.call('POST', `/v1/employees/${cover.id}/leaver`, t.gm, { leaveDate: '2026-11-01' })).status).toBe(403);
    const own = t.byName('Marco Bianchi');
    expect((await t.call('PATCH', `/v1/employees/${own.id}`, t.gm, { siteId: 'shd' })).status).toBe(403);
    expect((await t.call('PATCH', `/v1/employees/${own.id}`, t.gm, { maxWeeklyHours: 45 })).status).toBe(200);

    expect((await t.call('POST', '/v1/rota/build', t.gm, { siteId: 'shd', weekStart: WEEK })).status).toBe(403);
    expect((await t.call('GET', `/v1/rota/week?siteId=fitz&weekStart=${WEEK}`, t.gm)).status).toBe(403);
    expect((await t.call('PUT', '/v1/sites/shd/geofence', t.gm, { lat: 51.5, lng: -0.08, radiusMetres: 100 })).status).toBe(403);
  });

  it('rosters cover staff at its own site, but not its staff elsewhere', async () => {
    const t = await boot();
    const shift = (employeeId: string, siteId: string) => ({ employeeId, roleId: 'bar', siteId, date: WEEK, startMinute: 1020, endMinute: 1260, breakMinutes: 0 });
    expect((await t.call('POST', '/v1/shifts', t.gm, shift(t.byName('Dev Kapoor').id, 'mar'))).status).toBe(201);
    expect((await t.call('POST', '/v1/shifts', t.gm, shift(t.byName('Ben Ford').id, 'shd'))).status).toBe(403);
    expect((await t.call('POST', '/v1/shifts', t.gm, shift(t.byName('Pedro Alves').id, 'mar'))).status).toBe(404);
  });

  it('shows only its own sites in shifts, time and HR, and keeps payroll for the whole organisation', async () => {
    const t = await boot();
    await t.call('POST', '/v1/rota/build', t.owner, { siteIds: ['mar', 'fitz', 'shd'], weekStart: WEEK });
    const shifts = (await t.call('GET', `/v1/shifts?from=${WEEK}`, t.gm)).body as { siteId: string; employeeId: string }[];
    expect(shifts.length).toBeGreaterThan(0);
    const visible = new Set(((await t.call('GET', '/v1/employees', t.gm)).body as Person[]).map((p) => p.id));
    expect(shifts.every((s) => s.siteId === 'mar' || visible.has(s.employeeId))).toBe(true);
    expect(shifts.some((s) => s.siteId === 'fitz' && !visible.has(s.employeeId))).toBe(false);

    const records = (await t.call('GET', '/v1/hr/records', t.gm)).body as { employeeId: string }[];
    const own = new Set(((await t.call('GET', '/v1/employees', t.gm)).body as Person[]).filter((p) => !p.restricted).map((p) => p.id));
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => own.has(r.employeeId))).toBe(true);

    expect((await t.call('GET', '/v1/payroll/submissions', t.gm)).status).toBe(403);
    expect((await t.call('GET', '/v1/payroll/submissions', t.owner)).status).toBe(200);
  });

  it('lifts the limit when access is set back to the whole organisation', async () => {
    const t = await boot();
    await t.call('PATCH', `/v1/users/${encodeURIComponent(GM.email)}`, t.owner, { access: null });
    const seen = (await t.call('GET', '/v1/employees', t.gm)).body as Person[];
    expect(seen.some((p) => p.restricted)).toBe(false);
    expect(seen.some((p) => p.name === 'Pedro Alves')).toBe(true);
  });
});
