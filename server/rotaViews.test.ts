import { describe, expect, it } from 'vitest';
import { addDays, londonParts, weekStart } from '../src/engine/time';
import { kit, type Kit } from './testkit';

const PASSWORD = 'pint of best bitter';
const KEY = { key: 'manager' };

async function boot() {
  const k = await kit({ keys: [{ key: 'manager', orgId: 'demo', name: 'GM', scopes: ['*'] }, { key: 'rota-only', orgId: 'demo', name: 'Rota tool', scopes: ['rota:read'] as never }] });
  const join = async (person: string) => {
    const res = await k.call('POST', `/v1/staff-logins/${person}/invite`, KEY);
    const link = Object.fromEntries(new URLSearchParams(new URL(res.body.path, 'https://x').hash.slice(1)));
    const joined = await k.call('POST', '/v1/staff/join', null, { ...link, email: `${person}@example.com`, password: PASSWORD });
    expect(joined.status).toBe(200);
    return joined.cookie!;
  };
  const me = async (cookie: string) => (await k.call('GET', '/v1/staff/me', cookie)).body;
  return { k, join, me };
}

/** A clear stretch of days next-but-one week, away from the seeded rota. */
async function clearDay(k: Kit, today: string, offset = 9) {
  const day = addDays(weekStart(today), 7 + offset);
  const org = await k.store.load('demo');
  org.state.shifts = org.state.shifts.filter((s) => s.date < addDays(day, -3) || s.date > addDays(day, 9));
  return day;
}

const bar = (employeeId: string, date: string, startMinute = 17 * 60, endMinute = 23 * 60) => ({ employeeId, roleId: 'bar', siteId: 'mar', date, startMinute, endMinute, breakMinutes: 20 });

describe('changes since published', () => {
  it('lists who the next publish will tell and what, as the publish itself will', async () => {
    const { k } = await boot();
    const day = await clearDay(k, londonParts(new Date()).date);
    const ws = weekStart(day);
    const org = await k.store.load('demo');
    org.state.shifts = org.state.shifts.filter((s) => !(s.siteId === 'mar' && s.date >= ws && s.date <= addDays(ws, 6)));
    const changes = async (key = KEY) => k.call('GET', `/v1/rota/changes?siteId=mar&weekStart=${ws}`, key);

    const made = await k.call('POST', '/v1/shifts', KEY, bar('mar-12', day));
    let res = await changes();
    expect(res.status).toBe(200);
    expect(res.body.lastPublished).toBeNull();
    expect(res.body.notices).toEqual([expect.objectContaining({ employeeId: 'mar-12', name: 'Ben Ford', kind: 'first', removed: [] })]);

    expect((await k.call('POST', '/v1/rota/publish', KEY, { siteId: 'mar', weekStart: ws })).status).toBe(200);
    res = await changes();
    expect(res.body.notices).toEqual([]);
    expect(res.body.lastPublished).toMatchObject({ by: expect.any(String) });

    // A moved shift and a new person: one change, one first week.
    await k.call('PATCH', `/v1/shifts/${made.body.shift.id}`, KEY, { startMinute: 18 * 60 });
    await k.call('POST', '/v1/shifts', KEY, bar('mar-15', addDays(day, 1)));
    res = await changes();
    const ben = res.body.notices.find((n: { employeeId: string }) => n.employeeId === 'mar-12');
    expect(ben.kind).toBe('changed');
    expect(ben.added[0]).toMatch(/18:00-23:00/);
    expect(ben.removed[0]).toMatch(/17:00-23:00/);
    expect(res.body.notices.find((n: { employeeId: string }) => n.employeeId === 'mar-15').kind).toBe('first');

    // Reading needs only the rota read scope.
    expect((await changes({ key: 'rota-only' })).status).toBe(200);
  });
});

describe('the staff rota drawn', () => {
  it('carries the fortnight: hours, pay before tax for hourly staff, and the rest before each shift', async () => {
    const { k, join, me } = await boot();
    const ben = await join('mar-12');
    const today = (await me(ben)).today;
    const org = await k.store.load('demo');
    org.state.shifts = org.state.shifts.filter((s) => s.employeeId !== 'mar-12');
    const d1 = addDays(today, 3);
    const d2 = addDays(today, 4);
    // A close then an open: 10 hours between.
    await k.call('POST', '/v1/shifts', KEY, bar('mar-12', d1, 15 * 60, 23 * 60));
    await k.call('POST', '/v1/shifts', KEY, { ...bar('mar-12', d2, 9 * 60, 14 * 60), roleId: 'bar' });
    const o = await k.store.load('demo');
    for (const s of o.state.shifts) if (s.employeeId === 'mar-12') s.published = true;

    const view = await me(ben);
    const rate = o.state.employees.find((e) => e.id === 'mar-12')!.hourlyRate;
    const second = view.shifts.find((s: { date: string }) => s.date === d2);
    expect(view.fortnight.paidHours).toBeCloseTo((8 * 60 - 20 + 5 * 60 - 20) / 60, 1);
    expect(view.fortnight.estimatedPay).toBeCloseTo(view.fortnight.paidHours * rate, 1);
    expect(view.fortnight.restBefore[second.id]).toMatchObject({ minutes: 600, level: 'short', judged: true });
    expect(view.fortnight.shortestRest).toBe(600);
  });

  it("gives each shift's own times beside the crew, and what an open shift would do to the week", async () => {
    const { k, join, me } = await boot();
    const ben = await join('mar-12');
    const day = await clearDay(k, (await me(ben)).today);
    const org = await k.store.load('demo');
    org.state.shifts = org.state.shifts.filter((s) => s.employeeId !== 'mar-12' || s.date < addDays(weekStart(day), -1));
    await k.call('POST', '/v1/shifts', KEY, bar('mar-15', day, 18 * 60, 23 * 60));
    await k.call('POST', '/v1/shifts', KEY, bar('mar-12', day));
    await k.call('POST', '/v1/rota/publish', KEY, { siteId: 'mar', weekStart: weekStart(day) });

    const team = (await k.call('GET', '/v1/staff/team', ben)).body;
    expect(team.find((t: { date: string }) => t.date === day)).toMatchObject({ startMinute: 1020, endMinute: 1380, role: 'Bartender', siteName: 'Marylebone' });

    const posted = await k.call('POST', '/v1/open-shifts', KEY, { siteId: 'mar', roleId: 'bar', date: addDays(day, 1), startMinute: 12 * 60, endMinute: 17 * 60 });
    expect(posted.status).toBe(201);
    const board = (await k.call('GET', '/v1/staff/board', ben)).body;
    const open = board.openShifts.find((x: { id: string }) => x.id === posted.body.id);
    expect(open.effect).toMatchObject({ shortestRest: 13 * 60, minRest: 11 * 60, warnings: [] });
    expect(open.effect.weekHours).toBeGreaterThan(5);
  });
});
