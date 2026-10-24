import { describe, expect, it } from 'vitest';
import { adoption } from '../src/engine/adoption';
import { confirmWeek, weeksSeen } from '../src/engine/rotaSeen';
import { addDays, weekStart } from '../src/engine/time';
import { deciderLevel, managerDigests } from './digest';
import { kit } from './testkit';

const KEY = { key: 'manager' };

async function boot() {
  const k = await kit({ keys: [{ key: 'manager', orgId: 'demo', name: 'GM', scopes: ['*'] }] });
  const join = async (person: string) => {
    const res = await k.call('POST', `/v1/staff-logins/${person}/invite`, KEY);
    const link = Object.fromEntries(new URLSearchParams(new URL(res.body.path, 'https://x').hash.slice(1)));
    return (await k.call('POST', '/v1/staff/join', null, { ...link, email: `${person}@example.com`, password: 'pint of best bitter' })).cookie!;
  };
  return { k, join };
}

describe('overdue requests go up a level', () => {
  it('knows the site manager from those above them', async () => {
    const { k } = await boot();
    const org = await k.store.load('demo');
    const user = (email: string) => org.users.find((u) => u.email === email)!;
    const today = k.store.todayISO();
    expect(deciderLevel(org.users, user('priya@marylebonegroup.example'), 'team.manage', 'mar', today)).toBe('site');
    expect(deciderLevel(org.users, user('daniel@marylebonegroup.example'), 'team.manage', 'mar', today)).toBe('above');
    expect(deciderLevel(org.users, user('james@marylebonegroup.example'), 'team.manage', 'mar', today)).toBe('above');
    // Nobody runs Fitzrovia alone, so the area manager is its manager there.
    expect(deciderLevel(org.users, user('daniel@marylebonegroup.example'), 'team.manage', 'fitz', today)).toBe('site');
    expect(deciderLevel(org.users, user('grace@marylebonegroup.example'), 'team.manage', 'mar', today)).toBeNull();
  });

  it('puts a request waiting over two days in the area manager\'s email, naming who should decide', async () => {
    const { k, join } = await boot();
    const ben = await join('mar-12');
    const today = (await k.call('GET', '/v1/staff/me', ben)).body.today;
    const fresh = await k.call('POST', '/v1/staff/requests/holiday', ben, { from: addDays(today, 30), to: addDays(today, 30) });
    const old = await k.call('POST', '/v1/staff/requests/holiday', ben, { from: addDays(today, 40), to: addDays(today, 41) });
    const org = await k.store.load('demo');
    org.requests!.find((r) => r.id === old.body.id)!.createdAt = `${addDays(today, -3)}T09:00:00.000Z`;

    const digests = managerDigests(org, today);
    const of = (email: string) => digests.find((d) => d.user.email === email);
    // The GM sees both, as their own to decide.
    const priya = JSON.stringify(of('priya@marylebonegroup.example')!.sections);
    expect(priya).toMatch(/2 requests to decide/);
    expect(priya).not.toMatch(/Overdue/);
    // The area manager sees only the overdue one, and whose it is.
    const daniel = of('daniel@marylebonegroup.example')!;
    const text = JSON.stringify(daniel.sections);
    expect(text).toMatch(/Overdue at your sites: 1 waiting more than 2 days/);
    expect(text).toMatch(/For Priya Shah to decide/);
    expect(text).not.toMatch(new RegExp(fresh.body.id));
    expect(daniel.sections.find((s) => s.heading.startsWith('Overdue'))!.lines).toHaveLength(1);
    expect(daniel.sections.some((s) => /requests? to decide/.test(s.heading))).toBe(false);
  });
});

