import { describe, expect, it } from 'vitest';
import {
  cutoffInstant,
  DEFAULT_SCHEDULE,
  isWorkingDay,
  periodContaining,
  periodsBetween,
  SCHEDULE_PRESETS,
  scheduleFor,
  scheduleProblems,
  timeCards,
  upcomingPeriods,
  type PaySchedule,
} from './payPeriods';
import { seedState } from './seed';
import type { Employee, Shift, TimeEntry } from './types';

const make = (frequency: PaySchedule['frequency'], extra: Partial<PaySchedule> = {}): PaySchedule => ({
  id: frequency,
  name: frequency,
  ...SCHEDULE_PRESETS[frequency],
  ...extra,
});

describe('pay periods', () => {
  it('runs weekly Monday to Sunday, paid the Friday after with hours due by the Tuesday', () => {
    expect(periodContaining(DEFAULT_SCHEDULE, '2026-10-22')).toEqual({
      scheduleId: 'weekly',
      periodStart: '2026-10-19',
      periodEnd: '2026-10-25',
      payDate: '2026-10-30',
      cutoffDate: '2026-10-27',
      cutoffTime: '12:00',
    });
  });

  it('keeps a fortnightly and four weekly cycle from its anchor, whichever day is asked about', () => {
    const fortnight = make('fortnightly', { anchorDate: '2026-10-12' });
    expect(periodContaining(fortnight, '2026-10-12').periodEnd).toBe('2026-10-25');
    expect(periodContaining(fortnight, '2026-10-26').periodStart).toBe('2026-10-26');
    expect(periodContaining(fortnight, '2026-10-11').periodStart).toBe('2026-09-28');
    const four = make('four_weekly', { anchorDate: '2026-01-05' });
    const p = periodContaining(four, '2026-10-22');
    expect(p.periodStart).toBe('2026-10-12');
    expect(p.periodEnd).toBe('2026-11-08');
  });

  it('pays a monthly payroll on the last working day, with hours to the 20th', () => {
    const p = periodContaining(make('monthly'), '2026-10-01');
    expect(p).toMatchObject({ periodStart: '2026-09-21', periodEnd: '2026-10-20', payDate: '2026-10-30' });
    // Five days before Friday 30 October is a Sunday, so hours are due the Friday before.
    expect(p.cutoffDate).toBe('2026-10-23');
    expect(periodContaining(make('monthly'), '2026-10-21').periodEnd).toBe('2026-11-20');
  });

  it('runs a true calendar month when paid in the month after', () => {
    const p = periodContaining(make('monthly', { periodEndDay: 31, payDay: 7, payMonthOffset: 1 }), '2026-02-14');
    expect(p).toMatchObject({ periodStart: '2026-02-01', periodEnd: '2026-02-28', payDate: '2026-03-06' });
  });

  it('pays on the last Friday, moved back off Christmas Day, with whole weeks of hours', () => {
    const s = make('last_friday');
    const oct = periodContaining(s, '2026-10-01');
    expect(oct).toMatchObject({ periodStart: '2026-09-21', periodEnd: '2026-10-25', payDate: '2026-10-30', cutoffDate: '2026-10-27' });
    const dec = periodContaining(s, '2026-12-10');
    expect(dec.payDate).toBe('2026-12-24');
    // The period is counted from the Friday itself, so a bank holiday never moves the hours.
    expect(dec.periodEnd).toBe('2026-12-20');
    expect(dec.periodStart).toBe('2026-11-23');
  });

  it('moves a payday that falls on a bank holiday or weekend to the working day before', () => {
    expect(isWorkingDay('2026-12-25')).toBe(false);
    expect(isWorkingDay('2026-12-24')).toBe(true);
    const monthly = make('monthly', { periodEndDay: 15, payDay: 31 });
    expect(periodContaining(monthly, '2026-04-10').payDate).toBe('2026-04-30');
    expect(periodContaining(monthly, '2026-08-01').payDate).toBe('2026-08-28'); // 31st is the bank holiday Monday
  });

  it('never wants hours before they are worked, even over Christmas', () => {
    // Three days before Thursday 31 December is the Boxing Day substitute holiday; back from there is inside the week.
    const xmas = periodContaining(DEFAULT_SCHEDULE, '2026-12-23');
    expect(xmas).toMatchObject({ periodEnd: '2026-12-27', payDate: '2026-12-31', cutoffDate: '2026-12-29' });
  });

  it('lists every period touching a range, end to end with no gaps', () => {
    const periods = periodsBetween(make('last_friday'), '2026-01-01', '2026-12-31');
    for (let i = 1; i < periods.length; i++) {
      const prev = new Date(periods[i - 1].periodEnd);
      prev.setUTCDate(prev.getUTCDate() + 1);
      expect(periods[i].periodStart).toBe(prev.toISOString().slice(0, 10));
    }
    expect(periods.length).toBe(13);
  });

  it('turns the cutoff into an instant in UK time, summer and winter', () => {
    expect(cutoffInstant({ cutoffDate: '2026-07-14', cutoffTime: '12:00' })).toBe('2026-07-14T11:00:00.000Z');
    expect(cutoffInstant({ cutoffDate: '2026-11-17', cutoffTime: '12:00' })).toBe('2026-11-17T12:00:00.000Z');
  });

  it('refuses a calendar that would want hours before they are worked', () => {
    expect(scheduleProblems(make('monthly', { periodEndDay: 31, payDay: 31, payMonthOffset: 0 }), '2026-10-22')[0]).toMatch(/End the hours period earlier/);
    expect(scheduleProblems(make('weekly', { payDaysAfterPeriodEnd: 1, cutoffDaysBeforePay: 3 }), '2026-10-22')[0]).toMatch(/before its last day is worked/);
    for (const f of Object.keys(SCHEDULE_PRESETS) as PaySchedule['frequency'][]) expect(scheduleProblems(make(f), '2026-10-22')).toEqual([]);
    expect(scheduleProblems(make('weekly', { cutoffTime: '25:00' }), '2026-10-22')).toHaveLength(1);
  });

  it('shows the year ahead for a client to check', () => {
    expect(upcomingPeriods(make('fortnightly'), '2026-10-22', 26)).toHaveLength(26);
  });

  it("pays a person on their own payroll, or their company's first", () => {
    const monthly = make('monthly');
    const entity = { paySchedules: [DEFAULT_SCHEDULE, monthly] };
    expect(scheduleFor({ payScheduleId: 'monthly' }, entity).id).toBe('monthly');
    expect(scheduleFor({}, entity).id).toBe('weekly');
    expect(scheduleFor({ payScheduleId: 'gone' }, entity).id).toBe('weekly');
    expect(scheduleFor({}, {}).id).toBe('weekly');
  });
});

