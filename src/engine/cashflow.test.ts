import { describe, expect, it } from 'vitest';
import { cashCalendar, cashCsv, deductions, payPeriods, payScheduleProblem, workingDayOnOrBefore } from './cashflow';
import { newEmployee } from './employees';
import { addDays } from './time';
import type { Employee, Entity, RotaState, Shift } from './types';

const TODAY = '2026-10-22'; // a Thursday
const entity = (extra: Partial<Entity> = {}): Entity => ({ id: 'wdl', name: 'West End Dining Ltd', companyNumber: '1', payeReference: '120/WE1', intercompanyCode: '1351', ...extra });
const salaried = (extra: Partial<Employee> = {}): Employee => ({
  ...newEmployee('mar', 'wdl', 'server', '2025-01-06'), id: 'gm', name: 'Priya Shah', dateOfBirth: '1988-05-01', payBasis: 'salaried', annualSalary: 52_000, pensionEnrolled: true, ...extra,
});
const state = (employees: Employee[], shifts: Shift[] = [], entities: Entity[] = [entity()]): Pick<RotaState, 'employees' | 'shifts' | 'sites' | 'entities'> => ({
  employees, shifts, entities, sites: [{ id: 'mar', name: 'Marylebone', entityId: 'wdl', labourTargetPct: 0.28, trackingCode: 'MAR', openMinute: 600, closeMinute: 1380 }],
});

describe('what comes out of pay', () => {
  it('works tax, employee NI and pension on a weekly and a monthly period', () => {
    const e = salaried();
    expect(deductions(e, 500, 'weekly')).toEqual({ tax: 51.65, employeeNi: 20.66, employeePension: 15.2, net: 412.49 });
    expect(deductions(e, 3000, 'monthly')).toEqual({ tax: 390.5, employeeNi: 156.2, employeePension: 99.2, net: 2354.1 });
  });

  it('charges the higher rates above the basic rate band and the upper earnings limit', () => {
    const d = deductions(salaried({ pensionEnrolled: false }), 6000, 'monthly');
    expect(d.tax).toBe(1352.67);
    expect(d.employeeNi).toBe(287.55);
    expect(d.employeePension).toBe(0);
  });

  it('takes nothing from pay under the personal allowance and the primary threshold', () => {
    expect(deductions(salaried({ pensionEnrolled: false }), 200, 'weekly')).toEqual({ tax: 0, employeeNi: 0, employeePension: 0, net: 200 });
  });
});

describe('pay days and due dates', () => {
  it('pays a week on the Friday after it, a day earlier when that Friday is a bank holiday', () => {
    const weeks = payPeriods(entity(), '2026-10-30', '2027-01-08');
    expect(weeks[0]).toMatchObject({ from: '2026-10-19', to: '2026-10-25', payDate: '2026-10-30' });
    // The week to Sunday 27 December would be paid on New Year's Day.
    expect(weeks.find((p) => p.from === '2026-12-21')?.payDate).toBe('2026-12-31');
  });

  it('pays monthly on the last working day, or a set day moved back off a bank holiday', () => {
    expect(payPeriods(entity({ paySchedule: { frequency: 'monthly', monthlyPayDay: 'last-working' } }), '2026-10-01', '2026-10-31')[0])
      .toMatchObject({ from: '2026-10-01', to: '2026-10-31', payDate: '2026-10-30' });
    expect(payPeriods(entity({ paySchedule: { frequency: 'monthly', monthlyPayDay: 25 } }), '2026-12-01', '2026-12-31')[0].payDate).toBe('2026-12-24');
  });

  it('counts fortnights from the anchor Monday', () => {
    const p = payPeriods(entity({ paySchedule: { frequency: 'fortnightly', anchor: '2026-04-06', payLagDays: 5 } }), '2026-10-22', '2026-11-30');
    // Fortnights from 6 April: 5 October, 19 October, 2 November. Each is paid the Friday after it ends.
    expect(p.map((x) => [x.from, x.payDate])).toEqual([['2026-10-05', '2026-10-23'], ['2026-10-19', '2026-11-06'], ['2026-11-02', '2026-11-20']]);
  });

  it('moves a due date that falls at a weekend to the Friday before', () => {
    expect(workingDayOnOrBefore('2026-11-22')).toBe('2026-11-20');
    expect(workingDayOnOrBefore('2026-11-23')).toBe('2026-11-23');
  });

  it('checks a schedule before it is saved', () => {
    expect(payScheduleProblem({ frequency: 'weekly' })).toBeNull();
    expect(payScheduleProblem({ frequency: 'fortnightly', anchor: '2026-04-07' })).toMatch(/Monday/);
    expect(payScheduleProblem({ frequency: 'monthly', monthlyPayDay: 40 })).toMatch(/day of the month/);
  });
});

