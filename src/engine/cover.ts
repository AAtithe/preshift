// Cover requests: a shift someone cannot work, or a gap nobody is on, offered to the people who
// could legally work it, cheapest first. Pure logic, shared by the API and the screens.
//
// The difference from "anyone free Saturday?" in a WhatsApp group is who is asked. Only people
// trained for the role, free that day, inside their availability, clear of rest and hours limits,
// and set up to work at the site are offered it, so whoever says yes can be given it at once.

import { candidates, type Candidate, type Opening } from './candidates';
import { formatMinute } from './time';
import type { RotaState } from './types';

export type CoverStatus = 'open' | 'filled' | 'cancelled' | 'expired';

export interface CoverOffer {
  employeeId: string;
  /** What the shift would add to the group's labour for this person's week, when offered. */
  marginal: number;
  borrowed: boolean;
  /** Which round they are asked in, cheapest first. Absent on requests from before rounds: round 1. */
  round?: number;
  /** When they were asked. Absent while their round has not come: they have not been told anything. */
  offeredAt?: string;
  /** Their round came but they could no longer work it under the rota rules, so they were not asked, and why. */
  skipped?: string;
  response?: 'accepted' | 'declined';
  respondedAt?: string;
  /** Where they answered: the staff app or a WhatsApp reply. */
  via?: 'app' | 'whatsapp';
  /** Set when they said yes but it could no longer be given to them, and why. */
  refused?: string;
}

export interface CoverRequest {
  id: string;
  siteId: string;
  roleId: string;
  date: string;
  startMinute: number;
  endMinute: number;
  /** The shift being covered, when someone cannot work it. Absent for a gap. */
  shiftId?: string;
  /** Whoever held that shift. They are never asked, and are told when it is covered. */
  originalEmployeeId?: string;
  /** What the manager wants the team to know. Never why the original person is off. */
  note?: string;
  /** The first to accept gets it, re-checked at that moment. Otherwise the manager chooses among those who accepted. */
  firstToAccept: boolean;
  /** The filled shift goes out to the team at once: only when the requester may publish the site's rota. */
  publish: boolean;
  /** London time after which nobody can accept: the shift's start unless the manager closed it earlier. */
  closes: { date: string; minute: number };
  offers: CoverOffer[];
  /**
   * Asking in rounds: `size` people at a time, cheapest first, the next round every `everyMinutes`
   * until someone says yes. Absent: everyone is asked at once.
   */
  rounds?: { size: number; everyMinutes: number };
  /** When the next round goes, while there is one to come. */
  nextRoundAt?: string;
  /** Offers go through quiet hours, every round. */
  urgent?: boolean;
  status: 'open' | 'filled' | 'cancelled';
  createdAt: string;
  createdBy: string;
  filledBy?: string;
  filledAt?: string;
  /** The shift that now carries the cover. */
  filledShiftId?: string;
  closedBy?: string;
  closedAt?: string;
}

export const MAX_NOTE = 280;

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Sat 24 Oct: short enough for a text, unambiguous within the weeks a cover request spans. */
export const shortDate = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${DAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
};

export const openingOf = (r: Pick<CoverRequest, 'siteId' | 'roleId' | 'date' | 'startMinute' | 'endMinute'>): Opening => ({
  siteId: r.siteId,
  roleId: r.roleId,
  date: r.date,
  startMinute: r.startMinute,
  endMinute: r.endMinute,
});

/** The request's status at a London moment: an open request past its close has expired. */
export function coverStatus(r: CoverRequest, now: { date: string; minute: number }): CoverStatus {
  if (r.status !== 'open') return r.status;
  const past = now.date > r.closes.date || (now.date === r.closes.date && now.minute >= r.closes.minute);
  return past ? 'expired' : 'open';
}

/**
 * Everyone who could work the opening, ranked as the shift picker ranks them, with the shift being
 * covered taken out first so it does not clash with itself. Whoever held it is left out.
 */
export function coverCandidates(state: RotaState, opening: Opening, options: { shiftId?: string; exclude?: string } = {}): Candidate[] {
  const without = options.shiftId ? { ...state, shifts: state.shifts.filter((s) => s.id !== options.shiftId) } : state;
  return candidates(without, opening, options.shiftId ?? 'cover').filter((c) => c.employee.id !== options.exclude && c.employee.status !== 'leaver');
}

