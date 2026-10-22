import { describe, expect, it } from 'vitest';
import { autoSchedule } from './autoschedule';
import { breakFor, checkEmployeeWeek, isChildOn, schoolLeavingDate } from './compliance';
import { parseIcs } from './events';
import { siteHistory } from './history';
import { estimatedHolidays, holidaysFromIcs, readSchoolFeed, inHoliday, isSchoolDay, learnSchoolEffect, schoolHolidays, schoolYearOf } from './school';
import { seedState } from './seed';
import { addDays } from './time';
import type { Employee, HourActual, SchoolPeriod, Shift } from './types';

describe('estimated school holidays', () => {
  it('follows the usual England pattern', () => {
    const y = estimatedHolidays(2026);
    const at = (key: string) => y.find((p) => p.id === `est:2026:${key}`)!;
    expect([at('autumn').start, at('autumn').end]).toEqual(['2026-10-26', '2026-10-30']);
    expect([at('christmas').start, at('christmas').end]).toEqual(['2026-12-19', '2027-01-03']);
    expect([at('february').start, at('february').end]).toEqual(['2027-02-15', '2027-02-19']);
    expect([at('easter').start, at('easter').end]).toEqual(['2027-03-22', '2027-04-02']);
    expect([at('may').start, at('may').end]).toEqual(['2027-05-31', '2027-06-04']);
    expect([at('summer').start, at('summer').end]).toEqual(['2027-07-22', '2027-09-01']);
    expect(y.every((p) => p.source === 'estimate')).toBe(true);
    // 2025/26: Christmas from Saturday 20 December, back Monday 5 January.
    const c = estimatedHolidays(2025).find((p) => p.kind === 'christmas')!;
    expect([c.start, c.end]).toEqual(['2025-12-20', '2026-01-04']);
  });

  it('lets a confirmed holiday replace only the estimate it stands for', () => {
    const council: SchoolPeriod[] = [{ id: 'c1', start: '2026-10-19', end: '2026-10-30', name: 'Autumn half term (two weeks)', kind: 'half_term', source: 'council' }];
    const both = schoolHolidays(council, '2026-09-01', '2027-08-31');
    expect(both.find((p) => p.id === 'c1')).toBeDefined();
    expect(both.some((p) => p.id === 'est:2026:autumn')).toBe(false);
    // Christmas and the rest stay estimated until the council's dates for them are in.
    expect(both.filter((p) => p.source === 'estimate').map((p) => p.id)).toEqual(['est:2026:christmas', 'est:2026:february', 'est:2026:easter', 'est:2026:may', 'est:2026:summer']);
    // A February half term on a different week from the estimate still replaces it.
    const feb = schoolHolidays([{ id: 'f', start: '2027-02-08', end: '2027-02-12', name: 'Half term', kind: 'half_term', source: 'manual' }], '2027-01-01', '2027-03-31');
    expect(feb.map((p) => p.id)).toEqual(['est:2026:christmas', 'f', 'est:2026:easter']);
    expect(schoolHolidays([], '2026-10-01', '2026-11-30', false)).toEqual([]);
    expect(schoolYearOf('2026-08-31')).toBe(2025);
    expect(schoolYearOf('2026-09-01')).toBe(2026);
  });

  it('reads council iCal feeds as spans or as term ends and starts', () => {
    const spans = parseIcs(['BEGIN:VEVENT', 'UID:ht', 'DTSTART;VALUE=DATE:20261026', 'DTEND;VALUE=DATE:20261031', 'SUMMARY:October Half Term', 'END:VEVENT', 'BEGIN:VEVENT', 'UID:in', 'DTSTART;VALUE=DATE:20261102', 'SUMMARY:INSET day', 'END:VEVENT'].join('\r\n'));
    expect(holidaysFromIcs(spans, 'f').map((p) => [p.start, p.end, p.kind])).toEqual([
      ['2026-10-26', '2026-10-30', 'half_term'],
      ['2026-11-02', '2026-11-02', 'inset'],
    ]);
    const terms = parseIcs(
      [
        ['20261218', 'Autumn term ends'],
        ['20270104', 'Spring term starts'],
        ['20270212', 'Last day of term'],
        ['20270222', 'First day of term'],
      ].map(([d, s], i) => ['BEGIN:VEVENT', `UID:t${i}`, `DTSTART;VALUE=DATE:${d}`, `SUMMARY:${s}`, 'END:VEVENT'].join('\r\n')).join('\r\n'),
    );
    expect(holidaysFromIcs(terms, 'f').map((p) => [p.start, p.end, p.kind])).toEqual([
      ['2026-12-19', '2027-01-03', 'christmas'],
      ['2027-02-13', '2027-02-21', 'half_term'],
    ]);
  });

  const feed = (rows: [string, string, string?][]) =>
    parseIcs(rows.map(([d, s, end], i) => ['BEGIN:VEVENT', `UID:r${i}`, `DTSTART;VALUE=DATE:${d}`, ...(end ? [`DTEND;VALUE=DATE:${end}`] : []), `SUMMARY:${s}`, 'END:VEVENT'].join('\r\n')).join('\r\n'));

  it('understands the ways councils word a term starting', () => {
    const r = readSchoolFeed(feed([['20261023', 'Autumn 1 ends'], ['20261102', 'Autumn 2 begins'], ['20261218', 'Autumn term ends'], ['20270104', 'Pupils return']]), 'f');
    expect(r.periods.map((p) => [p.start, p.end])).toEqual([['2026-10-24', '2026-11-01'], ['2026-12-19', '2027-01-03']]);
    expect(r.ignored).toEqual([]);
  });

  it('refuses a holiday longer than one can be, rather than confirming months of it', () => {
    // A term start the reader cannot recognise would otherwise make November and December a holiday.
    const r = readSchoolFeed(feed([['20261023', 'Autumn 1 ends'], ['20270104', 'Spring term starts']]), 'f');
    expect(r.periods).toEqual([]);
    expect(r.ignored[0]).toMatch(/too long to be one holiday/);
    const span = readSchoolFeed(feed([['20261026', 'Half term holiday', '20261231']]), 'f');
    expect(span.periods).toEqual([]);
    expect(span.ignored[0]).toMatch(/longer than a school holiday runs/);
  });

  it('does not mistake clubs, early closures or breakfast for holidays', () => {
    const r = readSchoolFeed(feed([['20261104', 'Breakfast club starts'], ['20261105', 'School closed early (parents evening)'], ['20261106', 'Holiday club'], ['20261109', 'INSET day']]), 'f');
    expect(r.periods.map((p) => [p.start, p.kind])).toEqual([['2026-11-09', 'inset']]);
  });

  it('counts only confirmed holidays as school-free for the law', () => {
    expect(isSchoolDay('2026-10-27', [])).toBe(true); // estimated half term: still term time for a child's hours
    const council: SchoolPeriod[] = [{ id: 'c', start: '2026-10-26', end: '2026-10-30', name: 'Half term', kind: 'half_term', source: 'council' }];
    expect(isSchoolDay('2026-10-27', council)).toBe(false);
    expect(isSchoolDay('2026-10-24', [])).toBe(false); // Saturday
    expect(isSchoolDay('2026-12-25', [])).toBe(false); // bank holiday
    expect(inHoliday(council, '2026-10-30')?.id).toBe('c');
  });
});