describe('Seen it on the published rota', () => {
  it('asks each person to confirm their week, again after a change, and shows the manager who has not', async () => {
    const { k, join } = await boot();
    const ben = await join('mar-12');
    const today = (await k.call('GET', '/v1/staff/me', ben)).body.today;
    const ws = addDays(weekStart(today), 14);
    const org = await k.store.load('demo');
    org.state.shifts = org.state.shifts.filter((s) => s.date < ws || s.date > addDays(ws, 6));
    const made = await k.call('POST', '/v1/shifts', KEY, { employeeId: 'mar-12', roleId: 'bar', siteId: 'mar', date: addDays(ws, 4), startMinute: 1020, endMinute: 1380, breakMinutes: 20 });
    await k.call('POST', '/v1/shifts', KEY, { employeeId: 'mar-15', roleId: 'bar', siteId: 'mar', date: addDays(ws, 5), startMinute: 1020, endMinute: 1380, breakMinutes: 20 });
    await k.call('POST', '/v1/rota/publish', KEY, { siteId: 'mar', weekStart: ws });

    let me = (await k.call('GET', '/v1/staff/me', ben)).body;
    expect(me.rotaToConfirm).toEqual([expect.objectContaining({ weekStart: ws, changed: false })]);
    expect((await k.call('POST', '/v1/staff/rota/seen', ben, { weekStart: addDays(ws, 7) })).status).toBe(404);
    me = (await k.call('POST', '/v1/staff/rota/seen', ben, { weekStart: ws })).body;
    expect(me.rotaToConfirm).toEqual([]);

    // The manager's view of that week is only offered for this week and next, so check the record directly as well.
    const seen = weeksSeen(org.toldWeeks!, org.rotaSeen!, (w) => w.weekStart === ws);
    expect(seen.find((w) => w.employeeId === 'mar-12')).toMatchObject({ seen: true, changed: false });
    expect(seen.find((w) => w.employeeId === 'mar-15')).toMatchObject({ seen: false, changed: false });

    // A change, republished: Ben must confirm again.
    await k.call('PATCH', `/v1/shifts/${made.body.shift.id}`, KEY, { startMinute: 1080 });
    await k.call('POST', '/v1/rota/publish', KEY, { siteId: 'mar', weekStart: ws });
    me = (await k.call('GET', '/v1/staff/me', ben)).body;
    expect(me.rotaToConfirm).toEqual([expect.objectContaining({ weekStart: ws, changed: true })]);
  });

  it('lists this week for the manager, and puts who has not seen it in the GM\'s morning email', async () => {
    const { k, join } = await boot();
    const ben = await join('mar-12');
    const today = (await k.call('GET', '/v1/staff/me', ben)).body.today;
    const ws = weekStart(today);
    const org = await k.store.load('demo');
    org.state.shifts = org.state.shifts.filter((s) => !(s.siteId === 'mar' && s.date >= ws && s.date <= addDays(ws, 6)));
    await k.call('POST', '/v1/shifts', KEY, { employeeId: 'mar-12', roleId: 'bar', siteId: 'mar', date: addDays(ws, 6), startMinute: 1020, endMinute: 1380, breakMinutes: 20 });
    await k.call('POST', '/v1/shifts', KEY, { employeeId: 'mar-15', roleId: 'bar', siteId: 'mar', date: addDays(ws, 6), startMinute: 1020, endMinute: 1380, breakMinutes: 20 });
    await k.call('POST', '/v1/rota/publish', KEY, { siteId: 'mar', weekStart: ws });
    await k.call('POST', '/v1/staff/rota/seen', ben, { weekStart: ws });

    const list = (await k.call('GET', '/v1/requests/rota-seen', KEY)).body;
    const mar = list.find((w: { siteId: string; weekStart: string }) => w.siteId === 'mar' && w.weekStart === ws);
    expect(mar).toMatchObject({ total: 2, seen: 1, notSeen: [{ name: 'Zara Ahmed', onApp: false, changed: false }] });

    const priya = managerDigests(org, today).find((d) => d.user.email === 'priya@marylebonegroup.example')!;
    const unseen = priya.sections.find((s) => s.heading === 'Not yet seen their rota')!;
    expect(unseen.lines.join()).toMatch(/Marylebone, week of .*: Zara Ahmed\./);
    expect(unseen.lines.join()).not.toMatch(/Ben Ford/);
  });

  it('counts weeks seen in adoption, for people on the app', () => {
    const told: Record<string, string[]> = { 'a|mar|2026-10-12': ['x'], 'b|mar|2026-10-12': ['y'], 'c|mar|2026-10-12': ['z'] };
    const seen = {};
    confirmWeek(told, seen, 'a', '2026-10-12', '2026-10-12T08:00:00.000Z');
    const weeks = weeksSeen(told, seen, () => true);
    const [row] = adoption(
      { sites: [], shifts: [], employees: [] },
      { logins: [{ employeeId: 'a', active: true, pushDevices: 0 }, { employeeId: 'b', active: true, pushDevices: 0 }], requests: [], openShifts: [], entries: [], weeks },
      ['mar'], '2026-10-23', '2026-10-23T12:00:00.000Z',
    );
    // c has no app, so cannot press Seen it and is not counted.
    expect(row).toMatchObject({ rotaWeeks: 2, rotaSeen: 1 });
  });
});
