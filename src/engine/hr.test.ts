import { describe, expect, it } from 'vitest';
import { checkWeek } from './compliance';
import { newEmployee } from './employees';
import { absenceDays, bradfordFactor, hrChecks, hrSummary, isAbsentOn, lengthOfService, statutoryNoticeWeeks, trainingStatus } from './hr';
import { seedHrRecords, seedState } from './seed';
import type { Absence, Employee, HrRecord } from './types';

const TODAY = '2026-10-21';
const roles = seedState(TODAY).roles;

function person(extra: Partial<Employee> = {}): Employee {
  return {
    ...newEmployee('mar', 'wdl', 'server', '2024-01-08'),
    id: 'p1',
    name: 'Test Person',
    dateOfBirth: '1995-01-01',
    rightToWork: { checked: true },
    hr: {
      contractIssuedOn: '2024-01-02', contractSignedOn: '2024-01-05', niNumber: 'QQ123456C',
      emergencyContact: { name: 'Kin', phone: '07700 900000' },
    },
    ...extra,
  };
}

const sick = (from: string, to?: string, extra: Partial<Absence> = {}): Absence => ({ id: `${from}`, type: 'sickness', from, to, ...extra });
const training = (title: string, date: string, expiresOn?: string): HrRecord => ({
  id: title, employeeId: 'p1', kind: 'training', title, date, expiresOn, createdBy: 't', createdAt: TODAY,
});
const appraisal: HrRecord = { id: 'r', employeeId: 'p1', kind: 'review', reviewType: 'appraisal', title: 'Appraisal', date: '2026-06-01', createdBy: 't', createdAt: TODAY };
const codes = (e: Employee, records: HrRecord[] = [appraisal]) => hrChecks(e, records, roles, TODAY).map((c) => c.code);

describe('absence', () => {
  it('counts inclusive calendar days up to today', () => {
    expect(absenceDays(sick('2026-10-01', '2026-10-03'), TODAY)).toBe(3);
    expect(absenceDays(sick('2026-10-19'), TODAY)).toBe(3);
    expect(absenceDays(sick('2026-11-01', '2026-11-02'), TODAY)).toBe(0);
  });

  it('scores the Bradford factor on spells squared times days, leaving out protected absence', () => {
    const six = Array.from({ length: 6 }, (_, i) => sick(`2026-0${i + 1}-10`, `2026-0${i + 1}-10`));
    expect(bradfordFactor(person({ absences: six }), TODAY)).toEqual({ spells: 6, days: 6, score: 216 });
    expect(bradfordFactor(person({ absences: [sick('2026-03-01', '2026-03-06')] }), TODAY).score).toBe(6);
    const excluded = six.map((a) => ({ ...a, excludeFromTriggers: true }));
    expect(bradfordFactor(person({ absences: excluded }), TODAY).score).toBe(0);
    // Older than 52 weeks and statutory leave never count.
    const other = [sick('2025-01-10', '2025-01-11'), { id: 'f', type: 'family' as const, from: '2026-05-01', to: '2026-08-01' }];
    expect(bradfordFactor(person({ absences: other }), TODAY).score).toBe(0);
  });

  it('blocks a shift on an absence day', () => {
    const state = seedState(TODAY);
    const e = person({ absences: [sick('2026-10-20')] });
    state.employees.push(e);
    expect(isAbsentOn(e, '2026-10-25')).toBe(true);
    state.shifts.push({ id: 's', employeeId: 'p1', roleId: 'server', siteId: 'mar', date: '2026-10-22', startMinute: 600, endMinute: 900, breakMinutes: 0 });
    expect(checkWeek(state, '2026-10-19', 'mar').filter((i) => i.shiftId === 's').map((i) => i.code)).toContain('absent');
  });
});

