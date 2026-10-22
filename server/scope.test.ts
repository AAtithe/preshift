import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { SCOPED_ROUTES } from './scope';
import { MemoryStore } from './store';

const WEEK = '2026-10-19';
const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };
const GM = { email: 'gm.fitz@ws.example', password: 'another long password' };

async function boot() {
  const store = new MemoryStore(['demo'], '2026-10-21');
  const { app } = await buildApp({
    apiKeys: [{ key: 'fitz-key', orgId: 'demo', name: 'Fitzrovia tablet', scopes: ['*'], siteIds: ['fitz'] }],
    store,
    provider: new TeamPaySimulator(),
    autoDispatch: false,
  });
  const form = (url: string, fields: Record<string, string>) =>
    app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(fields).toString() });
  const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie'] ?? '').split(';')[0];
  const call = async (cookie: string, method: string, url: string, body?: unknown) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { ...(cookie.startsWith('key:') ? { authorization: `Bearer ${cookie.slice(4)}` } : { cookie }), ...(body ? { 'content-type': 'application/json' } : {}) },
      payload: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  const owner = cookieOf(await form('/auth/setup', { ...OWNER, confirm: OWNER.password, next: '/app/' }));
  const signIn = async (email: string, password: string) => cookieOf(await form('/auth/login', { email, password, next: '/app/' }));
  return { app, store, call, owner, signIn };
}

/** The owner adds a site manager for Fitzrovia, who signs in. */
async function withManager() {
  const t = await boot();
  const added = await t.call(t.owner, 'POST', '/v1/users', { ...GM, role: 'manager', siteIds: ['fitz'] });
  expect(added.status).toBe(201);
  expect(added.body).toMatchObject({ role: 'manager', siteIds: ['fitz'] });
  return { ...t, gm: await t.signIn(GM.email, GM.password) };
}

const shift = (employeeId: string, siteId: string, roleId = 'server') => ({
  employeeId, roleId, siteId, date: WEEK, startMinute: 600, endMinute: 900, breakMinutes: 0,
});

