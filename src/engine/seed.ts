import type { DemandRule, Employee, Entity, HourForecast, Role, RotaState, Site } from './types';
import { addDays, toISODate, weekDates, weekStart } from './time';

const roles: Role[] = [
  { id: 'server', name: 'Server', department: 'FOH', nominalCode: '7000' },
  { id: 'host', name: 'Host', department: 'FOH', nominalCode: '7000' },
  { id: 'bar', name: 'Bartender', department: 'BAR', nominalCode: '7002' },
  { id: 'chef', name: 'Chef', department: 'BOH', nominalCode: '7001' },
  { id: 'kp', name: 'Kitchen Porter', department: 'BOH', nominalCode: '7001' },
  { id: 'gm', name: 'General Manager', department: 'MGMT', nominalCode: '7003' },
];

// A typical small group: the original company now runs two sites, and the newer
// site sits in its own company (separate lease, separate investors).
const entities: Entity[] = [
  { id: 'wdl', name: 'West End Dining Ltd', companyNumber: '09876543', payeReference: '120/WE12345', intercompanyCode: '1351' },
  { id: 'eck', name: 'East Canteen & Kitchen Ltd', companyNumber: '13579246', payeReference: '120/EC67890', intercompanyCode: '1352', leaveYearStart: '04-01' },
];

const sites: Site[] = [
  { id: 'mar', name: 'Marylebone', entityId: 'wdl', labourTargetPct: 0.28, trackingCode: 'Marylebone', openMinute: 11 * 60, closeMinute: 23 * 60 },
  { id: 'fitz', name: 'Fitzrovia', entityId: 'wdl', labourTargetPct: 0.29, trackingCode: 'Fitzrovia', openMinute: 11 * 60, closeMinute: 22 * 60 },
  { id: 'shd', name: 'Shoreditch', entityId: 'eck', labourTargetPct: 0.27, trackingCode: 'Shoreditch', openMinute: 12 * 60, closeMinute: 24 * 60 },
];

const allWeek = (from: number, to: number) =>
  Array.from({ length: 7 }, (_, weekday) => ({ weekday, fromMinute: from * 60, toMinute: to * 60 }));

type Seed = [name: string, roles: string[], rate: number, dob: string, contracted: number, extra?: Partial<Employee>];

function team(siteId: string, people: Seed[]): Employee[] {
  const entityId = sites.find((s) => s.id === siteId)!.entityId;
  return people.map(([name, roleIds, rate, dob, contracted, extra], i) => ({
    id: `${siteId}-${i + 1}`,
    name,
    siteId,
    entityId,
    coverSiteIds: [],
    roleIds,
    payBasis: 'hourly',
    hourlyRate: rate,
    annualSalary: 0,
    dateOfBirth: dob,
    contractedHours: contracted,
    maxWeeklyHours: 48,
    optedOutOf48: false,
    irregularHours: contracted === 0,
    pensionEnrolled: true,
    availability: [],
    leave: [],
    startDate: '2024-01-08',
    rightToWork: { checked: true, checkedOn: '2024-01-02', evidence: 'British passport' },
    // Opening holiday position from before the rota went live, so balances are realistic on day one.
    holiday: contracted === 0
      ? { openingAccruedHours: 40 + (i % 5) * 12, openingTakenHours: (i % 3) * 8 }
      : { openingTakenHours: 24 + (i % 4) * 8, carriedOverHours: i % 3 === 0 ? 8 : 0 },
    ...extra,
  }));
}

