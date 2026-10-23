import { describe, expect, it } from 'vitest';
import { newEmployee } from './employees';
import { addDays, weekday } from './time';
import type { Employee, Shift, TimeEntry } from './types';
import {
  DEFAULT_WELFARE_POLICY,
  eligibilityCsv,
  milestones,
  personWelfare,
  policyProblem,
  pointsGiven,
  pulseTrend,
  recognitionProblem,
  rewardsChanges,
  rewardsMembers,
  staffMeals,
  teamWelfare,
  travelHome,
  type PulseResponse,
  type Recognition,
} from './welfare';

const TODAY = '2026-10-22'; // a Thursday
const policy = DEFAULT_WELFARE_POLICY;
const HR = { hr: true };

function person(extra: Partial<Employee> = {}): Employee {
  return { ...newEmployee('mar', 'wdl', 'server', '2025-01-06'), id: 'p1', name: 'Ama Mensah', dateOfBirth: '1996-04-12', hourlyRate: 13, leave: ['2026-09-01'], ...extra };
}

let n = 0;
const shift = (date: string, start: number, end: number, extra: Partial<Shift> = {}): Shift => ({
  id: `s${++n}`, employeeId: 'p1', roleId: 'server', siteId: 'mar', date, startMinute: start, endMinute: end, breakMinutes: 30, ...extra,
});
/** One shift a day on each of the days given, counting back from yesterday. */
const daysBack = (days: number[], start = 10 * 60, end = 18 * 60) => days.map((d) => shift(addDays(TODAY, -d), start, end));
const codes = (shifts: Shift[], e = person(), entries: TimeEntry[] = []) => personWelfare(e, shifts, entries, TODAY, policy, HR).signals.map((s) => s.code);

