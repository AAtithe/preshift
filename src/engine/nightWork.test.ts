import { describe, expect, it } from 'vitest';
import { hrChecks } from './hr';
import { isNightShift, nightMinutes } from './night';
import { nightWorkIssues, nightWorkStatus } from './nightWork';
import { addDays } from './time';
import type { Employee, HrRecord, RotaState, Shift, TimeEntry } from './types';

const WEEK = '2026-11-02';
const person = (over: Partial<Employee> = {}): Employee => ({
  id: 'e1', name: 'Sam Lee', siteId: 'mar', entityId: 'co', coverSiteIds: [], roleIds: ['server'], payBasis: 'hourly', hourlyRate: 12, annualSalary: 0,
  dateOfBirth: '1990-01-01', contractedHours: 0, maxWeeklyHours: 60, optedOutOf48: false, irregularHours: true, pensionEnrolled: true,
  availability: [], leave: [], ...over,
});
let n = 0;
const shift = (date: string, start: number, end: number, brk = 0): Shift => ({ id: `s${n++}`, employeeId: 'e1', roleId: 'server', siteId: 'mar', date, startMinute: start * 60, endMinute: end * 60, breakMinutes: brk });
const clocked = (s: Shift): TimeEntry => ({ id: `te-${s.id}`, employeeId: s.employeeId, siteId: s.siteId, roleId: s.roleId, date: s.date, clockIn: s.startMinute, clockOut: s.endMinute, breakMinutes: s.breakMinutes, status: 'approved', source: 'clock' });
const state = (employees: Employee[], shifts: Shift[]) => ({ employees, shifts, sites: [], roles: [], forecast: [], demandRules: [], entities: [] }) as unknown as RotaState;
const offer = (date: string, nextDue = addDays(date, 365)): HrRecord => ({ id: 'h1', employeeId: 'e1', kind: 'health_assessment', date, title: 'Night work health assessment', outcome: 'Offered', nextDue, createdBy: 'HR', createdAt: date });

describe('night shifts', () => {
  it('counts paid hours between 23:00 and 06:00 on every day the shift touches', () => {
    expect(nightMinutes(shift(WEEK, 22, 30))).toBe(7 * 60);
    expect(nightMinutes(shift(WEEK, 20, 28, 60))).toBeCloseTo(5 * 60 * (7 / 8), 6);
    expect(isNightShift(shift(WEEK, 18, 26))).toBe(true); // 23:00 to 02:00
    expect(isNightShift(shift(WEEK, 17, 25))).toBe(false); // two hours only
    expect(isNightShift(shift(WEEK, 3, 11))).toBe(true); // 03:00 to 06:00
  });
});

describe('night workers', () => {
  const nightWeek = [0, 1, 2, 3].map((d) => shift(addDays(WEEK, d), 22, 30));

  it('treats someone rostered on three night shifts as a night worker from the start', () => {
    const s = nightWorkStatus(person(), { shifts: nightWeek }, [], [], WEEK);
    expect(s).toMatchObject({ nightWorker: true, nightShiftsThisWeek: 4 });
  });

  it('judges regular night work over the reference weeks, a third of days at least', () => {
    const history = [1, 2, 3, 4].flatMap((w) => {
      const monday = addDays(WEEK, -7 * w);
      return [shift(monday, 22, 30), shift(addDays(monday, 2), 10, 18)];
    });
    const day = [shift(WEEK, 10, 18)];
    expect(nightWorkStatus(person(), { shifts: day }, history.map(clocked), [], WEEK).nightWorker).toBe(true);
    const mostlyDays = [1, 2, 3, 4].flatMap((w) => {
      const monday = addDays(WEEK, -7 * w);
      return [shift(monday, 10, 18), shift(addDays(monday, 1), 10, 18), shift(addDays(monday, 2), 10, 18), shift(addDays(monday, 3), 10, 18)];
    });
    expect(nightWorkStatus(person(), { shifts: day }, [...mostlyDays, shift(addDays(WEEK, -7), 22, 30)].map(clocked), [], WEEK).nightWorker).toBe(false);
  });

  it('asks for a health assessment offer until one is on file, and again when it falls due', () => {
    expect(nightWorkIssues(state([person()], nightWeek), [], [], WEEK).map((i) => i.code)).toEqual(['night-health']);
    expect(nightWorkIssues(state([person()], nightWeek), [], [offer('2026-10-01')], WEEK)).toEqual([]);
    expect(nightWorkIssues(state([person()], nightWeek), [], [offer('2025-10-01')], WEEK).map((i) => i.code)).toEqual(['night-health']);
  });

  it('holds night workers to 8 hours in each 24 even with a 48 hour opt-out', () => {
    // Six weeks of five ten-hour nights: 50 hours a week is 8.3 a day once the rest day is left out.
    const history = [1, 2, 3, 4, 5].flatMap((w) => [0, 1, 2, 3, 4].map((d) => shift(addDays(addDays(WEEK, -7 * w), d), 21, 31)));
    const week = [0, 1, 2, 3, 4].map((d) => shift(addDays(WEEK, d), 21, 31));
    const issues = nightWorkIssues(state([person({ optedOutOf48: true })], week), history.map(clocked), [offer('2026-10-01')], WEEK);
    expect(issues.map((i) => i.code)).toEqual(['night-average']);
    expect(issues[0].message).toContain('8.33h');
  });

  it('shows in the HR checks for someone with night shifts on the rota and no offer', () => {
    const today = WEEK;
    const codes = (records: HrRecord[]) => hrChecks(person(), records, [], today, nightWeek).map((c) => c.code);
    expect(codes([])).toContain('night-health');
    expect(codes([offer('2026-10-01')])).not.toContain('night-health');
  });
});
