import { describe, expect, it } from 'vitest';
import { breakOf, HOLIDAY_COLUMNS, importHoliday, importPeople, importShifts, matchColumns, PEOPLE_COLUMNS, SHIFT_COLUMNS } from './externalImport';
import { ABSENCE_COLUMNS, DOCUMENT_COLUMNS, RTW_COLUMNS, TOIL_COLUMNS, TRAINING_COLUMNS } from './hrImport';
import { onboardingTemplate, TEMPLATE_SHEETS } from './importTemplate';
import type { Employee, RotaState } from './types';

// Moving from another system: a team and a rota exported as CSV, columns found by name.

const roles = [
  { id: 'server', name: 'Server', department: 'FOH', nominalCode: '7001' },
  { id: 'chef', name: 'Chef', department: 'BOH', nominalCode: '7002' },
  { id: 'bar', name: 'Bartender', department: 'FOH', nominalCode: '7003' },
] as RotaState['roles'];
const sites = [{ id: 'ck', name: 'Clerkenwell' }, { id: 'sh', name: 'Shoreditch' }] as RotaState['sites'];
const person = (id: string, name: string, roleIds: string[], email?: string) => ({ id, name, roleIds, siteId: 'ck', ...(email ? { email } : {}) }) as unknown as Employee;
const employees = [person('e1', 'Alex Doe', ['server', 'bar'], 'alex@ck.example'), person('e2', 'Sam Cook', ['chef'])];
const state = { roles, sites, employees, shifts: [] } as Pick<RotaState, 'roles' | 'sites' | 'employees' | 'shifts'>;

describe('importing people', () => {
  it('reads a team export by its column names, whatever their order', () => {
    const csv = [
      'Employee ID,First Name,Last Name,Position,Location,Hourly Rate,Date of Birth,Hire Date,Contracted Hours,Email',
      '101,Pat,Lee,Server / Bartender,Shoreditch,£12.71,30/06/1990,02/09/2021,32,pat@x.example',
      '102,Jo,Ray,Chef,Clerkenwell,"38,000",12/04/1985,,45,',
    ].join('\n');
    const r = importPeople(csv, state);
    expect(r.errors).toEqual([]);
    expect(r.people).toHaveLength(2);
    expect(r.people[0]).toMatchObject({ siteId: 'sh', email: 'pat@x.example', person: { name: 'Pat Lee', roleIds: ['server', 'bar'], payBasis: 'hourly', hourlyRate: 12.71, dateOfBirth: '1990-06-30', startDate: '2021-09-02', contractedHours: 32, rightToWork: { checked: false } } });
    expect(r.people[1].person).toMatchObject({ payBasis: 'salaried', annualSalary: 38000, irregularHours: false });
    expect(r.unused).toEqual(['Employee ID']);
  });

  it('holds back rows it cannot complete honestly, and counts roles not set up here', () => {
    const csv = ['Name,Role,Rate,DOB', 'A One,Host,12.71,01/01/1990', 'B Two,Server,,01/01/1990', 'C Three,Server,12.71,', 'Alex Doe,Server,13,01/01/1990'].join('\n');
    const r = importPeople(csv, state);
    expect(r.people).toEqual([]);
    expect(r.unknownRoles).toEqual([{ name: 'Host', rows: 1 }]);
    expect(r.existing).toEqual(['Alex Doe']);
    expect(r.errors.join(' ')).toMatch(/Row 3 \(B Two\): Pay "" is not a number/);
    expect(r.errors.join(' ')).toMatch(/Row 4 \(C Three\): No date of birth/);
  });

  it('takes a hand-picked column over its guess', () => {
    const csv = ['Who,Job,Rate,DOB', 'Pat Lee,Chef,13,01/01/1990'].join('\n');
    expect(importPeople(csv, state).errors[0]).toMatch(/No name column/);
    expect(importPeople(csv, state, { columns: { name: 'Who', roles: 'Job' } }).people[0].person.name).toBe('Pat Lee');
  });
});

