import { describe, expect, it } from 'vitest';
import { adoption } from '../src/engine/adoption';
import type { Employee, OpenShift, Shift, StaffRequest, TimeEntry } from '../src/engine/types';
import { kit } from './testkit';

const person = (id: string, siteId = 'mar', extra: Partial<Employee> = {}) => ({ id, name: `Person ${id}`, siteId, status: 'active', leave: [], ...extra }) as unknown as Employee;
const request = (id: string, createdAt: string, extra: Partial<StaffRequest> = {}): StaffRequest =>
  ({ id, kind: 'holiday', employeeId: 'a', siteId: 'mar', status: 'pending', createdAt, ...extra });

describe('staff app adoption by site', () => {
  const today = '2026-10-23';
  const now = '2026-10-23T12:00:00.000Z';

  it('counts who is on the app, who has notifications, and names them', () => {
    const [row] = adoption(
      { sites: [], shifts: [], employees: [person('a'), person('b'), person('c'), person('gone', 'mar', { status: 'leaver' }), person('x', 'shd')] },
      { logins: [{ employeeId: 'a', active: true, pushDevices: 2 }, { employeeId: 'b', active: true, pushDevices: 0 }, { employeeId: 'c', active: false, pushDevices: 0 }], requests: [], openShifts: [], entries: [] },
      ['mar'], today, now,
    );
    expect(row).toMatchObject({ team: 3, onApp: 2, withPush: 1, notOnApp: ['Person c'], noNotifications: ['Person b'] });
  });

  it('times decisions from asked to decided, and starts a swap\'s clock when the colleague agrees', () => {
    const requests = [
      request('fast', '2026-10-20T09:00:00.000Z', { status: 'approved', decidedAt: '2026-10-20T11:00:00.000Z' }),
      request('slow', '2026-10-10T09:00:00.000Z', { status: 'declined', decidedAt: '2026-10-13T09:00:00.000Z' }),
      request('withdrawn', '2026-10-15T09:00:00.000Z', { status: 'cancelled', decidedAt: '2026-10-15T10:00:00.000Z' }),
      request('old', '2026-08-01T09:00:00.000Z', { status: 'approved', decidedAt: '2026-08-02T09:00:00.000Z' }),
      request('waiting', '2026-10-22T12:00:00.000Z'),
      request('swap-unagreed', '2026-10-01T12:00:00.000Z', { kind: 'swap' }),
    ];
    const [row] = adoption({ sites: [], shifts: [], employees: [] }, { logins: [], requests, openShifts: [], entries: [] }, ['mar'], today, now);
    expect(row).toMatchObject({ decided: 2, medianDecisionHours: 37, slowestDecisionHours: 72, decidedInADayPct: 50, waiting: 1, oldestWaitingHours: 24 });
  });

  it('measures open shifts filled and how fast', () => {
    const open = (id: string, extra: Partial<OpenShift>): OpenShift =>
      ({ id, siteId: 'mar', roleId: 'bar', date: today, startMinute: 1080, endMinute: 1380, breakMinutes: 0, status: 'open', postedBy: 'GM', postedAt: '2026-10-20T10:00:00.000Z', ...extra });
    const [row] = adoption({ sites: [], shifts: [], employees: [] }, {
      logins: [], requests: [], entries: [],
      openShifts: [open('a', { status: 'filled', filledAt: '2026-10-20T11:00:00.000Z' }), open('b', { status: 'filled', filledAt: '2026-10-20T13:00:00.000Z' }), open('c', {})],
    }, ['mar'], today, now);
    expect(row).toMatchObject({ openShiftsPosted: 3, openShiftsFilled: 2, medianFillHours: 2 });
  });

  it('counts no-shows only where people clock, leaving out leave and sickness', () => {
    const shift = (id: string, employeeId: string, date: string): Shift => ({ id, employeeId, roleId: 'bar', siteId: 'mar', date, startMinute: 600, endMinute: 960, breakMinutes: 0, published: true });
    const entry = (employeeId: string, date: string): TimeEntry => ({ id: `${employeeId}${date}`, employeeId, siteId: 'mar', roleId: 'bar', date, clockIn: 600, breakMinutes: 0, status: 'approved', source: 'clock' });
    const employees = [person('a'), person('b', 'mar', { leave: ['2026-10-21'] }), person('c', 'mar', { absences: [{ id: 's', type: 'sickness', from: '2026-10-21', to: '2026-10-21' }] })];
    const shifts = [shift('1', 'a', '2026-10-20'), shift('2', 'a', '2026-10-21'), shift('3', 'b', '2026-10-21'), shift('4', 'c', '2026-10-21'), shift('today', 'a', today)];
    const state = { sites: [], shifts, employees };
    expect(adoption(state, { logins: [], requests: [], openShifts: [], entries: [] }, ['mar'], today, now)[0].noShows).toBeNull();
    const [row] = adoption(state, { logins: [], requests: [], openShifts: [], entries: [entry('a', '2026-10-20')] }, ['mar'], today, now);
    // Shift 2: no clock. Shift 3 is leave, 4 is sickness, and today's is still to come.
    expect(row).toMatchObject({ noShows: 1, shiftsChecked: 2 });
  });
});

describe('the adoption endpoint', () => {
  it('covers the sites the caller runs, and names people only for those who manage the team', async () => {
    const k = await kit({ keys: [{ key: 'manager', orgId: 'demo', name: 'GM', scopes: ['*'] }] });
    const inv = await k.call('POST', '/v1/staff-logins/mar-12/invite', { key: 'manager' });
    const link = Object.fromEntries(new URLSearchParams(new URL(inv.body.path, 'https://x').hash.slice(1)));
    await k.call('POST', '/v1/staff/join', null, { ...link, email: 'ben@example.com', password: 'pint of best bitter' });

    const priya = await k.as('priya@marylebonegroup.example');
    const gm = (await k.call('GET', '/v1/insights/adoption', priya)).body;
    expect(gm.sites.map((s: { siteId: string }) => s.siteId)).toEqual(['mar']);
    const mar = gm.sites[0];
    expect(mar.onApp).toBe(1);
    expect(mar.notOnApp).not.toContain('Ben Ford');
    expect(mar.noNotifications).toEqual(['Ben Ford']);

    // A floor supervisor neither publishes nor manages the team: nothing.
    const grace = await k.as('grace@marylebonegroup.example');
    expect((await k.call('GET', '/v1/insights/adoption', grace)).body.sites).toEqual([]);

    const weeks = await k.call('GET', '/v1/insights/adoption?weeks=8', priya);
    expect(weeks.body.weeks).toBe(8);
    expect((await k.call('GET', '/v1/insights/adoption?weeks=99', priya)).status).toBe(400);
  });
});
