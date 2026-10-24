import { cutoffInstant, periodContaining, scheduleFor, schedulesOf, timeCards, type PayPeriod, type PaySchedule, type TimeCard } from '../src/engine/payPeriods';
import type { Employee, Entity, Shift } from '../src/engine/types';
import { HttpError, notFound } from './context';
import type { OrgData } from './store';

/** One pass of a period's hours to payroll. A later pass is a correction and supersedes it. */
export interface PayPeriodPass {
  at: string;
  by: string;
  version: number;
  /** After the cutoff: payroll may already have closed, so the bureau needs telling. */
  late: boolean;
  hours: number;
  /** Approved entries that went in it, to tell when time has changed since. */
  entries: number;
  /** The batch sent, absent when the period held no hours to send (salaried people only). */
  submissionId?: string;
  /** Why it was passed again. Required on a correction. */
  reason?: string;
}

/**
 * What has been done to one pay period of one company's payroll: rota locked, passes to payroll, and
 * every step with who and when. The dates are kept as they were worked out at the time, so a later
 * change to the calendar cannot rewrite a period already locked or paid.
 */
export interface PayPeriodRecord {
  id: string;
  entityId: string;
  scheduleId: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  cutoffAt: string;
  rotaLock?: { at: string; by: string };
  passes: PayPeriodPass[];
  history: { at: string; by: string; action: 'rota_locked' | 'rota_unlocked' | 'timecards_approved' | 'passed'; detail?: Record<string, unknown> }[];
}

export type PayPeriodStatus = 'open' | 'rota_locked' | 'ready' | 'passed' | 'changed';

export const periodId = (entityId: string, scheduleId: string, periodStart: string) => `${entityId}~${scheduleId}~${periodStart}`;

/** Everyone a company's payroll pays, leavers included: they may still have hours in the period. */
export function peopleOn(org: OrgData, entity: Entity, scheduleId: string): Employee[] {
  return org.state.employees.filter((e) => e.entityId === entity.id && scheduleFor(e, entity).id === scheduleId);
}

/** The company, payroll and period named in a path, refused unless the date is where a period starts. */
export function resolvePeriod(org: OrgData, entityId: string, scheduleId: string, periodStart: string) {
  const entity = org.state.entities.find((e) => e.id === entityId);
  if (!entity) throw notFound(`Entity ${entityId}`);
  const schedule = schedulesOf(entity).find((s) => s.id === scheduleId);
  if (!schedule) throw notFound(`Pay schedule ${scheduleId}`);
  const record = org.payPeriods?.find((r) => r.id === periodId(entityId, scheduleId, periodStart));
  // A period already acted on keeps its own dates, whatever the calendar says now.
  const period: PayPeriod = record
    ? { scheduleId, periodStart: record.periodStart, periodEnd: record.periodEnd, payDate: record.payDate, cutoffDate: record.cutoffAt.slice(0, 10), cutoffTime: schedule.cutoffTime }
    : periodContaining(schedule, periodStart);
  if (period.periodStart !== periodStart) {
    throw new HttpError(404, 'not_a_period', `${schedule.name} has no period starting ${periodStart}. The period that day falls in starts ${period.periodStart}.`);
  }
  return { entity, schedule, period, record };
}

/** The record for a period, made the first time anything is done to it. */
export function recordFor(org: OrgData, entity: Entity, schedule: PaySchedule, period: PayPeriod): PayPeriodRecord {
  org.payPeriods ??= [];
  const id = periodId(entity.id, schedule.id, period.periodStart);
  let record = org.payPeriods.find((r) => r.id === id);
  if (!record) {
    record = {
      id,
      entityId: entity.id,
      scheduleId: schedule.id,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      payDate: period.payDate,
      cutoffAt: cutoffInstant(period),
      passes: [],
      history: [],
    };
    org.payPeriods.push(record);
  }
  return record;
}

/** The locked pay period a person's day falls in, if their rota for it is locked. */
export function rotaLockOn(org: OrgData, employeeId: string, date: string): PayPeriodRecord | undefined {
  const locked = org.payPeriods?.filter((r) => r.rotaLock && date >= r.periodStart && date <= r.periodEnd);
  if (!locked?.length) return undefined;
  const employee = org.state.employees.find((e) => e.id === employeeId);
  if (!employee) return undefined;
  const entity = org.state.entities.find((e) => e.id === employee.entityId);
  const scheduleId = scheduleFor(employee, entity).id;
  return locked.find((r) => r.entityId === employee.entityId && r.scheduleId === scheduleId);
}

/**
 * Refuses any change to shifts in a locked pay period. The locked rota is what time cards are approved
 * against and what payroll is reconciled to, so it changes only by unlocking, with a reason, before
 * the hours are passed.
 */