describe('site managers', () => {
  it('lists only routes that exist', async () => {
    const { app } = await boot();
    await app.ready();
    for (const route of SCOPED_ROUTES) {
      const [method, url] = route.split(' ');
      expect(app.hasRoute({ method: method as 'GET', url }), route).toBe(true);
    }
  });

  it('needs at least one real site, and shows the sites to the manager', async () => {
    const t = await boot();
    expect((await t.call(t.owner, 'POST', '/v1/users', { ...GM, role: 'manager' })).body.error).toBe('sites_required');
    expect((await t.call(t.owner, 'POST', '/v1/users', { ...GM, role: 'manager', siteIds: ['nowhere'] })).status).toBe(404);
    await t.call(t.owner, 'POST', '/v1/users', { ...GM, role: 'manager', siteIds: ['fitz'] });
    const gm = await t.signIn(GM.email, GM.password);
    expect((await t.call(gm, 'GET', '/auth/me')).body).toMatchObject({ role: 'manager', siteIds: ['fitz'] });
  });

  it('reads their own sites only, and other sites\' cover staff without contact details or file', async () => {
    const t = await withManager();
    expect((await t.call(t.gm, 'GET', '/v1/sites')).body.map((s: { id: string }) => s.id)).toEqual(['fitz']);
    expect((await t.call(t.gm, 'GET', '/v1/entities')).body.map((e: { id: string }) => e.id)).toEqual(['wdl']);

    const people = (await t.call(t.gm, 'GET', '/v1/employees')).body as { id: string; siteId: string; hr?: unknown; email?: string }[];
    expect(people.filter((p) => p.siteId === 'fitz').length).toBe(9);
    // Marylebone people who have agreed to cover Fitzrovia, but nobody from Shoreditch.
    const cover = people.filter((p) => p.siteId !== 'fitz');
    expect(cover.map((p) => p.id).sort()).toEqual(['mar-16', 'mar-4', 'mar-8']);
    expect(cover.every((p) => p.hr === undefined && p.email === undefined)).toBe(true);
    expect(people.find((p) => p.id === 'fitz-5')?.hr).toBeDefined();
    expect((await t.call(t.gm, 'GET', '/v1/employees/shd-2')).status).toBe(404);

    expect((await t.call(t.gm, 'GET', '/v1/forecast')).body.every((f: { siteId: string }) => f.siteId === 'fitz')).toBe(true);
    const records = (await t.call(t.gm, 'GET', '/v1/hr/records')).body as { employeeId: string; kind: string }[];
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.employeeId.startsWith('fitz-') && r.kind !== 'case')).toBe(true);
    const overview = (await t.call(t.gm, 'GET', '/v1/hr/overview')).body;
    expect(overview.summary.headcount).toBe(9);
  });

  it('cannot reach payroll, the books, company settings, travel times, GDPR or user management', async () => {
    const t = await withManager();
    for (const [method, url] of [
      ['GET', '/v1/journal?weekStart=2026-10-19'],
      ['GET', '/v1/payroll/submissions'],
      ['POST', '/v1/payroll/submissions'],
      ['GET', '/v1/integrations/payroll'],
      ['PATCH', '/v1/entities/wdl'],
      ['GET', '/v1/privacy/register'],
      ['GET', '/v1/users'],
      ['POST', '/v1/dev/simulate-clocking'],
      ['PUT', '/v1/sites/fitz/location'],
      ['POST', '/v1/sites/travel/refresh'],
      ['PUT', '/v1/sites/fitz/travel/mar'],
    ]) {
      const res = await t.call(t.gm, method, url, method === 'GET' ? undefined : {});
      expect(res.status, `${method} ${url}`).toBe(403);
    }
  });

  it('rosters their own site, with their own staff or agreed cover, and nowhere else', async () => {
    const t = await withManager();
    expect((await t.call(t.gm, 'POST', '/v1/shifts', shift('fitz-6', 'fitz'))).status).toBe(201);
    expect((await t.call(t.gm, 'POST', '/v1/shifts', shift('mar-8', 'fitz'))).status).toBe(201);
    const borrowed = await t.call(t.gm, 'POST', '/v1/shifts', shift('mar-7', 'fitz'));
    expect(borrowed.status).toBe(403);
    expect(borrowed.body.error).toBe('outside_scope');
    expect((await t.call(t.gm, 'POST', '/v1/shifts', shift('fitz-6', 'mar'))).status).toBe(403);

    const theirs = await t.call(t.owner, 'POST', '/v1/shifts', shift('mar-7', 'mar'));
    expect((await t.call(t.gm, 'PATCH', `/v1/shifts/${theirs.body.shift.id}`, { siteId: 'fitz' })).status).toBe(403);
    expect((await t.call(t.gm, 'DELETE', `/v1/shifts/${theirs.body.shift.id}`)).status).toBe(403);

    expect((await t.call(t.gm, 'POST', '/v1/rota/build', { siteId: 'fitz', weekStart: WEEK })).status).toBe(200);
    expect((await t.call(t.gm, 'POST', '/v1/rota/build', { siteIds: ['fitz', 'mar'], weekStart: WEEK })).status).toBe(403);
    expect((await t.call(t.gm, 'POST', '/v1/rota/clear', { siteId: 'mar', weekStart: WEEK })).status).toBe(403);
    expect((await t.call(t.gm, 'POST', '/v1/rota/publish', { siteId: 'shd', weekStart: WEEK })).status).toBe(403);
    const forecast = { rows: [{ siteId: 'mar', date: WEEK, hour: 12, sales: 1, covers: 1 }] };
    expect((await t.call(t.gm, 'PUT', '/v1/forecast', forecast)).status).toBe(403);
    // Marylebone's own shift is untouched by all of that.
    expect((await t.call(t.owner, 'GET', `/v1/shifts?siteId=mar&from=${WEEK}&to=${WEEK}`)).body.some((s: { id: string }) => s.id === theirs.body.shift.id)).toBe(true);
  });

  it('manages their own staff, but cannot move them away or change their employer', async () => {
    const t = await withManager();
    expect((await t.call(t.gm, 'PATCH', '/v1/employees/fitz-6', { hourlyRate: 13.5 })).status).toBe(200);
    expect((await t.call(t.gm, 'PATCH', '/v1/employees/fitz-6', { siteId: 'mar' })).status).toBe(403);
    expect((await t.call(t.gm, 'PATCH', '/v1/employees/fitz-6', { entityId: 'eck' })).status).toBe(403);
    expect((await t.call(t.gm, 'PATCH', '/v1/employees/mar-8', { hourlyRate: 20 })).status).toBe(403);
    expect((await t.call(t.gm, 'POST', '/v1/employees/mar-8/leaver', { leaveDate: '2026-10-30' })).status).toBe(403);
    const starter = { name: 'New Starter', siteId: 'mar', roleIds: ['server'], payBasis: 'hourly', dateOfBirth: '2000-01-01' };
    expect((await t.call(t.gm, 'POST', '/v1/employees', starter)).status).toBe(403);
    expect((await t.call(t.gm, 'POST', '/v1/employees', { ...starter, siteId: 'fitz', entityId: 'eck' })).status).toBe(403);
    expect((await t.call(t.gm, 'POST', '/v1/employees', { ...starter, siteId: 'fitz' })).status).toBe(201);
  });

  it('keeps HR, absence, cards, clocking and staff logins to their own site', async () => {
    const t = await withManager();
    const note = { kind: 'note', date: '2026-10-21', title: 'Chat' };
    expect((await t.call(t.gm, 'POST', '/v1/hr/records', { ...note, employeeId: 'fitz-6' })).status).toBe(201);
    expect((await t.call(t.gm, 'POST', '/v1/hr/records', { ...note, employeeId: 'mar-8' })).status).toBe(403);
    const caseRecord = (await t.call(t.owner, 'GET', '/v1/hr/records?kind=case&employeeId=fitz-7')).body[0];
    expect((await t.call(t.gm, 'PATCH', `/v1/hr/records/${caseRecord.id}`, { notes: 'x' })).status).toBe(404);
    expect((await t.call(t.gm, 'PUT', '/v1/employees/mar-8/hr', {})).status).toBe(403);
    const absence = { type: 'sickness', from: '2026-10-22', to: '2026-10-22' };
    expect((await t.call(t.gm, 'POST', '/v1/employees/fitz-6/absences', absence)).status).toBe(201);
    expect((await t.call(t.gm, 'POST', '/v1/employees/mar-8/absences', absence)).status).toBe(403);

    expect((await t.call(t.gm, 'PUT', '/v1/employees/mar-8/badge', { badgeId: 'AA11BB22' })).status).toBe(403);
    expect((await t.call(t.gm, 'PUT', '/v1/sites/mar/geofence', { lat: 51.5, lng: -0.15, radiusMetres: 100 })).status).toBe(403);
    expect((await t.call(t.gm, 'POST', '/v1/time-entries/tap', { badgeId: 'AA11BB22', siteId: 'mar' })).status).toBe(403);
    expect((await t.call(t.gm, 'POST', '/v1/time-entries/clock-in', { employeeId: 'fitz-6', siteId: 'mar' })).status).toBe(403);

    const manual = { employeeId: 'fitz-6', siteId: 'fitz', roleId: 'server', date: '2026-10-20', clockIn: 600, clockOut: 900 };
    expect((await t.call(t.gm, 'POST', '/v1/time-entries', manual)).status).toBe(201);
    expect((await t.call(t.gm, 'POST', '/v1/time-entries', { ...manual, siteId: 'mar' })).status).toBe(403);
    expect((await t.call(t.gm, 'POST', '/v1/time-entries/approve', { from: '2026-10-01', to: '2026-10-31' })).status).toBe(403);
    expect((await t.call(t.gm, 'POST', '/v1/time-entries/approve', { siteId: 'mar', from: '2026-10-01', to: '2026-10-31' })).status).toBe(403);
    expect((await t.call(t.gm, 'POST', '/v1/time-entries/approve', { siteId: 'fitz', from: '2026-10-01', to: '2026-10-31' })).body.approved).toBe(1);

    expect((await t.call(t.gm, 'PUT', '/v1/sales', { rows: [{ siteId: 'fitz', date: '2026-10-20', netSales: 2100 }] })).status).toBe(200);
    expect((await t.call(t.gm, 'PUT', '/v1/sales', { rows: [{ siteId: 'mar', date: '2026-10-20', netSales: 1 }] })).status).toBe(403);
    expect((await t.call(t.gm, 'DELETE', '/v1/sales?siteId=mar&date=2026-10-20')).status).toBe(403);
    await t.call(t.owner, 'PUT', '/v1/sales', { rows: [{ siteId: 'mar', date: '2026-10-20', netSales: 3000 }] });
    const sales = (await t.call(t.gm, 'GET', '/v1/sales')).body as { siteId: string }[];
    expect(sales.length).toBeGreaterThan(0);
    expect(sales.every((r) => r.siteId === 'fitz')).toBe(true);
    expect((await t.call(t.gm, 'GET', '/v1/employees/mar-8/right-to-work/documents/doc1')).status).toBe(403);
    expect((await t.call(t.gm, 'GET', '/v1/employees/fitz-6/right-to-work/documents/doc1/access')).status).toBe(403);
    expect((await t.call(t.gm, 'DELETE', '/v1/employees/fitz-6/right-to-work/documents/doc1')).status).toBe(403);

    expect((await t.call(t.gm, 'POST', '/v1/staff-logins/mar-8/invite')).status).toBe(403);
    expect((await t.call(t.owner, 'POST', '/v1/staff-logins/mar-8/invite')).status).toBe(201);
    expect((await t.call(t.gm, 'POST', '/v1/staff-logins/fitz-6/invite')).status).toBe(201);
    expect((await t.call(t.gm, 'GET', '/v1/staff-logins')).body.map((l: { employeeId: string }) => l.employeeId)).toEqual(['fitz-6']);
  });

  it('takes a change of role or sites on the next request', async () => {
    const t = await withManager();
    await t.call(t.owner, 'PATCH', `/v1/users/${GM.email}`, { siteIds: ['fitz', 'mar'] });
    expect((await t.call(t.gm, 'GET', '/v1/sites')).body.map((s: { id: string }) => s.id).sort()).toEqual(['fitz', 'mar']);
    expect((await t.call(t.owner, 'PATCH', `/v1/users/${GM.email}`, { siteIds: [] })).status).toBe(400);
    await t.call(t.owner, 'PATCH', `/v1/users/${GM.email}`, { role: 'member' });
    expect((await t.call(t.gm, 'GET', '/v1/sites')).body.length).toBe(3);
    expect((await t.call(t.owner, 'GET', '/v1/users')).body.find((u: { email: string }) => u.email === GM.email).siteIds).toBeUndefined();
    expect((await t.call(t.owner, 'PATCH', `/v1/users/${GM.email}`, { role: 'manager' })).status).toBe(400);
  });

  it('applies the same limits to an API key given sites', async () => {
    const t = await boot();
    expect((await t.call('key:fitz-key', 'GET', '/v1/sites')).body.map((s: { id: string }) => s.id)).toEqual(['fitz']);
    expect((await t.call('key:fitz-key', 'GET', '/v1/journal?weekStart=2026-10-19')).status).toBe(403);
    expect((await t.call('key:fitz-key', 'POST', '/v1/shifts', shift('fitz-6', 'mar'))).status).toBe(403);
  });
});
