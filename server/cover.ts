// Shifts going on the server: putting an open shift out, asking it round by round, taking a yes and
// filling it. Every yes is checked again at the moment it is given, against the rota as it is then,
// with the same rule a claim is checked against: someone may have picked up another shift, booked
// leave or been given it by a manager in the meantime.

import { breakFor, complianceOptions } from '../src/engine/compliance';
import { currentRound, goingStatus, mayTake, nextRoundOffers, offerText, roomForRounds, roundDue, shiftLabel, slotOf, waiting, wasAsked } from '../src/engine/cover';
import { withinBudget } from '../src/engine/offers';
import { claimCheck, decisionText, namesOf, shiftLine } from '../src/engine/requests';
import type { Employee, OpenShift, Shift, StaffRequest } from '../src/engine/types';
import { randomUUID } from 'node:crypto';
import { HttpError, londonParts, type AppContext } from './context';
import { assertRotaOpen } from './payPeriods';
import { managerLink, notifyTeam, outboundFor } from './messaging';
import { notify, syncTold } from './notify';
import { addRequest, openShiftsOf, requestsOf } from './routes/requests';
import { audit, type OrgData } from './store';

export const labelOf = (org: OrgData, o: Pick<OpenShift, 'siteId' | 'roleId' | 'date' | 'startMinute' | 'endMinute'>) => {
  const names = namesOf(org.state);
  return shiftLabel(o, names.role(o.roleId), names.site(o.siteId));
};
const openClaim = (r: StaffRequest) => r.status === 'pending' || r.status === 'accepted';

/** Tells someone, through quiet hours when the shift was put out as urgent. */
function tell(org: OrgData, o: OpenShift, employeeId: string, kind: Parameters<typeof notify>[2], title: string, body: string, now: Date) {
  const note = notify(org, employeeId, kind, title, body, now);
  if (o.urgent) note.urgent = true;
  return note;
}

/** The shift an approved claim becomes: the posted times, with at least the break this person is owed. */
export function claimedShift(org: OrgData, o: OpenShift, e: Employee): Shift {
  const owed = breakFor(e, o.date, o.endMinute - o.startMinute, complianceOptions(org.state, e).nation);
  return { id: `s_${randomUUID()}`, employeeId: e.id, siteId: o.siteId, roleId: o.roleId, date: o.date, startMinute: o.startMinute, endMinute: o.endMinute, breakMinutes: Math.max(o.breakMinutes, owed), published: true };
}

/** Why the shift could not go to this person because its pay period is locked for payroll, if it is. */
function lockedFor(org: OrgData, o: OpenShift, e: Employee): string | null {
  const held = o.heldBy ? org.state.shifts.find((x) => x.id === o.heldBy!.shiftId) : undefined;
  try {
    assertRotaOpen(org, [...(held ? [held] : []), { id: 'claim', employeeId: e.id, date: o.date }]);
    return null;
  } catch (err) {
    if (err instanceof HttpError) return err.message;
    throw err;
  }
}

/**
 * Whether a claim can be approved without a manager: the site has it turned on, the claim breaks no
 * rule and raises nothing to review, and the site's labour for the week stays within its target.
 */
function autoApproval(org: OrgData, o: OpenShift, e: Employee): boolean {
  if (!(org.settings.openShiftAutoApprove ?? []).includes(o.siteId)) return false;
  const check = claimCheck(org.state, e, slotOf(o));
  if (check.problem || check.issues.length) return false;
  return withinBudget(org.state, claimedShift(org, o, e)).ok;
}

/**
 * Whether a shift put out while its holder kept it is still as it was. A manager moving it, or giving
 * it to someone, means it is no longer the shift on offer: the open shift is withdrawn.
 */
export function heldProblem(org: OrgData, o: OpenShift, by: string, now: Date): string | null {
  if (!o.heldBy) return null;
  const s = org.state.shifts.find((x) => x.id === o.heldBy!.shiftId);
  const same = s && s.employeeId === o.heldBy.employeeId && s.siteId === o.siteId && s.roleId === o.roleId && s.date === o.date && s.startMinute === o.startMinute && s.endMinute === o.endMinute;
  if (same && !org.timeEntries.some((t) => t.shiftId === s.id)) return null;
  withdraw(org, o, by, now, 'The shift was changed after it was put out.');
  return 'The shift was changed by a manager, so it is no longer on offer.';
}

/**
 * Fills the open shift with this person, once everything is checked. A shift its holder kept moves
 * to them, keeping whether it was published; otherwise a new published shift is made. Everyone
 * else who asked for it, or was asked and has not answered, hears it has gone.
 */
