import type { Employee, RotaState, Shift, TimeEntry } from './types';
import { clockedShifts, knownAge } from './actuals';
import type { Issue } from './compliance';
import { shiftPaidMinutes, shiftsInWeek } from './cost';
import { ERA_ASSUMPTIONS, guaranteedHoursOffers, type EraPolicy, type GuaranteedHoursOffer } from './era';
import { absoluteMinute, addDays, daysBetween, londonParts, weekStart } from './time';

// The Employment Rights Act 2025 measures for zero and low hours workers, as things a GM acts on:
// pay owed when a published shift is cancelled, cut or moved at short notice, and the guaranteed
// hours offer owed to people the rota leans on every week. The Act sets the rights and leaves the
// numbers to regulations not yet made, so every number here is a setting, and nothing is owed until
// the organisation sets the date each measure starts. Before then the same figures are shown as
// what it would cost, so the habits can change before the law does.

export interface EraSettings extends EraPolicy {
  /** A change to a published shift with less notice than this is short notice. */
  shortNoticeHours: number;
  /** Days a worker has to answer a guaranteed hours offer before it lapses. */
  responseDays: number;
  /** From this shift date, short notice pay is owed and goes to payroll. Unset: shown, not owed. */
  shortNoticeFrom?: string;
  /** From this date, guaranteed hours offers are owed. Unset: shown, not owed. */
  guaranteedHoursFrom?: string;
}

/** Assumptions to plan against until the regulations are made. */
export const DEFAULT_ERA_SETTINGS: EraSettings = { ...ERA_ASSUMPTIONS, shortNoticeHours: 48, responseDays: 28 };

const round2 = (n: number) => Math.round(n * 100) / 100;
const paidMinutes = (s: ShiftSnapshot) => Math.max(0, s.endMinute - s.startMinute - s.breakMinutes);

/** Zero and low hours workers: hourly, contracted for fewer hours than the threshold. */
export function qualifiesForEra(employee: Employee, settings: EraSettings = DEFAULT_ERA_SETTINGS): boolean {
  return employee.payBasis === 'hourly' && employee.contractedHours < settings.lowHoursThreshold;
}

/** What a worker was told: the parts of a shift that short notice is measured against. */
export type ShiftSnapshot = Pick<Shift, 'employeeId' | 'siteId' | 'roleId' | 'date' | 'startMinute' | 'endMinute' | 'breakMinutes'>;

export const snapshot = (s: ShiftSnapshot): ShiftSnapshot => ({
  employeeId: s.employeeId,
  siteId: s.siteId,
  roleId: s.roleId,
  date: s.date,
  startMinute: s.startMinute,
  endMinute: s.endMinute,
  breakMinutes: s.breakMinutes,
});

export type ShortNoticeChange = 'cancelled' | 'cut' | 'moved';

/** A published shift changed at short notice, kept against what the worker was first told. */
export interface ShortNoticeRecord {
  id: string;
  shiftId: string;
  employeeId: string;
  siteId: string;
  original: ShiftSnapshot;
  change: ShortNoticeChange;
  minutesLost: number;
  /** Hours between the change and the shift's start. */
  noticeHours: number;
  /** Pay owed to the worker. */
  amount: number;
  /** False before the measure starts: the figure is what it would have cost. */
  owed: boolean;
  status: 'open' | 'waived';
  waivedBy?: string;
  waiveReason?: string;
  /** The payroll submission it was paid in. */
  sentIn?: string;
  createdAt: string;
  updatedAt: string;
  by: string;
}

/** Hours from an instant to a shift's start, London time; negative once it has started. */
export function noticeHours(date: string, startMinute: number, now: Date): number {
  const here = londonParts(now);
  return (absoluteMinute(here.date, date, startMinute) - here.minute) / 60;
}

/**
 * Paid minutes of the original shift the worker no longer has. A cancelled shift, or one given to
 * someone else, loses all of it; a cut or moved shift loses the part the new times do not cover.
 * The break is taken as spread evenly, since when it falls is not recorded.
 */
