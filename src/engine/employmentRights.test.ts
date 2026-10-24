import { describe, expect, it } from 'vitest';
import {
  assessShortNotice,
  DEFAULT_ERA_SETTINGS,
  lostMinutes,
  offerCandidates,
  offerLetter,
  offerStanding,
  rollingAverageIssues,
  type HoursOffer,
  type ShiftSnapshot,
} from './employmentRights';
import { addDays } from './time';
import type { Employee, RotaState, Shift, TimeEntry } from './types';

const person = (over: Partial<Employee> = {}): Employee => ({
  id: 'e1',
  name: 'Sam Lee',
  siteId: 'mar',
  entityId: 'co',
  coverSiteIds: [],
  roleIds: ['server'],
  payBasis: 'hourly',
  hourlyRate: 12,
  annualSalary: 0,
  dateOfBirth: '1995-01-01',
  contractedHours: 0,
  maxWeeklyHours: 60,
  optedOutOf48: false,
  irregularHours: true,
  pensionEnrolled: true,
  availability: [],
  leave: [],
  ...over,
});

// Monday 2 November 2026, 10:00 in London (GMT).
const NOW = new Date('2026-11-02T10:00:00Z');
const shift = (date: string, start: number, end: number, brk = 0, employeeId = 'e1'): ShiftSnapshot => ({
  employeeId,
  siteId: 'mar',
  roleId: 'server',
  date,
  startMinute: start * 60,
  endMinute: end * 60,
  breakMinutes: brk,
});
const TUESDAY = '2026-11-03';

describe('short notice changes', () => {
  it('owes the whole shift when a published shift is cancelled inside the notice window', () => {
    const a = assessShortNotice(shift(TUESDAY, 12, 18), null, person(), NOW)!;
    expect(a).toMatchObject({ change: 'cancelled', minutesLost: 360, noticeHours: 26, amount: 72, owed: false });
    const started = assessShortNotice(shift(TUESDAY, 12, 18), null, person(), NOW, { ...DEFAULT_ERA_SETTINGS, shortNoticeFrom: '2026-11-01' })!;
    expect(started.owed).toBe(true);
  });

  it('owes the hours taken away when a shift is cut or moved, and all of it when given to someone else', () => {
    expect(assessShortNotice(shift(TUESDAY, 12, 18), shift(TUESDAY, 12, 15), person(), NOW)).toMatchObject({ change: 'cut', minutesLost: 180, amount: 36 });
    expect(assessShortNotice(shift(TUESDAY, 12, 18), shift(TUESDAY, 15, 21), person(), NOW)).toMatchObject({ change: 'moved', minutesLost: 180 });
    expect(assessShortNotice(shift(TUESDAY, 12, 18), shift(TUESDAY, 12, 18, 0, 'e2'), person(), NOW)).toMatchObject({ change: 'cancelled', minutesLost: 360 });
    expect(assessShortNotice(shift(TUESDAY, 12, 18), shift(TUESDAY, 11, 19), person(), NOW)).toBeNull();
  });

  it('takes an unpaid break as spread across the shift', () => {
    expect(lostMinutes(shift(TUESDAY, 12, 18, 30), shift(TUESDAY, 12, 15))).toBe(165);
  });

  it('counts sending someone home mid-shift, measured to the new finish', () => {
    // 09:00 to 17:00 today, cut at 10:00 to finish at 13:00: four hours lost with three hours' notice.
    expect(assessShortNotice(shift('2026-11-02', 9, 17), shift('2026-11-02', 9, 13), person(), NOW)).toMatchObject({ change: 'cut', minutesLost: 240, noticeHours: 3 });
  });

  it('owes nothing with enough notice, for time already gone, or for people on enough hours', () => {
    expect(assessShortNotice(shift('2026-11-05', 12, 18), null, person(), NOW)).toBeNull();
    expect(assessShortNotice(shift('2026-11-02', 9, 17), null, person(), NOW)).toBeNull();
    expect(assessShortNotice(shift('2026-11-02', 6, 12), shift('2026-11-02', 6, 9), person(), NOW)).toBeNull();
    expect(assessShortNotice(shift(TUESDAY, 12, 18), null, person({ contractedHours: 20 }), NOW)).toBeNull();
    expect(assessShortNotice(shift(TUESDAY, 12, 18), null, person({ payBasis: 'salaried', annualSalary: 30000 }), NOW)).toBeNull();
  });
});

