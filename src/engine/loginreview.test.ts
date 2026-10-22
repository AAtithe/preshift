import { describe, expect, it } from 'vitest';
import { loginCases, reviewRefusal, type StaffLoginEvent } from './loginreview';
import type { TimeEntry } from './types';

const ev = (at: string, kind: StaffLoginEvent['kind'], by: string, extra: Partial<StaffLoginEvent> = {}): StaffLoginEvent => ({ at: `${at}Z`, employeeId: 'mar-1', kind, by, ...extra });
const phone = (date: string, clockIn: number, clockOut: number): TimeEntry =>
  ({ id: `t-${date}-${clockIn}`, employeeId: 'mar-1', siteId: 'mar', roleId: 'bar', date, clockIn, clockOut, breakMinutes: 0, status: 'submitted', method: 'phone' }) as TimeEntry;

// Priya joined with her own address; then the GM closed her login, handed a new link over and it was set up with another.
const takeover: StaffLoginEvent[] = [
  ev('2026-09-01T09:00:00', 'invited', 'Grace', { emailed: true }),
  ev('2026-09-01T10:00:00', 'activated', 'staff:mar-1', { email: 'priya@example.com' }),
  ev('2026-10-05T09:00:00', 'closed', 'Grace'),
  ev('2026-10-05T09:01:00', 'invited', 'Grace', { emailed: false }),
  ev('2026-10-05T09:05:00', 'activated', 'staff:mar-1', { email: 'grace.spare@example.com' }),
];

describe('the staff login close review', () => {
  it('follows a close through the re-invite and re-join, and calls the takeover pattern high risk', () => {
    const [c] = loginCases(takeover, [], [phone('2026-10-06', 600, 900), phone('2026-09-20', 600, 900)], '2026-10-01', '2026-10-31');
    expect(c).toMatchObject({
      id: 'mar-1:2026-10-05T09:00:00Z',
      status: 'rejoined',
      closedBy: 'Grace',
      reinvitedBy: 'Grace',
      reinviteEmailed: false,
      previousEmail: 'priya@example.com',
      newEmail: 'grace.spare@example.com',
      // Only the hours after the re-join: September's were before it.
      phoneHours: 5,
      risk: 'high',
      needsReview: true,
    });
    expect(c.flags).toEqual(['same_person', 'handed_over', 'new_address', 'phone_hours']);
  });

  it('treats a genuine lost-address case, emailed by someone else, as low risk but still for review', () => {
    const log = [
      ev('2026-09-01T10:00:00', 'activated', 'staff:mar-1', { email: 'priya@old.example' }),
      ev('2026-10-05T09:00:00', 'closed', 'Grace'),
      ev('2026-10-05T11:00:00', 'invited', 'Olivia', { emailed: true }),
      ev('2026-10-05T12:00:00', 'activated', 'staff:mar-1', { email: 'priya@old.example' }),
    ];
    const [c] = loginCases(log, [], [], '2026-10-01', '2026-10-31');
    expect(c).toMatchObject({ risk: 'low', flags: [], needsReview: true });
    // Olivia sent the new link, so she may not sign it off either, though Grace closed it.
    expect(reviewRefusal(c, 'Olivia')).toMatch(/someone else/);
    expect(reviewRefusal(c, 'Ben')).toBeNull();
  });

  it('needs no review for a login closed and left closed, and only counts closes in the period', () => {
    const log = [...takeover.slice(0, 3), ev('2026-11-02T09:00:00', 'closed', 'Grace')];
    const cases = loginCases(log, [], [], '2026-10-01', '2026-10-31');
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ status: 'closed', needsReview: false, risk: 'low' });
  });

  it('keeps each close its own case, and stops counting hours at the next close', () => {
    const log = [...takeover, ev('2026-10-10T09:00:00', 'closed', 'Olivia')];
    const cases = loginCases(log, [], [phone('2026-10-06', 600, 900), phone('2026-10-12', 600, 660)], '2026-10-01', '2026-10-31');
    expect(cases.map((c) => c.closedBy)).toEqual(['Olivia', 'Grace']);
    expect(cases[1].phoneHours).toBe(5);
  });

  it('marks a signed-off case done, and refuses a sign-off by anyone who closed or re-invited it', () => {
    const [open] = loginCases(takeover, [], [], '2026-10-01', '2026-10-31');
    expect(reviewRefusal(open, 'Grace')).toMatch(/someone else/);
    expect(reviewRefusal(open, 'Olivia')).toBeNull();
    const review = { caseId: open.id, at: '2026-10-31T09:00:00Z', by: 'Olivia', outcome: 'concern' as const, note: 'Asked Priya: she did not ask for this.' };
    const [done] = loginCases(takeover, [review], [], '2026-10-01', '2026-10-31');
    expect(done).toMatchObject({ needsReview: false, review: { outcome: 'concern' } });
    expect(reviewRefusal(done, 'Ben')).toMatch(/signed off by Olivia/);
  });
});