describe('what school holidays do to trade', () => {
  it('learns a daypart effect from holiday days against term days nearby', () => {
    // Summer: weekday lunches 40% busier, dinners unchanged.
    const holidays = estimatedHolidays(2025);
    const summer = holidays.find((p) => p.kind === 'summer')!;
    const rows: HourActual[] = [];
    for (let d = '2026-06-01'; d <= '2026-10-15'; d = addDays(d, 1)) {
      const inSummer = d >= summer.start && d <= summer.end;
      for (const hour of [12, 13, 19, 20]) rows.push({ siteId: 'mar', date: d, hour, sales: hour < 15 && inSummer ? 140 : 100, covers: 3 });
    }
    const effects = learnSchoolEffect(siteHistory(rows, 'mar'), holidays, new Set());
    const lunch = effects.find((e) => e.daypart === 'lunch' && !e.weekend)!;
    const dinner = effects.find((e) => e.daypart === 'dinner' && !e.weekend)!;
    expect(lunch.usable).toBe(true);
    expect(lunch.factor).toBeCloseTo(1.4, 1);
    expect(dinner.factor).toBeCloseTo(1, 1);
  });
});

describe('children on the rota', () => {
  const child = (dob: string, over: Partial<Employee> = {}): Employee => ({
    id: 'k', name: 'Kid', siteId: 'mar', entityId: 'wdl', coverSiteIds: [], roleIds: ['host'], payBasis: 'hourly', hourlyRate: 8, annualSalary: 0,
    dateOfBirth: dob, contractedHours: 0, maxWeeklyHours: 48, optedOutOf48: false, irregularHours: true, pensionEnrolled: false, availability: [], leave: [], ...over,
  });
  let n = 0;
  const shift = (date: string, start: number, end: number, brk = 0, roleId = 'host'): Shift => ({ id: `k${n++}`, employeeId: 'k', roleId, siteId: 'mar', date, startMinute: start * 60, endMinute: end * 60, breakMinutes: brk });
  const WEEK = '2026-10-19'; // a term week
  const HALF_TERM = '2026-10-26';
  const council: SchoolPeriod[] = [{ id: 'c', start: '2026-10-26', end: '2026-10-30', name: 'Half term', kind: 'half_term', source: 'council' }];
  const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

  it('knows who is still of school age, by nation', () => {
    // Turns 16 on 1 May 2027: can leave on the last Friday of June 2027.
    expect(schoolLeavingDate('2011-05-01')).toBe('2027-06-25');
    // Turns 16 on 1 October 2026: after the summer, so the year after.
    expect(schoolLeavingDate('2010-10-01')).toBe('2027-06-25');
    expect(schoolLeavingDate('2011-05-01', 'scotland')).toBe('2027-05-31');
    expect(schoolLeavingDate('2011-08-01', 'northern_ireland')).toBe('2028-06-30');
    expect(isChildOn({ dateOfBirth: '2011-05-01' }, '2027-06-25')).toBe(true);
    expect(isChildOn({ dateOfBirth: '2011-05-01' }, '2027-06-26')).toBe(false);
    // The seed's 17-year-old host has left school, so the young worker rules apply to them.
    expect(isChildOn({ dateOfBirth: '2009-04-21' }, '2026-10-21')).toBe(false);
  });

  it('holds a fifteen-year-old to term-time limits', () => {
    const k = child('2011-05-01');
    const issues = checkEmployeeWeek(k, WEEK, [
      shift(WEEK, 16, 19), // 3h on a school day
      shift(addDays(WEEK, 1), 12, 14), // during school hours
      shift(addDays(WEEK, 2), 17, 20), // past 19:00
      shift(addDays(WEEK, 5), 10, 19, 30), // Saturday 8.5h with half an hour's break
      shift(addDays(WEEK, 6), 10, 13), // Sunday 3h
    ]);
    expect(codes(issues)).toEqual(expect.arrayContaining(['child-daily', 'child-school-hours', 'child-time', 'break', 'child-weekly', 'child-permit']));
    expect(issues.find((i) => i.code === 'break')!.message).toMatch(/needs a 60 minute break \(school age/);
    expect(codes(issues)).not.toContain('young-daily');
    expect(issues.find((i) => i.code === 'child-weekly')!.message).toMatch(/12 hours a week in term time/);
  });

  it('adds up a day’s shifts against the daily limit, and flags the one that tips it over', () => {
    const k = child('2011-05-01');
    const before = shift(WEEK, 7, 8); // an hour before school
    const after = shift(WEEK, 16, 18); // two after: three in the day
    const issues = checkEmployeeWeek(k, WEEK, [before, after]);
    expect(issues.find((i) => i.code === 'child-daily')!.shiftId).toBe(after.id);
    // And a seventeen-year-old's split day counts as one day too.
    const teen = child('2009-03-01');
    const split = checkEmployeeWeek(teen, WEEK, [shift(WEEK, 8, 13), shift(WEEK, 15, 20)]);
    expect(split.map((i) => i.code)).toContain('young-daily');
  });

  it('warns about bar work by the role’s department, not its name', () => {
    const k = child('2011-05-01');
    const issues = checkEmployeeWeek(k, WEEK, [shift(addDays(WEEK, 5), 10, 12, 0, 'mixology')], undefined, undefined, { barRoleIds: ['mixology'] });
    expect(issues.map((i) => i.code)).toContain('child-bar');
  });

  it('allows holiday hours only once the council’s dates are in', () => {
    const k = child('2011-05-01');
    const week = [0, 1, 2, 3].map((i) => shift(addDays(HALF_TERM, i), 10, 18, 60)); // 7h a day, 28h
    const estimated = checkEmployeeWeek(k, HALF_TERM, week);
    expect(codes(estimated)).toContain('child-school-hours');
    const confirmed = checkEmployeeWeek(k, HALF_TERM, week, undefined, undefined, { schoolHolidays: council });
    expect(confirmed.filter((i) => i.severity === 'block')).toEqual([]);
    // A fourteen-year-old is held to five hours a day and 25 a week in the holidays.
    const younger = checkEmployeeWeek(child('2012-03-01'), HALF_TERM, week, undefined, undefined, { schoolHolidays: council });
    expect(codes(younger)).toEqual(expect.arrayContaining(['child-daily', 'child-weekly']));
  });

  it('gives a child an hour’s break after four hours, and blocks under thirteens', () => {
    expect(breakFor(child('2011-05-01'), '2026-10-24', 5 * 60)).toBe(60);
    expect(breakFor(child('2011-05-01'), '2026-10-24', 4 * 60)).toBe(0);
    expect(breakFor(child('2000-01-01'), '2026-10-24', 7 * 60)).toBe(20);
    expect(codes(checkEmployeeWeek(child('2014-01-01'), WEEK, [shift(addDays(WEEK, 5), 10, 12)]))).toContain('child-age');
  });

  it('never has the auto-build roster a child outside the law', () => {
    const state = seedState('2026-10-21');
    const kid = child('2011-05-01', { siteId: 'mar', roleIds: ['host'], availability: [] });
    const built = autoSchedule({ ...state, employees: [...state.employees, kid] }, 'mar', WEEK);
    const theirs = built.shifts.filter((s) => s.employeeId === 'k');
    const issues = checkEmployeeWeek(kid, WEEK, theirs);
    expect(issues.filter((i) => i.severity === 'block')).toEqual([]);
  });
});
