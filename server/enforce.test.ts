import { describe, expect, it } from 'vitest';
import { checkWeek } from '../src/engine/compliance';
import { seedState } from '../src/engine/seed';
import { addDays, londonParts, weekStart } from '../src/engine/time';
import type { Employee } from '../src/engine/types';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

const WEEK = '2026-10-19';
// Each key stands for its person having entered their authenticator code.
const person = (key: string, userId: string) => ({ key, orgId: 'demo', name: `${key} key`, scopes: ['*' as const], userId, mfa: true });
const KEYS = [
  { key: 'system', orgId: 'demo', name: 'System', scopes: ['*' as const] },
  person('owner', 'usr_owner'),
  person('james', 'usr_ops'),
  person('priya', 'usr_gm_mar'),
  person('grace', 'usr_sup'),
  person('nadia', 'usr_fd'),
  person('ravi', 'usr_ws_payroll'),
  person('leah', 'usr_ws_ma'),
  person('chris', 'usr_viewer'),
];

async function setup() {
  const { app } = await buildApp({ apiKeys: KEYS, store: new MemoryStore(['demo'], '2026-10-21'), provider: new TeamPaySimulator(), autoDispatch: false });
  return async (method: string, url: string, body?: unknown, key = 'system') => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      payload: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? (res.headers['content-type']?.includes('json') ? res.json() : res.body) : undefined };
  };
}

const shift = (siteId: string, employeeId: string) => ({ employeeId, roleId: 'server', siteId, date: WEEK, startMinute: 660, endMinute: 900 });

describe('access on the rota', () => {
  it('keeps a GM to their own site, in what they see and what they change', async () => {
    const call = await setup();
    await call('POST', '/v1/rota/build', { siteId: 'mar', weekStart: WEEK });
    await call('POST', '/v1/rota/build', { siteId: 'shd', weekStart: WEEK });
    expect((await call('GET', '/v1/sites', undefined, 'priya')).body.map((s: { id: string }) => s.id)).toEqual(['mar']);
    const shifts = (await call('GET', '/v1/shifts', undefined, 'priya')).body as { siteId: string }[];
    expect(shifts.length).toBeGreaterThan(0);
    expect(shifts.every((s) => s.siteId === 'mar')).toBe(true);
    expect((await call('POST', '/v1/shifts', shift('mar', 'mar-8'), 'priya')).status).toBe(201);
    const other = await call('POST', '/v1/shifts', shift('shd', 'shd-2'), 'priya');
    expect(other.status).toBe(403);
    expect(other.body.message).toMatch(/at Shoreditch/);
    expect((await call('POST', '/v1/rota/publish', { siteId: 'shd', weekStart: WEEK }, 'priya')).status).toBe(403);
    expect((await call('GET', `/v1/rota/week?siteId=shd&weekStart=${WEEK}`, undefined, 'priya')).status).toBe(403);
  });

  it('refuses a group action unless every site in it is theirs, all or nothing', async () => {
    const call = await setup();
    const group = await call('POST', '/v1/rota/build', { siteIds: ['mar', 'shd'], weekStart: WEEK }, 'priya');
    expect(group.status).toBe(403);
    expect(group.body.message).toMatch(/at Shoreditch/);
    // Nothing was built at Marylebone either: the refusal comes before any change.
    expect((await call('GET', `/v1/shifts?siteId=mar&from=${WEEK}`, undefined, 'priya')).body).toEqual([]);
    expect((await call('POST', '/v1/rota/publish', { siteIds: ['mar', 'fitz'], weekStart: WEEK }, 'priya')).status).toBe(403);
    expect((await call('POST', '/v1/rota/build', { siteIds: ['mar'], weekStart: WEEK }, 'priya')).status).toBe(200);
  });

  it('shows a GM the people from other sites who cover theirs, with pay, and not the rest', async () => {
    const call = await setup();
    const staff = (await call('GET', '/v1/employees', undefined, 'priya')).body as { id: string; hourlyRate: number; payHidden?: boolean }[];
    const ids = staff.map((e) => e.id);
    expect(ids).toContain('shd-12'); // Shoreditch, covers Marylebone
    expect(ids).toContain('fitz-3'); // Fitzrovia, covers Marylebone
    expect(ids).not.toContain('shd-2');
    expect(staff.find((e) => e.id === 'shd-12')!.payHidden).toBeUndefined();
  });

  it('treats a change of employing company as a pay change', async () => {
    const call = await setup();
    const res = await call('PATCH', '/v1/employees/mar-8', { entityId: 'eck' }, 'priya');
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/pay rates/);
  });

  it('lets a supervisor see the rota but not change it, cost it, or see pay', async () => {
    const call = await setup();
    expect((await call('POST', '/v1/shifts', shift('mar', 'mar-8'), 'grace')).status).toBe(403);
    const rota = await call('GET', `/v1/rota/week?siteId=mar&weekStart=${WEEK}`, undefined, 'grace');
    expect(rota.status).toBe(200);
    expect(rota.body.metrics).toBeNull();
    const staff = (await call('GET', '/v1/employees', undefined, 'grace')).body as { hourlyRate: number; payHidden?: boolean }[];
    expect(staff.every((e) => e.hourlyRate === 0 && e.payHidden)).toBe(true);
    const priyaSees = (await call('GET', '/v1/employees', undefined, 'priya')).body as { hourlyRate: number }[];
    expect(priyaSees.some((e) => e.hourlyRate > 0)).toBe(true);
    // The browser runs compliance on what it received: withheld pay must not read as a minimum wage breach.
    const week = { ...seedState('2026-10-21'), employees: staff as Employee[], shifts: [{ id: 'x', ...shift('mar', 'mar-8'), breakMinutes: 0 }] };
    expect(checkWeek(week, WEEK, 'mar').some((i) => i.code === 'minimum-wage')).toBe(false);
  });

  it('refuses a suspended person whatever their key', async () => {
    const call = await setup();
    const res = await call('GET', '/v1/shifts', undefined, 'chris');
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/suspended/);
  });
});

