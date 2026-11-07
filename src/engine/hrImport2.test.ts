import { describe, expect, it } from 'vitest';
import { availabilityOf, importPeople } from './externalImport';
import { importHours, importManagers, importReviews, importTakings, managerRoleOf, reviewTypeOf } from './hrImport';
import type { Employee, RotaState } from './types';

// Past hours, takings history, managers, reviews, and the working time and pension fields on the team.

const TODAY = '2026-11-06';
const pat = { id: 'e1', name: 'Pat Lee', siteId: 'ck', roleIds: ['chef'], leave: [], contractedHours: 40, hr: {} } as unknown as Employee;
const state = {
  employees: [pat],
  sites: [{ id: 'ck', name: 'Clerkenwell' }, { id: 'sh', name: 'Shoreditch' }],
  roles: [{ id: 'chef', name: 'Chef' }, { id: 'server', name: 'Server' }],
  sales: [{ siteId: 'ck', date: '2026-10-01', netSales: 999, source: 'till' }],
} as unknown as RotaState;
const csv = (...rows: string[]) => rows.join('\n');

describe('past hours', () => {
  it('reads clock in and out, past midnight included, hours-only days from 09:00, and leaves today on out', () => {
    const r = importHours(csv('Employee,Date,Clock In,Clock Out,Break (mins),Hours', 'Pat Lee,02/10/2026,18:00,02:00,30,', 'Pat Lee,03/10/2026,,,,7.5', 'Pat Lee,06/11/2026,09:00,17:00,,'), state, TODAY);
    expect(r.errors).toEqual([]);
    expect(r.entries).toEqual([
      { employeeId: 'e1', siteId: 'ck', roleId: 'chef', date: '2026-10-02', clockIn: 1080, clockOut: 1560, breakMinutes: 30 },
      { employeeId: 'e1', siteId: 'ck', roleId: 'chef', date: '2026-10-03', clockIn: 540, clockOut: 990, breakMinutes: 0 },
    ]);
    expect(r).toMatchObject({ withoutTimes: 1, fromToday: 1, hoursTotal: 15 });
  });

  it('spreads a weekly total over Monday to Friday', () => {
    const r = importHours(csv('Name,Week Ending,Hours Worked', 'Pat Lee,11/10/2026,40'), state, TODAY);
    expect(r.entries.map((e) => [e.date, e.clockOut - e.clockIn])).toEqual([['2026-10-05', 480], ['2026-10-06', 480], ['2026-10-07', 480], ['2026-10-08', 480], ['2026-10-09', 480]]);
    expect(r.fromWeeklyTotals).toBe(1);
  });
});

describe('takings', () => {
  it('adds net takings by site and day, sums split rows, keeps days already held, and turns gross into net', () => {
    const r = importTakings(csv('Site,Trading Date,Net Sales,Gross Sales,Covers', 'Clerkenwell,01/10/2026,1000,,40', 'Clerkenwell,02/10/2026,"1,200.50",,50', 'Clerkenwell,02/10/2026,300,,10', 'Shoreditch,02/10/2026,,1200,', 'Nowhere,02/10/2026,10,,'), state, TODAY);
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { siteId: 'ck', date: '2026-10-02', netSales: 1500.5, covers: 60 },
      { siteId: 'sh', date: '2026-10-02', netSales: 1000 },
    ]);
    expect(r).toMatchObject({ kept: 1, fromGross: 1, unknownSites: [{ name: 'Nowhere', rows: 1 }] });
  });
});

