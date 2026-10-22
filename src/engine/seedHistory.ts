import { tipsPayBy } from './tronc';
import { addDays, ageOn, weekDates, weekStart } from './time';
import type { DaySales, Department, Dish, DishSales, Employee, Purchase, RotaState, Shift, StockCount, TimeEntry, TipsTaken, TroncScheme } from './types';

/**
 * The demo’s trading history: nine weeks of published rota and clocking up to yesterday, the tips
 * taken and the tronc schemes they ran through, and the menu, invoices and stock counts behind cost
 * of sales. Built from the seeded takings, so a slow day is one where people went home early.
 *
 * Every site carries the problems a finance lead finds on a first review, so each screen has
 * something to act on: overruns on busy nights, one casual sent home on every quiet one, a chef
 * closing and opening, a student over their term-time hours, a uniform deduction that takes a KP
 * under the minimum wage, an employer-run tronc on a mandatory service charge, a site with no
 * tipping policy, tips a payroll missed, and a bar losing stock.
 *
 * Deterministic for a given date, so tests and screenshots can rely on it. Nothing on or after
 * today is written: the live day and the weeks ahead are for the visitor to run.
 */

// Nine weeks: the eight retention reads, and always a month of tips past its deadline, whatever the date.
const WEEKS = 9;
const ON_TIME = 15;

/** Sample clocking is stamped with this prefix, so set-up can tell it from time anyone really worked. */
const SAMPLE_ENTRY = 'te-seed-';
export const isSampleEntry = (entry: Pick<TimeEntry, 'id'>) => entry.id.startsWith(SAMPLE_ENTRY);