describe('access on the team and pay', () => {
  it('lets a GM add starters at their site but not set pay', async () => {
    const call = await setup();
    const starter = { name: 'New Starter', siteId: 'mar', roleIds: ['server'], payBasis: 'hourly', dateOfBirth: '2000-01-01' };
    expect((await call('POST', '/v1/employees', starter, 'priya')).status).toBe(201);
    expect((await call('POST', '/v1/employees', { ...starter, hourlyRate: 14 }, 'priya')).status).toBe(403);
    expect((await call('PATCH', '/v1/employees/mar-8', { hourlyRate: 20 }, 'priya')).status).toBe(403);
    expect((await call('PATCH', '/v1/employees/mar-8', { contractedHours: 16 }, 'priya')).status).toBe(200);
    expect((await call('PATCH', '/v1/employees/shd-3', { contractedHours: 16 }, 'priya')).status).toBe(403);
  });

  it('never lets someone change their own pay', async () => {
    const call = await setup();
    expect((await call('PATCH', '/v1/employees/mar-3', { hourlyRate: 15.5 }, 'owner')).status).toBe(200);
    // Linking someone to their rota record is access management, done by someone else.
    expect((await call('PATCH', '/v1/users/usr_owner', { employeeId: 'mar-3' }, 'james')).status).toBe(200);
    const own = await call('PATCH', '/v1/employees/mar-3', { hourlyRate: 30 }, 'owner');
    expect(own.status).toBe(403);
    expect(own.body.message).toMatch(/your own pay/);
  });
});

