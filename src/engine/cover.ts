// Shifts going: a shift someone cannot work, or a gap nobody is on, put out to the people who could
// legally take it. One record, the open shift, whichever way it is put out. Pure logic, shared by
// the API and the screens.
//
// A manager chooses three things. Who hears: everyone eligible at once, or the cheapest first in
// rounds. How it is decided: staff ask and a manager approves, or the first legal yes gets it.
// And, for someone's shift, whether it is taken off them now or stays theirs until someone takes it.
//
// Eligible means one rule everywhere, the one a claim is checked against: trained for the role,
// set up for the site, employed that day, and nothing in the rota rules blocking it.

import { candidates, type Candidate } from './candidates';
import { blocking, claimCheck } from './requests';
import { formatMinute } from './time';
import type { OpenShift, RotaState, Shift } from './types';

/** One person a targeted shift is put to. */
export interface ShiftOffer {
  employeeId: string;
  /** What the shift would add to the group's labour for this person's week, when asked. */
  marginal: number;
  borrowed: boolean;
  /** Which round they are asked in, cheapest first. */
  round: number;
  /** When they were asked. Absent while their round has not come: they have not been told anything. */
  offeredAt?: string;
  /** Their round came but they could no longer take it under the rota rules, so they were not asked, and why. */
  skipped?: string;
  declinedAt?: string;
  /** They said yes but it could not be given to them, and why. */
  refused?: string;
}

export type GoingStatus = OpenShift['status'] | 'expired';

/** The note everyone told reads, as the API takes it. */
export const MAX_NOTE = 300;

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Sat 24 Oct: short enough for a text, unambiguous within the weeks a shift is put out. */
export const shortDate = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${DAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
};

/** The open shift as a shift with nobody on it, for the rota rules. */
export function slotOf(o: Pick<OpenShift, 'id' | 'siteId' | 'roleId' | 'date' | 'startMinute' | 'endMinute' | 'breakMinutes'>): Shift {
  return { id: `open:${o.id}`, employeeId: '', siteId: o.siteId, roleId: o.roleId, date: o.date, startMinute: o.startMinute, endMinute: o.endMinute, breakMinutes: o.breakMinutes };
}

/** An open shift still open once it has started has nobody to take it: it has expired. */
export function goingStatus(o: OpenShift, now: { date: string; minute: number }): GoingStatus {
  if (o.status !== 'open') return o.status;
  return o.date < now.date || (o.date === now.date && o.startMinute <= now.minute) ? 'expired' : 'open';
}

/** Whether the person may take it, and if not why: the one rule for asking, claiming and filling. */
export function mayTake(state: RotaState, employeeId: string, slot: Shift): string | null {
  const e = state.employees.find((x) => x.id === employeeId);
  if (!e) return 'No longer on the team.';
  const check = claimCheck(state, e, slot);
  if (check.problem) return check.problem;
  const blocks = blocking(check.issues);
  return blocks.length ? blocks.map((i) => i.message).join(' ') : null;
}

export interface GoingCandidate {
  candidate: Candidate;
  /** May be asked: the claim rule passes. */
  eligible: boolean;
  /** Why not, for the manager. */
  reason: string | null;
}

/**
 * Everyone who might take the slot, eligible first and cheapest first within that, with why anyone
 * is not. Cost is what the shift adds to the person's whole loaded week, from the shift picker.
 */
export function goingCandidates(state: RotaState, slot: Shift, exclude: string[] = []): GoingCandidate[] {
  return candidates(state, slot, slot.id)
    .filter((c) => !exclude.includes(c.employee.id) && c.employee.status !== 'leaver')
    .map((candidate) => {
      const reason = mayTake(state, candidate.employee.id, slot);
      return { candidate, eligible: !reason, reason };
    })
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.candidate.marginal - b.candidate.marginal || a.candidate.employee.name.localeCompare(b.candidate.employee.name));
}

export function shiftLabel(o: Pick<OpenShift, 'date' | 'startMinute' | 'endMinute'>, roleName: string, siteName: string): string {
  return `${shortDate(o.date)}, ${formatMinute(o.startMinute)} to ${formatMinute(o.endMinute)}, ${roleName} at ${siteName}`;
}

