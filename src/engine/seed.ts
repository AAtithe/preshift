import type { Absence, Booking, BookingPace, DaySales, DemandRule, Employee, Entity, HourActual, HourForecast, HrProfile, HrRecord, Role, RotaState, Site } from './types';
import { COURSES, requiredCourses } from './hr';
import { PACE_LEADS } from './bookings';
import { daypartOf, DAYPARTS } from './forecast';
import { estimatedHolidays, schoolYearOf } from './school';
import { withStories } from './seedHistory';
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
  { id: 'wdl', name: 'West End Dining Ltd', companyNumber: '09876543', payeReference: '120/WE12345', intercompanyCode: '1351', travelPay: { basis: 'normal' } },
  { id: 'eck', name: 'East Canteen & Kitchen Ltd', companyNumber: '13579246', payeReference: '120/EC67890', intercompanyCode: '1352', leaveYearStart: '04-01', travelPay: { basis: 'normal' } },
];

const sites: Site[] = [
  // Locations are the postcode centres from postcodes.io; journey times come from TfL once refreshed.
  { id: 'mar', name: 'Marylebone', entityId: 'wdl', labourTargetPct: 0.28, trackingCode: 'Marylebone', openMinute: 11 * 60, closeMinute: 23 * 60, location: { lat: 51.520957, lng: -0.153565, postcode: 'W1U 5AS' },
    // Split into areas, so the sample shows labour by area without anyone setting it up first.
    areas: [
      { id: 'mar-foh', name: 'Front of house', roleIds: ['server', 'host', 'gm'] },
      { id: 'mar-bar', name: 'Bar', roleIds: ['bar'] },
      { id: 'mar-boh', name: 'Back of house', roleIds: ['chef', 'kp'] },
    ] },
  { id: 'fitz', name: 'Fitzrovia', entityId: 'wdl', labourTargetPct: 0.29, trackingCode: 'Fitzrovia', openMinute: 11 * 60, closeMinute: 22 * 60, location: { lat: 51.517734, lng: -0.134021, postcode: 'W1T 1JB' } },
  { id: 'shd', name: 'Shoreditch', entityId: 'eck', labourTargetPct: 0.27, trackingCode: 'Shoreditch', openMinute: 12 * 60, closeMinute: 24 * 60, location: { lat: 51.526419, lng: -0.078249, postcode: 'E1 6JE' } },
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
          const covers = Math.round(sales / AVERAGE_SPEND);
          rows.push({ siteId: site.id, date, hour, sales, covers, modelSales: sales, modelCovers: covers });
        }
      });
    }
  }
  return rows;
}

/** Repeatable noise in [-1, 1] for a key, so the demo history is the same on every run. */
function noise(key: string): number {
  let h = 2166136261;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((Math.abs(h) % 2001) / 1000) - 1;
}

/**
 * Twelve weeks of till history up to yesterday: the forecast pattern, a little
 * busier each week (trade is growing), with day and hour noise either way.
 */
function actuals(start: string, today: string): HourActual[] {
  const rows: HourActual[] = [];
  const holidays = [...estimatedHolidays(schoolYearOf(today) - 1), ...estimatedHolidays(schoolYearOf(today))];
  for (const site of sites) {
    for (let w = -12; w <= 0; w++) {
      weekDates(addDays(start, w * 7)).forEach((date, weekday) => {
        if (date >= today) return;
        const growth = 1 + 0.004 * (w + 12);
        const dayNoise = 1 + 0.08 * noise(`${site.id}${date}`);
        const day = DAILY[site.id as keyof typeof DAILY][weekday] * growth * dayNoise;
        for (const [h, share] of Object.entries(CURVE)) {
          const hour = Number(h);
          if (hour * 60 < site.openMinute || hour * 60 >= site.closeMinute) continue;
          // Marylebone's weekday lunches pick up families in the school holidays.
          const holidayLunch = site.id === 'mar' && weekday < 5 && hour >= 11 && hour < 15 && holidays.some((p) => p.start <= date && p.end >= date) ? 1.15 : 1;
          const sales = Math.max(0, Math.round(day * share * holidayLunch * (1 + 0.12 * noise(`${site.id}${date}${hour}`))));
          rows.push({ siteId: site.id, date, hour, sales, covers: Math.round(sales / AVERAGE_SPEND) });
        }
      });
    }
  }
  return rows;
}

