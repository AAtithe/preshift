import { afterEach, describe, expect, it, vi } from 'vitest';
import { dueAlerts, pruneAlerts } from '../src/engine/reminders';
import type { Employee, Shift, TimeEntry } from '../src/engine/types';
import { emailSetting } from './mail';
import { shiftAlerts } from './reminders';
import { kit } from './testkit';

const person = (id: string, extra: Partial<Employee> = {}) => ({ id, name: id, status: 'active', leave: [], ...extra }) as unknown as Employee;
const shift = (id: string, date: string, startMinute: number, endMinute: number, extra: Partial<Shift> = {}): Shift =>
  ({ id, employeeId: 'p1', roleId: 'bar', siteId: 'mar', date, startMinute, endMinute, breakMinutes: 0, published: true, ...extra });
const entry = (employeeId: string, date: string, siteId = 'mar'): TimeEntry =>
  ({ id: `t_${employeeId}_${date}`, employeeId, siteId, roleId: 'bar', date, clockIn: 600, breakMinutes: 0, status: 'open', source: 'clock' });

describe('which shifts are due a reminder or a not-clocked-in alert', () => {
  const state = (shifts: Shift[], employees = [person('p1')]) => ({ shifts, employees });
  const kinds = (due: { kind: string; shift: Shift }[]) => due.map((d) => `${d.kind}:${d.shift.id}`).sort();

  it('reminds the evening before, from 18:00, and within two hours of the start', () => {
    const s = state([shift('tomorrow', '2026-10-24', 600, 960), shift('tonight', '2026-10-23', 1140, 1380), shift('later', '2026-10-23', 1320, 1440)]);
    expect(kinds(dueAlerts(s, [], {}, { date: '2026-10-23', minute: 16 * 60 + 59 }))).toEqual([]);
    expect(kinds(dueAlerts(s, [], {}, { date: '2026-10-23', minute: 17 * 60 + 59 }))).toEqual(['soon:tonight']);
    expect(kinds(dueAlerts(s, [], {}, { date: '2026-10-23', minute: 18 * 60 }))).toEqual(['evening:tomorrow', 'soon:tonight']);
    // Already sent: nothing again.
    expect(kinds(dueAlerts(s, [], { tomorrow: { date: '2026-10-24', evening: 'x' }, tonight: { date: '2026-10-23', soon: 'x' } }, { date: '2026-10-23', minute: 18 * 60 }))).toEqual([]);
  });

  it('flags a no-show ten minutes after the start, only where people clock, and not once they have', () => {
    const s = state([shift('tonight', '2026-10-23', 1140, 1380)]);
    const at = { date: '2026-10-23', minute: 1140 + 10 };
    // Nobody clocks at this site: a missing clock means nothing.
    expect(kinds(dueAlerts(s, [], {}, at))).toEqual([]);
    const clocking = [entry('someone-else', '2026-10-20')];
    expect(kinds(dueAlerts(s, clocking, {}, { ...at, minute: 1140 + 9 }))).toEqual([]);
    expect(kinds(dueAlerts(s, clocking, {}, at))).toEqual(['late:tonight']);
    expect(kinds(dueAlerts(s, [...clocking, entry('p1', '2026-10-23')], {}, at))).toEqual([]);
    // Over once the shift has ended.
    expect(kinds(dueAlerts(s, clocking, {}, { ...at, minute: 1380 }))).toEqual([]);
  });

  it('follows a shift that runs past midnight', () => {
    const s = state([shift('late-night', '2026-10-23', 1320, 1620)]);
    expect(kinds(dueAlerts(s, [entry('x', '2026-10-22')], {}, { date: '2026-10-24', minute: 30 }))).toEqual(['late:late-night']);
  });

  it('leaves out drafts, leave, sickness and leavers', () => {
    const at = { date: '2026-10-23', minute: 1100 };
    expect(dueAlerts(state([shift('draft', '2026-10-23', 1140, 1380, { published: false })]), [], {}, at)).toEqual([]);
    expect(dueAlerts(state([shift('a', '2026-10-23', 1140, 1380)], [person('p1', { leave: ['2026-10-23'] })]), [], {}, at)).toEqual([]);
    expect(dueAlerts(state([shift('a', '2026-10-23', 1140, 1380)], [person('p1', { absences: [{ id: 'x', type: 'sickness', from: '2026-10-22' }] })]), [], {}, at)).toEqual([]);
    expect(dueAlerts(state([shift('a', '2026-10-23', 1140, 1380)], [person('p1', { status: 'leaver', leaveDate: '2026-10-20' })]), [], {}, at)).toEqual([]);
  });

  it('forgets shifts two days gone', () => {
    expect(Object.keys(pruneAlerts({ old: { date: '2026-10-20' }, kept: { date: '2026-10-21' } }, '2026-10-23'))).toEqual(['kept']);
  });
});