/** Repeatable noise in [-1, 1] for a key. */
function noise(key: string): number {
  let h = 2166136261;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((Math.abs(h) % 2001) / 1000) - 1;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const quarter = (minutes: number) => Math.round(minutes / ON_TIME) * ON_TIME;

/** The demo people each story is told through, by seeded id. */
const SENT_HOME = 'mar-8'; // Oliver Hughes: the first to go on every quiet night.
const CLOSE_OPEN = 'mar-4'; // Tom Reilly: closes Friday, opens Saturday.
const STUDENT = 'mar-17'; // Freya Jones: student visa, rostered at the limit and clocked over it.
const DEDUCTION = 'mar-6'; // Daniel Ruiz: on the wage floor with a uniform deduction.
const LONG_WEEKS = 'mar-2'; // Marco Bianchi: head chef, near the 48 hour average.

/** Story fields on the seeded team. Applied by seedState, so the rota and the records agree. */
export function withStories(list: Employee[], today: string): Employee[] {
  return list.map((e) => {
    if (e.id === DEDUCTION) return { ...e, nmwReducingDeductionsWeekly: 15 };
    if (e.id === STUDENT) {
      return {
        ...e,
        rightToWork: {
          checked: true,
          checkedOn: '2025-09-15',
          evidence: 'Share code (Student visa)',
          expiry: addDays(today, 300),
          studentWeeklyHourLimit: 20,
          // The summer vacation ended seven weeks ago: since then every week is term time.
          termVacations: [{ from: addDays(weekStart(today), -7 * 20), to: addDays(weekStart(today), -7 * 7 - 1) }],
        },
      };
    }
    return e;
  });
}

function department(state: RotaState, roleId: string): Department {
  return state.roles.find((r) => r.id === roleId)?.department ?? 'FOH';
}

function daySales(state: RotaState, siteId: string, date: string): number {
  const recorded = state.sales?.find((s) => s.siteId === siteId && s.date === date);
  if (recorded) return recorded.netSales;
  return (state.actuals ?? []).filter((a) => a.siteId === siteId && a.date === date).reduce((s, a) => s + a.sales, 0);
}

function working(e: Employee, date: string): boolean {
  if (e.payBasis !== 'hourly' || !e.rightToWork?.checked) return false;
  if (e.startDate && e.startDate > date) return false;
  if (e.status === 'leaver' && e.leaveDate && e.leaveDate <= date) return false;
  return !e.leave.includes(date);
}

/** Days a person works in a week, Monday 0 to Sunday 6. */
function daysWorked(e: Employee, index: number, week: number, today: string): number[] {
  if (ageOn(e.dateOfBirth, today) < 18) return e.availability.map((a) => a.weekday);
  if (e.id === STUDENT) return [3, 4, 5, 6];
  // Oliver's hours swing week to week, and last week he was given one shift.
  if (e.id === SENT_HOME) return week === WEEKS - 1 ? [4] : week % 3 === 0 ? [4, 5] : [0, 1, 2, 3, 4, 5];
  if (e.contractedHours > 0) {
    const off = [[0, 1], [1, 2], [0, 2], [2, 6], [0, 6], [1, 6]][index % 6];
    return [0, 1, 2, 3, 4, 5, 6].filter((d) => !off.includes(d));
  }
  // Every casual works Friday; Saturday most weeks, so there is someone free to call in when it is busy.
  const days = new Set([4, (index + week) % 3 === 0 ? 3 : 5, [0, 1, 2][(index + week) % 3], [3, 6][(index + week) % 2]]);
  if (index % 3 === 0 || e.id === SENT_HOME) days.add([0, 1, 2][(index + week + 1) % 3]);
  return [...days].sort();
}

/** One rostered shift: who, when, and whether it opens or closes. */
function rostered(state: RotaState, e: Employee, index: number, date: string, day: number): Shift {
  const site = state.sites.find((s) => s.id === e.siteId)!;
  const roleId = e.roleIds[0];
  const dept = department(state, roleId);
  const close = Math.min(24 * 60, dept === 'FOH' ? site.closeMinute : site.closeMinute + 30);
  const paid =
    ageOn(e.dateOfBirth, date) < 18 ? 5.5 * 60
    : e.id === STUDENT ? 5 * 60
    : e.id === LONG_WEEKS ? 8.5 * 60
    : e.contractedHours > 0 ? quarter((e.contractedHours * 60) / 5)
    : 7 * 60;
  // A rest break on anything that could run past six hours on the clock; always for an under 18.
  const breakMinutes = paid >= 6 * 60 || ageOn(e.dateOfBirth, date) < 18 ? 30 : 0;
  const length = paid + breakMinutes;
  let start: number;
  if (ageOn(e.dateOfBirth, date) < 18) start = 12 * 60;
  else if (e.id === LONG_WEEKS) start = 10 * 60;
  else if (e.id === CLOSE_OPEN) start = day === 5 ? 10 * 60 : close - length;
  // Openers open and closers close, so nobody closes and opens by accident.
  else if (dept === 'BOH') start = index % 2 === 0 ? 10 * 60 : close - length;
  else if (e.contractedHours > 0 && index % 2 === 0) start = site.openMinute;
  else start = close - length;
  return { id: `seed-${date}-${e.id}`, employeeId: e.id, roleId, siteId: e.siteId, date, startMinute: start, endMinute: start + length, breakMinutes, published: true };
}

function siteShifts(state: RotaState, siteId: string, date: string, week: number, today: string): Shift[] {
  const team = state.employees.filter((e) => e.siteId === siteId);
  const day = weekDates(weekStart(date)).indexOf(date);
  const shifts: Shift[] = [];
  team.forEach((e, index) => {
    if (!working(e, date) || !daysWorked(e, index, week, today).includes(day)) return;
    shifts.push(rostered(state, e, index, date, day));
  });
  return shifts;
}

/** Published rota for every closed day in the window. */
export function seedRota(state: RotaState, today: string): Shift[] {
  const first = addDays(weekStart(today), -7 * WEEKS);
  const shifts: Shift[] = [];
  for (let w = 0; w <= WEEKS; w++) {
    for (const date of weekDates(addDays(first, w * 7))) {
      if (date >= today) continue;
      for (const site of state.sites) shifts.push(...siteShifts(state, site.id, date, w, today));
    }
  }
  return shifts;
}

/** Each site's average takings by weekday over the window, to tell a quiet day from a normal one. */
function weekdayMeans(state: RotaState, today: string): Map<string, number> {
  const first = addDays(weekStart(today), -7 * WEEKS);
  const sums = new Map<string, { total: number; n: number }>();
  for (const site of state.sites) {
    for (let date = first; date < today; date = addDays(date, 1)) {
      const key = `${site.id}|${weekDates(weekStart(date)).indexOf(date)}`;
      const s = sums.get(key) ?? { total: 0, n: 0 };
      s.total += daySales(state, site.id, date);
      s.n += 1;
      sums.set(key, s);
    }
  }
  return new Map([...sums].map(([k, v]) => [k, v.total / Math.max(1, v.n)]));
}

/**
 * The clock against that rota. Most people arrive a few minutes early and leave on time; busy
 * nights run over at the bar and on the floor; quiet nights send casuals home early, Oliver first;
 * the kitchen cuts breaks short on Saturdays; a few casuals do not turn up and one extra comes in
 * unrostered. Weeks before this one are approved; this week's wait for the manager.
 */
export function seedTimeEntries(state: RotaState, today: string): TimeEntry[] {
  const means = weekdayMeans(state, today);
  const thisWeek = weekStart(today);
  const entries: TimeEntry[] = [];
  const byDay = new Map<string, Shift[]>();
  for (const s of state.shifts) {
    if (!s.id.startsWith('seed-') || s.date >= today) continue;
    const key = `${s.siteId}|${s.date}`;
    byDay.set(key, [...(byDay.get(key) ?? []), s]);
  }

  for (const [key, shifts] of byDay) {
    const [siteId, date] = key.split('|');
    const day = weekDates(weekStart(date)).indexOf(date);
    const ratio = daySales(state, siteId, date) / (means.get(`${siteId}|${day}`) || 1);
    const quiet = ratio < 0.96;
    const busy = ratio > 1.03 || ((day === 4 || day === 5) && noise(`busy${key}`) > 0.2);
    const status = date < thisWeek ? ('approved' as const) : ('submitted' as const);
    const approval = status === 'approved' ? { approvedBy: 'Preshift demo', approvedAt: `${addDays(date, 2)}T10:00:00.000Z` } : {};

    for (const s of shifts) {
      const e = state.employees.find((x) => x.id === s.employeeId)!;
      const dept = department(state, s.roleId);
      const casual = e.contractedHours === 0;
      if (casual && e.id !== SENT_HOME && e.id !== STUDENT && noise(`noshow${s.id}`) > 0.95) continue;

      let clockIn = s.startMinute - (3 + Math.round(5 * (noise(`in${s.id}`) + 1)));
      let clockOut = s.endMinute + Math.round(3 * (noise(`out${s.id}`) + 1));
      let breakMinutes = s.breakMinutes;
      const evening = s.endMinute >= 21 * 60;

      if (busy && evening && dept !== 'BOH') clockOut = s.endMinute + 25 + Math.round(10 * (noise(`over${s.id}`) + 1));
      // Oliver goes first on any weeknight that is not busy; others only when it is properly quiet, and not always.
      const sendHome = e.id === SENT_HOME ? !busy && day < 4 : quiet && noise(`home${s.id}`) > 0.3;
      if (evening && casual && dept !== 'BOH' && sendHome) {
        clockOut = s.endMinute - (e.id === SENT_HOME ? 120 : 75);
      }
      if (e.id === LONG_WEEKS) clockOut = s.endMinute + 30 + Math.round(15 * (noise(`long${s.id}`) + 1));
      if (e.id === STUDENT) clockOut = s.endMinute + 15;
      if (dept === 'BOH' && day === 5 && breakMinutes >= 30 && noise(`brk${s.id}`) > 0.4) breakMinutes = 10;
      // Kept on past ten on a busy Saturday: night work an under 18 may not do.
      if (ageOn(e.dateOfBirth, date) < 18 && day === 5 && noise(`late${date}`) > 0.2) clockOut = 22 * 60 + 30;
      if (e.id === CLOSE_OPEN && day === 4) clockOut = s.endMinute + 15;
      clockIn = Math.max(0, clockIn);

      entries.push({
        id: `${SAMPLE_ENTRY}${s.id.slice('seed-'.length)}`,
        employeeId: s.employeeId,
        siteId: s.siteId,
        roleId: s.roleId,
        shiftId: s.id,
        date: s.date,
        clockIn,
        clockOut,
        breakMinutes,
        status,
        source: 'clock',
        method: 'card',
        ...approval,
      });
    }

    // A busy Saturday every other week: a casual called in who was not on the rota.
    const week = Math.round((Date.parse(thisWeek) - Date.parse(weekStart(date))) / (7 * 86_400_000));
    if (day === 5 && week % 2 === 1) {
      const rostered = new Set(shifts.map((s) => s.employeeId));
      const extra = state.employees.find((x) => x.siteId === siteId && x.contractedHours === 0 && working(x, date) && !rostered.has(x.id) && ageOn(x.dateOfBirth, date) >= 18 && x.id !== STUDENT);
      const site = state.sites.find((x) => x.id === siteId)!;
      if (extra) {
        entries.push({
          id: `${SAMPLE_ENTRY}extra-${siteId}-${date}`,
          employeeId: extra.id,
          siteId,
          roleId: extra.roleIds[0],
          date,
          clockIn: 18 * 60,
          clockOut: Math.min(24 * 60, site.closeMinute),
          breakMinutes: 0,
          status,
          source: 'clock',
          method: 'card',
          ...approval,
        });
      }
    }
  }
  return entries.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

const SCHEMES: TroncScheme[] = [
  {
    siteId: 'mar',
    troncmaster: 'Grace Mensah, elected by the team',
    independent: true,
    pointsPerHour: { server: 10, host: 8, bar: 10, chef: 8, kp: 6 },
    serviceCharge: 'discretionary',
  },
  {
    siteId: 'shd',
    troncmaster: 'Hannah Lee, General Manager',
    independent: false,
    pointsPerHour: { server: 10, host: 8, bar: 10, chef: 7, kp: 5 },
    serviceCharge: 'mandatory',
  },
  {
    siteId: 'fitz',
    troncmaster: 'Rachel Adams, General Manager',
    independent: true,
    pointsPerHour: { server: 10, host: 8, bar: 10, chef: 8, kp: 6 },
    departmentShares: { FOH: 0.6, BOH: 0.4 },
    serviceCharge: 'none',
  },
];

/** Tronc schemes: Marylebone run properly, Shoreditch run by the business, Fitzrovia with no written policy. */
export function seedTroncSchemes(today: string): TroncScheme[] {
  return SCHEMES.map((s) =>
    s.siteId === 'fitz' ? { ...s } : { ...s, policyPublishedOn: addDays(today, -400), lastReviewedOn: addDays(today, s.siteId === 'mar' ? -200 : -1300) },
  );
}

/**
 * Tips by day: a service charge at Marylebone and Shoreditch, card tips everywhere, cash pooled on
 * Friday and Saturday. Paid in the payroll on the 25th of the month after; Shoreditch's payroll
 * missed the card and cash tips of the latest month that has fallen due, so those are overdue.
 */
export function seedTips(state: RotaState, today: string): TipsTaken[] {
  const first = addDays(weekStart(today), -7 * WEEKS);
  const due = (date: string) => tipsPayBy(date) < today;
  const missedMonth = [...new Set(Array.from({ length: daysTo(first, today) }, (_, i) => addDays(first, i)).filter(due).map((d) => d.slice(0, 7)))].sort().at(-1);
  const tips: TipsTaken[] = [];
  for (const site of state.sites) {
    for (let date = first; date < today; date = addDays(date, 1)) {
      const sales = daySales(state, site.id, date);
      if (sales <= 0) continue;
      const day = weekDates(weekStart(date)).indexOf(date);
      const paidOn = (d: string, source: TipsTaken['source']) => {
        // Shoreditch's payroll took the service charge that month but not the card and cash tips.
        if (site.id === 'shd' && d.slice(0, 7) === missedMonth && source !== 'service-charge') return undefined;
        const on = `${tipsPayBy(d).slice(0, 8)}25`;
        return on < today ? on : undefined;
      };
      const add = (source: TipsTaken['source'], amount: number) => {
        if (amount <= 0) return;
        tips.push({ id: `tip-${site.id}-${date}-${source}`, siteId: site.id, date, source, amount: round2(amount), paidOn: paidOn(date, source) });
      };
      if (site.id !== 'fitz') add('service-charge', sales * (site.id === 'mar' ? 0.11 : 0.1));
      add('card-tip', sales * (site.id === 'fitz' ? 0.07 : 0.015));
      if (day === 4 || day === 5) add('cash-pooled', 40 + Math.round(40 * (noise(`cash${site.id}${date}`) + 1)));
    }
  }
  return tips;
}

function daysTo(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

type MenuSeed = [name: string, category: 'food' | 'drink', price: number, recipeCost: number, weight: number];

/**
 * One menu, priced a little lower in Fitzrovia and Shoreditch. The weights give menu engineering
 * all four classes: fries and the chicken sell on volume, the ribeye earns per plate, and the sea
 * bass does neither.
 */
const MENU: MenuSeed[] = [
  ['Burrata, blood orange', 'food', 9.5, 2.6, 8],
  ['Crab linguine', 'food', 18, 5.4, 9],
  ['Dry-aged ribeye', 'food', 28, 9.8, 4],
  ['Roast chicken, jus', 'food', 19, 4.4, 14],
  ['Wild mushroom risotto', 'food', 16, 3.4, 8],
  ['Sea bass, fennel', 'food', 19, 11, 3],
  ['Caesar salad', 'food', 12, 2.9, 7],
  ['Fries', 'food', 4.5, 0.7, 22],
  ['Tiramisu', 'food', 7.5, 1.6, 8],
  ['Sticky toffee pudding', 'food', 7, 1.4, 7],
  ['House wine, 175ml', 'drink', 7.5, 1.8, 20],
  ['Bottle of wine', 'drink', 32, 10.5, 4],
  ['Lager, pint', 'drink', 5.8, 1.3, 22],
  ['Signature cocktail', 'drink', 11, 2.4, 10],
  ['Gin and tonic', 'drink', 9, 1.9, 9],
  ['Soft drink', 'drink', 3.5, 0.5, 14],
];
const PRICE_LEVEL: Record<string, number> = { mar: 1, fitz: 0.9, shd: 0.95 };
const FOOD_SHARE = 0.68;

/** How much more than the recipes say each site actually uses: Fitzrovia's bar is losing stock. */
const USAGE: Record<string, { food: number; drink: number }> = {
  mar: { food: 1.08, drink: 1.03 },
  fitz: { food: 1.05, drink: 1.16 },
  shd: { food: 1.11, drink: 1.05 },
};
const STOCK: Record<string, { food: number; drink: number }> = {
  mar: { food: 6500, drink: 9000 },
  fitz: { food: 3800, drink: 5200 },
  shd: { food: 5800, drink: 7400 },
};
const FOOD_SUPPLIERS: [supplier: string, day: number, share: number][] = [
  ['Fine Meats London', 0, 0.35],
  ['Billingsgate Direct', 1, 0.15],
  ['Natoora', 2, 0.2],
  ['Bookers', 3, 0.18],
  ['Longley Farm Dairy', 4, 0.12],
];
const DRINK_SUPPLIERS: [supplier: string, day: number, share: number][] = [
  ['Matthew Clark', 1, 0.7],
  ['Camden Town Brewery', 3, 0.3],
];

/**
 * The menu, what the till sold of it each day, the supplier invoices and the Sunday stock counts.
 * Invoices are what was used (the recipes, plus each site's waste and loss) so a closed week's actual
 * cost of sales lands where the story puts it.
 */
export function seedCostOfSales(state: RotaState, today: string): Pick<RotaState, 'dishes' | 'dishSales' | 'purchases' | 'stockCounts'> {
  const first = addDays(weekStart(today), -7 * WEEKS);
  const dishes: Dish[] = [];
  const dishSales: DishSales[] = [];
  const purchases: Purchase[] = [];
  const stockCounts: StockCount[] = [];
  for (const site of state.sites) {
    const level = PRICE_LEVEL[site.id] ?? 1;
    const menu = MENU.map(([name, category, price, recipeCost, weight], i) => ({
      dish: { id: `${site.id}-dish-${i + 1}`, siteId: site.id, name, category, price: round2(price * level), recipeCost },
      weight,
    }));
    dishes.push(...menu.map((m) => m.dish));
    const totalWeight = (c: 'food' | 'drink') => menu.filter((m) => m.dish.category === c).reduce((s, m) => s + m.weight * m.dish.price, 0);

    for (let w = 0; w <= WEEKS; w++) {
      const week = addDays(first, w * 7);
      const used = { food: 0, drink: 0 };
      for (const date of weekDates(week)) {
        if (date >= today) continue;
        const sales = daySales(state, site.id, date);
        for (const c of ['food', 'drink'] as const) {
          const categorySales = sales * (c === 'food' ? FOOD_SHARE : 1 - FOOD_SHARE);
          const scale = categorySales / totalWeight(c);
          for (const m of menu.filter((x) => x.dish.category === c)) {
            const units = Math.max(0, Math.round(m.weight * scale * (1 + 0.1 * noise(`${m.dish.id}${date}`))));
            if (units === 0) continue;
            dishSales.push({ siteId: site.id, date, dishId: m.dish.id, units });
            used[c] += units * m.dish.recipeCost;
          }
        }
      }
      for (const c of ['food', 'drink'] as const) {
        const bought = used[c] * USAGE[site.id][c];
        for (const [supplier, day, share] of c === 'food' ? FOOD_SUPPLIERS : DRINK_SUPPLIERS) {
          const date = addDays(week, day);
          if (date >= today || bought <= 0) continue;
          purchases.push({ id: `inv-${site.id}-${date}-${supplier.split(' ')[0].toLowerCase()}`, siteId: site.id, date, supplier, category: c, amount: round2(bought * share) });
        }
      }
    }
    // Counted at close every Sunday, from the one before the window opens.
    for (let w = 0; w <= WEEKS; w++) {
      const sunday = addDays(first, w * 7 - 1);
      if (sunday >= today) continue;
      for (const c of ['food', 'drink'] as const) {
        stockCounts.push({ siteId: site.id, date: sunday, category: c, value: round2(STOCK[site.id][c] * (1 + 0.015 * noise(`stock${site.id}${c}${sunday}`))) });
      }
    }
  }
  return { dishes, dishSales, purchases, stockCounts };
}

/** Everything above on a seeded state, and the clock to go with it. */
export function seedHistory(state: RotaState, today: string): { state: RotaState; timeEntries: TimeEntry[] } {
  const withRota: RotaState = { ...state, shifts: [...state.shifts, ...seedRota(state, today)] };
  const full: RotaState = {
    ...withRota,
    troncSchemes: seedTroncSchemes(today),
    tips: seedTips(withRota, today),
    ...seedCostOfSales(withRota, today),
  };
  return { state: full, timeEntries: seedTimeEntries(full, today) };
}

/**
 * The live day, for the cut call: today's rota published and the till's takings for each hour
 * already traded. Marylebone is having a slow day, so there is a call to make. Only where the
 * time of day is known (a demo sandbox, local development); tests seed history alone.
 */
export function seedLiveDay(state: RotaState, today: string, nowMinute: number): RotaState {
  const week = Math.round((Date.parse(weekStart(today)) - Date.parse(addDays(weekStart(today), -7 * WEEKS))) / (7 * 86_400_000));
  const shifts = state.sites.flatMap((site) => siteShifts(state, site.id, today, week, today));
  const pace: Record<string, number> = { mar: 0.72, fitz: 0.97, shd: 1.08 };
  const sales: DaySales[] = [];
  for (const site of state.sites) {
    const hours = state.forecast
      .filter((f) => f.siteId === site.id && f.date === today && (f.hour + 1) * 60 <= nowMinute)
      .map((f) => {
        const netSales = round2(f.sales * (pace[site.id] ?? 1) * (1 + 0.05 * noise(`live${site.id}${f.hour}`)));
        return { hour: f.hour, netSales, orders: Math.max(1, Math.round(netSales / 42)) };
      });
    if (hours.length === 0) continue;
    sales.push({ siteId: site.id, date: today, netSales: round2(hours.reduce((s, h) => s + h.netSales, 0)), source: 'till', hours });
  }
  const others = (state.sales ?? []).filter((s) => s.date !== today || !sales.some((x) => x.siteId === s.siteId));
  return { ...state, shifts: [...state.shifts.filter((s) => !shifts.some((x) => x.id === s.id)), ...shifts], sales: [...others, ...sales] };
}