/** Share of a day's final bookings already made `lead` days out: most come in the last fortnight. */
const filled = (lead: number) => Math.exp(-lead / 9);
const BOOKED_SHARE = 0.6;

/**
 * Marylebone takes bookings: twelve weeks of how its days filled up, and the
 * next three weeks on the books, with next Saturday's dinner pacing well ahead
 * and a party of 24 booked for Halloween. The other sites are walk-in led.
 */
function bookingDemo(start: string, today: string, actualRows: HourActual[], forecastRows: HourForecast[]): { bookings: Booking[]; pace: BookingPace[] } {
  const pace: BookingPace[] = [];
  const covers = (rows: { date: string; hour: number; covers: number; siteId: string }[], date: string, dp: string) =>
    rows.filter((r) => r.siteId === 'mar' && r.date === date && daypartOf(r.hour).id === dp).reduce((s, r) => s + r.covers, 0);
  const pastDays = [...new Set(actualRows.filter((a) => a.siteId === 'mar' && a.date < addDays(today, -1)).map((a) => a.date))];
  for (const date of pastDays) {
    for (const dp of DAYPARTS) {
      const final = dp.id === 'lunch' || dp.id === 'dinner' ? Math.round(covers(actualRows, date, dp.id) * BOOKED_SHARE) : 0;
      pace.push({ siteId: 'mar', date, daypart: dp.id, booked: PACE_LEADS.map((l) => Math.round(final * filled(l))), leads: [...PACE_LEADS] });
    }
  }
  const bookings: Booking[] = [];
  const saturday = addDays(start, 5);
  for (let d = today; d < addDays(today, 21); d = addDays(d, 1)) {
    for (const dp of ['lunch', 'dinner'] as const) {
      const lift = d === saturday && dp === 'dinner' ? 1.45 : 1;
      const final = Math.round(covers(forecastRows, d, dp) * BOOKED_SHARE * lift);
      const lead = Math.round((Date.parse(d) - Date.parse(today)) / 86_400_000);
      const n = Math.max(0, Math.round(final / 4));
      for (let i = 1; i <= n; i++) {
        // The i-th of n bookings is made when the day is i/n filled; only those already made are on the books today.
        const madeLead = Math.round(-9 * Math.log(i / n));
        if (madeLead < lead) continue;
        bookings.push({
          id: `resdiary:demo-${d}-${dp}-${i}`,
          siteId: 'mar',
          source: 'resdiary',
          date: d,
          startMinute: (dp === 'lunch' ? 12 * 60 : 19 * 60) + (i % 4) * 30,
          covers: 2 + (i % 3) * 2,
          status: 'booked',
          createdAt: addDays(d, -madeLead),
        });
      }
    }
  }
  const halloween = `${today.slice(0, 4)}-10-31`;
  if (halloween >= today && halloween < addDays(today, 21)) {
    bookings.push({ id: 'resdiary:demo-party', siteId: 'mar', source: 'resdiary', date: halloween, startMinute: 19 * 60 + 30, covers: 24, status: 'booked', createdAt: addDays(today, -12) });
  }
  return { bookings, pace };
}

/** Ids the sample group uses, so set-up can tell sample data from a customer's own. */
export const SAMPLE_ENTITY_IDS = entities.map((e) => e.id);
export const SAMPLE_SITE_IDS = sites.map((s) => s.id);

/**
 * Takings for every trading day before today in the forecast's first two weeks, off forecast by a
 * steady few percent so the reports have real variance to show. Deterministic, so tests can rely on it.
 */
