import type { ClockRecord, HourActual, RotaState, Shift, TipsTaken } from './types';
import { autoSchedule } from './autoschedule';
import { addDays, toISODate, weekStart } from './time';
import { seedState } from './seed';

/** Small deterministic generator so the demo week looks the same on every load. */
export function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TradeUntil {
  date: string;
  minute: number;
}

/**
 * Plays the rota forward into clockings and sales, with the habits that open
 * the gap between rota and payroll on a real floor: early clock-ins, closers
 * running over, skipped breaks, the odd no-show and an unrostered shift.
 * Trading stops at `until`; anyone still on shift then is left clocked in.
 */
export function simulateTrading(state: RotaState, until: TradeUntil, seed = 51, slowToday = 0.68): RotaState {
  const rnd = random(seed);
  const between = (lo: number, hi: number) => Math.round(lo + rnd() * (hi - lo));
  const traded = (date: string, minute: number) => date < until.date || (date === until.date && minute <= until.minute);
  const clocks: ClockRecord[] = [];

  const shifts = state.shifts
    .filter((s) => traded(s.date, s.startMinute))
    .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute || a.employeeId.localeCompare(b.employeeId));
  for (const shift of shifts) {
    // No-shows happen on the floor; a manager who misses a day is covering elsewhere, not absent.
    const noShow = rnd() < 0.02;
    if (noShow && !shift.id.startsWith('mgr-')) continue;
    const site = state.sites.find((s) => s.id === shift.siteId)!;
    const r = rnd();
    const clockIn = shift.startMinute + (r < 0.45 ? -between(3, 10) : r < 0.6 ? between(2, 20) : 0);
    const closer = shift.endMinute >= site.closeMinute;
    const o = rnd();
    const clockOut =
      shift.endMinute +
      (o < (closer ? 0.6 : 0.25) ? between(5, closer ? 45 : 25) : o > 0.96 ? -between(30, 90) : 0);
    const breakMinutes = shift.breakMinutes > 0 && rnd() < 0.2 ? 0 : shift.breakMinutes;
    const open = shift.date === until.date && clockOut > until.minute;
    clocks.push({
      id: `c-${shift.id}`,
      employeeId: shift.employeeId,
      siteId: shift.siteId,
      roleId: shift.roleId,
      shiftId: shift.id,
      date: shift.date,
      clockIn,
      clockOut: open ? undefined : clockOut,
      breakMinutes: open ? 0 : breakMinutes,
      approved: !open && rnd() < 0.3,
      source: 'geofence',
    });
  }

  // Someone covers a busy Friday evening without being on the rota.
  for (const site of state.sites) {
    const friday = addDays(weekStart(addDays(until.date, -7)), 4);
    const busy = new Set(state.shifts.filter((s) => s.date === friday).map((s) => s.employeeId));
    const spare = state.employees.find((e) => e.siteId === site.id && e.payBasis === 'hourly' && !busy.has(e.id) && !e.leave.includes(friday));
    if (spare && traded(friday, 22 * 60)) {
      clocks.push({
        id: `c-extra-${site.id}`,
        employeeId: spare.id,
        siteId: site.id,
        roleId: spare.roleIds[0],
        date: friday,
        clockIn: 18 * 60,
        clockOut: 22 * 60,
        breakMinutes: 0,
        source: 'manager',
      });
    }
  }

  // Trade lands around forecast, with today running quiet so there is a call to make.
  const dayFactor = new Map<string, number>();
  const actuals: HourActual[] = [];
  for (const f of state.forecast) {
    if (!traded(f.date, (f.hour + 1) * 60)) continue;
    const key = `${f.siteId}|${f.date}`;
    if (!dayFactor.has(key)) dayFactor.set(key, f.date === until.date ? slowToday : 0.88 + rnd() * 0.24);
    const factor = dayFactor.get(key)! * (0.9 + rnd() * 0.2);
    const sales = Math.round(f.sales * factor);
    actuals.push({ siteId: f.siteId, date: f.date, hour: f.hour, sales, covers: Math.round(f.covers * factor) });
  }

  // Service charge and tips on each full day traded. Shoreditch's charge is mandatory, so everyone pays it.
  const tips: TipsTaken[] = [];
  const daySales = new Map<string, number>();
  for (const a of actuals) if (a.date < until.date) daySales.set(`${a.siteId}|${a.date}`, (daySales.get(`${a.siteId}|${a.date}`) ?? 0) + a.sales);
  for (const [key, sales] of daySales) {
    const [siteId, date] = key.split('|');
    const mandatory = state.troncSchemes.find((t) => t.siteId === siteId)?.serviceCharge === 'mandatory';
    const uptake = mandatory ? 1 : 0.84 + rnd() * 0.08;
    const add = (source: TipsTaken['source'], amount: number) =>
      tips.push({ id: `tip-${siteId}-${date}-${source}`, siteId, date, source, amount: Math.round(amount * 100) / 100 });
    add('service-charge', sales * 0.125 * uptake);
    add('card-tip', sales * (0.006 + rnd() * 0.008));
    add('cash-pooled', sales * (0.002 + rnd() * 0.004));
  }

  return { ...state, clocks, actuals, tips };
}