describe('managers', () => {
  it('invites by role and sites, never an owner, and not twice', () => {
    const r = importManagers(csv('Name,Email,Job Title,Sites', 'Pat Lee,pat@x.example,Head Chef,Clerkenwell', 'Sam Day,sam@x.example,Restaurant Manager,"Clerkenwell, Shoreditch"', 'Jo Ray,jo@x.example,Owner,', 'Al Bee,al@x.example,Finance Director,', 'Cy Dee,cy@x.example,General Manager,', 'Di Eve,taken@x.example,Supervisor,Clerkenwell'), state, [{ email: 'Taken@x.example' }]);
    expect(r.invites.map((i) => [i.name, i.roleId, i.siteIds, i.employeeId])).toEqual([
      ['Pat Lee', 'head_chef', ['ck'], 'e1'],
      ['Sam Day', 'general_manager', ['ck', 'sh'], undefined],
      ['Al Bee', 'finance_director', null, undefined],
    ]);
    expect(r.errors.join(' ')).toMatch(/owner is never made from a file.*runs named sites/);
    expect(r.existing).toEqual(['Di Eve']);
    expect(['GM', 'Deputy Manager', 'Area Manager', 'Head of HR', 'Kitchen porter'].map((x) => managerRoleOf(x)?.id ?? null)).toEqual(['general_manager', 'assistant_manager', 'area_manager', 'people_manager', null]);
  });
});

describe('reviews', () => {
  it('records reviews, sets probation passed, and refuses cases', () => {
    const r = importReviews(csv('Name,Review Type,Review Date,Outcome,Next Review', 'Pat Lee,Probation,01/09/2026,Passed,', 'Pat Lee,Annual appraisal,01/10/2026,Exceeds,01/04/2027', 'Pat Lee,Disciplinary,02/10/2026,First written warning,'), state, [], TODAY);
    expect(r.records.map((x) => [x.record.reviewType, x.record.date, x.record.nextDue])).toEqual([['probation', '2026-09-01', undefined], ['appraisal', '2026-10-01', '2027-04-01']]);
    expect(r.probationsPassed).toEqual([{ employeeId: 'e1', date: '2026-09-01' }]);
    expect(r.errors[0]).toMatch(/not imported from a file/);
    expect(['1:1', 'Mid-year review', 'Supervision'].map(reviewTypeOf)).toEqual(['one-to-one', 'appraisal', 'one-to-one']);
  });
});

describe('the team, with working time, pension and pattern', () => {
  it('reads the opt-out, hours, pension, pay frequency, availability, cover sites and clock card', () => {
    const r = importPeople(csv(
      'Name,Role,Rate,DOB,48 Hour Opt Out,Max Hours,Pension,Pay Frequency,Availability,Cover Sites,Clock Card',
      'Jo Ray,Server,12.71,01/01/1990,Yes,55,Opted out,Monthly,Mon-Fri 9-5; Sat 10:00-16:00,Shoreditch,04 A1 B2 C3',
      'Kid Lee,Server,10,01/01/2010,Yes,,,,,,',
      'Al Bee,Server,12.71,01/01/1990,maybe,,,Fortnightly,whenever,Nowhere,1',
    ), state, { today: TODAY });
    expect(r.people[0].extra).toEqual({
      optedOutOf48: true, maxWeeklyHours: 55, pensionEnrolled: false, payFrequency: 'monthly', coverSiteIds: ['sh'],
      availability: [0, 1, 2, 3, 4].map((weekday) => ({ weekday, fromMinute: 540, toMinute: 1020 })).concat([{ weekday: 5, fromMinute: 600, toMinute: 960 }]),
    });
    expect(r.people[0].badge).toBe('04A1B2C3');
    expect(r.errors[0]).toMatch(/Kid Lee.*under 18s cannot opt out/i);
    expect(r.people[1].extra).toEqual({});
    expect(r.people[1].notes).toHaveLength(5);
  });

  it('reads availability as people write it', () => {
    expect(availabilityOf('Any')).toEqual([]);
    expect(availabilityOf('Weekends 18:00-23:30')).toEqual([{ weekday: 5, fromMinute: 1080, toMinute: 1410 }, { weekday: 6, fromMinute: 1080, toMinute: 1410 }]);
    expect(availabilityOf('Fri-Mon')).toHaveLength(4);
    expect(availabilityOf('not Sundays')).toBeNull();
  });
});