describe('time cards', () => {
  const state = seedState('2026-10-21');
  const [a, b] = state.employees as [Employee, Employee];
  const shift = (id: string, e: Employee, date: string): Shift => ({ id, employeeId: e.id, roleId: e.roleIds[0], siteId: e.siteId, date, startMinute: 600, endMinute: 960, breakMinutes: 0 });
  const entry = (id: string, e: Employee, date: string, status: TimeEntry['status'], shiftId?: string): TimeEntry => ({
    id, employeeId: e.id, siteId: e.siteId, roleId: e.roleIds[0], shiftId, date, clockIn: 600, clockOut: 1020, breakMinutes: 0, status, source: 'clock',
  });

  it('puts rota against clock for each person, with what still blocks payroll', () => {
    const cards = timeCards(
      [a, b],
      [shift('s1', a, '2026-10-19'), shift('s2', a, '2026-10-20'), shift('s3', b, '2026-10-19')],
      [entry('t1', a, '2026-10-19', 'approved', 's1'), entry('t2', b, '2026-10-19', 'submitted', 's3'), entry('t3', b, '2026-10-21', 'submitted')],
      { periodStart: '2026-10-19', periodEnd: '2026-10-25' },
      '2026-10-22',
    );
    const ca = cards.find((c) => c.employeeId === a.id)!;
    expect(ca).toMatchObject({ rosteredHours: 12, clockedHours: 7, approvedHours: 7, notClocked: 1, status: 'approved' });
    const cb = cards.find((c) => c.employeeId === b.id)!;
    expect(cb).toMatchObject({ rosteredHours: 6, clockedHours: 14, variance: 8, unrostered: 1, waiting: 2, status: 'waiting' });
  });
});