function employees(today: string): Employee[] {
  return [
    ...team('mar', [
      ['Priya Shah', ['gm'], 0, '1986-03-14', 45, { payBasis: 'salaried', annualSalary: 52_000, maxWeeklyHours: 55, optedOutOf48: true }],
      ['Marco Bianchi', ['chef'], 16.5, '1990-07-02', 40],
      ['Aisha Okafor', ['chef'], 15.0, '1995-11-20', 40],
      ['Tom Reilly', ['chef', 'kp'], 13.5, '2001-02-09', 0, { coverSiteIds: ['fitz'] }],
      ['Lukas Novak', ['kp'], 12.71, '1999-05-30', 30],
      ['Daniel Ruiz', ['kp'], 12.71, '2004-09-12', 0],
      ['Grace Mensah', ['server', 'host'], 13.25, '1997-01-25', 32],
      ['Oliver Hughes', ['server'], 12.85, '2000-06-18', 0, { coverSiteIds: ['fitz'] }],
      ['Sofia Rossi', ['server', 'bar'], 13.0, '1998-12-03', 24],
      ['Ellie Carter', ['server', 'host'], 10.85, '2006-08-08', 0],
      ['Jamie Patel', ['host', 'server'], 8.0, '2009-04-21', 0, { availability: [4, 5, 6].map((weekday) => ({ weekday, fromMinute: 11 * 60, toMinute: 21 * 60 })) }],
      ['Ben Ford', ['bar'], 13.75, '1994-10-10', 36],
      ['Chloe Dubois', ['bar', 'server'], 12.9, '2002-03-27', 0, { leave: [addDays(today, 2)] }],
      ['Ryan Walsh', ['server'], 12.71, '2003-07-15', 0, { availability: allWeek(16, 24) }],
      ['Zara Ahmed', ['bar'], 13.1, '1998-02-17', 0],
      ['Callum Fraser', ['bar', 'server'], 12.8, '2002-10-29', 0, { coverSiteIds: ['fitz'] }],
      ['Freya Jones', ['host', 'server'], 12.71, '2003-03-08', 0],
      ['Mateo Garcia', ['server'], 12.71, '2001-09-23', 0, {
        rightToWork: { checked: true, checkedOn: '2025-02-03', evidence: 'Share code', expiry: addDays(today, 40) },
      }],
      ['Nadia Haddad', ['server', 'host'], 12.71, '2000-01-15', 0, { startDate: addDays(today, 5), rightToWork: { checked: false } }],
    ]),
    ...team('shd', [
      ['Hannah Lee', ['gm'], 0, '1988-09-01', 45, { payBasis: 'salaried', annualSalary: 48_000, maxWeeklyHours: 55, optedOutOf48: true }],
      ['Kwame Asante', ['chef'], 16.0, '1991-04-04', 40],
      ['Nina Petrova', ['chef', 'kp'], 14.0, '1996-02-14', 0],
      ['Sam Oduya', ['kp'], 12.71, '2000-12-12', 0],
      ['Leo Martins', ['server', 'bar'], 13.0, '1999-08-19', 30],
      ['Maya Singh', ['server', 'host'], 12.75, '2001-05-05', 0],
      ['Josh Turner', ['bar'], 13.5, '1997-11-11', 32],
      ['Isla Brown', ['server'], 12.71, '2003-01-30', 0],
      ['Femi Adeyemi', ['chef'], 14.5, '1993-06-06', 32],
      ['Ana Costa', ['kp'], 12.71, '2002-04-14', 0],
      ['Ruby Clarke', ['bar'], 13.0, '2000-07-07', 0],
      ['Dev Kapoor', ['bar', 'server'], 12.9, '1999-03-03', 0, { coverSiteIds: ['mar'] }],
      ['Lily Evans', ['server', 'host'], 12.71, '2004-11-19', 0],
      ['Kai Morgan', ['server'], 12.71, '2002-08-25', 0, { status: 'leaver', leaveDate: addDays(today, 3) }],
    ]),
    ...team('fitz', [
      ['Rachel Adams', ['gm'], 0, '1989-12-02', 45, { payBasis: 'salaried', annualSalary: 46_000, maxWeeklyHours: 55, optedOutOf48: true }],
      ['Pedro Alves', ['chef'], 15.5, '1992-05-17', 40],
      ['Yusuf Demir', ['chef', 'kp'], 13.75, '1998-08-30', 0, { coverSiteIds: ['mar'] }],
      ['Joe Bennett', ['kp'], 12.71, '2001-01-12', 0],
      ['Hana Kim', ['server', 'host'], 13.0, '1999-10-04', 30],
      ['Owen Price', ['server'], 12.71, '2003-06-21', 0],
      ['Tasha Reid', ['server', 'bar'], 12.9, '2000-02-28', 0],
      ['Will Barker', ['bar'], 13.25, '1996-09-09', 30],
      ['Megan Shaw', ['server', 'host'], 12.71, '2004-12-15', 0],
    ]),
  ];
}

const rules: DemandRule[] = [
  ...['mar', 'fitz', 'shd'].flatMap((siteId) => [
    { siteId, roleId: 'server', coversPerHour: 14, minimumWhileOpen: 1, maximum: 6 },
    { siteId, roleId: 'host', coversPerHour: 60, minimumWhileOpen: 0, maximum: 1 },
    { siteId, roleId: 'bar', salesPerLabourHour: 380, minimumWhileOpen: 1, maximum: 3 },
    { siteId, roleId: 'chef', coversPerHour: 22, minimumWhileOpen: 1, maximum: 4 },
    { siteId, roleId: 'kp', coversPerHour: 45, minimumWhileOpen: 1, maximum: 2 },
  ]),
];

// Net sales by weekday (Mon..Sun) and how each day's trade falls across the hours.
const DAILY = {
  mar: [3400, 3800, 4400, 5400, 7900, 8800, 5600],
  fitz: [1900, 2200, 2600, 3300, 4800, 5200, 2900],
  shd: [2600, 3000, 3600, 4800, 7600, 8400, 4200],
};
const CURVE: Record<number, number> = {
  11: 0.02, 12: 0.09, 13: 0.11, 14: 0.06, 15: 0.03, 16: 0.03, 17: 0.06,
  18: 0.11, 19: 0.15, 20: 0.15, 21: 0.1, 22: 0.06, 23: 0.03,
};
const AVERAGE_SPEND = 42;

function forecast(start: string): HourForecast[] {
  const rows: HourForecast[] = [];
  for (const site of sites) {
    for (let w = -1; w <= 2; w++) {
      weekDates(addDays(start, w * 7)).forEach((date, weekday) => {
        const day = DAILY[site.id as keyof typeof DAILY][weekday];
        for (const [h, share] of Object.entries(CURVE)) {
          const hour = Number(h);
          if (hour * 60 < site.openMinute || hour * 60 >= site.closeMinute) continue;
          const sales = Math.round(day * share);
          rows.push({ siteId: site.id, date, hour, sales, covers: Math.round(sales / AVERAGE_SPEND) });
        }
      });
    }
  }
  return rows;
}

/** Ids the sample group uses, so set-up can tell sample data from a customer's own. */
export const SAMPLE_ENTITY_IDS = entities.map((e) => e.id);
export const SAMPLE_SITE_IDS = sites.map((s) => s.id);

export function seedState(today = toISODate(new Date())): RotaState {
  const start = weekStart(today);
  return {
    // West End Dining claims for the group. Payroll to last Sunday left £1,850, so it runs out this week or next.
    entities: entities.map((e) => (e.id === 'wdl' ? { ...e, employmentAllowance: { remaining: 1850, asAt: addDays(start, -1) } } : e)),
    sites,
    roles,
    employees: employees(today),
    shifts: [],
    forecast: forecast(start),
    demandRules: rules,
  };
}