describe('the cash calendar', () => {
  it('pays net pay every Friday, PAYE by the 22nd and pensions by the 22nd of the month after', () => {
    const cal = cashCalendar(state([salaried()]), [], TODAY);
    const net = cal.items.filter((i) => i.kind === 'net-pay');
    // £1,000 a week: tax £158.31, employee NI £58.67, pension £33.88.
    expect(net[0]).toMatchObject({ date: '2026-10-23', amount: 749.14, covers: { from: '2026-10-12', to: '2026-10-18' }, people: 1 });
    expect(net).toHaveLength(13);

    // Tax month 6 October to 5 November: pay days 9, 16, 23 and 30 October. The 22nd of November is a Sunday.
    const hmrc = cal.items.find((i) => i.kind === 'hmrc' && i.covers.from === '2026-10-06')!;
    expect(hmrc).toMatchObject({ date: '2026-11-20', covers: { to: '2026-11-05' } });
    expect(hmrc.parts).toEqual({ tax: 633.24, employeeNi: 234.68, employerNi: 542.4, allowance: 0 });
    expect(hmrc.amount).toBe(1410.32);

    // October's five pay days, employer 3% and employee 4% of qualifying earnings each.
    const pension = cal.items.find((i) => i.kind === 'pension' && i.covers.from === '2026-10-01')!;
    expect(pension).toMatchObject({ date: '2026-11-20', amount: 296.45 });
  });

  it('sets Employment Allowance against the claimant’s employer NI from the month after its last payroll', () => {
    const claimant = entity({ employmentAllowance: { remaining: 10_500, asAt: '2026-10-04' } });
    const hmrc = cashCalendar(state([salaried()], [], [claimant]), [], TODAY).items.find((i) => i.kind === 'hmrc' && i.covers.from === '2026-10-06')!;
    expect(hmrc.parts!.allowance).toBe(542.4);
    expect(hmrc.amount).toBe(867.92);
  });

  it('uses the rota where the week is built, and repeats the last four weeks where it is not', () => {
    const hourly = { ...newEmployee('mar', 'wdl', 'server', '2025-01-06'), id: 'p1', name: 'Ama Mensah', dateOfBirth: '1996-04-12', hourlyRate: 13, pensionEnrolled: false } as Employee;
    let n = 0;
    const shift = (date: string): Shift => ({ id: `s${++n}`, employeeId: 'p1', roleId: 'server', siteId: 'mar', date, startMinute: 600, endMinute: 1080, breakMinutes: 30 });
    // Four weeks worked before this week, five 7.5 hour shifts each; this week and next rostered; later weeks not.
    const shifts: Shift[] = [];
    for (let w = -4; w <= 1; w++) for (let d = 0; d < 5; d++) shifts.push(shift(addDays('2026-10-19', w * 7 + d)));
    const cal = cashCalendar(state([hourly], shifts), [], TODAY);
    const net = cal.items.filter((i) => i.kind === 'net-pay');
    expect(net.find((i) => i.covers.from === '2026-10-19')!.bases).toEqual(['rota']);
    expect(net.find((i) => i.covers.from === '2026-11-02')!.bases).toEqual(['run-rate']);
    // The run rate is the same week again, so the same net pay.
    expect(net.find((i) => i.covers.from === '2026-11-02')!.amount).toBe(net.find((i) => i.covers.from === '2026-10-19')!.amount);
    expect(cal.notes.join(' ')).toMatch(/repeat each person's last 4 weeks/);
  });

  it('stops paying a leaver after their last day, and narrows to the companies asked for', () => {
    const cal = cashCalendar(state([salaried({ leaveDate: '2026-10-25' })]), [], TODAY);
    expect(cal.items.filter((i) => i.kind === 'net-pay').map((i) => i.date)).toEqual(['2026-10-23', '2026-10-30']);
    expect(cashCalendar(state([salaried()]), [], TODAY, 13, ['other']).items).toEqual([]);
  });

  it('adds the weeks up and writes a CSV', () => {
    const cal = cashCalendar(state([salaried()]), [], TODAY, 4);
    expect(cal.weeks).toHaveLength(4);
    expect(cal.weeks[3].cumulative).toBe(cal.totals.total);
    expect(cashCsv(cal, () => 'West End Dining Ltd').split('\n')[0]).toBe('Date,Company,Payment,Amount,Covers from,Covers to,People,Basis');
  });
});
