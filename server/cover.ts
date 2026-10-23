// Cover requests on the server: offering a shift, taking a yes, and telling everyone the outcome.
//
// A yes is re-checked at the moment it is given, against the rota as it is then, with the same
// compliance rules as the screens and the API. Someone may have picked up another shift, booked
// leave or been given the cover by a manager in the meantime; a yes that has become illegal is
// refused with the reason, and the next person can still say yes.

import { randomUUID } from 'node:crypto';
import {
  askable, coverCandidates, coverStatus, currentRound, minutesUntil, nextRoundOffers, offerText, openingOf, roundDue, shiftLabel, waiting,
  type CoverOffer, type CoverRequest,
} from '../src/engine/cover';
import { hasStarted } from '../src/engine/rotaWeek';
import type { Employee, Shift } from '../src/engine/types';
import { londonParts, type AppContext } from './context';
import { addMessage, deliverToStaff, directThread, inBatches, managerLink, notifyTeam, outboundFor, type Outbound } from './messaging';
import { siteName } from './routes/messages';
import { syncTold } from './notify';
import { audit, type OrgData } from './store';

export const coverOf = (org: OrgData) => (org.coverRequests ??= []);

const roleName = (org: OrgData, id: string) => org.state.roles.find((r) => r.id === id)?.name ?? id;
export const labelOf = (org: OrgData, r: Pick<CoverRequest, 'siteId' | 'roleId' | 'date' | 'startMinute' | 'endMinute'>) => shiftLabel(r, roleName(org, r.roleId), siteName(org, r.siteId));

/** The outcome of a yes. */
export type Taken =
  | { kind: 'filled'; request: CoverRequest; employee: Employee; shift: Shift }
  | { kind: 'waiting'; request: CoverRequest; employee: Employee }
  | { kind: 'refused'; request: CoverRequest; employee: Employee; reason: string };

/** Ends a request because the shift behind it changed, so nobody is given a shift that no longer exists. */
function voided(org: OrgData, r: CoverRequest, at: string, why: string) {
  r.status = 'cancelled';
  r.closedAt = at;
  r.closedBy = `Preshift: ${why}`;
  audit(org, 'Preshift', 'cover.cancelled', { id: r.id, reason: why });
}

/**
 * Gives the cover to the person, if it is still theirs to have: the request open, the shift as it
 * was, and the person still clear to work it. Changes the rota in place; the caller saves.
 */
export function giveCover(org: OrgData, r: CoverRequest, employee: Employee, by: string, now: Date): Taken {
  const at = now.toISOString();
  const london = londonParts(now);
  const refuse = (reason: string): Taken => ({ kind: 'refused', request: r, employee, reason });
  const status = coverStatus(r, london);
  if (status === 'filled') return refuse('Someone else has already taken it.');
  if (status !== 'open') return refuse(status === 'expired' ? 'It has closed.' : 'It has been called off.');
  if (hasStarted(r, london)) return refuse('The shift has started.');
  let original: Shift | undefined;
  if (r.shiftId) {
    original = org.state.shifts.find((s) => s.id === r.shiftId);
    const same = original && original.employeeId === r.originalEmployeeId && original.siteId === r.siteId && original.roleId === r.roleId &&
      original.date === r.date && original.startMinute === r.startMinute && original.endMinute === r.endMinute;
    if (!same) {
      voided(org, r, at, 'the shift was changed after cover was asked for');
      return refuse('The shift was changed by a manager, so it is no longer on offer.');
    }
    if (org.timeEntries.some((t) => t.shiftId === r.shiftId)) return refuse('Someone has already clocked in for this shift.');
  }
  const candidate = coverCandidates(org.state, openingOf(r), { shiftId: r.shiftId, exclude: r.originalEmployeeId }).find((c) => c.employee.id === employee.id);
  if (!candidate || !askable(candidate)) return refuse(candidate?.blocker ?? 'You can no longer work this shift under the rota rules.');
  const offer = r.offers.find((o) => o.employeeId === employee.id);
  let shift: Shift;
  if (original) {
    shift = { ...original, employeeId: employee.id, breakMinutes: candidate.shift.breakMinutes, published: r.publish };
    org.state.shifts = org.state.shifts.map((s) => (s.id === original!.id ? shift : s));
    audit(org, by, 'shift.updated', { id: shift.id });
  } else {
    shift = { ...candidate.shift, id: `s_${randomUUID()}`, published: r.publish };
    org.state.shifts.push(shift);
    audit(org, by, 'shift.created', { id: shift.id });
  }
  r.status = 'filled';
  r.filledBy = employee.id;
  r.filledAt = at;
  r.filledShiftId = shift.id;
  if (offer && !offer.response) {
    offer.response = 'accepted';
    offer.respondedAt = at;
  }
  audit(org, by, 'cover.filled', { id: r.id, employeeId: employee.id, shiftId: shift.id });
  return { kind: 'filled', request: r, employee, shift };
}

