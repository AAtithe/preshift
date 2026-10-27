import { describe, expect, it } from 'vitest';
import { rotaHints } from './rotaHints';
import { addDays } from './time';
import type { DaySales, Employee, HourForecast, RotaState, Shift } from './types';

const WEEK = '2026-11-02';
const TODAY = '2026-10-31';
const TUE = addDays(WEEK, 1);
/** The four Tuesdays before the draft week, newest first. */
const PAST_TUES = [1, 2, 3, 4].map((k) => addDays(TUE, -7 * k));

const person = (id: string, roleIds = ['chef']): Employee => ({
  id,
  name: `${id[0].toUpperCase()}${id.slice(1)} Test`,
  siteId: 'mar',
  entityId: 'wdl',
  coverSiteIds: [],
  roleIds,
  payBasis: 'hourly',
  hourlyRate: 13,
  annualSalary: 0,
  dateOfBirth: '1995-01-01',
  contractedHours: 0,
  maxWeeklyHours: 48,
  optedOutOf48: false,
  irregularHours: true,
  pensionEnrolled: true,
  availability: [],
  leave: [],
});

let n = 0;
const shift = (employeeId: string, date: string, start: number, end: number, roleId = 'chef'): Shift => ({
  id: `s${n++}`,
  employeeId,
  roleId,
  siteId: 'mar',
  date,
  startMinute: start * 60,
  endMinute: end * 60,
  breakMinutes: end - start > 6 ? 20 : 0,
});

/** £100 of sales an hour from 11:00 to 23:00, one chef needed throughout. */
const dayForecast = (date: string, perHour = 100): HourForecast[] =>
  Array.from({ length: 12 }, (_, i) => ({ siteId: 'mar', date, hour: 11 + i, sales: perHour, covers: 3 }));

function state(shifts: Shift[], forecast: HourForecast[], sales: DaySales[] = [], employees = ['ann', 'ben', 'cal', 'dee'].map((id) => person(id))): RotaState {
  return {
    entities: [{ id: 'wdl', name: 'West End Dining Ltd', companyNumber: '1', payeReference: '1', intercompanyCode: '1351' }],
    sites: [{ id: 'mar', name: 'Marylebone', entityId: 'wdl', labourTargetPct: 0.28, trackingCode: 'Marylebone', openMinute: 11 * 60, closeMinute: 23 * 60 }],
    roles: [{ id: 'chef', name: 'Chef', department: 'BOH', nominalCode: '7000' }],
    employees,
    shifts,
    forecast,
    demandRules: [{ siteId: 'mar', roleId: 'chef', salesPerLabourHour: 200, minimumWhileOpen: 1, maximum: 4 }],
    sales,
  };
}

describe('rota hints', () => {
  it('asks whether three chefs need to be on at the same time, and says when it has happened before', () => {
    const stack = (date: string) => [shift('ann', date, 11, 23), shift('ben', date, 14, 18), shift('cal', date, 14, 18)];
    const s = state([...stack(TUE), ...PAST_TUES.flatMap(stack)], [TUE, ...PAST_TUES].flatMap((d) => dayForecast(d)));
    const hints = rotaHints({ state: s, siteId: 'mar', week: WEEK, today: TODAY, showCost: false });
    const stacked = hints.find((h) => h.kind === 'stacked');
    expect(stacked?.title).toBe('Did you know you have 3 chefs on at the same time on Tuesday?');
    expect(stacked?.detail).toMatch(/^14:00 to 18:00, when the forecast needs 1\./);
    expect(stacked?.detail).toMatch(/all of the last 4 Tuesdays/);
    expect(stacked?.tone).toBe('repeat');
    expect(stacked?.action).toEqual({ kind: 'day', date: TUE });
    // One hint per problem: the shared start is not said twice.
    expect(hints.filter((h) => h.dates[0] === TUE && h.kind === 'same-start')).toEqual([]);
  });

  it('flags a role all starting at once even where the forecast needs them', () => {
    const s = state([shift('ann', TUE, 11, 23), shift('ben', TUE, 11, 20), shift('cal', TUE, 11, 20)], dayForecast(TUE, 600));
    const hints = rotaHints({ state: s, siteId: 'mar', week: WEEK, today: TODAY, showCost: false });
    expect(hints.map((h) => h.title)).toContain('3 chefs all start at 11:00 on Tuesday');
  });

  it('says a day is over target again when it has been before, and praises it when the draft holds it', () => {
    const heavy = (date: string) => [shift('ann', date, 11, 23), shift('ben', date, 11, 23)];
    const past = PAST_TUES.flatMap(heavy);
    const forecast = [TUE, ...PAST_TUES].flatMap((d) => dayForecast(d));
    const again = rotaHints({ state: state([...heavy(TUE), ...past], forecast), siteId: 'mar', week: WEEK, today: TODAY, showCost: true });
    const repeat = again.find((h) => h.kind === 'over-target-again');
    expect(repeat?.title).toMatch(/^Tuesday is over target again, at \d+\.\d%$/);
    expect(repeat?.detail).toMatch(/on all of the last 4 Tuesdays/);
    expect(again[0].tone).toBe('repeat');

    const held = rotaHints({ state: state([shift('ann', TUE, 11, 17), ...past], forecast), siteId: 'mar', week: WEEK, today: TODAY, showCost: true });
    expect(held.find((h) => h.kind === 'over-target-held')?.tone).toBe('keep');
    expect(held.some((h) => h.kind === 'over-target-again')).toBe(false);

    // Those who do not see cost are not told labour percentages.
    const hidden = rotaHints({ state: state([...heavy(TUE), ...past], forecast), siteId: 'mar', week: WEEK, today: TODAY, showCost: false });
    expect(hidden.some((h) => h.kind.startsWith('over-target'))).toBe(false);
  });

  it('says when a weekday keeps taking more than its sales forecast', () => {
    const past = PAST_TUES.map((date) => shift('ann', date, 11, 23));
    const sales: DaySales[] = PAST_TUES.map((date) => ({ siteId: 'mar', date, netSales: 1440, source: 'till' }));
    const s = state([shift('ann', TUE, 11, 23), ...past], [TUE, ...PAST_TUES].flatMap((d) => dayForecast(d)), sales);
    const hint = rotaHints({ state: s, siteId: 'mar', week: WEEK, today: TODAY, showCost: false }).find((h) => h.kind === 'forecast-low');
    expect(hint?.detail).toMatch(/^The last 4 Tuesdays took 20% more than the sales forecast\./);
  });

  it('counts the hours a day carries over the pace it usually runs at', () => {
    const past = PAST_TUES.map((date) => shift('ann', date, 11, 23));
    const s = state([shift('ann', TUE, 11, 23), shift('ben', TUE, 11, 23), shift('cal', TUE, 11, 23), ...past], [TUE, ...PAST_TUES].flatMap((d) => dayForecast(d)));
    const hint = rotaHints({ state: s, siteId: 'mar', week: WEEK, today: TODAY, showCost: false, maxHints: 10 }).find((h) => h.kind === 'heavy');
    expect(hint?.title).toMatch(/^Tuesday has about \d+ more hours than usual$/);
  });

  it('says nothing about days already gone, and nothing from days not yet traded', () => {
    const s = state([shift('ann', TUE, 11, 23), shift('ben', TUE, 14, 18), shift('cal', TUE, 14, 18)], dayForecast(TUE));
    expect(rotaHints({ state: s, siteId: 'mar', week: WEEK, today: addDays(TUE, 1), showCost: true })).toEqual([]);
  });
});
