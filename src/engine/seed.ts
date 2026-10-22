import type { DemandRule, Dish, Employee, HourForecast, Role, RotaState, SalesCategory, Site, TroncScheme } from './types';
import { addDays, toISODate, weekDates, weekStart } from './time';

const roles: Role[] = [
  { id: 'server', name: 'Server', department: 'FOH', nominalCode: '7000' },
  { id: 'host', name: 'Host', department: 'FOH', nominalCode: '7000' },
  { id: 'bar', name: 'Bartender', department: 'BAR', nominalCode: '7002' },
  { id: 'chef', name: 'Chef', department: 'BOH', nominalCode: '7001' },
  { id: 'kp', name: 'Kitchen Porter', department: 'BOH', nominalCode: '7001' },
  { id: 'gm', name: 'General Manager', department: 'MGMT', nominalCode: '7003' },
  { id: 'am', name: 'Assistant Manager', department: 'MGMT', nominalCode: '7003' },
];

const sites: Site[] = [
  {
    id: 'mar', name: 'Marylebone', labourTargetPct: 0.28, trackingCode: 'Marylebone', openMinute: 11 * 60, closeMinute: 23 * 60,
    location: { lat: 51.5203, lng: -0.1515 }, geofenceMetres: 150, concept: 'restaurant', region: 'London',
    foodCostTargetPct: 0.28, drinkCostTargetPct: 0.22,
  },
  {
    id: 'shd', name: 'Shoreditch', labourTargetPct: 0.27, trackingCode: 'Shoreditch', openMinute: 12 * 60, closeMinute: 24 * 60,
    location: { lat: 51.5246, lng: -0.0794 }, geofenceMetres: 150, concept: 'restaurant', region: 'London',
    foodCostTargetPct: 0.28, drinkCostTargetPct: 0.22,
  },
];

const allWeek = (from: number, to: number) =>
  Array.from({ length: 7 }, (_, weekday) => ({ weekday, fromMinute: from * 60, toMinute: to * 60 }));

type Seed = [name: string, roles: string[], rate: number, dob: string, contracted: number, extra?: Partial<Employee>];

function team(siteId: string, people: Seed[]): Employee[] {
  return people.map(([name, roleIds, rate, dob, contracted, extra], i) => ({
    id: `${siteId}-${i + 1}`,
    name,
    siteId,
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
    rightToWork: { basis: 'unlimited', checkedOn: '2025-03-01' },
    startedOn: '2024-04-15',
    ...extra,
  }));
}

function employees(today: string): Employee[] {
  return [
    ...team('mar', [
      ['Priya Shah', ['gm'], 0, '1986-03-14', 0, { payBasis: 'salaried', annualSalary: 52_000, maxWeeklyHours: 55, optedOutOf48: true }],
      // Salaried head chef on a salary that only clears minimum wage at 45 hours a week.
      ['Ivan Petrov', ['chef'], 0, '1992-05-11', 0, { payBasis: 'salaried', annualSalary: 30_000, maxWeeklyHours: 55, optedOutOf48: true, nmwReducingDeductionsWeekly: 6, payFrequency: 'monthly' }],
      ['Marco Bianchi', ['chef'], 16.5, '1990-07-02', 40],
      ['Aisha Okafor', ['chef'], 15.0, '1995-11-20', 40],
      ['Tom Reilly', ['chef', 'kp'], 13.5, '2001-02-09', 0, { startedOn: addDays(today, -38) }],
      ['Lukas Novak', ['kp'], 12.71, '1999-05-30', 30],
      ['Daniel Ruiz', ['kp'], 12.71, '2004-09-12', 0],
      ['Grace Mensah', ['server', 'host'], 13.25, '1997-01-25', 32],
      ['Oliver Hughes', ['server'], 12.85, '2000-06-18', 0],
      ['Sofia Rossi', ['server', 'bar'], 13.0, '1998-12-03', 24],
      ['Ellie Carter', ['server', 'host'], 10.85, '2006-08-08', 0, {
        rightToWork: {
          basis: 'student', checkedOn: '2025-09-20', expires: '2027-10-31', weeklyHourLimit: 20,
          vacations: [{ from: '2026-12-12', to: '2027-01-10' }, { from: '2027-03-27', to: '2027-04-25' }, { from: '2027-06-12', to: '2027-09-26' }],
        },
      }],
      ['Jamie Patel', ['host', 'server'], 8.0, '2009-04-21', 0, { availability: [4, 5, 6].map((weekday) => ({ weekday, fromMinute: 11 * 60, toMinute: 21 * 60 })) }],
      ['Ben Ford', ['bar'], 13.75, '1994-10-10', 36],
      ['Chloe Dubois', ['bar', 'server'], 12.9, '2002-03-27', 0, { leave: [addDays(today, 2)] }],
      ['Ryan Walsh', ['server'], 12.71, '2003-07-15', 0, { availability: allWeek(16, 24) }],
      ['Zara Ahmed', ['bar'], 13.1, '1998-02-17', 0],
      ['Callum Fraser', ['bar', 'server'], 12.8, '2002-10-29', 0],
      ['Freya Jones', ['host', 'server'], 12.71, '2003-03-08', 0],
      ['Mateo Garcia', ['server'], 12.71, '2001-09-23', 0, { startedOn: addDays(today, -75) }],
    ]),
    ...team('shd', [
      ['Hannah Lee', ['gm'], 0, '1988-09-01', 0, { payBasis: 'salaried', annualSalary: 48_000, maxWeeklyHours: 55, optedOutOf48: true }],
      ['Owen Hart', ['am'], 0, '1998-01-19', 0, { payBasis: 'salaried', annualSalary: 27_500, maxWeeklyHours: 55, optedOutOf48: true }],
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
      ['Dev Kapoor', ['bar', 'server'], 12.9, '1999-03-03', 0],
      ['Lily Evans', ['server', 'host'], 12.71, '2004-11-19', 0, { startedOn: addDays(today, -20) }],
      ['Kai Morgan', ['server'], 12.71, '2002-08-25', 0, { rightToWork: { basis: 'time-limited', checkedOn: '2025-02-10', expires: addDays(today, 9) } }],
    ]),
  ];
}