// Salaried managers are rostered by hand: [employee, role, first weekday, start, end, break].
const MANAGERS: [string, string, number, number, number, number][] = [
  ['mar-1', 'gm', 0, 10 * 60, 20 * 60, 30],
  ['mar-2', 'chef', 1, 10 * 60, 21 * 60, 60],
  ['shd-1', 'gm', 0, 11 * 60, 21 * 60, 30],
  ['shd-2', 'am', 2, 11 * 60 + 30, 22 * 60 + 30, 30],
];

/** Five days a week each, the long days hospitality managers actually work. */
function managerRota(week: string): Shift[] {
  return MANAGERS.flatMap(([employeeId, roleId, first, startMinute, endMinute, breakMinutes]) =>
    Array.from({ length: 5 }, (_, i) => ({
      id: `mgr-${employeeId}-${addDays(week, first + i)}`,
      employeeId,
      roleId,
      siteId: employeeId.slice(0, 3),
      date: addDays(week, first + i),
      startMinute,
      endMinute,
      breakMinutes,
      published: true,
    })),
  );
}

function studentToTheLimit(week: string): Shift[] {
  return [2, 3, 4, 5, 6].map((day) => ({
    id: `hand-mar-11-${addDays(week, day)}`,
    employeeId: 'mar-11',
    roleId: 'server',
    siteId: 'mar',
    date: addDays(week, day),
    startMinute: 18 * 60,
    endMinute: 22 * 60,
    breakMinutes: 0,
    published: true,
  }));
}

/** Where the demo's trading day has got to. */
export const DEMO_MINUTE = 18 * 60;

/** The demo: the last three weeks and this week built from forecast, traded up to `minute` today. */
export function seedDemo(today = toISODate(new Date()), minute = DEMO_MINUTE): RotaState {
  let state = seedState(today);
  const thisWeek = weekStart(today);
  const lastWeek = addDays(thisWeek, -7);
  // Four weeks of history so trends (hours, early finishes, the 17 week average) have something to read.
  for (const week of [addDays(thisWeek, -21), addDays(thisWeek, -14), lastWeek, thisWeek]) {
    // Last week a GM hand-rostered the student to the full 20 hours, past the buffer warning.
    const handBuilt = week === lastWeek ? studentToTheLimit(week) : [];
    state = { ...state, shifts: [...state.shifts, ...managerRota(week), ...handBuilt] };
    for (const site of state.sites) {
      state = { ...state, shifts: autoSchedule(state, site.id, week).shifts.map((s) => ({ ...s, published: true })) };
    }
  }
  const traded = simulateTrading(state, { date: today, minute });
  // Last week the GM took most of a regular's shifts away: one person's hours collapse. Applied after
  // trading so the rest of the demo week plays out exactly as before.
  const cut = new Set(
    traded.shifts.filter((s) => s.employeeId === 'mar-17' && s.date >= lastWeek && s.date < thisWeek).slice(1).map((s) => s.id),
  );
  return {
    ...traded,
    shifts: traded.shifts.filter((s) => !cut.has(s.id)),
    clocks: traded.clocks.filter((c) => !c.shiftId || !cut.has(c.shiftId)),
  };
}