export function fillOpenShift(org: OrgData, o: OpenShift, e: Employee, by: string, now: Date): Shift {
  const names = namesOf(org.state);
  let shift: Shift;
  if (o.heldBy) {
    const held = org.state.shifts.find((x) => x.id === o.heldBy!.shiftId)!;
    const owed = breakFor(e, o.date, o.endMinute - o.startMinute, complianceOptions(org.state, e).nation);
    shift = { ...held, employeeId: e.id, breakMinutes: Math.max(held.breakMinutes, owed) };
    assertRotaOpen(org, [held, shift]);
    org.state.shifts = org.state.shifts.map((x) => (x.id === held.id ? shift : x));
    audit(org, by, 'shift.updated', { id: shift.id });
    if (held.published) tell(org, o, o.heldBy.employeeId, 'shift_cancelled', 'Your shift is covered', `${shiftLine(o, names)} is covered by ${e.name}. You are off it.`, now);
    syncTold(org, [e.id, o.heldBy.employeeId], [shift]);
  } else {
    shift = claimedShift(org, o, e);
    assertRotaOpen(org, [shift]);
    org.state.shifts.push(shift);
    audit(org, by, 'shift.created', { id: shift.id });
    syncTold(org, [e.id], [shift]);
  }
  Object.assign(o, { status: 'filled', filledBy: e.id, filledAt: now.toISOString(), shiftId: shift.id, nextRoundAt: undefined });
  for (const other of requestsOf(org).filter((x) => x.openShiftId === o.id && x.employeeId !== e.id && openClaim(x))) {
    Object.assign(other, { status: 'cancelled', decidedBy: by, decidedAt: now.toISOString(), decisionNote: 'Filled by someone else.' });
    notify(org, other.employeeId, 'request_decided', 'Open shift filled', `${shiftLine(o, names)} has gone to someone else. Thanks for offering.`, now);
  }
  // Those asked who have not answered hear it has gone, so nobody keeps an evening free for nothing.
  // Nobody whose round never came is told anything.
  const claimed = new Set(requestsOf(org).filter((x) => x.openShiftId === o.id).map((x) => x.employeeId));
  for (const offer of o.offers ?? []) {
    if (offer.employeeId === e.id || !offer.offeredAt || offer.declinedAt || claimed.has(offer.employeeId)) continue;
    notify(org, offer.employeeId, 'request_decided', 'Shift taken', `${shiftLine(o, names)} has been taken. Thank you for looking.`, now);
  }
  audit(org, by, 'open_shift.filled', { id: o.id, employeeId: e.id, shiftId: shift.id });
  return shift;
}

/** Withdraws it: anyone who asked for it, or was asked and has not answered, is told. A held shift stays with its holder. */
export function withdraw(org: OrgData, o: OpenShift, by: string, now: Date, why = 'The shift was withdrawn.') {
  const names = namesOf(org.state);
  o.status = 'withdrawn';
  o.nextRoundAt = undefined;
  const told = new Set<string>();
  for (const r of requestsOf(org).filter((x) => x.openShiftId === o.id && openClaim(x))) {
    Object.assign(r, { status: 'cancelled', decidedBy: by, decidedAt: now.toISOString(), decisionNote: why });
    notify(org, r.employeeId, 'request_decided', 'Open shift withdrawn', `${shiftLine(o, names)} is no longer needed.`, now);
    told.add(r.employeeId);
  }
  for (const offer of o.offers ?? []) {
    if (!offer.offeredAt || offer.declinedAt || told.has(offer.employeeId)) continue;
    notify(org, offer.employeeId, 'request_decided', 'Shift no longer needed', `${shiftLine(o, names)} is no longer needed.`, now);
  }
  audit(org, by, 'open_shift.withdrawn', { id: o.id });
}

/** What came of someone's yes. */
export type Taken =
  | { kind: 'filled'; open: OpenShift; employee: Employee; shift: Shift; request?: StaffRequest }
  | { kind: 'claimed'; open: OpenShift; employee: Employee; request: StaffRequest }
  | { kind: 'refused'; open: OpenShift; employee: Employee; reason: string };

/**
 * A yes from the staff app or a WhatsApp reply. For a shift the first yes gets, it is filled at
 * once if still legal; otherwise it becomes a claim for a manager to approve.
 */
export function takeOpenShift(org: OrgData, o: OpenShift, employee: Employee, via: 'app' | 'whatsapp', now: Date): Taken {
  const refuse = (reason: string): Taken => {
    const offer = o.offers?.find((x) => x.employeeId === employee.id);
    if (offer) offer.refused = reason;
    return { kind: 'refused', open: o, employee, reason };
  };
  const status = goingStatus(o, londonParts(now));
  if (status !== 'open') return { kind: 'refused', open: o, employee, reason: status === 'filled' ? 'Someone else has already taken it.' : status === 'expired' ? 'The shift has started.' : 'It is no longer needed.' };
  if (!wasAsked(o, employee.id)) return { kind: 'refused', open: o, employee, reason: 'This shift was not offered to you.' };
  if (requestsOf(org).some((r) => r.openShiftId === o.id && r.employeeId === employee.id && openClaim(r))) return { kind: 'refused', open: o, employee, reason: 'You have already asked for this shift.' };
  const held = heldProblem(org, o, 'Preshift', now);
  if (held) return { kind: 'refused', open: o, employee, reason: held };
  const problem = mayTake(org.state, employee.id, slotOf(o));
  if (problem) return refuse(problem);
  const locked = lockedFor(org, o, employee);
  if (locked) return refuse(locked);
  audit(org, `staff:${employee.id}`, 'open_shift.yes', { id: o.id, employeeId: employee.id, via });
  if (o.fill === 'first_yes') return { kind: 'filled', open: o, employee, shift: fillOpenShift(org, o, employee, `${employee.name} (took it)`, now) };
  const request = addRequest(org, { kind: 'open_shift', employeeId: employee.id, siteId: o.siteId, openShiftId: o.id }, londonParts(now).date);
  if (autoApproval(org, o, employee)) {
    const by = 'Preshift, automatically';
    const shift = fillOpenShift(org, o, employee, by, now);
    o.autoApproved = true;
    Object.assign(request, { status: 'approved', decidedBy: by, decidedAt: now.toISOString(), decisionNote: 'Inside the rules and the labour budget, so approved straight away.' });
    audit(org, by, 'request.approved', { id: request.id, kind: request.kind, employeeId: request.employeeId, automatic: true });
    return { kind: 'filled', open: o, employee, shift, request };
  }
  return { kind: 'claimed', open: o, employee, request };
}