describe('personnel file checks', () => {
  it('passes a complete file', () => {
    const records = [training('Allergen awareness', '2026-01-01', '2029-01-01'), appraisal];
    expect(hrChecks(person(), records, roles, TODAY)).toEqual([]);
  });

  it('treats a missing written statement as a legal gap, and a starter as a to-do', () => {
    const e = person({ hr: { ...person().hr, contractIssuedOn: undefined } });
    expect(hrChecks(e, [], roles, TODAY).find((c) => c.code === 'statement')?.severity).toBe('block');
    const starter = { ...e, startDate: '2026-11-01' };
    expect(hrChecks(starter, [], roles, TODAY).find((c) => c.code === 'statement')?.severity).toBe('warn');
  });

  it('flags probation, fixed-term end and missing details', () => {
    const e = person({
      hr: { contractIssuedOn: '2024-01-02', contractSignedOn: '2024-01-05', probationEnd: '2026-10-01', contractType: 'fixed-term', fixedTermEnd: '2026-11-15' },
    });
    expect(codes(e)).toEqual(expect.arrayContaining(['probation', 'fixed-term', 'ni-number', 'emergency-contact']));
  });

  it('chases fit notes and return to work conversations', () => {
    const e = person({ absences: [sick('2026-10-01', '2026-10-10'), sick('2026-10-19')] });
    const c = codes(e);
    expect(c).toContain('fit-note:2026-10-01');
    expect(c).toContain('rtw:2026-10-01');
    expect(c).toContain('off:2026-10-19');
    const done = person({ absences: [sick('2026-10-01', '2026-10-10', { fitNote: true, returnToWorkOn: '2026-10-11' })] });
    expect(codes(done).filter((x) => x.includes('2026-10-01'))).toEqual([]);
  });

  it('expects training by role and tracks expiry', () => {
    const chef = person({ roleIds: ['chef'] });
    expect(codes(chef)).toEqual(expect.arrayContaining(['training:Food hygiene level 2', 'training:Allergen awareness']));
    const records = [training('Food hygiene level 2', '2023-11-01', '2026-11-01'), training('Allergen awareness', '2023-01-01', '2026-01-01')];
    expect(trainingStatus(records, 'p1', 'Food hygiene level 2', TODAY).status).toBe('expiring');
    expect(trainingStatus(records, 'p1', 'Allergen awareness', TODAY).status).toBe('expired');
    expect(trainingStatus([], 'p1', 'COSHH', TODAY).status).toBe('missing');
  });

  it('wants a review at least once a year and reports open cases and live warnings', () => {
    expect(codes(person(), [])).toContain('review-due');
    const cases: HrRecord[] = [
      { id: 'c1', employeeId: 'p1', kind: 'case', caseType: 'disciplinary', caseStatus: 'open', title: 'Lateness', date: '2026-10-01', createdBy: 't', createdAt: TODAY },
      { id: 'c2', employeeId: 'p1', kind: 'case', caseType: 'disciplinary', caseStatus: 'closed', title: 'Till', date: '2026-05-01', outcome: 'First written warning', warningExpires: '2026-11-01', createdBy: 't', createdAt: TODAY },
    ];
    expect(codes(person(), [appraisal, ...cases])).toEqual(expect.arrayContaining(['case:c1', 'warning:c2']));
  });

  it('says nothing about people who have left', () => {
    expect(hrChecks(person({ leaveDate: '2026-09-01', hr: {} }), [], roles, TODAY)).toEqual([]);
  });
});

describe('service and notice', () => {
  it('gives a week after a month, then a week a year to twelve', () => {
    expect(statutoryNoticeWeeks(person({ startDate: '2026-10-01' }), TODAY)).toBe(0);
    expect(statutoryNoticeWeeks(person({ startDate: '2026-06-01' }), TODAY)).toBe(1);
    expect(statutoryNoticeWeeks(person({ startDate: '2021-10-01' }), TODAY)).toBe(5);
    expect(statutoryNoticeWeeks(person({ startDate: '2000-01-01' }), TODAY)).toBe(12);
    expect(lengthOfService(person({ startDate: '2024-01-08' }), TODAY)).toBe('2y 9m');
  });

  it('summarises headcount, turnover and sickness', () => {
    const team = [
      person({ id: 'a', startDate: '2020-01-01', absences: [sick('2026-09-01', '2026-09-04')] }),
      person({ id: 'b', startDate: '2020-01-01' }),
      person({ id: 'c', startDate: '2020-01-01', leaveDate: '2026-03-01' }),
      person({ id: 'd', startDate: '2026-04-01' }),
    ];
    const s = hrSummary(team, TODAY);
    expect(s.headcount).toBe(3);
    expect(s.leaversLastYear).toBe(1);
    expect(s.startersLastYear).toBe(1);
    expect(s.turnover).toBeCloseTo(1 / 3);
    expect(s.sickDaysPerHead).toBeCloseTo(4 / 3);
  });
});

describe('demo data', () => {
  it('gives every HR screen something to act on', () => {
    const state = seedState(TODAY);
    const records = seedHrRecords(TODAY);
    const all = state.employees.flatMap((e) => hrChecks(e, records, state.roles, TODAY).map((c) => c.code.split(':')[0]));
    for (const code of ['statement', 'probation', 'fixed-term', 'ni-number', 'emergency-contact', 'off', 'fit-note', 'rtw', 'bradford', 'training', 'review-due', 'case', 'warning']) {
      expect(all).toContain(code);
    }
    expect(records.every((r) => state.employees.some((e) => e.id === r.employeeId))).toBe(true);
  });
});