describe('importing a rota', () => {
  it('reads shifts by name or email, past midnight included, as an unpublished draft', () => {
    const csv = [
      'Team Member,Email,Date,Start Time,End Time,Unpaid Break (mins),Area,Location',
      'Alex Doe,,09/11/2026,17:00,01:00,30,Bartender,Clerkenwell',
      'someone,alex@ck.example,10/11/2026,9am,5:30pm,0:45,,Clerkenwell',
      '"Cook, Sam",,11/11/2026,08:00,16:00,1,Kitchen Porter,Clerkenwell',
    ].join('\n');
    const r = importShifts(csv, state);
    expect(r.errors).toEqual([]);
    expect(r.shifts).toEqual([
      { employeeId: 'e1', roleId: 'bar', siteId: 'ck', date: '2026-11-09', startMinute: 1020, endMinute: 1500, breakMinutes: 30, published: false },
      { employeeId: 'e1', roleId: 'server', siteId: 'ck', date: '2026-11-10', startMinute: 540, endMinute: 1050, breakMinutes: 45, published: false },
      { employeeId: 'e2', roleId: 'chef', siteId: 'ck', date: '2026-11-11', startMinute: 480, endMinute: 960, breakMinutes: 60, published: false },
    ]);
    expect(r.roleFromPerson).toBe(2);
    expect(r.unknownRoles).toEqual([{ name: 'Kitchen Porter', rows: 1 }]);
    expect(r.weeks).toEqual(['2026-11-09']);
  });

  it('reads a start that carries its own date, and uses the chosen site when the file has none', () => {
    const r = importShifts(['Employee,Shift Start,Shift End', 'Sam Cook,2026-11-12 07:00,2026-11-12 15:00'].join('\n'), state, { siteId: 'sh' });
    expect(r.shifts).toEqual([{ employeeId: 'e2', roleId: 'chef', siteId: 'sh', date: '2026-11-12', startMinute: 420, endMinute: 900, breakMinutes: 0, published: false }]);
  });

  it('counts people not on Preshift, skips shifts already on the rota, and leaves open shifts to the rota', () => {
    const onRota = { ...state, shifts: [{ id: 's1', employeeId: 'e2', roleId: 'chef', siteId: 'ck', date: '2026-11-12', startMinute: 420, endMinute: 900, breakMinutes: 0 }] };
    const csv = ['Name,Date,Start,End', 'Sam Cook,12/11/2026,07:00,15:00', 'Nobody Here,12/11/2026,07:00,15:00', 'Nobody Here,13/11/2026,07:00,15:00', ',13/11/2026,07:00,15:00'].join('\n');
    const r = importShifts(csv, onRota, { siteId: 'ck' });
    expect(r.shifts).toEqual([]);
    expect(r.duplicates).toBe(1);
    expect(r.unknownPeople).toEqual([{ name: 'Nobody Here', rows: 2 }]);
    expect(r.errors[0]).toMatch(/open shift/);
  });

  it('reads US dates when told to', () => {
    const r = importShifts(['Name,Date,Start,End', 'Sam Cook,11/12/2026,07:00,15:00'].join('\n'), state, { siteId: 'ck', usDates: true });
    expect(r.shifts[0].date).toBe('2026-11-12');
  });

  it('needs a person, a start and an end, and says which column is missing', () => {
    expect(importShifts('Name,Date,Start\nSam Cook,12/11/2026,07:00', state, { siteId: 'ck' }).errors).toEqual(['No end column found. Choose which column holds the shift end.']);
  });
});

describe('columns and breaks', () => {
  it('uses each column for one field only', () => {
    const m = matchColumns(['Start Date', 'Start', 'End'], SHIFT_COLUMNS);
    expect(m.columns).toMatchObject({ date: 0, start: 1, end: 2 });
  });

  it('reads breaks as minutes, hours and minutes, or hours', () => {
    expect([breakOf('30'), breakOf('0:30'), breakOf('0.5'), breakOf('1'), breakOf('45 mins'), breakOf('1h'), breakOf(''), breakOf('x')]).toEqual([30, 30, 30, 60, 45, 60, 0, null]);
    expect(breakOf('2', true)).toBe(120);
  });
});