describe('access on clocking', () => {
  it('keeps the clocking area a site setting, and cards to the team at the home site', async () => {
    const call = await setup();
    const fence = { lat: 51.52, lng: -0.15, radiusMetres: 100 };
    // A wider fence would let people clock in from home: not a GM's to move.
    expect((await call('PUT', '/v1/sites/mar/geofence', fence, 'priya')).status).toBe(403);
    expect((await call('PUT', '/v1/sites/mar/geofence', fence, 'owner')).status).toBe(200);
    expect((await call('DELETE', '/v1/sites/mar/geofence', undefined, 'priya')).status).toBe(403);
    expect((await call('PUT', '/v1/employees/mar-8/badge', { badgeId: 'A1B2C3D4' }, 'priya')).status).toBe(200);
    expect((await call('PUT', '/v1/employees/shd-2/badge', { badgeId: 'E5F6A7B8' }, 'priya')).status).toBe(403);
    expect((await call('PUT', '/v1/employees/mar-7/badge', { badgeId: 'C0FFEE01' }, 'grace')).status).toBe(403);
  });

  it('takes a card tap only where the caller records time', async () => {
    const call = await setup();
    await call('PUT', '/v1/employees/mar-8/badge', { badgeId: 'A1B2C3D4' });
    expect((await call('POST', '/v1/time-entries/tap', { badgeId: 'A1B2C3D4', siteId: 'shd' }, 'grace')).status).toBe(403);
    expect((await call('POST', '/v1/time-entries/tap', { badgeId: 'A1B2C3D4', siteId: 'mar' }, 'grace')).status).toBe(201);
  });
});

describe('access on time and payroll', () => {
  it('stops a manager approving their own hours, and keeps them to their site', async () => {
    const call = await setup();
    await call('POST', '/v1/shifts', { ...shift('mar', 'mar-1'), roleId: 'gm' });
    await call('POST', '/v1/shifts', shift('mar', 'mar-8'));
    await call('POST', '/v1/shifts', shift('shd', 'shd-4'));
    await call('POST', '/v1/dev/simulate-clocking', { siteId: 'mar', weekStart: WEEK });
    await call('POST', '/v1/dev/simulate-clocking', { siteId: 'shd', weekStart: WEEK });
    const entries = (await call('GET', `/v1/time-entries?from=${WEEK}`, undefined, 'priya')).body as { id: string; employeeId: string; siteId: string }[];
    expect(entries.every((t) => t.siteId === 'mar')).toBe(true);
    const mine = entries.find((t) => t.employeeId === 'mar-1')!;
    expect((await call('POST', '/v1/time-entries/approve', { ids: [mine.id] }, 'priya')).body.message).toMatch(/your own hours/);
    const range = await call('POST', '/v1/time-entries/approve', { siteId: 'mar', from: WEEK, to: '2026-10-25' }, 'priya');
    expect(range.body).toMatchObject({ approved: 1, ownSkipped: 1 });
    expect((await call('POST', '/v1/time-entries/approve', { siteId: 'shd', from: WEEK, to: '2026-10-25' }, 'priya')).status).toBe(403);
  });

  it('keeps which TeamPay employer a company pays through to those who manage settings', async () => {
    const call = await setup();
    // Repointing a company's PAYE scheme sends its hours elsewhere: not the GM's, nor even payroll's, to change.
    expect((await call('PATCH', '/v1/entities/wdl', { payrollEmployerId: 'emp-west' }, 'priya')).status).toBe(403);
    expect((await call('PATCH', '/v1/entities/wdl', { payrollEmployerId: 'emp-west' }, 'ravi')).status).toBe(403);
    expect((await call('PATCH', '/v1/entities/wdl', { payrollEmployerId: 'emp-west' }, 'owner')).status).toBe(200);
  });

  it('keeps sending pay to payroll roles with an authenticator, and the journal to finance', async () => {
    const call = await setup();
    expect((await call('POST', '/v1/payroll/submissions', { weekStart: WEEK }, 'priya')).status).toBe(403);
    const nadia = await call('POST', '/v1/payroll/submissions', { weekStart: WEEK }, 'nadia');
    expect(nadia.status).toBe(403);
    expect(nadia.body.message).toMatch(/authenticator/);
    // Ravi may send; this week has no approved hours, which is the next thing to stop him.
    expect((await call('POST', '/v1/payroll/submissions', { weekStart: WEEK }, 'ravi')).status).toBe(422);
    expect((await call('GET', '/v1/payroll/runs', undefined, 'priya')).status).toBe(403);
    expect((await call('GET', `/v1/journal?weekStart=${WEEK}`, undefined, 'priya')).status).toBe(403);
    expect((await call('GET', `/v1/journal?weekStart=${WEEK}`, undefined, 'leah')).status).toBe(200);
  });
});