/**
 * A yes from the person offered. When the first yes wins it is given at once; otherwise it waits
 * for the manager to choose. Changes the organisation in place; the caller saves.
 */
export function acceptOffer(org: OrgData, r: CoverRequest, employee: Employee, via: 'app' | 'whatsapp', now: Date): Taken {
  const offer = r.offers.find((o) => o.employeeId === employee.id);
  if (!offer?.offeredAt) return { kind: 'refused', request: r, employee, reason: 'This was not offered to you.' };
  const status = coverStatus(r, londonParts(now));
  if (status !== 'open') return { kind: 'refused', request: r, employee, reason: status === 'filled' ? 'Someone else has already taken it.' : 'It is no longer on offer.' };
  offer.response = 'accepted';
  offer.respondedAt = now.toISOString();
  offer.via = via;
  delete offer.refused;
  if (!r.firstToAccept) {
    audit(org, `staff:${employee.id}`, 'cover.accepted', { id: r.id, employeeId: employee.id });
    return { kind: 'waiting', request: r, employee };
  }
  const taken = giveCover(org, r, employee, `${employee.name} (cover accepted)`, now);
  if (taken.kind === 'refused') offer.refused = taken.reason;
  return taken;
}

/** Sends the offer to each person given, in their own thread and by the channel they chose, and marks them asked. */
export async function sendOffers(ctx: Pick<AppContext, 'store' | 'fetch' | 'now'>, org: OrgData, r: CoverRequest, offers: CoverOffer[], by: string) {
  const out = await outboundFor(ctx, org);
  const text = offerText(r, roleName(org, r.roleId), siteName(org, r.siteId));
  const at = ctx.now().toISOString();
  await inBatches(offers, 10, async (o) => {
    const employee = org.state.employees.find((e) => e.id === o.employeeId);
    if (!employee) return;
    o.offeredAt = at;
    const thread = directThread(org, employee, by, at);
    const message = addMessage(org, thread, { at, from: { kind: 'system', name: 'Cover' }, body: text, via: 'app', urgent: r.urgent });
    message.deliveries = await deliverToStaff(out, employee, text, { urgent: r.urgent, subject: `Cover wanted: ${labelOf(org, r)}` });
  });
}

/**
 * Asks the next round: the next people in line, or everyone left. Each is checked again first:
 * the rota may have changed since the request was made, and someone who can no longer work it is
 * passed over with the reason rather than asked. Sets when the round after this one goes.
 */
export async function askNextRound(ctx: Pick<AppContext, 'store' | 'fetch' | 'now'>, org: OrgData, r: CoverRequest, by: string, everyone = false): Promise<number> {
  const now = ctx.now();
  const london = londonParts(now);
  if (coverStatus(r, london) !== 'open') return 0;
  const queue = nextRoundOffers(r, everyone || (!!r.rounds && minutesUntil(london, r.closes) <= r.rounds.everyMinutes));
  if (queue.length === 0) return 0;
  const still = new Map(coverCandidates(org.state, openingOf(r), { shiftId: r.shiftId, exclude: r.originalEmployeeId }).map((c) => [c.employee.id, c]));
  const ask: CoverOffer[] = [];
  for (const o of queue) {
    const c = still.get(o.employeeId);
    if (c && askable(c)) {
      o.marginal = Math.round(c.marginal * 100) / 100;
      ask.push(o);
    } else o.skipped = c?.blocker ?? 'No longer able to work it under the rota rules.';
  }
  if (ask.length) await sendOffers(ctx, org, r, ask, by);
  const more = waiting(r).length > 0;
  r.nextRoundAt = more && r.rounds ? new Date(now.getTime() + r.rounds.everyMinutes * 60_000).toISOString() : undefined;
  audit(org, by, 'cover.round_asked', { id: r.id, round: currentRound(r), asked: ask.length, passedOver: queue.length - ask.length });
  // Everyone in this round was passed over: go straight on to the next, rather than leave a round asking nobody.
  if (ask.length === 0 && more) return askNextRound(ctx, org, r, by, everyone);
  return ask.length;
}

