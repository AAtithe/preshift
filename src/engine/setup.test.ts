import { autoSchedule } from './autoschedule';
import { seedState } from './seed';
import {
  applySetup,
  draftFromState,
  droppedShifts,
  emptyDraft,
  forecastForWeek,
  missingForecast,
  newEmployee,
  parseTeamPaste,
  validateSetup,
  type SetupDraft,
} from './setup';
import { addDays, weekDates } from './time';

const TODAY = '2026-10-21'; // a Wednesday
const WEEK = '2026-10-19';

function readyDraft(): SetupDraft {
  const d = emptyDraft();
  d.sites[0].name = 'Clerkenwell';
  d.sites[0].salesProfile = { dailySales: [3000, 3000, 3500, 4000, 6000, 7000, 4500], averageSpend: 40 };
  const site = d.sites[0].id;
  d.employees = [
    { ...newEmployee(site, 'server'), name: 'Alex', dateOfBirth: '1998-01-01', hourlyRate: 13 },
    { ...newEmployee(site, 'chef'), name: 'Sam', dateOfBirth: '1990-01-01', hourlyRate: 16, contractedHours: 40 },
    { ...newEmployee(site, 'kp'), name: 'Jo', dateOfBirth: '2000-01-01', hourlyRate: 12.71 },
    { ...newEmployee(site, 'bar'), name: 'Kim', dateOfBirth: '1995-01-01', hourlyRate: 13.5 },
  ];
  return d;
}

describe('forecast from a sales profile', () => {
  it('ties each day back to the profile to the pound and only uses open hours', () => {
    const site = readyDraft().sites[0];
    const rows = forecastForWeek(site, WEEK);
    weekDates(WEEK).forEach((date, day) => {
      const dayRows = rows.filter((r) => r.date === date);
      expect(dayRows.reduce((s, r) => s + r.sales, 0)).toBe(site.salesProfile!.dailySales[day]);
      expect(dayRows.every((r) => r.hour >= 12 && r.hour < 23)).toBe(true);
    });
  });

  it('fills a week that has no forecast, and leaves one that does alone', () => {
    const state = applySetup(null, readyDraft(), TODAY);
    expect(missingForecast(state, WEEK)).toHaveLength(0);
    expect(missingForecast(state, addDays(WEEK, 7 * 10)).length).toBeGreaterThan(0);
  });
});

describe('validation', () => {
  it('passes a complete set-up', () => {
    expect(validateSetup(readyDraft(), TODAY).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('flags a missing date of birth and pay below the minimum wage', () => {
    const d = readyDraft();
    d.employees[0].dateOfBirth = '';
    d.employees[1].hourlyRate = 11;
    const issues = validateSetup(d, TODAY);
    expect(issues.some((i) => i.severity === 'error' && i.message.startsWith('Alex: date of birth'))).toBe(true);
    expect(issues.some((i) => i.severity === 'warning' && i.message.startsWith('Sam: £11.00 is below'))).toBe(true);
  });

  it('will not finish on a blank trading week', () => {
    const issues = validateSetup(emptyDraft(), TODAY).map((i) => i.message);
    expect(issues.some((m) => m.includes('typical net sales'))).toBe(true);
    expect(issues.some((m) => m.includes('average spend'))).toBe(true);
  });

  it('rejects a closing time before opening', () => {
    const d = readyDraft();
    d.sites[0].closeMinute = 600;
    expect(validateSetup(d, TODAY).some((i) => i.message.includes('closing time'))).toBe(true);
  });
});

describe('applying set-up', () => {
  it('produces a state the auto-build can roster', () => {
    const state = applySetup(null, readyDraft(), TODAY);
    expect(autoSchedule(state, state.sites[0].id, WEEK).shifts.length).toBeGreaterThan(0);
  });

  it('round-trips an existing account and drops only shifts that no longer fit', () => {
    const seeded = seedState(TODAY);
    const built = { ...seeded, shifts: autoSchedule(seeded, 'mar', WEEK).shifts };
    const draft = draftFromState(built);
    expect(droppedShifts(built, draft)).toBe(0);
    const leaving = built.shifts[0].employeeId;
    draft.employees = draft.employees.filter((e) => e.id !== leaving);
    const lost = built.shifts.filter((s) => s.employeeId === leaving).length;
    expect(droppedShifts(built, draft)).toBe(lost);
    expect(applySetup(built, draft, TODAY).shifts).toHaveLength(built.shifts.length - lost);
  });

  it('keeps past forecast and regenerates from this week on', () => {
    const seeded = seedState(TODAY);
    const past = seeded.forecast.filter((f) => f.date < WEEK);
    const next = applySetup(seeded, draftFromState(seeded), TODAY);
    expect(next.forecast.filter((f) => f.date < WEEK)).toEqual(past);
    expect(next.forecast.some((f) => f.date >= addDays(WEEK, 21))).toBe(true);
  });
});

describe('team paste', () => {
  const roles = emptyDraft().roles;

  it('reads tab or comma separated rows, salaries and UK dates', () => {
    const text = 'Name,Roles,Pay,DOB,Hours\nAlex Doe,Server/Host,13.25,01/02/1999,32\nPat Lee\tGeneral Manager\t£48,000\t1985-06-30\t45';
    const { employees, errors } = parseTeamPaste(text, 's1', roles);
    expect(errors).toEqual([]);
    expect(employees[0]).toMatchObject({ name: 'Alex Doe', roleIds: ['server', 'host'], hourlyRate: 13.25, dateOfBirth: '1999-02-01', contractedHours: 32 });
    expect(employees[1]).toMatchObject({ payBasis: 'salaried', annualSalary: 48000, roleIds: ['gm'] });
  });

  it('reports unknown roles and impossible dates', () => {
    const { errors } = parseTeamPaste('Alex,Sommelier,13,31/02/1999,0', 's1', roles);
    expect(errors).toHaveLength(2);
  });
});