export function lostMinutes(original: ShiftSnapshot, after: ShiftSnapshot | null): number {
  const paid = paidMinutes(original);
  if (!after || after.employeeId !== original.employeeId) return paid;
  const a0 = absoluteMinute(original.date, original.date, original.startMinute);
  const a1 = absoluteMinute(original.date, original.date, original.endMinute);
  const b0 = absoluteMinute(original.date, after.date, after.startMinute);
  const b1 = absoluteMinute(original.date, after.date, after.endMinute);
  const overlap = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const length = a1 - a0;
  const kept = length > 0 ? Math.min((overlap * paid) / length, paidMinutes(after)) : 0;
  return Math.max(0, Math.round(paid - kept));
}

export function changeKind(original: ShiftSnapshot, after: ShiftSnapshot | null): ShortNoticeChange {
  if (!after || after.employeeId !== original.employeeId) return 'cancelled';
  const within =
    absoluteMinute(original.date, after.date, after.startMinute) >= original.startMinute &&
    absoluteMinute(original.date, after.date, after.endMinute) <= original.endMinute;
  return within ? 'cut' : 'moved';
}

export interface ShortNoticeAssessment {
  change: ShortNoticeChange;
  minutesLost: number;
  noticeHours: number;
  amount: number;
  owed: boolean;
}

/**
 * Whether changing a shift from what the worker was told to `after` (null to cancel it) at `now` is
 * short notice, and what it owes. Nothing for people the measures do not cover, shifts already
 * started (those are timesheet matters), changes with enough notice, or changes that take nothing away.
 */
export function assessShortNotice(
  original: ShiftSnapshot,
  after: ShiftSnapshot | null,
  employee: Employee,
  now: Date,
  settings: EraSettings = DEFAULT_ERA_SETTINGS,
): ShortNoticeAssessment | null {
  if (!qualifiesForEra(employee, settings)) return null;
  const notice = noticeHours(original.date, original.startMinute, now);
  if (notice <= 0 || notice >= settings.shortNoticeHours) return null;
  const minutesLost = lostMinutes(original, after);
  if (minutesLost <= 0) return null;
  return {
    change: changeKind(original, after),
    minutesLost,
    noticeHours: round2(notice),
    amount: round2((minutesLost / 60) * employee.hourlyRate * settings.compensationShare),
    owed: !!settings.shortNoticeFrom && original.date >= settings.shortNoticeFrom,
  };
}

/** A guaranteed hours offer made to a worker, and their answer. */
export interface HoursOffer {
  id: string;
  employeeId: string;
  siteId: string;
  /** The weeks the offer was worked out on. */
  referenceFrom: string;
  referenceTo: string;
  averageHours: number;
  contractedBefore: number;
  offeredHours: number;
  status: 'offered' | 'accepted' | 'declined';
  offeredOn: string;
  respondBy: string;
  respondedOn?: string;
  by: string;
  respondedBy?: string;
}

/** An offer still waiting past its answer date has lapsed: the worker stays on their contract. */
export function offerStanding(offer: HoursOffer, today: string): HoursOffer['status'] | 'lapsed' {
  return offer.status === 'offered' && today > offer.respondBy ? 'lapsed' : offer.status;
}

export interface OfferCandidate extends GuaranteedHoursOffer {
  /** Suggested guaranteed hours: the average, to the nearest half hour. */
  suggestedHours: number;
  referenceFrom: string;
  referenceTo: string;
  /** The measure has started and a full reference period is in: an offer is owed now. */
  due: boolean;
  /** The latest offer to this person, if any. */
  lastOffer?: HoursOffer;
}

/**
 * People at a site who work more than their contract on average over the reference weeks. Someone
 * offered within the last reference period is left out until it comes round again, unless the
 * offer lapsed unanswered.
 */
export function offerCandidates(
  state: RotaState,
  entries: TimeEntry[],
  siteId: string,
  asOf: string,
  offers: HoursOffer[],
  settings: EraSettings = DEFAULT_ERA_SETTINGS,
): OfferCandidate[] {
  const started = !!settings.guaranteedHoursFrom && asOf >= settings.guaranteedHoursFrom;
  return guaranteedHoursOffers(state, entries, siteId, asOf, settings)
    .map((c) => {
      const mine = offers.filter((o) => o.employeeId === c.employeeId).sort((a, b) => a.offeredOn.localeCompare(b.offeredOn));
      const lastOffer = mine.at(-1);
      // The reference weeks are the closed weeks before this one.
      const referenceTo = addDays(weekStart(asOf), -1);
      return {
        ...c,
        suggestedHours: Math.round(c.averageHours * 2) / 2,
        referenceFrom: addDays(referenceTo, -7 * settings.referenceWeeks + 1),
        referenceTo,
        due: started && c.weeksUsed >= settings.referenceWeeks,
        lastOffer,
      };
    })
    .filter((c) => {
      const recent = c.lastOffer && daysBetween(c.lastOffer.offeredOn, asOf) < settings.referenceWeeks * 7;
      return !recent || offerStanding(c.lastOffer!, asOf) === 'lapsed';
    });
}