/** Tells the person what came of their yes, and the site's team channel when it was filled. */
export async function afterYes(ctx: Pick<AppContext, 'store' | 'fetch' | 'now'>, org: OrgData, t: Taken) {
  const now = ctx.now();
  const label = labelOf(org, t.open);
  const first = t.employee.name.split(' ')[0];
  if (t.kind === 'refused') {
    notify(org, t.employee.id, 'request_decided', 'Shift not given', `Sorry ${first}, ${label} could not be given to you. ${t.reason}`, now);
    return;
  }
  if (t.kind === 'claimed') return;
  // Approved by the site's own rule: told as any decision on their request is.
  if (t.request) {
    const { title, body } = decisionText(t.request, namesOf(org.state), t.open);
    notify(org, t.employee.id, 'request_decided', title, body, now);
  } else notify(org, t.employee.id, 'request_decided', "It's yours", `${label}. It is on your rota now. Thank you.`, now);
  const out = await outboundFor(ctx, org);
  await notifyTeam(out, t.open.siteId, `Covered: ${t.employee.name} takes ${label}.`, managerLink(out, t.open.siteId));
}

/**
 * Asks the next round: the next people in line, or everyone left. Each is checked again first, and
 * someone who can no longer take it is passed over with the reason rather than asked. Sets when the
 * round after this one goes.
 */
export function askNextRound(org: OrgData, o: OpenShift, by: string, now: Date, everyone = false): number {
  const london = londonParts(now);
  if (goingStatus(o, london) !== 'open' || !o.offers) return 0;
  const closing = !!o.rounds && !roomForRounds(o, o.rounds, london);
  const queue = nextRoundOffers(o, everyone || closing);
  if (queue.length === 0) return 0;
  const names = namesOf(org.state);
  const { title, body } = offerText(o, names.role(o.roleId), names.site(o.siteId));
  let asked = 0;
  for (const offer of queue) {
    const problem = mayTake(org.state, offer.employeeId, slotOf(o));
    if (problem) {
      offer.skipped = problem;
      continue;
    }
    offer.offeredAt = now.toISOString();
    tell(org, o, offer.employeeId, 'open_shift', title, body, now);
    asked++;
  }
  const more = waiting(o).length > 0;
  o.nextRoundAt = more && o.rounds ? new Date(now.getTime() + o.rounds.everyMinutes * 60_000).toISOString() : undefined;
  audit(org, by, 'open_shift.round_asked', { id: o.id, round: currentRound(o), asked, passedOver: queue.length - asked });
  // Everyone in this round was passed over: go straight on, rather than leave a round asking nobody.
  if (asked === 0 && more) return askNextRound(org, o, by, now, everyone);
  return asked;
}

/** Asks every round that is due across the organisation. Run by the quarter-hourly schedule and after a no. */
export function askDueRounds(org: OrgData, now: Date): number {
  const london = londonParts(now);
  let asked = 0;
  for (const o of openShiftsOf(org)) {
    const claimed = new Set(requestsOf(org).filter((r) => r.openShiftId === o.id && openClaim(r)).map((r) => r.employeeId));
    const why = roundDue(o, now.toISOString(), london, claimed);
    if (why) asked += askNextRound(org, o, 'Preshift (next round)', now, why === 'closing');
  }
  return asked;
}

/**
 * The shifts going that this person could take now, soonest first: those they were asked, or for
 * an untargeted one, any they are eligible for. `claimed` marks those they have asked for already.
 */
export function shiftsGoingFor(org: OrgData, employee: Employee, now: Date) {
  const london = londonParts(now);
  const mine = new Set(requestsOf(org).filter((r) => r.employeeId === employee.id && openClaim(r) && r.openShiftId).map((r) => r.openShiftId));
  return openShiftsOf(org)
    .filter((o) => goingStatus(o, london) === 'open')
    .filter((o) => mine.has(o.id) || (wasAsked(o, employee.id) && o.heldBy?.employeeId !== employee.id && o.releasedFrom?.employeeId !== employee.id && !mayTake(org.state, employee.id, slotOf(o))))
    .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute)
    .map((o) => ({ open: o, claimed: mine.has(o.id) }));
}

