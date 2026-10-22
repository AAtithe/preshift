import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

const TODAY = '2026-10-21';
const KEYS = [{ key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*' as const] }];

async function setup() {
  const store = new MemoryStore(['demo'], TODAY);
  const { app } = await buildApp({ apiKeys: KEYS, store, provider: new TeamPaySimulator(), autoDispatch: false, now: () => new Date(`${TODAY}T07:00:00Z`) });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url, headers: { authorization: 'Bearer admin', ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  return { call, store };
}

describe('bookings in', () => {
  it('drops guest details from a push before anything is kept', async () => {
    const { call, store } = await setup();
    const res = await call('PUT', '/v1/bookings', {
      rows: [{ id: '1', siteId: 'mar', source: 'sevenrooms', date: '2026-10-30', startMinute: 1140, covers: 4, status: 'booked', guestName: 'Jane Smith', phone: '07700900123' }],
    });
    expect(res.status).toBe(200);
    const org = await store.load('demo');
    expect(org.state.bookings!.find((b) => b.id === 'sevenrooms:1')).toEqual({ id: 'sevenrooms:1', siteId: 'mar', source: 'sevenrooms', date: '2026-10-30', startMinute: 1140, covers: 4, status: 'booked' });
    expect(JSON.stringify(org)).not.toMatch(/Jane|07700900123/);
  });

  it('takes a push by reference, and leaves a day already in history alone', async () => {
    const { call, store } = await setup();
    const row = { id: 'abc', siteId: 'mar', source: 'sevenrooms', date: '2026-10-30', startMinute: 1140, covers: 4, status: 'booked', createdAt: '2026-10-20T10:00:00Z' };
    expect((await call('PUT', '/v1/bookings', { rows: [row] })).body).toEqual({ received: 1, historyKept: 0 });
    await call('PUT', '/v1/bookings', { rows: [{ ...row, covers: 6 }] });
    const held = (await store.load('demo')).state.bookings!.filter((b) => b.id === 'sevenrooms:abc');
    expect(held.map((b) => b.covers)).toEqual([6]);
    // A no-show marked for a day already compacted into history does not rewrite that day.
    const old = await call('PUT', '/v1/bookings', { rows: [{ ...row, id: 'late', date: '2026-10-10', status: 'no_show' }] });
    expect(old.body).toEqual({ received: 0, historyKept: 1 });
    expect((await call('PUT', '/v1/bookings', { rows: [{ ...row, date: '2026-02-31' }] })).body.error).toBe('invalid_date');
    // A backfill pushed in pages keeps every page: pushed days wait for the daily job to compact them.
    // Fitzrovia has no booking history yet, so its past days are open to a backfill.
    const page = (n: number) => Array.from({ length: 3 }, (_, i) => ({ ...row, siteId: 'fitz', id: `bf${n}-${i}`, date: '2026-09-01', status: 'completed' }));
    await call('PUT', '/v1/bookings', { rows: page(1) });
    expect((await call('PUT', '/v1/bookings', { rows: page(2) })).body).toEqual({ received: 3, historyKept: 0 });
    expect((await store.load('demo')).state.bookings!.filter((b) => b.siteId === 'fitz' && b.date === '2026-09-01')).toHaveLength(6);
    expect((await call('PUT', '/v1/bookings', { rows: [{ ...row, siteId: 'nowhere' }] })).status).toBe(404);
  });

  it('imports an export, says which columns it left unread, and shows what is loaded', async () => {
    const { call, store } = await setup();
    const csv = [
      'Booking Reference,Visit Date,Visit Time,Covers,Status,Customer Name,Phone,Date Booked',
      'R1,30/10/2026,19:30,4,Confirmed,Jane Smith,07700900123,02/10/2026',
      'R2,30/10/2026,20:00,2,Confirmed,John Doe,07700900456,20/10/2026',
      'R3,30/10/2026,,2,Confirmed,No Time,07700900000,20/10/2026',
    ].join('\n');
    const res = await call('POST', '/v1/bookings/import', { siteId: 'fitz', source: 'resdiary', csv });
    expect(res.body).toMatchObject({ imported: 2, from: '2026-10-30', to: '2026-10-30', skipped: 1, notRead: ['Customer Name', 'Phone'] });
    expect(res.body.problems).toEqual([{ line: 4, reason: 'No booking time' }]);
    const org = await store.load('demo');
    expect(JSON.stringify(org.state.bookings)).not.toMatch(/Jane|0770/);
    expect(JSON.stringify(org.audit.slice(-1))).not.toMatch(/Jane|0770/);
    const status = (await call('GET', '/v1/bookings/status')).body.find((s: { siteId: string }) => s.siteId === 'fitz');
    expect(status).toMatchObject({ bookingsAhead: 2, coversAhead: 6, furthestAhead: '2026-10-30' });
    expect(status.lastLoadedAt).toBeTruthy();
  });
});

describe('bookings in the forecast and reminders', () => {
  it('moves Saturday dinner with what is on the books, and says why', async () => {
    const { call } = await setup();
    const run = await call('POST', '/v1/forecast/model', { siteId: 'mar', weekStart: '2026-10-19' });
    const booked = run.body.automatic.filter((a: { kind: string }) => a.kind === 'bookings');
    const saturday = booked.find((a: { date: string; note: string }) => a.date === '2026-10-24' && a.note === 'Dinner bookings');
    expect(saturday).toBeDefined();
    expect(saturday.factor).toBeGreaterThan(1.15);
    expect(saturday.evidence).toMatch(/covers booked for Saturday dinner/);
    // Shoreditch takes walk-ins: no bookings, so nothing from them.
    const shd = await call('POST', '/v1/forecast/model', { siteId: 'shd', weekStart: '2026-10-19' });
    expect(shd.body.automatic.some((a: { kind: string }) => a.kind === 'bookings')).toBe(false);
  });

  it('reminds about the pace and the large party', async () => {
    const { call } = await setup();
    const due = (await call('GET', '/v1/reminders?siteIds=mar')).body as { key: string; title: string; kind: string }[];
    const keys = due.filter((r) => r.kind === 'bookings').map((r) => r.key);
    expect(keys).toContain('bookings:pace:2026-10-24:dinner');
    expect(keys).toContain('bookings:party:resdiary:demo-party');
    expect(due.find((r) => r.key === 'bookings:party:resdiary:demo-party')!.title).toBe('Party of 24, 19:30');
    const cal = await call('GET', '/v1/calendar?siteId=mar');
    const sat = cal.body.days.find((d: { date: string }) => d.date === '2026-10-24');
    expect(sat.bookings.find((b: { daypart: string }) => b.daypart === 'dinner')).toMatchObject({ usable: true });
  });
});

describe('the daily job and pushed bookings', () => {
  it('compacts pushed bookings into pace history for a site with no location or feeds', async () => {
    const store = new MemoryStore(['demo'], TODAY);
    const { app } = await buildApp({ apiKeys: KEYS, store, provider: new TeamPaySimulator(), autoDispatch: false, now: () => new Date(`${TODAY}T07:00:00Z`), env: { CRON_SECRET: 'tick' } });
    const seeded = await store.load('demo');
    seeded.state.sites = seeded.state.sites.map(({ location: _l, geofence: _g, ...site }) => site);
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, siteId: 'fitz', source: 'sevenrooms', date: '2026-10-15', startMinute: 1140, covers: 4, status: 'completed', createdAt: '2026-10-05' }));
    await app.inject({ method: 'PUT', url: '/v1/bookings', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' }, payload: JSON.stringify({ rows }) });
    const before = await store.load('demo');
    expect(before.state.sites.some((s) => s.location || s.geofence)).toBe(false);
    expect(before.state.bookings!.filter((b) => b.siteId === 'fitz')).toHaveLength(5);
    const tick = await app.inject({ method: 'GET', url: '/internal/dispatch', headers: { authorization: 'Bearer tick' } });
    expect(tick.json()).toMatchObject({ refreshed: 1, failed: 0 });
    const after = await store.load('demo');
    expect(after.state.bookings!.some((b) => b.siteId === 'fitz' && b.date === '2026-10-15')).toBe(false);
    expect(after.state.bookingPace!.find((p) => p.siteId === 'fitz' && p.date === '2026-10-15' && p.daypart === 'dinner')!.booked[0]).toBe(20);
  });
});