/** Asks every round that is due across the organisation. Run by the quarter-hourly schedule and after a no. */
export async function askDueRounds(ctx: Pick<AppContext, 'store' | 'fetch' | 'now'>, org: OrgData): Promise<number> {
  const nowIso = ctx.now().toISOString();
  const london = londonParts(ctx.now());
  let asked = 0;
  for (const r of org.coverRequests ?? []) {
    const why = roundDue(r, nowIso, london);
    if (why) asked += await askNextRound(ctx, org, r, 'Preshift (next round)', why === 'closing');
  }
  return asked;
}

/** Tells one person something about a request, in their thread and on their phone. */
async function tell(out: Outbound, org: OrgData, employee: Employee, body: string, subject: string, outside = true) {
  const at = out.ctx.now().toISOString();
  const thread = directThread(org, employee, 'Cover', at);
  const message = addMessage(org, thread, { at, from: { kind: 'system', name: 'Cover' }, body, via: 'app' });
  if (outside) message.deliveries = await deliverToStaff(out, employee, body, { subject });
}

/**
 * After a yes: the person hears whether it is theirs, whoever held the shift hears they are off it,
 * those still deciding hear it has gone, and the site's managers hear in their team channel.
 */
export async function announceTaken(ctx: Pick<AppContext, 'store' | 'fetch' | 'now'>, org: OrgData, taken: Taken) {
  const out = await outboundFor(ctx, org);
  const r = taken.request;
  const label = labelOf(org, r);
  const first = taken.employee.name.split(' ')[0];
  if (taken.kind === 'refused') {
    await tell(out, org, taken.employee, `Sorry ${first}, the cover for ${label} could not be given to you. ${taken.reason}`, 'Cover not given');
    return;
  }
  if (taken.kind === 'waiting') {
    await tell(out, org, taken.employee, `Thanks ${first}. Your manager will confirm who covers ${label}.`, 'Cover', false);
    await notifyTeam(out, r.siteId, `${taken.employee.name} can cover ${label}. Choose who takes it in Preshift.`, managerLink(out, r.siteId));
    return;
  }
  await tell(
    out,
    org,
    taken.employee,
    r.publish
      ? `It's yours, ${first}: ${label}. It is on your rota now. Thank you.`
      : `It's yours, ${first}: ${label}. Your manager will publish it to your rota. Thank you.`,
    'Cover confirmed',
  );
  const original = org.state.employees.find((e) => e.id === r.originalEmployeeId);
  if (original) await tell(out, org, original, `${original.name.split(' ')[0]}, your shift ${label} is covered. You are off it.`, 'Your shift is covered');
  // Those who had not answered hear it has gone, so nobody sets aside an evening for nothing.
  // Only those asked: someone whose round never came was never told there was anything to take.
  for (const o of r.offers) {
    if (o.employeeId === taken.employee.id || !o.offeredAt) continue;
    const e = org.state.employees.find((x) => x.id === o.employeeId);
    if (e) await tell(out, org, e, `The cover for ${label} has been taken. Thank you for looking.`, 'Cover taken', !o.response);
  }
  // They have been told of this change, so the next publish does not tell them it again.
  if (r.publish) syncTold(org, [taken.employee.id, ...(r.originalEmployeeId ? [r.originalEmployeeId] : [])], [taken.shift]);
  await notifyTeam(out, r.siteId, `Cover found: ${taken.employee.name} takes ${label}.`, managerLink(out, r.siteId));
}