const troncSchemes: TroncScheme[] = [
  {
    siteId: 'mar',
    troncmaster: 'Grace Mensah, head server',
    independent: true,
    pointsPerHour: { server: 10, host: 8, bar: 10, chef: 7, kp: 6, gm: 0, am: 5 },
    serviceCharge: 'discretionary',
    policyPublishedOn: '2024-09-20',
    lastReviewedOn: '2024-09-20',
  },
  {
    // The GM decides who gets what, so the employer is allocating and NI is due.
    siteId: 'shd',
    troncmaster: 'Hannah Lee, general manager',
    independent: false,
    pointsPerHour: { server: 10, host: 8, bar: 10, chef: 8, kp: 6, gm: 0, am: 5 },
    departmentShares: { FOH: 0.55, BAR: 0.2, BOH: 0.25 },
    serviceCharge: 'mandatory',
  },
];

// One menu, priced net of VAT, with the recipe cost of each portion or serve: [name, category, price, cost, popularity].
export const MENU: [string, SalesCategory, number, number, number][] = [
  ['Burrata, blood orange', 'food', 10.0, 3.1, 0.9],
  ['Crispy squid', 'food', 9.17, 2.2, 1.3],
  ['Soup of the day', 'food', 6.67, 1.1, 0.5],
  ['Steak frites', 'food', 24.17, 9.4, 1.6],
  ['Roast chicken, salsa verde', 'food', 18.33, 4.4, 1.2],
  ['Hake, mussels, cider', 'food', 21.67, 7.9, 0.7],
  ['Wild mushroom risotto', 'food', 15.83, 2.9, 0.6],
  ['Lamb shoulder for two', 'food', 45.83, 16.5, 0.35],
  ['Cheeseburger', 'food', 15.0, 4.6, 1.4],
  ['Sticky toffee pudding', 'food', 7.5, 1.4, 0.9],
  ['Chocolate delice', 'food', 8.33, 2.1, 0.4],
  ['Cheese board', 'food', 11.67, 4.9, 0.25],
  ['House wine 175ml', 'drink', 6.67, 1.35, 1.6],
  ['Rioja 175ml', 'drink', 9.17, 2.6, 0.6],
  ['Champagne 125ml', 'drink', 12.5, 4.6, 0.3],
  ['Draught lager pint', 'drink', 5.42, 1.25, 1.5],
  ['Negroni', 'drink', 9.58, 2.2, 0.7],
  ['Espresso martini', 'drink', 10.42, 2.4, 0.9],
  ['Soft drink', 'drink', 3.33, 0.55, 0.8],
  ['Coffee', 'drink', 2.92, 0.35, 0.9],
];

const dishes: Dish[] = ['mar', 'shd'].flatMap((siteId) =>
  MENU.map(([name, category, price, recipeCost], i) => ({ id: `${siteId}-d${i + 1}`, siteId, name, category, price, recipeCost })),
);

const rules: DemandRule[] = [
  ...['mar', 'shd'].flatMap((siteId) => [
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
    for (let w = -4; w <= 2; w++) {
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

export function seedState(today = toISODate(new Date())): RotaState {
  const start = weekStart(today);
  return {
    sites,
    roles,
    employees: employees(today),
    shifts: [],
    forecast: forecast(start),
    demandRules: rules,
    clocks: [],
    actuals: [],
    tips: [],
    troncSchemes,
    dishes,
    dishSales: [],
    purchases: [],
    stockCounts: [],
  };
}