/** A plain English offer letter for the manager to check, sign and give. */
export function offerLetter(employee: Employee, offer: Pick<HoursOffer, 'offeredHours' | 'contractedBefore' | 'referenceFrom' | 'referenceTo' | 'averageHours' | 'respondBy'>, company: string): string {
  const first = employee.name.split(' ')[0];
  const contract = offer.contractedBefore > 0 ? `${offer.contractedBefore} hours a week` : 'no guaranteed hours';
  return [
    `Dear ${first},`,
    '',
    `Over the weeks from ${offer.referenceFrom} to ${offer.referenceTo} you worked an average of ${offer.averageHours} hours a week. Your contract currently guarantees ${contract}.`,
    '',
    `Under the Employment Rights Act 2025, ${company} is offering you a contract guaranteeing ${offer.offeredHours} hours a week, reflecting the hours you have regularly worked. Your hourly rate and other terms stay the same.`,
    '',
    `You do not have to accept. If you would like to stay on your current contract, you can say no and nothing else changes. Please let us know by ${offer.respondBy}. If we have not heard from you by then, you will stay on your current contract.`,
    '',
    'If you have any questions, please speak to your manager.',
    '',
    'Yours sincerely,',
    '',
    company,
  ].join('\n');
}

const ROLLING_WEEKS = 17;
const MIN_HISTORY_WEEKS = 3;

/**
 * The 48 hour limit as a rolling 17 week average, checked on the week being rostered: the person's
 * clocked hours over the previous 16 weeks (any site) plus this week's rota. Warned, not blocked,
 * since one long week is legal; it says how many hours this week keeps the average at 48. Too little
 * history (under three weeks) says nothing. Adults who have not opted out only: under 18s have a hard
 * weekly cap of their own.
 */
export function rollingAverageIssues(state: RotaState, entries: TimeEntry[], weekStartDate: string, siteId?: string): Issue[] {
  const clocked = clockedShifts(entries);
  const priorWeeks = Array.from({ length: ROLLING_WEEKS - 1 }, (_, i) => addDays(weekStartDate, -7 * (i + 1)));
  const issues: Issue[] = [];
  for (const employee of state.employees) {
    if (employee.optedOutOf48 || (knownAge(employee, weekStartDate) ?? 18) < 18) continue;
    const rota = shiftsInWeek(state.shifts, weekStartDate).filter((s) => s.employeeId === employee.id);
    if (rota.length === 0 || (siteId && !rota.some((s) => s.siteId === siteId))) continue;
    const mine = clocked.filter((s) => s.employeeId === employee.id);
    const weekly = priorWeeks.map((w) => shiftsInWeek(mine, w).reduce((h, s) => h + shiftPaidMinutes(s), 0) / 60);
    // Weeks before their first clocked week do not count: a new starter's average is over the weeks they have.
    const firstWorked = weekly.map((h, i) => (h > 0 ? i : -1)).filter((i) => i >= 0).pop();
    if (firstWorked === undefined || firstWorked + 1 < MIN_HISTORY_WEEKS) continue;
    const history = weekly.slice(0, firstWorked + 1);
    const before = history.reduce((a, b) => a + b, 0);
    const rostered = rota.reduce((h, s) => h + shiftPaidMinutes(s), 0) / 60;
    const weeks = history.length + 1;
    const average = (before + rostered) / weeks;
    if (average <= 48 + 1e-9) continue;
    const allowed = Math.max(0, 48 * weeks - before);
    issues.push({
      code: 'wtr-average',
      severity: 'warn',
      employeeId: employee.id,
      message: `${round2(rostered)}h this week takes the 17 week average to ${round2(average)}h, over 48 without an opt-out. ${round2(allowed)}h this week keeps it at 48.`,
    });
  }
  return issues;
}