/** Who may be asked: trained for the role and nothing blocking. Warnings are shown to the manager, not hidden. */
export const askable = (c: Candidate) => c.trained && !c.blocker;

/** Why a candidate is not asked, for the manager. */
export const notAskedBecause = (c: Candidate) => c.blocker ?? (c.trained ? null : `Not trained for this role`);

export function shiftLabel(r: Pick<CoverRequest, 'date' | 'startMinute' | 'endMinute'>, roleName: string, siteName: string): string {
  return `${shortDate(r.date)}, ${formatMinute(r.startMinute)} to ${formatMinute(r.endMinute)}, ${roleName} at ${siteName}`;
}

/** The offer as each person receives it, in the app and on their phone. */
export function offerText(r: CoverRequest, roleName: string, siteName: string): string {
  return [
    `Cover wanted: ${shiftLabel(r, roleName, siteName)}.`,
    ...(r.note ? [r.note] : []),
    r.firstToAccept
      ? 'The first person to say yes gets it. Accept it in the Preshift app, or reply YES on WhatsApp.'
      : 'Your manager chooses from everyone who says yes. Accept it in the Preshift app, or reply YES on WhatsApp.',
  ].join('\n');
}

/** Replies taken as yes on WhatsApp. Anything else is an ordinary message to the manager. */
export const isYes = (text: string) => /^\s*(yes|y|yep|yeah|yes please|i can|i'll do it|ill do it)\s*[.!]*\s*$/i.test(text);

/** Open requests a person has been asked and not yet answered. Someone whose round has not come sees nothing. */
export function openOffersFor(requests: CoverRequest[], employeeId: string, now: { date: string; minute: number }) {
  return requests.filter((r) => coverStatus(r, now) === 'open' && r.offers.some((o) => o.employeeId === employeeId && o.offeredAt && !o.response));
}

// ---- Rounds ----

/** How often a round may go: the scheduled run checks every quarter hour, so nothing shorter. */
export const ROUND_MINUTES = [15, 30, 60, 120] as const;
export const MAX_ROUND_SIZE = 20;

/**
 * The sensible default: three at a time every half hour when there are more than three to ask and
 * at least six hours to go, else everyone at once. Short notice is not the time to save pennies.
 */
export function defaultRounds(askable: number, minutesToStart: number): CoverRequest['rounds'] {
  return askable > 3 && minutesToStart >= 6 * 60 ? { size: 3, everyMinutes: 30 } : undefined;
}

/** Splits the people to ask, already cheapest first, into rounds. */
export const roundOf = (index: number, rounds: CoverRequest['rounds']) => (rounds ? Math.floor(index / rounds.size) + 1 : 1);

/** Minutes from one London moment to another. */
export function minutesUntil(from: { date: string; minute: number }, to: { date: string; minute: number }): number {
  const days = (Date.parse(`${to.date}T00:00:00Z`) - Date.parse(`${from.date}T00:00:00Z`)) / 86_400_000;
  return days * 1440 + to.minute - from.minute;
}

export const waiting = (r: CoverRequest) => r.offers.filter((o) => !o.offeredAt && !o.skipped);
const roundNo = (o: CoverOffer) => o.round ?? 1;

/** The round asked most recently, or 0 before any. */
export const currentRound = (r: CoverRequest) => Math.max(0, ...r.offers.filter((o) => o.offeredAt).map(roundNo));

/**
 * Whether the next round should go now, and why: its time has come, everyone asked so far has said
 * no, or there is not time for another round before the request closes, so everyone left goes now.
 */
export function roundDue(r: CoverRequest, nowIso: string, london: { date: string; minute: number }): 'time' | 'all_declined' | 'closing' | null {
  if (coverStatus(r, london) !== 'open' || !r.rounds || waiting(r).length === 0) return null;
  if (minutesUntil(london, r.closes) <= r.rounds.everyMinutes) return 'closing';
  const asked = r.offers.filter((o) => o.offeredAt);
  if (asked.length > 0 && asked.every((o) => o.response === 'declined' || o.refused)) return 'all_declined';
  return r.nextRoundAt && r.nextRoundAt <= nowIso ? 'time' : null;
}

/** Who the next round asks: the next round's people, or everyone left when it is closing or asked for. */
export function nextRoundOffers(r: CoverRequest, everyone = false): CoverOffer[] {
  const left = waiting(r);
  if (everyone || left.length === 0) return left;
  const next = Math.min(...left.map(roundNo));
  return left.filter((o) => roundNo(o) === next);
}