function takings(rows: HourForecast[], today: string): DaySales[] {
  const byDay = new Map<string, { siteId: string; date: string; sales: number; covers: number }>();
  for (const f of rows) {
    if (f.date >= today) continue;
    const key = `${f.siteId}|${f.date}`;
    const day = byDay.get(key) ?? { siteId: f.siteId, date: f.date, sales: 0, covers: 0 };
    day.sales += f.sales;
    day.covers += f.covers;
    byDay.set(key, day);
  }
  return [...byDay.values()].map((d) => {
    const seed = [...`${d.siteId}${d.date}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1000, 7);
    const factor = 0.88 + (seed % 23) / 100; // 0.88 to 1.10
    return { siteId: d.siteId, date: d.date, netSales: Math.round(d.sales * factor), covers: Math.round(d.covers * factor), source: 'till' as const };
  });
}

export function seedState(today = toISODate(new Date())): RotaState {
  const start = weekStart(today);
  const history = actuals(start, today);
  const fc = forecast(start);
  const demo = bookingDemo(start, today, history, fc);
  return {
    // West End Dining claims for the group. Payroll to last Sunday left £1,850, so it runs out this week or next.
    // Copies, so one organisation's edits can never reach another seeded from the same data (demo sandboxes, tests).
    entities: structuredClone(entities).map((e) => (e.id === 'wdl' ? { ...e, employmentAllowance: { remaining: 1850, asAt: addDays(start, -1) } } : e)),
    sites: structuredClone(sites),
    roles: structuredClone(roles),
    employees: withStories(withHr(employees(today), today), today),
    shifts: [],
    forecast: fc,
    demandRules: structuredClone(rules),
    sales: takings(fc, today),
    actuals: history,
    forecastAdjustments: [],
    bookings: demo.bookings,
    bookingPace: demo.pace,
    // Two weeks out, so this week and next build as they always have: a confirmed wedding in the evening
    // and a Christmas party still on hold, to show what each does to demand.
    privateEvents: [
      { id: 'tripleseat:demo-wedding', siteId: 'mar', source: 'tripleseat', date: addDays(start, 19), startMinute: 17 * 60, endMinute: 23 * 60 + 30, guests: 90, kind: 'wedding', style: 'seated', status: 'confirmed', exclusive: false, space: 'Garden room', spend: 8250 },
      { id: 'tripleseat:demo-xmas', siteId: 'mar', source: 'tripleseat', date: addDays(start, 18), startMinute: 19 * 60, endMinute: 23 * 60, guests: 40, kind: 'corporate', style: 'standing', status: 'provisional', exclusive: false, space: 'Garden room', spend: 2400 },
    ],
  };
}

const FIRST_NAMES = ['Sarah', 'David', 'Amira', 'James', 'Rosa', 'Michael', 'Leah', 'Kofi'];
const RELATIONSHIPS = ['Partner', 'Parent', 'Sibling', 'Friend'];

/**
 * Personnel files for the demo: most are in order, a few carry the problems a GM meets
 * every month, so every HR screen has something to act on.
 */
function withHr(list: Employee[], today: string): Employee[] {
  const gmOf = (siteId: string) => `${siteId}-1`;
  const profiles: Record<string, Partial<HrProfile>> = {
    // Starts in five days: statement not yet issued, probation set.
    'mar-19': { contractIssuedOn: undefined, contractSignedOn: undefined, probationEnd: addDays(today, 95), probationPassedOn: undefined },
    'mar-16': { emergencyContact: undefined },
    'shd-13': { niNumber: undefined },
    'mar-7': { contractSignedOn: undefined },
    'fitz-6': { probationEnd: addDays(today, 10), probationPassedOn: undefined },
    'fitz-9': { contractType: 'fixed-term', fixedTermEnd: addDays(today, 30) },
  };
  const absences: Record<string, Absence[]> = {
    'mar-3': [
      { id: 'abs-1', type: 'sickness', from: addDays(today, -200), to: addDays(today, -199), reason: 'Migraine', returnToWorkOn: addDays(today, -198) },
      { id: 'abs-2', type: 'sickness', from: addDays(today, -120), to: addDays(today, -120), reason: 'Stomach bug', returnToWorkOn: addDays(today, -119) },
      { id: 'abs-3', type: 'sickness', from: addDays(today, -40), to: addDays(today, -39), reason: 'Cold', returnToWorkOn: addDays(today, -38) },
      { id: 'abs-4', type: 'sickness', from: addDays(today, -15), to: addDays(today, -14), reason: 'Migraine' },
    ],
    'mar-5': [
      { id: 'abs-5', type: 'sickness', from: addDays(today, -70), to: addDays(today, -61), reason: 'Back injury', fitNote: true, returnToWorkOn: addDays(today, -60) },
    ],
    'fitz-5': [{ id: 'abs-6', type: 'sickness', from: addDays(today, -9), reason: 'Flu' }],
    'shd-6': [{ id: 'abs-7', type: 'compassionate', from: addDays(today, -30), to: addDays(today, -28), reason: 'Bereavement' }],
  };
  return list.map((e, i) => {
    const base: HrProfile = {
      jobTitle: e.roleIds[0] === 'gm' ? 'General Manager' : undefined,
      contractType: e.contractedHours === 0 ? 'casual' : 'permanent',
      contractIssuedOn: '2024-01-02',
      contractSignedOn: '2024-01-05',
      probationEnd: '2024-04-07',
      probationPassedOn: '2024-04-05',
      niNumber: `QQ${String(100000 + i * 7919).slice(-6)}C`,
      emergencyContact: { name: `${FIRST_NAMES[i % FIRST_NAMES.length]} ${e.name.split(' ')[1]}`, relationship: RELATIONSHIPS[i % 4], phone: `07700 900${String(100 + i).slice(-3)}` },
      managerId: e.id === gmOf(e.siteId) ? undefined : gmOf(e.siteId),
    };
    const startDate = e.id === 'fitz-6' ? addDays(today, -80) : e.startDate;
    return { ...e, startDate, hr: { ...base, ...profiles[e.id] }, ...(absences[e.id] ? { absences: absences[e.id] } : {}) };
  });
}

/** Training, reviews and cases on the demo files. */
export function seedHrRecords(today = toISODate(new Date())): HrRecord[] {
  const people = withHr(employees(today), today).filter((e) => e.status !== 'leaver');
  const records: HrRecord[] = [];
  const add = (r: Omit<HrRecord, 'id' | 'createdBy' | 'createdAt'>) =>
    records.push({ ...r, id: `hr-${records.length + 1}`, createdBy: 'Preshift demo', createdAt: today });
  const plusYears = (iso: string, years: number) => `${Number(iso.slice(0, 4)) + years}${iso.slice(4)}`;

  people.forEach((e, i) => {
    for (const course of requiredCourses(e, roles)) {
      // A few gaps and expiries so the training matrix shows what an EHO visit would find.
      if (e.id === 'fitz-4' && course.name === 'Food hygiene level 2') continue;
      if (i % 9 === 4 && course.name === 'Allergen awareness') continue;
      let date = course.renewYears === 1 ? addDays(today, -(150 + (i * 13) % 150)) : addDays(today, -(200 + (i * 41) % 600));
      if (e.id === 'mar-12' && course.renewYears === 1) date = addDays(today, -375);
      let expiresOn = course.renewYears ? plusYears(date, course.renewYears) : undefined;
      if (e.id === 'mar-4' && course.name === 'Food hygiene level 2') expiresOn = addDays(today, 20);
      add({ employeeId: e.id, kind: 'training', date, title: course.name, expiresOn });
    }
    if (e.roleIds[0] === 'gm') {
      const fa = COURSES.find((c) => c.name === 'First aid at work')!;
      const date = addDays(today, -1050);
      add({ employeeId: e.id, kind: 'training', date, title: fa.name, expiresOn: e.id === 'mar-1' ? addDays(today, 45) : plusYears(date, 3) });
    }
    if (e.startDate && e.startDate <= addDays(today, -365)) {
      const date = addDays(today, -(40 + (i * 37) % 280));
      const nextDue = e.id === 'mar-7' ? addDays(today, -12) : addDays(date, 365);
      add({ employeeId: e.id, kind: 'review', reviewType: 'appraisal', date, title: 'Annual appraisal', outcome: 'Meets expectations', nextDue });
    }
  });

  add({
    employeeId: 'mar-14', kind: 'case', caseType: 'disciplinary', caseStatus: 'open', date: addDays(today, -6),
    title: 'Lateness on three shifts', notes: 'Investigation meeting held. Hearing to be arranged with five days\' written notice and the right to be accompanied.',
  });
  add({
    employeeId: 'shd-7', kind: 'case', caseType: 'disciplinary', caseStatus: 'closed', date: addDays(today, -60),
    title: 'Till discrepancy', outcome: 'First written warning', warningExpires: addDays(today, 120),
  });
  add({
    employeeId: 'fitz-7', kind: 'case', caseType: 'grievance', caseStatus: 'closed', date: addDays(today, -45),
    title: 'Fairness of weekend rota', outcome: 'Grievance partly upheld', notes: 'Weekend shifts now rotated monthly.',
  });
  add({ employeeId: 'mar-3', kind: 'note', date: addDays(today, -14), title: 'Migraines', notes: 'Discussed support. Referral to GP suggested; consider occupational health if it continues.' });
  add({ employeeId: 'mar-19', kind: 'document', date: addDays(today, -3), title: 'Offer letter', notes: 'Signed copy received.' });
  return records;
}
