import { describe, expect, it } from 'vitest';
import { addWorkingDays, approvalDigest, DEFAULT_PAY_POLICY, nextCutoff, standingOf } from './payPolicy';

describe('the rule for pay approvals', () => {
  it('counts working days past weekends and bank holidays', () => {
    expect(addWorkingDays('2026-10-22', 2)).toBe('2026-10-26'); // Thursday to Monday
    expect(addWorkingDays('2026-12-24', 1)).toBe('2026-12-29'); // Christmas and Boxing Day, substitute Monday 28th
  });

  it('finds the next payroll cut-off, today included', () => {
    expect(nextCutoff('2026-10-21', DEFAULT_PAY_POLICY)).toBe('2026-10-26');
    expect(nextCutoff('2026-10-26', DEFAULT_PAY_POLICY)).toBe('2026-10-26');
    expect(nextCutoff('2026-10-21', { turnaroundDays: 2, cutoffWeekday: 2 })).toBe('2026-10-21');
  });

  it('says where a change stands, and when the owner is copied in', () => {
    const c = { requestedAt: '2026-10-19T09:00:00.000Z' };
    expect(standingOf(c, '2026-10-20', DEFAULT_PAY_POLICY)).toMatchObject({ dueBy: '2026-10-21', standing: 'on_time' });
    expect(standingOf(c, '2026-10-21', DEFAULT_PAY_POLICY).standing).toBe('due_today');
    expect(standingOf(c, '2026-10-22', DEFAULT_PAY_POLICY).standing).toBe('overdue');
    expect(approvalDigest([c], '2026-10-20', DEFAULT_PAY_POLICY)).toMatchObject({ waiting: 1, overdue: 0, nearCutoff: 0, escalate: false, oldestDays: 1 });
    expect(approvalDigest([c], '2026-10-22', DEFAULT_PAY_POLICY).escalate).toBe(true);
    // Sunday before a Monday cut-off: still inside the turnaround, but a day from the pay run.
    expect(approvalDigest([{ requestedAt: '2026-10-23T09:00:00.000Z' }], '2026-10-25', DEFAULT_PAY_POLICY)).toMatchObject({ overdue: 0, nearCutoff: 1, escalate: true });
  });
});