const entry = (date: string, from: number, to: number, employeeId = 'e1', siteId = 'mar'): TimeEntry => ({
  id: `te-${employeeId}-${date}-${from}`,
  employeeId,
  siteId,
  roleId: 'server',
  date,
  clockIn: from * 60,
  clockOut: to * 60,
  breakMinutes: 0,
  status: 'approved',
  source: 'clock',
});

const state = (employees: Employee[], shifts: Shift[] = []) => ({ employees, shifts, sites: [], roles: [], forecast: [], demandRules: [], entities: [] }) as unknown as RotaState;

/** Twenty hours a week (two ten hour days) for the twelve weeks before 2 November. */
const twelveWeeks = Array.from({ length: 12 }, (_, i) => addDays('2026-11-02', -7 * (i + 1))).flatMap((w) => [entry(w, 8, 18), entry(addDays(w, 2), 8, 18)]);

describe('guaranteed hours offers', () => {
  it('finds who works beyond their contract, due once the measure starts and a full reference period is in', () => {
    const [c] = offerCandidates(state([person()]), twelveWeeks, 'mar', '2026-11-02', []);
    expect(c).toMatchObject({ employeeId: 'e1', averageHours: 20, suggestedHours: 20, due: false, referenceFrom: '2026-08-10', referenceTo: '2026-11-01' });
    const [due] = offerCandidates(state([person()]), twelveWeeks, 'mar', '2026-11-02', [], { ...DEFAULT_ERA_SETTINGS, guaranteedHoursFrom: '2026-10-01' });
    expect(due.due).toBe(true);
  });

  it('leaves out someone offered recently, unless the offer lapsed unanswered', () => {
    const offer: HoursOffer = {
      id: 'o1', employeeId: 'e1', siteId: 'mar', referenceFrom: '2026-08-03', referenceTo: '2026-10-25', averageHours: 20,
      contractedBefore: 0, offeredHours: 20, status: 'declined', offeredOn: '2026-10-26', respondBy: '2026-11-23', by: 'GM',
    };
    expect(offerCandidates(state([person()]), twelveWeeks, 'mar', '2026-11-02', [offer])).toEqual([]);
    const old = { ...offer, status: 'offered' as const, offeredOn: '2026-09-01', respondBy: '2026-09-29' };
    expect(offerStanding(old, '2026-11-02')).toBe('lapsed');
    expect(offerCandidates(state([person()]), twelveWeeks, 'mar', '2026-11-02', [old])).toHaveLength(1);
  });

  it('drafts a letter that says what is offered and that the worker may say no', () => {
    const letter = offerLetter(person(), { offeredHours: 20, contractedBefore: 0, referenceFrom: '2026-08-10', referenceTo: '2026-11-01', averageHours: 20, respondBy: '2026-11-30' }, 'West End Dining Ltd');
    expect(letter).toContain('Dear Sam,');
    expect(letter).toContain('guaranteeing 20 hours a week');
    expect(letter).toContain('no guaranteed hours');
    expect(letter).toContain('You do not have to accept');
    expect(letter).toContain('2026-11-30');
  });
});

describe('the 48 hour average on the rota', () => {
  const week = '2026-11-02';
  const fifty = (weeks: number) =>
    Array.from({ length: weeks }, (_, i) => addDays(week, -7 * (i + 1))).flatMap((w) => [0, 1, 2, 3, 4].map((d) => entry(addDays(w, d), 8, 18)));
  const rota: Shift[] = [0, 1, 2, 3, 4].map((d) => ({ id: `s${d}`, ...shift(addDays(week, d), 8, 18) }));

  it('warns when this week takes the rolling average over 48, saying how many hours keep it there', () => {
    const [issue] = rollingAverageIssues(state([person()], rota), fifty(16), week, 'mar');
    expect(issue).toMatchObject({ code: 'wtr-average', severity: 'warn', employeeId: 'e1' });
    expect(issue.message).toContain('17 week average to 50h');
    expect(issue.message).toContain('16h this week keeps it at 48');
  });

  it('says nothing with an opt-out or too little history', () => {
    expect(rollingAverageIssues(state([person({ optedOutOf48: true })], rota), fifty(16), week)).toEqual([]);
    expect(rollingAverageIssues(state([person()], rota), fifty(1), week)).toEqual([]);
  });
});