describe('access to staff app logins', () => {
  it("lets a GM issue and see staff logins for their own site's people only", async () => {
    const call = await setup();
    // Priya manages Marylebone's team, not Shoreditch's.
    expect((await call('POST', '/v1/staff-logins/mar-2/invite', undefined, 'priya')).status).toBe(201);
    expect((await call('POST', '/v1/staff-logins/shd-2/invite', undefined, 'priya')).status).toBe(403);
    expect((await call('POST', '/v1/staff-logins/shd-2/invite', undefined, 'owner')).status).toBe(201);
    const seen = (await call('GET', '/v1/staff-logins', undefined, 'priya')).body.map((l: { employeeId: string }) => l.employeeId);
    expect(seen).toEqual(['mar-2']);
    expect((await call('DELETE', '/v1/staff-logins/shd-2', undefined, 'priya')).status).toBe(403);
    // A supervisor runs shifts, not the team: no logins at all.
    expect((await call('POST', '/v1/staff-logins/mar-2/invite', undefined, 'grace')).status).toBe(403);
  });
});

describe('access to site travel times', () => {
  it('leaves where sites are and the travel between them to settings.manage', async () => {
    const call = await setup();
    expect((await call('PUT', '/v1/sites/mar/travel/shd', { minutes: 25 }, 'priya')).status).toBe(403);
    expect((await call('PUT', '/v1/sites/mar/location', { lat: 51.52, lng: -0.15 }, 'priya')).status).toBe(403);
    expect((await call('PUT', '/v1/sites/mar/travel/shd', { minutes: 25 }, 'owner')).status).toBe(200);
  });
});

describe('access to right to work copies and takings', () => {
  const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 1)]);

  it("files and shows a person's copies only where the reader holds their personnel file", async () => {
    process.env.PRESHIFT_DOCUMENT_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      const { app } = await buildApp({ apiKeys: KEYS, store: new MemoryStore(['demo'], '2026-10-21'), provider: new TeamPaySimulator(), autoDispatch: false });
      const upload = (id: string, key: string) =>
        app.inject({ method: 'POST', url: `/v1/employees/${id}/right-to-work/documents?fileName=p.pdf`, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/pdf' }, payload: PDF });
      // Priya runs Marylebone: she files her own team's copies, not Shoreditch's, and never her own.
      const mine = await upload('mar-2', 'priya');
      expect(mine.statusCode).toBe(201);
      expect((await upload('shd-2', 'priya')).statusCode).toBe(403);
      expect((await upload('mar-1', 'priya')).statusCode).toBe(403);
      // The answer carries pay only as she may see it, and a supervisor cannot open the copy.
      const docId = mine.json().rightToWork.documents[0].id;
      const view = (key: string) => app.inject({ method: 'GET', url: `/v1/employees/mar-2/right-to-work/documents/${docId}`, headers: { authorization: `Bearer ${key}` } });
      expect((await view('priya')).statusCode).toBe(200);
      expect((await view('grace')).statusCode).toBe(403);
      // Deleting a copy is a data protection act: not a GM's.
      expect((await app.inject({ method: 'DELETE', url: `/v1/employees/mar-2/right-to-work/documents/${docId}`, headers: { authorization: 'Bearer priya' } })).statusCode).toBe(403);
    } finally {
      delete process.env.PRESHIFT_DOCUMENT_KEY;
    }
  });

  it('lets a site key in its takings, and only its own', async () => {
    const call = await setup();
    expect((await call('PUT', '/v1/sales', { rows: [{ siteId: 'mar', date: '2026-10-19', netSales: 4200 }] }, 'priya')).status).toBe(200);
    expect((await call('PUT', '/v1/sales', { rows: [{ siteId: 'mar', date: '2026-10-19', netSales: 4200 }, { siteId: 'shd', date: '2026-10-19', netSales: 10 }] }, 'priya')).status).toBe(403);
    expect((await call('PUT', '/v1/sales', { rows: [{ siteId: 'mar', date: '2026-10-20', netSales: 1 }] }, 'grace')).status).toBe(403);
  });

  it("lets a site forecast from its takings, and only its own", async () => {
    const call = await setup();
    expect((await call('POST', '/v1/forecast/from-takings', { siteId: 'mar', weekStart: '2026-11-09' }, 'priya')).status).toBe(200);
    expect((await call('POST', '/v1/forecast/from-takings', { siteIds: ['mar', 'shd'], weekStart: '2026-11-09' }, 'priya')).status).toBe(403);
    expect((await call('POST', '/v1/forecast/from-takings', { siteId: 'mar', weekStart: '2026-11-09' }, 'grace')).status).toBe(403);
  });
});