describe('the reminder run', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reminds by phone only, nudges a no-show and emails the manager, once each', async () => {
    // 18:00 in London on Friday 23 October 2026 (still summer time), then 19:15.
    const six = new Date('2026-10-23T17:00:00Z');
    const quarterPast7 = new Date('2026-10-23T18:15:00Z');
    let clock = six;
    const k = await kit({ keys: [{ key: 'manager', orgId: 'demo', name: 'GM', scopes: ['*'] }], now: () => clock });
    const inv = await k.call('POST', '/v1/staff-logins/mar-12/invite', { key: 'manager' });
    const link = Object.fromEntries(new URLSearchParams(new URL(inv.body.path, 'https://x').hash.slice(1)));
    await k.call('POST', '/v1/staff/join', null, { ...link, email: 'ben@example.com', password: 'pint of best bitter' });

    const org = await k.store.load('demo');
    // Only this test's shifts, and someone else clocked at the site this week, so it counts as clocking.
    org.state.shifts = [
      { id: 'tonight', employeeId: 'mar-12', roleId: 'bar', siteId: 'mar', date: '2026-10-23', startMinute: 1140, endMinute: 1380, breakMinutes: 20, published: true },
      { id: 'tomorrow', employeeId: 'mar-12', roleId: 'bar', siteId: 'mar', date: '2026-10-24', startMinute: 1020, endMinute: 1380, breakMinutes: 20, published: true },
    ];
    org.timeEntries = [{ id: 't1', employeeId: 'mar-2', siteId: 'mar', roleId: 'chef', date: '2026-10-22', clockIn: 600, clockOut: 900, breakMinutes: 0, status: 'approved', source: 'clock' }];
    await k.store.setSetting(emailSetting('demo'), JSON.stringify({ resendApiKey: 're_test', from: 'Preshift <rota@ws.example>', appUrl: 'https://rota.ws.example' }));
    const emails: { to: string[]; subject: string; text: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (String(url).includes('resend')) emails.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: 'm1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    expect(await shiftAlerts(k.store, org, six)).toMatchObject({ reminders: 2, late: 0 });
    const mine = () => org.notifications!.filter((n) => n.employeeId === 'mar-12');
    expect(mine().map((n) => n.title).sort()).toEqual(['You are working tomorrow', 'Your shift starts at 19:00']);
    // Phone only: never emailed.
    expect(mine().every((n) => n.email === 'skip')).toBe(true);
    expect(emails).toEqual([]);
    expect(await shiftAlerts(k.store, org, six)).toBeNull();

    clock = quarterPast7;
    expect(await shiftAlerts(k.store, org, quarterPast7)).toMatchObject({ late: 1 });
    expect(mine().at(-1)).toMatchObject({ kind: 'shift_late', title: 'You have not clocked in' });
    const priya = emails.find((m) => m.to[0] === 'priya@marylebonegroup.example')!;
    expect(priya.subject).toBe('Not clocked in: Ben Ford');
    expect(priya.text).toMatch(/started 15 minutes ago/);
    // A floor supervisor does not publish the rota, so is not told.
    expect(emails.some((m) => m.to[0] === 'grace@marylebonegroup.example')).toBe(false);
    expect(await shiftAlerts(k.store, org, quarterPast7)).toBeNull();

    const late = (await k.call('GET', '/v1/requests/late', { key: 'manager' })).body;
    expect(late).toEqual([expect.objectContaining({ shiftId: 'tonight', employeeName: 'Ben Ford', minutesLate: 15 })]);
    // Once they clock in, they are off the list.
    org.timeEntries.push({ id: 't2', employeeId: 'mar-12', siteId: 'mar', roleId: 'bar', shiftId: 'tonight', date: '2026-10-23', clockIn: 1156, breakMinutes: 0, status: 'open', source: 'clock' });
    expect((await k.call('GET', '/v1/requests/late', { key: 'manager' })).body).toEqual([]);
  });

  it('respects a person turning reminders off, but still nudges a no-show', async () => {
    const k = await kit({ keys: [{ key: 'manager', orgId: 'demo', name: 'GM', scopes: ['*'] }] });
    const inv = await k.call('POST', '/v1/staff-logins/mar-12/invite', { key: 'manager' });
    const link = Object.fromEntries(new URLSearchParams(new URL(inv.body.path, 'https://x').hash.slice(1)));
    const ben = (await k.call('POST', '/v1/staff/join', null, { ...link, email: 'ben@example.com', password: 'pint of best bitter' })).cookie!;
    expect((await k.call('PUT', '/v1/staff/reminders', ben, { on: false })).body).toEqual({ on: false });
    expect((await k.call('GET', '/v1/staff/me', ben)).body.reminders).toBe(false);
    const org = await k.store.load('demo');
    org.state.shifts = [{ id: 'tonight', employeeId: 'mar-12', roleId: 'bar', siteId: 'mar', date: '2026-10-23', startMinute: 1140, endMinute: 1380, breakMinutes: 20, published: true }];
    org.timeEntries = [{ id: 't1', employeeId: 'mar-2', siteId: 'mar', roleId: 'chef', date: '2026-10-22', clockIn: 600, breakMinutes: 0, status: 'approved', source: 'clock' }];
    await shiftAlerts(k.store, org, new Date('2026-10-23T17:00:00Z'));
    expect((org.notifications ?? []).filter((n) => n.employeeId === 'mar-12')).toEqual([]);
    await shiftAlerts(k.store, org, new Date('2026-10-23T18:15:00Z'));
    expect((org.notifications ?? []).filter((n) => n.employeeId === 'mar-12').map((n) => n.kind)).toEqual(['shift_late']);
  });
});