describe('importing holiday balances', () => {
  const entities = [{ id: 'co', name: 'CK Ltd', leaveYearStart: '04-01' }] as RotaState['entities'];
  const fixed = { id: 'f1', name: 'Pat Lee', entityId: 'co', siteId: 'ck', roleIds: ['chef'], payBasis: 'hourly', hourlyRate: 13, annualSalary: 0, contractedHours: 40, maxWeeklyHours: 48, irregularHours: false, leave: [], coverSiteIds: [] } as unknown as Employee;
  const casual = { ...fixed, id: 'c1', name: 'Jo Ray', contractedHours: 0, irregularHours: true, holiday: { dayHours: { '2026-05-01': 4 } } } as Employee;
  const s = { employees: [fixed, casual], entities };
  // The leave year began 1 April 2026: 40h a week at 5.6 weeks is 224h for the year.

  it('keeps accrued and taken for irregular hours staff, and the record they already have', () => {
    const r = importHoliday(['Employee,Accrued hours,Taken hours,Carried over', 'Jo Ray,41.5,16,0'].join('\n'), s, '2026-11-04');
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({ employeeId: 'c1', holiday: { openingAccruedHours: 41.5, openingTakenHours: 16, carriedOverHours: 0, dayHours: { '2026-05-01': 4 } }, remainingHours: 25.5 });
  });

  it('turns a fixed hours balance into the taken figure that leaves exactly that balance', () => {
    const r = importHoliday(['Name,Remaining hours', 'Pat Lee,100'].join('\n'), s, '2026-11-04');
    expect(r.rows[0].holiday.openingTakenHours).toBe(124);
    expect(r.rows[0].remainingHours).toBe(100);
  });

  it('reads days on the contracted day, and says when a day cannot be turned into hours', () => {
    const r = importHoliday(['Name,Taken (days),Remaining (days)', 'Pat Lee,10,18', 'Jo Ray,2,3'].join('\n'), s, '2026-11-04');
    expect(r.inDays).toBe(true);
    expect(r.rows[0].holiday.openingTakenHours).toBe(80);
    expect(r.errors[0]).toMatch(/Row 3 \(Jo Ray\): figures are in days/);
  });

  it('counts people not on Preshift and refuses figures that are not balances', () => {
    const r = importHoliday(['Name,Taken,Entitlement weeks', 'Nobody,1,', 'Pat Lee,-3,', 'Pat Lee,3,5'].join('\n'), s, '2026-11-04');
    expect(r.unknownPeople).toEqual([{ name: 'Nobody', rows: 1 }]);
    expect(r.errors.join(' ')).toMatch(/negative taken/);
    expect(r.errors.join(' ')).toMatch(/below the statutory 5.6/);
  });
});

describe('reading a table', () => {
  it('finds the header row under a title', () => {
    const r = importShifts([['Rota for week of 9 Nov', '', ''], ['Name', 'Date', 'Start', 'End'], ['Sam Cook', '12/11/2026', '07:00', '15:00']], state, { siteId: 'ck' });
    expect(r.shifts).toHaveLength(1);
  });
});

describe('the onboarding template', () => {
  it('maps every column of its own sheets without help', () => {
    const sheets = onboardingTemplate(state);
    for (const [kind, aliases] of [['team', PEOPLE_COLUMNS], ['rota', SHIFT_COLUMNS], ['holiday', HOLIDAY_COLUMNS], ['rtw', RTW_COLUMNS], ['documents', DOCUMENT_COLUMNS], ['training', TRAINING_COLUMNS], ['toil', TOIL_COLUMNS], ['absences', ABSENCE_COLUMNS]] as const) {
      const sheet = sheets.find((s) => s.name === TEMPLATE_SHEETS[kind])!;
      expect(matchColumns(sheet.rows[0] as string[], aliases as Record<string, string[]>).unused, kind).toEqual([]);
    }
    expect(sheets.find((s) => s.name === 'Lists')!.rows).toEqual([['Roles', 'Sites'], ['Server', 'Clerkenwell'], ['Chef', 'Shoreditch'], ['Bartender', '']]);
  });
});