export function assertRotaOpen(org: OrgData, shifts: Pick<Shift, 'id' | 'employeeId' | 'date'>[]) {
  if (!org.payPeriods?.some((r) => r.rotaLock)) return;
  const locked = shifts.filter((s) => rotaLockOn(org, s.employeeId, s.date));
  if (locked.length) {
    const r = rotaLockOn(org, locked[0].employeeId, locked[0].date)!;
    throw new HttpError(
      409,
      'rota_locked',
      `The rota for the pay period ${r.periodStart} to ${r.periodEnd} is locked for payroll. Whoever locked it can unlock it, with a reason, until the hours are passed.`,
      locked.map((s) => s.id),
    );
  }
}

/** Why this person cannot be offered a shift on this day: their rota for it is locked for payroll. */
export const LOCKED_FOR_PAYROLL = 'Their rota for that day is locked for payroll.';

/** Whether a shift sits in a locked period: used to keep such shifts as they are in bulk changes. */
export const isRotaLocked = (org: OrgData, s: Pick<Shift, 'employeeId' | 'date'>) => !!org.payPeriods?.some((r) => r.rotaLock) && !!rotaLockOn(org, s.employeeId, s.date);

/** Approved entries in a period that belong to it: none already passed in a period of another payroll. */
export function periodEntries(org: OrgData, people: Employee[], period: Pick<PayPeriod, 'periodStart' | 'periodEnd'>, id: string) {
  const ids = new Set(people.map((e) => e.id));
  return org.timeEntries.filter(
    (t) => ids.has(t.employeeId) && t.date >= period.periodStart && t.date <= period.periodEnd && (!t.passedIn || t.passedIn === id),
  );
}

export interface PayPeriodSummary {
  id: string;
  entityId: string;
  entityName: string;
  scheduleId: string;
  scheduleName: string;
  frequency: PaySchedule['frequency'];
  periodStart: string;
  periodEnd: string;
  payDate: string;
  cutoffAt: string;
  status: PayPeriodStatus;
  /** Past the cutoff and not yet passed. */
  overdue: boolean;
  /** The period's last day has been worked, so its hours can be passed. */
  ended: boolean;
  rotaLock?: PayPeriodRecord['rotaLock'];
  lastPass?: PayPeriodPass;
  people: number;
  cards: { total: number; approved: number; waiting: number; clockedIn: number; noTime: number };
  hours: { rostered: number; clocked: number; approved: number };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Where a period stands, from its record and the time cards as they are now. */
export function summarise(org: OrgData, entity: Entity, schedule: PaySchedule, period: PayPeriod, today: string, now: Date): PayPeriodSummary & { timeCards: TimeCard[] } {
  const id = periodId(entity.id, schedule.id, period.periodStart);
  const record = org.payPeriods?.find((r) => r.id === id);
  const people = peopleOn(org, entity, schedule.id);
  const entries = periodEntries(org, people, period, id);
  const cards = timeCards(people, org.state.shifts, entries, period, today);
  const count = (s: TimeCard['status']) => cards.filter((c) => c.status === s).length;
  const lastPass = record?.passes.at(-1);
  const approvedEntries = entries.filter((t) => t.status === 'approved').length;
  const unsettled = entries.some((t) => t.status === 'open' || t.status === 'submitted');
  const status: PayPeriodStatus = lastPass
    ? unsettled || approvedEntries !== lastPass.entries ? 'changed' : 'passed'
    : !record?.rotaLock ? 'open' : unsettled ? 'rota_locked' : 'ready';
  const cutoffAt = record?.cutoffAt ?? cutoffInstant(period);
  return {
    id,
    entityId: entity.id,
    entityName: entity.name,
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    frequency: schedule.frequency,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    payDate: period.payDate,
    cutoffAt,
    status,
    overdue: !lastPass && now.toISOString() > cutoffAt,
    ended: today > period.periodEnd,
    ...(record?.rotaLock ? { rotaLock: record.rotaLock } : {}),
    ...(lastPass ? { lastPass } : {}),
    people: people.filter((e) => e.status !== 'leaver').length,
    cards: { total: cards.length, approved: count('approved'), waiting: count('waiting'), clockedIn: count('clocked_in'), noTime: count('no_time') },
    hours: {
      rostered: round2(cards.reduce((s, c) => s + c.rosteredHours, 0)),
      clocked: round2(cards.reduce((s, c) => s + c.clockedHours, 0)),
      approved: round2(cards.reduce((s, c) => s + c.approvedHours, 0)),
    },
    timeCards: cards,
  };
}