describe('wellbeing signals', () => {
  it('finds nothing in a steady five day week with holiday booked', () => {
    // Monday to Friday, 10:00 to 17:00, for four weeks.
    const shifts = Array.from({ length: 28 }, (_, i) => addDays(TODAY, -1 - i)).filter((d) => weekday(d) < 5).map((d) => shift(d, 10 * 60, 17 * 60));
    const w = personWelfare(person({ leave: [addDays(TODAY, 10)] }), shifts, [], TODAY, policy, HR);
    expect(w.signals).toEqual([]);
    expect(w.level).toBe('ok');
    expect(w.averageWeeklyHours).toBe(32.5);
  });

  it('counts a run of days across the week boundary, which the weekly rest rule cannot see', () => {
    const run = daysBack([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const w = personWelfare(person(), run, [], TODAY, policy, HR);
    expect(w.signals.find((s) => s.code === 'run-of-days')).toMatchObject({ level: 'act', detail: expect.stringContaining('9 days in a row') });
    expect(w.level).toBe('act');
  });

  it('flags long weeks, close then open, and late finishes', () => {
    // Closes to 00:30, then opens at 10:00 the next day: 9.5 hours of rest, three times a week.
    const shifts = [2, 4, 6, 9, 11, 13, 16, 18, 20, 23, 25, 27].flatMap((d) => [shift(addDays(TODAY, -d), 14 * 60, 24 * 60 + 30), shift(addDays(TODAY, -d + 1), 10 * 60, 16 * 60)]);
    expect(codes(shifts)).toEqual(expect.arrayContaining(['late-finishes', 'tight-turnarounds']));
    const long = [5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17].map((d) => shift(addDays(TODAY, -d), 9 * 60, 18 * 60 + 30));
    expect(personWelfare(person(), long, [], TODAY, policy, HR).signals.find((s) => s.code === 'long-weeks')?.level).toBe('act');
  });

  it('flags a month without a weekend off, and both days every weekend as act', () => {
    // The last four weekends: 17 and 18 October back to 26 and 27 September.
    const sats = ['2026-10-17', '2026-10-18', '2026-10-10', '2026-10-11', '2026-10-03', '2026-10-04', '2026-09-26', '2026-09-27'];
    const both = sats.map((d) => shift(d, 10 * 60, 16 * 60));
    expect(personWelfare(person(), both, [], TODAY, policy, HR).signals.find((s) => s.code === 'no-weekend-off')?.level).toBe('act');
    const one = sats.filter((_, i) => i % 2 === 0).map((d) => shift(d, 10 * 60, 16 * 60));
    expect(personWelfare(person(), one, [], TODAY, policy, HR).signals.find((s) => s.code === 'no-weekend-off')?.level).toBe('watch');
  });

  it('nudges holiday after three months without any', () => {
    expect(codes(daysBack([1, 2]), person({ leave: [] }))).toContain('no-holiday');
    // Booked ahead, or too new to have had any.
    expect(codes(daysBack([1, 2]), person({ leave: [addDays(TODAY, 20)] }))).not.toContain('no-holiday');
    expect(codes(daysBack([1, 2]), person({ leave: [], startDate: addDays(TODAY, -40) }))).not.toContain('no-holiday');
  });

  it('warns when an hourly person’s hours are cut, but only against a week already built', () => {
    const past = [1, 2, 3, 4, 8, 9, 10, 11, 15, 16, 17, 18, 22, 23, 24, 25].map((d) => shift(addDays(TODAY, -d), 10 * 60, 18 * 60));
    const someoneElse = shift(addDays(TODAY, 5), 10 * 60, 18 * 60, { employeeId: 'p2' });
    expect(codes([...past, someoneElse])).toContain('hours-drop');
    // No rota built ahead at the site: nothing to compare.
    expect(codes(past)).not.toContain('hours-drop');
    // Salaried: the pay does not move with the rota.
    expect(codes([...past, someoneElse], person({ payBasis: 'salaried', annualSalary: 32000 }))).not.toContain('hours-drop');
  });

  it('reads short sickness spells only for those who see the personnel file, and leaves out protected absence', () => {
    const spell = (from: string, extra = {}) => ({ id: from, type: 'sickness' as const, from, to: from, ...extra });
    const e = person({ absences: [spell('2026-06-01'), spell('2026-08-03'), spell('2026-10-05')] });
    expect(personWelfare(e, [], [], TODAY, policy, HR).signals.map((s) => s.code)).toContain('short-sickness');
    expect(personWelfare(e, [], [], TODAY, policy, { hr: false }).signals.map((s) => s.code)).not.toContain('short-sickness');
    const protectedSpell = person({ absences: [spell('2026-06-01'), spell('2026-08-03'), spell('2026-10-05', { excludeFromTriggers: true })] });
    expect(personWelfare(protectedSpell, [], [], TODAY, policy, HR).signals.map((s) => s.code)).not.toContain('short-sickness');
  });

  it('counts clocked shifts without the full rest break', () => {
    const entry = (d: number, breakMinutes: number): TimeEntry => ({
      id: `t${d}`, employeeId: 'p1', siteId: 'mar', roleId: 'server', date: addDays(TODAY, -d), clockIn: 9 * 60, clockOut: 17 * 60, breakMinutes, status: 'approved', source: 'clock',
    });
    expect(codes([], person(), [entry(1, 0), entry(2, 5), entry(3, 30)])).toContain('missed-breaks');
  });

  it('puts someone who asked for a chat at the top, then the rest by how much is going on', () => {
    const quiet = person({ id: 'p2', name: 'Quiet', leave: [addDays(TODAY, 5)] });
    const list = teamWelfare([quiet, person()], [], [], TODAY, policy, () => HR, (e) => (e.id === 'p1' ? { chatRequestedAt: `${TODAY}T08:00:00Z` } : {}));
    expect(list[0]).toMatchObject({ employeeId: 'p1', level: 'act' });
    expect(list[0].signals.map((s) => s.code)).toContain('asked-for-chat');
    expect(list.map((w) => w.employeeId)).toEqual(['p1', 'p2']);
  });

  it('leaves out leavers and people not started yet', () => {
    const list = teamWelfare([person({ id: 'a', leaveDate: '2026-10-01' }), person({ id: 'b', startDate: '2026-11-01' }), person({ id: 'c', status: 'leaver' })], [], [], TODAY, policy, () => HR);
    expect(list).toEqual([]);
  });
});

describe('a safe way home and staff meals', () => {
  it('lists late finishes ahead, and an under 18 after 22:00 whatever the policy says is late', () => {
    const young = person({ id: 'y', dateOfBirth: '2009-06-01' });
    const shifts = [
      shift(addDays(TODAY, 1), 17 * 60, 24 * 60 + 15),
      shift(addDays(TODAY, 2), 16 * 60, 22 * 60 + 30, { employeeId: 'y' }),
      shift(addDays(TODAY, 2), 16 * 60, 22 * 60 + 30),
      shift(addDays(TODAY, -1), 17 * 60, 24 * 60 + 15),
    ];
    const list = travelHome([person(), young], shifts, TODAY, { ...policy, travelHomeAllowance: 15 });
    expect(list.map((t) => [t.employeeId, t.under18, t.allowance])).toEqual([['p1', false, 15], ['y', true, 15]]);
  });

  it('counts a meal for each shift of the policy length, with the cost', () => {
    const week = '2026-10-19';
    const meals = staffMeals([shift(week, 10 * 60, 16 * 60 + 30), shift(week, 10 * 60, 14 * 60), shift(week, 17 * 60, 24 * 60, { siteId: 'fitz' })], week, ['mar', 'fitz'], policy);
    expect(meals).toEqual([{ siteId: 'mar', meals: 1, cost: 3.5 }, { siteId: 'fitz', meals: 1, cost: 3.5 }]);
  });
});

describe('milestones and recognition', () => {
  it('marks work anniversaries in the month ahead, birthdays only when the date of birth is visible, and probation passed', () => {
    const list = milestones([
      person({ id: 'a', startDate: '2023-11-05', dateOfBirth: '1990-10-30' }),
      person({ id: 'b', startDate: '2026-02-01', dateOfBirth: '1990-10-30', personalHidden: true }),
      person({ id: 'c', startDate: '2026-07-01', hr: { probationPassedOn: '2026-10-15' } }),
    ], TODAY);
    expect(list.map((m) => [m.employeeId, m.kind, m.date, m.points])).toEqual([
      ['c', 'probation', '2026-10-15', 50],
      ['a', 'birthday', '2026-10-30', 25],
      ['a', 'anniversary', '2026-11-05', 150],
    ]);
  });

  it('refuses awarding yourself, a thin message and going over the site budget', () => {
    const award = { employeeId: 'p1', category: 'guest', message: 'Turned a complaint into a booking for twelve.', points: 100 };
    expect(recognitionProblem(award, undefined, 0, policy)).toBeNull();
    expect(recognitionProblem(award, 'p1', 0, policy)).toMatch(/themselves/);
    expect(recognitionProblem({ ...award, message: 'Thanks' }, undefined, 0, policy)).toMatch(/what they did/);
    expect(recognitionProblem(award, undefined, 450, policy)).toMatch(/past its 500 points/);
    expect(recognitionProblem({ ...award, points: 400 }, undefined, 0, policy)).toMatch(/at most 250/);
    expect(recognitionProblem({ ...award, category: 'bribe' }, undefined, 0, policy)).toMatch(/Choose/);
  });

  it('counts the points a site gave in the calendar month', () => {
    const r = (siteId: string, at: string, points: number) => ({ siteId, at, points }) as Recognition;
    expect(pointsGiven([r('mar', '2026-10-01T10:00:00Z', 100), r('mar', '2026-09-30T10:00:00Z', 100), r('fitz', '2026-10-02T10:00:00Z', 50)], 'mar', TODAY)).toBe(100);
  });
});

describe('the team pulse', () => {
  it('shows a week only once five people have answered', () => {
    const week = '2026-10-19';
    const answers = (count: number, score: PulseResponse['score'], w = week): PulseResponse[] => Array.from({ length: count }, () => ({ siteId: 'mar', week: w, score }));
    const trend = pulseTrend([...answers(4, 2, '2026-10-12'), ...answers(3, 4), ...answers(2, 5)], ['mar'], week, 2);
    expect(trend).toEqual([
      { week: '2026-10-12', responses: 4, average: null },
      { week, responses: 5, average: 4.4 },
    ]);
  });
});

describe('Hospitality Rewards membership', () => {
  const sites = [{ id: 'mar', name: 'Marylebone' }];
  const entities = [{ id: 'wdl', name: 'West End Dining Ltd' }];

  it('enrols people who have started and not opted out, and drops leavers after their last day', () => {
    const list = rewardsMembers([
      person({ email: 'ama@example.com' }),
      person({ id: 'p2', name: 'Not Yet', startDate: '2026-11-02' }),
      person({ id: 'p3', name: 'Opted Out' }),
      person({ id: 'p4', name: 'Last Day', leaveDate: TODAY }),
      person({ id: 'p5', name: 'Gone', leaveDate: '2026-10-21' }),
    ], sites, entities, TODAY, ['p3']);
    expect(list.map((m) => m.ref)).toEqual(['p1', 'p4']);
    expect(list[0]).toEqual({ ref: 'p1', firstName: 'Ama', lastName: 'Mensah', email: 'ama@example.com', site: 'Marylebone', company: 'West End Dining Ltd', startDate: '2025-01-06' });
    // Nothing about pay, age or health goes across.
    expect(Object.keys(list[0])).not.toEqual(expect.arrayContaining(['hourlyRate', 'dateOfBirth']));
  });

  it('removes whoever was enrolled and is no longer eligible', () => {
    const eligible = rewardsMembers([person()], sites, entities, TODAY, []);
    expect(rewardsChanges(eligible, ['p1', 'p9']).remove).toEqual(['p9']);
  });

  it('writes the eligibility file with quoting', () => {
    const csv = eligibilityCsv([{ ref: 'p1', firstName: 'Ama', lastName: 'Mensah', site: 'Marylebone, W1', company: 'WED "Ltd"' }]);
    expect(csv.split('\n')[1]).toBe('p1,Ama,Mensah,,"Marylebone, W1","WED ""Ltd""",');
  });
});

describe('the welfare policy', () => {
  it('checks each figure before it is saved', () => {
    expect(policyProblem({ lateFinishMinute: 23 * 60 })).toBeNull();
    expect(policyProblem({ lateFinishMinute: 15 * 60 })).toMatch(/20:00/);
    expect(policyProblem({ travelHomeAllowance: -1 })).toMatch(/allowance/);
    expect(policyProblem({ supportLine: { name: 'EAP', url: 'http://x' } })).toMatch(/https/);
  });
});