describe('rest breach overrides', () => {
  // A week ahead of the real clock: shifts that have started can no longer be moved.
  const AHEAD = weekStart(addDays(londonParts(new Date()).date, 14));
  const late = { employeeId: 'mar-2', roleId: 'chef', siteId: 'mar', date: AHEAD, startMinute: 15 * 60, endMinute: 24 * 60, breakMinutes: 30 };
  const early = { ...late, date: addDays(AHEAD, 1), startMinute: 6 * 60, endMinute: 12 * 60, breakMinutes: 0 };

  async function breach() {
    const call = await setup();
    await call('POST', '/v1/shifts', late);
    const morning = (await call('POST', '/v1/shifts', early)).body.shift;
    const publish = (key = 'priya') => call('POST', '/v1/rota/publish', { siteId: 'mar', weekStart: AHEAD }, key);
    const refused = await publish();
    expect(refused.status).toBe(409);
    const key = refused.body.details.find((i: { code: string }) => i.code === 'daily-rest').overrideKey as string;
    const override = (reason: string, by = 'priya', k = key) => call('POST', '/v1/rota/overrides', { weekStart: AHEAD, key: k, reason }, by);
    return { call, morning, publish, override };
  }

  it('lets the GM who can publish there override with a reason, for that breach only', async () => {
    const { call, morning, publish, override } = await breach();
    expect((await override('cover')).status).toBe(422);
    expect((await override('Covering sickness', 'priya', 'daily-rest|made-up')).status).toBe(404);
    const made = await override('Covering sickness, Thursday off instead');
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ employeeId: 'mar-2', siteId: 'mar', code: 'daily-rest', by: 'Priya Shah' });
    expect((await override('Covering sickness, again')).status).toBe(409);
    expect((await call('GET', '/v1/rota/overrides', undefined, 'priya')).body).toHaveLength(1);

    // Opening earlier is a new breach the reason does not cover.
    await call('PATCH', `/v1/shifts/${morning.id}`, { startMinute: 5 * 60 });
    expect((await publish()).status).toBe(409);
    await call('PATCH', `/v1/shifts/${morning.id}`, { startMinute: 6 * 60 });
    expect((await publish()).status).toBe(200);

    expect((await call('DELETE', `/v1/rota/overrides/${made.body.id}`, undefined, 'priya')).status).toBe(204);
    expect((await call('GET', '/v1/rota/overrides', undefined, 'priya')).body).toEqual([]);
  });

  it('refuses a supervisor who cannot publish, and a system key with no person behind it', async () => {
    const { call, override } = await breach();
    const grace = await override('Covering sickness, Thursday off instead', 'grace');
    expect(grace.status).toBe(403);
    expect(grace.body.message).toMatch(/Grace Mensah cannot publish the rota to the team at Marylebone/);
    expect((await override('Covering sickness, Thursday off instead', 'system')).status).toBe(403);

    const made = await override('Covering sickness, Thursday off instead');
    expect((await call('DELETE', `/v1/rota/overrides/${made.body.id}`, undefined, 'grace')).status).toBe(403);
  });
});