/** What each person asked is told, in the app and on their phone. */
export function offerText(o: OpenShift, roleName: string, siteName: string): { title: string; body: string } {
  return {
    title: o.fill === 'first_yes' ? 'Cover wanted' : 'An open shift you could take',
    body: [
      `${shiftLabel(o, roleName, siteName)}.`,
      ...(o.note ? [o.note] : []),
      o.fill === 'first_yes'
        ? 'The first to say yes gets it. Take it in the Preshift app, or reply YES on WhatsApp.'
        : 'Ask for it in the Preshift app, or reply YES on WhatsApp; your manager confirms.',
    ].join(' '),
  };
}

/** Replies taken as yes on WhatsApp. Anything else is an ordinary message to the manager. */
export const isYes = (text: string) => /^\s*(yes|y|yep|yeah|yes please|i can|i'll do it|ill do it)\s*[.!]*\s*$/i.test(text);

/** Whether the person was asked: everyone eligible for an untargeted shift, only those asked for a targeted one. */
export function wasAsked(o: OpenShift, employeeId: string): boolean {
  if (!o.offers) return true;
  const offer = o.offers.find((x) => x.employeeId === employeeId);
  return !!offer?.offeredAt && !offer.declinedAt;
}

// ---- Rounds ----

/** How often a round may go: the scheduled run checks every quarter hour, so nothing shorter. */
export const ROUND_MINUTES = [15, 30, 60, 120] as const;
export const MAX_ROUND_SIZE = 20;

/**
 * The sensible default: three at a time every half hour when there are more than three to ask and
 * at least six hours to go, else everyone at once. Short notice is not the time to save pennies.
 */
export function defaultRounds(eligible: number, minutesToStart: number): OpenShift['rounds'] {
  return eligible > 3 && minutesToStart >= 6 * 60 ? { size: 3, everyMinutes: 30 } : undefined;
}

/** Splits the people to ask, already cheapest first, into rounds. */
export const roundOf = (index: number, rounds: OpenShift['rounds']) => (rounds ? Math.floor(index / rounds.size) + 1 : 1);

/** Minutes from one London moment to another. */
export function minutesUntil(from: { date: string; minute: number }, to: { date: string; minute: number }): number {
  const days = (Date.parse(`${to.date}T00:00:00Z`) - Date.parse(`${from.date}T00:00:00Z`)) / 86_400_000;
  return days * 1440 + to.minute - from.minute;
}

const startOf = (o: OpenShift) => ({ date: o.date, minute: o.startMinute });
export const waiting = (o: OpenShift) => (o.offers ?? []).filter((x) => !x.offeredAt && !x.skipped);

/** The round asked most recently, or 0 before any. */
export const currentRound = (o: OpenShift) => Math.max(0, ...(o.offers ?? []).filter((x) => x.offeredAt).map((x) => x.round));

/**
 * Whether the next round should go now, and why: its time has come, everyone asked so far has said
 * no, or there is not time for another round before the shift, so everyone left goes now. `claimed`
 * is who has asked for it and is waiting for a manager: they have not said no.
 */
export function roundDue(o: OpenShift, nowIso: string, london: { date: string; minute: number }, claimed: Set<string> = new Set()): 'time' | 'all_declined' | 'closing' | null {
  if (goingStatus(o, london) !== 'open' || !o.rounds || waiting(o).length === 0) return null;
  if (minutesUntil(london, startOf(o)) <= o.rounds.everyMinutes) return 'closing';
  const asked = (o.offers ?? []).filter((x) => x.offeredAt);
  if (asked.length > 0 && asked.every((x) => (x.declinedAt || x.refused) && !claimed.has(x.employeeId))) return 'all_declined';
  return o.nextRoundAt && o.nextRoundAt <= nowIso ? 'time' : null;
}

/** Who the next round asks: the next round's people, or everyone left when it is closing or asked for. */
export function nextRoundOffers(o: OpenShift, everyone = false): ShiftOffer[] {
  const left = waiting(o);
  if (everyone || left.length === 0) return left;
  const next = Math.min(...left.map((x) => x.round));
  return left.filter((x) => x.round === next);
}

/** Whether there is time for a second round before the shift. */
export const roomForRounds = (o: Pick<OpenShift, 'date' | 'startMinute'>, rounds: NonNullable<OpenShift['rounds']>, now: { date: string; minute: number }) =>
  minutesUntil(now, { date: o.date, minute: o.startMinute }) > rounds.everyMinutes;
