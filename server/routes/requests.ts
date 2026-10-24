import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Issue } from '../../src/engine/compliance';
import { holidayBalance, workedShifts } from '../../src/engine/holiday';
import { ABSENCE_LABEL } from '../../src/engine/hr';
import {
  newestFirst,
  blocking, claimCheck, datesBetween, dayLabel, decisionText, eligibleFor, holidayHours, MAX_REQUEST_DAYS, namesOf,
  REQUESTABLE_ABSENCE, shiftLine, swapCheck, swapped,
} from '../../src/engine/requests';
import { offerCost, OFFER_TIER_LABEL, OFFER_WAVE_MINUTES, offerWaves, rankOffer, tierOf, tooCloseForWaves } from '../../src/engine/offers';
import { shiftEffect } from '../../src/engine/rotaViews';
import { hasStarted } from '../../src/engine/rotaWeek';
import { absoluteMinute, addDays, londonParts, weekStart } from '../../src/engine/time';
import { weeksSeen } from '../../src/engine/rotaSeen';
import { clockedFor } from '../../src/engine/reminders';
import { adoption, adoptionTotal, TARGETS } from '../../src/engine/adoption';
import { entriesAsShifts } from '../../src/engine/timesheet';
import type { Absence, AbsenceType, Availability, Employee, OpenShift, Shift, StaffRequest } from '../../src/engine/types';
import { hasScope, requireScope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard, type Guard } from '../guard';
import { managerDigests } from '../digest';
import { deliverNotifications, notify, syncTold } from '../notify';
import { carryNotifications } from '../messaging';
import { askDueRounds, askNextRound, afterYes, fillOpenShift, heldProblem, labelOf, shiftsGoingFor, takeOpenShift, withdraw } from '../cover';
import {
  currentRound, defaultRounds, goingCandidates, goingStatus, wasAsked, MAX_ROUND_SIZE, minutesUntil, offerText, roomForRounds, ROUND_MINUTES, roundOf, slotOf, waiting,
} from '../../src/engine/cover';
import { idParam } from '../schemas';
import { assertRotaOpen } from '../payPeriods';
import { audit, type OrgData } from '../store';
import { readsHr } from './hr';

/** Requests decided in the last this many days still show, so a manager can see what they did. */
const DECIDED_SHOWN_DAYS = 30;
/** Decided requests are kept this long; the audit log keeps that each was made and decided. */
const DECIDED_KEPT_DAYS = 400;

const open = (r: StaffRequest) => r.status === 'pending' || r.status === 'accepted';
const newId = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;

export const requestsOf = (org: OrgData) => (org.requests ??= []);
export const openShiftsOf = (org: OrgData) => (org.openShifts ??= []);

function employeeOf(org: OrgData, id: string): Employee {
  const e = org.state.employees.find((x) => x.id === id);
  if (!e) throw notFound(`Employee ${id}`);
  return e;
}

/** Adds a request, dropping decided ones past keeping. Open ones are kept however old. */
export function addRequest(org: OrgData, r: Omit<StaffRequest, 'id' | 'createdAt' | 'status'>, today: string, status: StaffRequest['status'] = 'pending') {
  const request: StaffRequest = { ...r, id: newId('req'), status, createdAt: new Date().toISOString() };
  const cutoff = addDays(today, -DECIDED_KEPT_DAYS);
  org.requests = [...requestsOf(org).filter((x) => open(x) || (x.decidedAt ?? x.createdAt).slice(0, 10) >= cutoff), request];
  const e = org.state.employees.find((x) => x.id === r.employeeId);
  audit(org, `staff:${e?.id ?? r.employeeId}`, 'request.created', { id: request.id, kind: request.kind, employeeId: request.employeeId });
  return request;
}

/** A published shift that has not started and has not been clocked: the only kind people may trade. */
export function tradeable(org: OrgData, shift: Shift | undefined, now = londonParts(new Date())): shift is Shift {
  return Boolean(shift && shift.published && !hasStarted(shift, now) && !org.timeEntries.some((t) => t.shiftId === shift.id));
}

/** Holiday left for one person, from approved clocked time where there is some and the rota otherwise. */
export function balanceOf(org: OrgData, e: Employee, today: string) {
  const worked = workedShifts(
    org.state.shifts.filter((s) => s.date <= today),
    entriesAsShifts(org.timeEntries.filter((t) => t.status === 'approved' && t.employeeId === e.id)),
  );
  const yearStart = org.state.entities.find((x) => x.id === e.entityId)?.leaveYearStart ?? '01-01';
  return holidayBalance(e, worked, today, yearStart, undefined, org.state.sites);
}

/** The permission that decides each kind, and the API scope a key needs for it. */
export function authority(kind: StaffRequest['kind']) {
  if (kind === 'swap' || kind === 'open_shift') return { permission: 'rota.publish', scope: 'rota:write' } as const;
  if (kind === 'time_off' || kind === 'sickness') return { permission: 'hr.manage', scope: 'hr:write' } as const;
  return { permission: 'team.manage', scope: 'rota:write' } as const;
}

/** The sites whose say a request needs: both ends of an exchange. */
function decidingSites(org: OrgData, r: StaffRequest): string[] {
  const back = r.returnShiftId ? org.state.shifts.find((s) => s.id === r.returnShiftId) : undefined;
  return [...new Set([r.siteId, ...(back ? [back.siteId] : [])])];
}

const issueView = (org: OrgData) => (i: Issue) => ({
  severity: i.severity,
  code: i.code,
  message: i.message,
  employee: org.state.employees.find((e) => e.id === i.employeeId)?.name ?? i.employeeId,
});


/**
 * Tells the next wave of an open shift, or everyone left when `all` is set or it is the last wave.
 * A wave nobody in it can still take is passed over for the next. Returns how many were told.
 */
export function releaseWave(org: OrgData, o: OpenShift, now: Date, all = false): number {
  const offer = o.offer;
  if (!offer || o.status !== 'open') return 0;
  const names = namesOf(org.state);
  const { title, body } = offerText(o, names.role(o.roleId), names.site(o.siteId));
  const exclude = [o.releasedFrom?.employeeId, o.heldBy?.employeeId].filter((x): x is string => !!x);
  const eligible = new Set(eligibleFor(org.state, slotOf(o), exclude).map((e) => e.id));
  let told = 0;
  while (offer.released < offer.waves.length) {
    const last = all || offer.released === offer.waves.length - 1;
    // The last wave is everyone eligible now, including anyone who has become eligible since it was posted.
    const targets = last ? [...eligible] : offer.waves[offer.released].employeeIds.filter((id) => eligible.has(id));
    const fresh = targets.filter((id) => !offer.told.includes(id));
    offer.released = last ? offer.waves.length : offer.released + 1;
    offer.told = [...offer.told, ...fresh];
    for (const id of fresh) {
      const note = notify(org, id, 'open_shift', title, body, now);
      if (o.urgent) note.urgent = true;
    }
    told += fresh.length;
    if (fresh.length) break;
  }
  if (offer.released < offer.waves.length) offer.nextAt = new Date(now.getTime() + OFFER_WAVE_MINUTES * 60_000).toISOString();
  else delete offer.nextAt;
  return told;
}

/**
 * The scheduled step: each open shift whose wave has had its time goes to the next, unless a claim
 * is waiting for the manager. Inside a day of the start, everyone left is told whatever is waiting.
 */
export function releaseDueWaves(org: OrgData, now: Date): number {
  const at = londonParts(now);
  let told = 0;
  for (const o of org.openShifts ?? []) {
    if (goingStatus(o, at) !== 'open' || !o.offer || o.offer.released >= o.offer.waves.length) continue;
    const close = tooCloseForWaves(o, at);
    const waiting = requestsOf(org).some((r) => r.openShiftId === o.id && open(r));
    if (close || (!waiting && o.offer.nextAt && o.offer.nextAt <= now.toISOString())) told += releaseWave(org, o, now, close);
  }
  return told;
}


/** What the request would do now, checked again: anything that has changed since it was made shows here. */
function currentCheck(org: OrgData, r: StaffRequest): { problem: string | null; issues: Issue[] } {
  if (r.kind === 'swap') {
    if (!r.takerId) return { problem: null, issues: [] };
    return swapCheck(org.state, r, r.takerId);
  }
  if (r.kind === 'open_shift') {
    const o = openShiftsOf(org).find((x) => x.id === r.openShiftId);
    if (!o || o.status !== 'open') return { problem: 'This open shift has been filled or withdrawn.', issues: [] };
    return claimCheck(org.state, employeeOf(org, r.employeeId), slotOf(o));
  }
  return { problem: null, issues: [] };
}

function offerView(g: Guard, org: OrgData, o: OpenShift, e: Employee) {
  const tier = tierOf(o, e.id);
  const cost = offerCost(org.state, slotOf(o), e);
  return {
    tier,
    tierLabel: tier ? OFFER_TIER_LABEL[tier] : null,
    shortHours: cost.shortHours,
    cost: g.can('costs.view', o.siteId) ? cost.marginal : null,
  };
}

/** One request as a manager sees it. Notes on sickness and time off go only to those who read the personnel file. */
function managerView(req: FastifyRequest, g: Guard, org: OrgData, r: StaffRequest, today: string) {
  const names = namesOf(org.state);
  const e = org.state.employees.find((x) => x.id === r.employeeId);
  const name = (id?: string) => (id ? org.state.employees.find((x) => x.id === id)?.name ?? id : undefined);
  const shift = r.shiftId ? org.state.shifts.find((s) => s.id === r.shiftId) : undefined;
  const back = r.returnShiftId ? org.state.shifts.find((s) => s.id === r.returnShiftId) : undefined;
  const os = r.openShiftId ? openShiftsOf(org).find((x) => x.id === r.openShiftId) : undefined;
  const healthy = r.kind !== 'sickness' && r.kind !== 'time_off';
  const dates = r.from ? datesBetween(r.from, r.to ?? addDays(r.from, 6)) : [];
  const mine = e ? org.state.shifts.filter((s) => s.employeeId === e.id && dates.includes(s.date)) : [];
  const check = open(r) ? currentCheck(org, r) : { problem: null, issues: [] };
  const { permission } = authority(r.kind);
  const balance = r.kind === 'holiday' && e ? balanceOf(org, e, today) : null;
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    createdAt: r.createdAt,
    employeeId: r.employeeId,
    employeeName: e?.name ?? r.employeeId,
    siteId: r.siteId,
    siteName: names.site(r.siteId),
    from: r.from ?? null,
    to: r.to ?? null,
    hours: r.hours ?? null,
    absenceType: r.absenceType ?? null,
    absenceLabel: r.absenceType ? ABSENCE_LABEL[r.absenceType] : null,
    note: healthy || (e && readsHr(req, g, e)) ? r.note ?? null : null,
    availability: r.availability ?? null,
    shift: shift ? { id: shift.id, line: shiftLine(shift, names) } : null,
    returnShift: back ? { id: back.id, line: shiftLine(back, names) } : null,
    openShift: os ? { id: os.id, line: shiftLine(os, names), status: os.status } : null,
    // For a claim: the tier they were offered it in, and what adding it costs, to those who see cost.
    offer: os && e && r.kind === 'open_shift' ? offerView(g, org, os, e) : null,
    toName: name(r.toEmployeeId) ?? null,
    takerName: name(r.takerId) ?? null,
    decidedBy: r.decidedBy ?? null,
    decidedAt: r.decidedAt ?? null,
    decisionNote: r.decisionNote ?? null,
    problem: check.problem,
    issues: check.issues.map(issueView(org)),
    // Holiday: what is left, and what is left after this.
    balance: balance ? { remainingHours: Math.round(balance.remainingHours * 100) / 100, afterHours: Math.round((balance.remainingHours - (r.hours ?? 0)) * 100) / 100, yearEnd: balance.year.end } : null,
    // Shifts the person already has on those days: approving leave or recording sickness leaves them to re-cover.
    clashes: mine.map((s) => ({ id: s.id, line: shiftLine(s, names), published: Boolean(s.published) })),
    // Who else at the site is off then, so a manager sees the floor before saying yes.
    othersOff: r.kind === 'holiday' || r.kind === 'time_off'
      ? org.state.employees
          .filter((x) => x.id !== r.employeeId && x.siteId === r.siteId && x.status !== 'leaver' && dates.some((d) => x.leave.includes(d)))
          .map((x) => x.name)
      : [],
    canDecide: open(r) && decidingSites(org, r).every((s) => g.can(permission, s)) && g.behind?.employeeId !== r.employeeId && !(r.kind === 'swap' && r.status === 'pending'),
  };
}

/** Whether the caller sees this request at all: they hold the deciding permission at its site. */
function sees(req: FastifyRequest, g: Guard, r: StaffRequest) {
  // That someone is off sick, or asked for compassionate or family leave, is health and family data:
  // only for those who read personnel files, so a rota key never learns of it.
  if ((r.kind === 'sickness' || r.kind === 'time_off') && !hasScope(req, 'hr:read')) return false;
  return g.can(authority(r.kind).permission, r.siteId);
}

function tell(org: OrgData, r: StaffRequest, now: Date) {
  const names = namesOf(org.state);
  const shift = r.shiftId ? org.state.shifts.find((s) => s.id === r.shiftId) : undefined;
  const os = r.openShiftId ? openShiftsOf(org).find((x) => x.id === r.openShiftId) : undefined;
  const { title, body } = decisionText(r, names, shift ?? os);
  notify(org, r.employeeId, 'request_decided', title, body, now);
  if (r.kind === 'swap' && r.takerId) notify(org, r.takerId, 'request_decided', title, body, now);
}

/**
 * Carries out an approved request. Everything is checked again first, since the rota, the person or
 * the law may have moved on since it was asked; a request that would now break a rule is refused.
 */
function apply(org: OrgData, r: StaffRequest, by: string, now: Date) {
  const e = employeeOf(org, r.employeeId);
  const check = currentCheck(org, r);
  if (check.problem) throw new HttpError(409, 'request_stale', check.problem);
  const blocks = blocking(check.issues);
  if (blocks.length) throw new HttpError(409, 'compliance_block', `This would break a rule: ${blocks.map((i) => i.message).join(' ')}`, blocks);
  switch (r.kind) {
    case 'holiday': {
      e.leave = [...new Set([...e.leave, ...datesBetween(r.from!, r.to!)])].sort();
      audit(org, by, 'employee.updated', { id: e.id, fields: ['leave'] });
      break;
    }
    case 'time_off': {
      const absence: Absence = { id: newId('abs'), type: r.absenceType!, from: r.from!, to: r.to, ...(r.note ? { reason: r.note } : {}) };
      e.absences = [...(e.absences ?? []), absence].sort((a, b) => a.from.localeCompare(b.from));
      audit(org, by, 'hr.absence.created', { id: e.id, absenceId: absence.id, type: absence.type, from: absence.from });
      break;
    }
    case 'availability': {
      e.availability = r.availability!;
      audit(org, by, 'employee.updated', { id: e.id, fields: ['availability'] });
      break;
    }
    case 'sickness':
      // Recorded when reported: approving is the manager saying they have seen it and arranged cover.
      break;
    case 'swap': {
      const touched = org.state.shifts.filter((s) => s.id === r.shiftId || s.id === r.returnShiftId);
      if (touched.some((s) => !tradeable(org, s, londonParts(now)))) throw new HttpError(409, 'request_stale', 'The shift has started or changed since the swap was agreed.');
      const next = swapped(org.state, r, r.takerId!);
      // A swap moves shifts between people, so neither side may sit in a pay period whose rota is locked.
      assertRotaOpen(org, [...touched, ...next.filter((s) => touched.some((t) => t.id === s.id))]);
      org.state.shifts = next;
      for (const s of touched) audit(org, by, 'shift.updated', { id: s.id });
      syncTold(org, [r.employeeId, r.takerId!], touched);
      break;
    }
    case 'open_shift': {
      const o = openShiftsOf(org).find((x) => x.id === r.openShiftId)!;
      const held = heldProblem(org, o, by, now);
      if (held) throw new HttpError(409, 'request_stale', held);
      fillOpenShift(org, o, e, by, now);
      break;
    }
  }
}

const decideBody = { type: ['object', 'null'], properties: { note: { type: 'string', maxLength: 500 } }, additionalProperties: false } as const;

/** Manager side: requests to decide, and open shifts to post. Inside the authenticated API. */
export function requestRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('rota:write') };
  const tags = ['Staff requests'];
  const today = () => londonParts(ctx.now()).date;

  app.get<{ Querystring: { siteId?: string; status?: 'open' | 'all' } }>(
    '/v1/requests',
    {
      ...read,
      schema: {
        tags,
        description:
          'Holiday, time off, sickness, availability, swaps and open shift claims from the staff app, for the sites where the caller decides them. ' +
          'Each carries what it would do now: compliance issues, clashing shifts, who else is off, and the holiday balance after it. ' +
          '`status=open` (the default) lists those waiting; `all` adds those decided in the last 30 days.',
        querystring: { type: 'object', properties: { siteId: { type: 'string' }, status: { type: 'string', enum: ['open', 'all'] } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const since = addDays(today(), -DECIDED_SHOWN_DAYS);
      return requestsOf(org)
        .filter((r) => (!req.query.siteId || r.siteId === req.query.siteId) && sees(req, g, r))
        .filter((r) => open(r) || (req.query.status === 'all' && (r.decidedAt ?? r.createdAt).slice(0, 10) >= since))
        .sort((a, b) => Number(open(b)) - Number(open(a)) || a.createdAt.localeCompare(b.createdAt))
        .map((r) => managerView(req, g, org, r, today()));
    },
  );

  for (const verdict of ['approve', 'decline'] as const) {
    app.post<{ Params: { id: string }; Body: { note?: string } | null }>(
      `/v1/requests/:id/${verdict}`,
      {
        ...read,
        schema: {
          tags,
          description:
            verdict === 'approve'
              ? 'Approves a request and carries it out: leave booked, absence recorded, availability changed, or the shift reassigned and published. ' +
                'Checked again first, and refused if it would now break a rule. A swap is approved once the colleague has agreed. The person is told.'
              : 'Declines a request, with a note the person will read.',
          params: idParam,
          body: decideBody,
        },
      },
      async (req) => {
        const org = orgOf(req);
        const g = guard(ctx, req, org);
        const r = requestsOf(org).find((x) => x.id === req.params.id);
        if (!r || !sees(req, g, r)) throw notFound(`Request ${req.params.id}`);
        const { permission, scope } = authority(r.kind);
        if (!hasScope(req, scope)) throw new HttpError(403, 'forbidden', `This key lacks the ${scope} scope`);
        for (const s of decidingSites(org, r)) g.allow(permission, s);
        if (g.behind?.employeeId === r.employeeId) throw new HttpError(403, 'forbidden', 'Somebody else decides your own requests.');
        if (!open(r)) throw new HttpError(409, 'already_decided', `This request was ${r.status} already.`);
        if (verdict === 'approve' && r.kind === 'swap' && r.status !== 'accepted') {
          throw new HttpError(409, 'not_agreed', 'Nobody has agreed to take this shift yet. It can be approved once a colleague accepts.');
        }
        const by = actorName(g);
        const now = ctx.now();
        const note = req.body?.note?.trim();
        if (verdict === 'approve') apply(org, r, by, now);
        Object.assign(r, { status: verdict === 'approve' ? 'approved' : 'declined', decidedBy: by, decidedAt: now.toISOString(), ...(note ? { decisionNote: note } : {}) });
        audit(org, by, `request.${verdict === 'approve' ? 'approved' : 'declined'}`, { id: r.id, kind: r.kind, employeeId: r.employeeId });
        tell(org, r, now);
        return managerView(req, g, org, r, today());
      },
    );
  }

  // The morning email: each signed-in manager sees what it would say today, and turns it on or off for themselves.
  app.get(
    '/v1/requests/digest',
    { ...read, schema: { tags, description: "The caller's morning email of staff requests: whether it is on, and what it would say today. Signed-in people only." } },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      if (!g.user) throw new HttpError(403, 'forbidden', 'The morning email goes to people, not API keys.');
      const mine = managerDigests({ ...org, settings: { ...org.settings, digestOff: [] } }, today()).find((d) => d.user.id === g.user!.id);
      return { on: !(org.settings.digestOff ?? []).includes(g.user.id), email: g.user.email, sections: mine?.sections ?? [], count: mine?.count ?? 0 };
    },
  );

  app.put<{ Body: { on: boolean } }>(
    '/v1/requests/digest',
    { ...read, schema: { tags, description: 'Turns the morning email on or off for the caller.', body: { type: 'object', required: ['on'], properties: { on: { type: 'boolean' } }, additionalProperties: false } } },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      if (!g.user) throw new HttpError(403, 'forbidden', 'The morning email goes to people, not API keys.');
      const off = new Set(org.settings.digestOff ?? []);
      if (req.body.on) off.delete(g.user.id);
      else off.add(g.user.id);
      org.settings.digestOff = [...off];
      audit(org, actorName(g), 'requests.digest_set', { on: req.body.on });
      return { on: req.body.on };
    },
  );

  // People who have not clocked in for a shift that started more than ten minutes ago, at the sites
  // where the caller publishes the rota. Gone from the list once they clock in or the shift ends.
  app.get(
    '/v1/requests/late',
    { ...read, schema: { tags, description: 'Shifts running now that nobody has clocked in for, ten minutes or more after the start, so cover can be found for the rest.' } },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const now = londonParts(ctx.now());
      const names = namesOf(org.state);
      return Object.entries(org.shiftAlerts ?? {})
        .filter(([, a]) => a.late)
        .map(([id]) => org.state.shifts.find((s) => s.id === id))
        .filter((s): s is Shift => Boolean(s) && g.can('rota.publish', s!.siteId))
        .filter((s) => absoluteMinute(now.date, s.date, s.endMinute) > now.minute && !clockedFor(org.timeEntries, s))
        .map((s) => ({
          shiftId: s.id,
          employeeName: org.state.employees.find((e) => e.id === s.employeeId)?.name ?? s.employeeId,
          siteId: s.siteId,
          siteName: names.site(s.siteId),
          roleId: s.roleId,
          date: s.date,
          startMinute: s.startMinute,
          endMinute: s.endMinute,
          line: shiftLine(s, names),
          minutesLate: now.minute - absoluteMinute(now.date, s.date, s.startMinute),
        }));
    },
  );

  app.get<{ Querystring: { weeks?: number } }>(
    '/v1/insights/adoption',
    {
      ...read,
      schema: {
        tags,
        description:
          'Per site, over the last 4 weeks (or `weeks`, 1 to 13): how much of the team is on the staff app and has notifications on, ' +
          'how fast requests are decided and how many wait now, open shifts posted and filled, and no-shows at sites where people clock. ' +
          'For the sites where the caller publishes the rota or manages the team; names of who is not on the app only where they manage the team.',
        querystring: { type: 'object', properties: { weeks: { type: 'integer', minimum: 1, maximum: 13 } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const sites = org.state.sites.filter((s) => g.can('rota.publish', s.id) || g.can('team.manage', s.id)).map((s) => s.id);
      const logins = (await ctx.store.listStaffLogins(org.orgId)).map((l) => ({ employeeId: l.employeeId, active: Boolean(l.hash), pushDevices: l.push?.length ?? 0 }));
      const weeks = req.query.weeks ?? 4;
      const weeksSeenAll = weeksSeen(org.toldWeeks ?? {}, org.rotaSeen ?? {}, (w) => sites.includes(w.siteId));
      const rows = adoption(org.state, { logins, requests: requestsOf(org), openShifts: openShiftsOf(org), entries: org.timeEntries, weeks: weeksSeenAll }, sites, today(), ctx.now().toISOString(), weeks)
        .map((r) => (g.can('team.manage', r.siteId) ? r : { ...r, notOnApp: undefined, noNotifications: undefined }));
      return { weeks, from: addDays(today(), -7 * weeks), to: addDays(today(), -1), targets: TARGETS, sites: rows, total: adoptionTotal(rows) };
    },
  );

  // Who has confirmed their published week, this week and next, at the sites where the caller publishes the rota.
  app.get(
    '/v1/requests/rota-seen',
    { ...read, schema: { tags, description: 'This week and next, per site: who has pressed Seen it on their published week as it now stands, who has not, and who has no staff app to do so.' } },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const names = namesOf(org.state);
      const thisWeek = weekStart(today());
      const weeks = [thisWeek, addDays(thisWeek, 7)];
      const onApp = new Set((await ctx.store.listStaffLogins(org.orgId)).filter((l) => l.hash).map((l) => l.employeeId));
      const rows = weeksSeen(org.toldWeeks ?? {}, org.rotaSeen ?? {}, (w) => weeks.includes(w.weekStart) && g.can('rota.publish', w.siteId));
      const groups = new Map<string, typeof rows>();
      for (const r of rows) groups.set(`${r.siteId}|${r.weekStart}`, [...(groups.get(`${r.siteId}|${r.weekStart}`) ?? []), r]);
      return [...groups.entries()]
        .map(([key, people]) => {
          const [siteId, ws] = key.split('|');
          const person = (id: string) => org.state.employees.find((e) => e.id === id)?.name ?? id;
          return {
            siteId,
            siteName: names.site(siteId),
            weekStart: ws,
            total: people.length,
            seen: people.filter((p) => p.seen).length,
            notSeen: people
              .filter((p) => !p.seen)
              .map((p) => ({ name: person(p.employeeId), onApp: onApp.has(p.employeeId), changed: p.changed }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          };
        })
        .sort((a, b) => a.weekStart.localeCompare(b.weekStart) || a.siteName.localeCompare(b.siteName));
    },
  );

  const openShiftView = (req: FastifyRequest, org: OrgData, o: OpenShift) => {
    const names = namesOf(org.state);
    const g = guard(ctx, req, org);
    // Pay shows only to those who see cost: what a shift adds to someone's week gives their rate away.
    const showCost = g.can('costs.view', o.siteId);
    const person = (id: string) => org.state.employees.find((e) => e.id === id)?.name ?? id;
    const now = londonParts(ctx.now());
    return {
      ...o,
      offers: undefined,
      status: goingStatus(o, now),
      fill: o.fill ?? 'claim',
      line: shiftLine(o, names),
      label: labelOf(org, o),
      filledByName: o.filledBy ? person(o.filledBy) : null,
      heldByName: o.heldBy ? person(o.heldBy.employeeId) : null,
      claims: requestsOf(org)
        .filter((r) => r.openShiftId === o.id)
        .map((r) => managerView(req, g, org, r, today())),
      // Untargeted: offered in waves to everyone eligible. Whoever it was released from or held by is not offered it.
      eligible: o.status === 'open' && !o.offers ? eligibleFor(org.state, slotOf(o), [o.releasedFrom?.employeeId, o.heldBy?.employeeId].filter((x): x is string => !!x)).map((e) => e.name) : [],
      // Targeted: who is asked, in what round, and how each answered.
      asked: o.offers
        ? o.offers.map((x) => ({
            employeeId: x.employeeId,
            name: person(x.employeeId),
            round: x.round,
            asked: !!x.offeredAt,
            skipped: x.skipped ?? null,
            declined: !!x.declinedAt,
            refused: x.refused ?? null,
            borrowed: x.borrowed,
            ...(showCost ? { marginal: x.marginal } : {}),
          }))
        : null,
      rounds: o.rounds ?? null,
      round: currentRound(o),
      nextRoundAt: goingStatus(o, now) === 'open' ? o.nextRoundAt ?? null : null,
      waiting: waiting(o).length,
      // Who has been told so far, wave by wave, and when the next goes.
      offer: o.offer
        ? {
            waves: o.offer.waves.map((w, i) => ({ tier: w.tier, label: OFFER_TIER_LABEL[w.tier], count: w.employeeIds.length, released: i < o.offer!.released })),
            told: o.offer.told.length,
            allTold: o.offer.released >= o.offer.waves.length,
            nextAt: o.offer.nextAt ?? null,
          }
        : null,
      autoApproved: Boolean(o.autoApproved),
    };
  };

  app.get<{ Querystring: { siteId?: string } }>(
    '/v1/open-shifts',
    { ...read, schema: { tags, description: 'Open shifts put out for staff, at the sites where the caller publishes the rota, with claims, who is eligible or asked, and rounds.', querystring: { type: 'object', properties: { siteId: { type: 'string' } } } } },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const since = addDays(today(), -7);
      return openShiftsOf(org)
        .filter((o) => (!req.query.siteId || o.siteId === req.query.siteId) && g.can('rota.publish', o.siteId) && (o.status === 'open' || o.date >= since))
        .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute)
        .map((o) => openShiftView(req, org, o));
    },
  );

  type Put = Partial<OpenShift> & {
    fromShiftId?: string;
    keepUntilTaken?: boolean;
    employeeIds?: string[];
    rounds?: { size?: number; everyMinutes?: number } | null;
    fill?: 'claim' | 'first_yes';
    urgent?: boolean;
    everyone?: boolean;
  };

  /**
   * The slot being put out, from someone's shift or given directly, checked for the caller's right to
   * publish at its site. Nothing is changed.
   */
  function slotFor(org: OrgData, g: Guard, body: Put) {
    const now = ctx.now();
    if (body.fromShiftId) {
      const s = org.state.shifts.find((x) => x.id === body.fromShiftId);
      if (!s) throw notFound(`Shift ${body.fromShiftId}`);
      g.allow('rota.publish', s.siteId);
      if (hasStarted(s, londonParts(now)) || org.timeEntries.some((t) => t.shiftId === s.id)) throw new HttpError(409, 'worked_shift', 'This shift has started or been clocked against, so it cannot be put out for cover.');
      // A shift in a pay period locked for payroll cannot move to anyone else.
      assertRotaOpen(org, [s]);
      if (openShiftsOf(org).some((o) => o.status === 'open' && o.heldBy?.shiftId === s.id)) throw new HttpError(409, 'already_out', 'This shift is already out for cover. Withdraw that first to put it out again.');
      return { shift: s, slot: { siteId: s.siteId, roleId: s.roleId, date: s.date, startMinute: s.startMinute, endMinute: s.endMinute, breakMinutes: s.breakMinutes } };
    }
    const { siteId, roleId, date, startMinute, endMinute } = body;
    if (!siteId || !roleId || !date || startMinute === undefined || endMinute === undefined) throw new HttpError(400, 'invalid_request', 'Give siteId, roleId, date, startMinute and endMinute, or fromShiftId.');
    if (!org.state.sites.some((s) => s.id === siteId)) throw notFound(`Site ${siteId}`);
    if (!org.state.roles.some((r) => r.id === roleId)) throw notFound(`Role ${roleId}`);
    g.allow('rota.publish', siteId);
    if (endMinute <= startMinute) throw new HttpError(422, 'invalid_shift', 'Shift must end after it starts');
    if (hasStarted({ date, startMinute }, londonParts(now))) throw new HttpError(422, 'in_the_past', 'That shift has started.');
    return { shift: undefined, slot: { siteId, roleId, date, startMinute, endMinute, breakMinutes: body.breakMinutes ?? 0 } };
  }

  const candidateRows = (org: OrgData, g: Guard, slot: Shift, exclude: string[]) =>
    goingCandidates(org.state, slot, exclude).map(({ candidate: c, eligible, reason }) => ({
      employeeId: c.employee.id,
      name: c.employee.name,
      homeSite: c.homeSite,
      borrowed: c.borrowed,
      eligible,
      reason,
      warnings: c.warnings.map((w) => w.message),
      ...(g.can('costs.view', slot.siteId) ? { marginal: Math.round(c.marginal * 100) / 100 } : {}),
    }));

  app.post<{ Body: Put }>(
    '/v1/open-shifts/preview',
    { ...read, schema: { tags, description: 'Who could take a shift before it is put out: everyone eligible, cheapest first, with what each adds to labour (with cost access) and why anyone is not eligible. Changes nothing.' } },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const { shift, slot } = slotFor(org, g, req.body ?? {});
      const names = namesOf(org.state);
      const now = londonParts(ctx.now());
      const rows = candidateRows(org, g, { ...slot, id: 'preview', employeeId: '' }, shift ? [shift.employeeId] : []);
      return {
        line: shiftLine(slot, names),
        label: labelOf(org, slot),
        holder: shift ? { employeeId: shift.employeeId, name: org.state.employees.find((e) => e.id === shift.employeeId)?.name ?? '', published: !!shift.published } : null,
        suggestedRounds: defaultRounds(rows.filter((r) => r.eligible).length, minutesUntil(now, { date: slot.date, minute: slot.startMinute })) ?? null,
        candidates: rows,
      };
    },
  );

  app.post<{ Body: Put }>(
    '/v1/open-shifts',
    {
      ...write,
      schema: {
        tags,
        description:
          'Puts a shift out for staff to take. By default it is offered to everyone eligible (trained for the role, set up for the site, free and legal) in waves, ' +
          'cheapest first: people short of their contracted hours that week, then the three cheapest to add, then everyone, ' +
          `each wave ${OFFER_WAVE_MINUTES} minutes after the last while nobody has claimed. Inside a day of the start, or with \`everyone\`, all are told at once. ` +
          'Each who asks for it waits for a manager to approve, unless the site approves claims automatically inside the rules and the labour budget; ' +
          '`fill: "first_yes"` gives it to the first legal yes instead. ' +
          '`employeeIds` puts it to those people only, cheapest first; `rounds: {size, everyMinutes}` asks them a few at a time, every 15, 30, 60 or 120 minutes, ' +
          'until someone takes it. With `fromShiftId`, the shift is taken off whoever has it (they are told) and put out as it was: how a sick person\'s shift is put out for cover; ' +
          'add `keepUntilTaken: true` to leave it with them until someone takes it. `urgent` reaches people through their quiet hours.',
        body: {
          type: 'object',
          properties: {
            siteId: { type: 'string' }, roleId: { type: 'string' }, date: { type: 'string', format: 'date' },
            startMinute: { type: 'integer', minimum: 0, maximum: 2880 }, endMinute: { type: 'integer', minimum: 1, maximum: 2880 },
            breakMinutes: { type: 'integer', minimum: 0, maximum: 240 }, note: { type: 'string', maxLength: 300 }, fromShiftId: { type: 'string' },
            keepUntilTaken: { type: 'boolean' },
            employeeIds: { type: 'array', items: { type: 'string' }, maxItems: 200 },
            rounds: { type: ['object', 'null'], properties: { size: { type: 'integer' }, everyMinutes: { type: 'integer' } }, additionalProperties: false },
            fill: { type: 'string', enum: ['claim', 'first_yes'] },
            urgent: { type: 'boolean' },
            everyone: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const now = ctx.now();
      const names = namesOf(org.state);
      const body = req.body;
      const { shift: s, slot } = slotFor(org, g, body);
      if (slot.date < today()) throw new HttpError(422, 'in_the_past', 'That day has gone.');
      const keep = !!s && body.keepUntilTaken === true;
      const exclude = s ? [s.employeeId] : [];
      const targeted = body.employeeIds !== undefined || !!body.rounds;
      // Who is put to, cheapest first: the eligible people named, or everyone eligible when rounds are asked for.
      let offers: OpenShift['offers'];
      let rounds: OpenShift['rounds'];
      if (targeted) {
        const rows = goingCandidates(org.state, { ...slot, id: 'new', employeeId: '' }, exclude);
        const named = body.employeeIds;
        const bad = (named ?? []).filter((id) => !rows.some((r) => r.eligible && r.candidate.employee.id === id));
        if (bad.length) {
          const who = bad.map((id) => org.state.employees.find((e) => e.id === id)?.name ?? id).join(', ');
          throw new HttpError(409, 'not_eligible', `${who} cannot take this shift under the rota rules, so cannot be asked.`);
        }
        const chosen = rows.filter((r) => r.eligible && (!named || named.includes(r.candidate.employee.id)));
        if (chosen.length === 0) throw new HttpError(409, 'nobody_eligible', 'Nobody trained for this role can legally take this shift. It is a gap to fill by hiring or cross-training.');
        const asked = body.rounds;
        if (asked && (!Number.isInteger(asked.size) || asked.size! < 1 || asked.size! > MAX_ROUND_SIZE || !(ROUND_MINUTES as readonly number[]).includes(asked.everyMinutes!))) {
          throw new HttpError(400, 'invalid_rounds', `Ask between 1 and ${MAX_ROUND_SIZE} people a round, every ${ROUND_MINUTES.join(', ')} minutes.`);
        }
        rounds = asked && asked.size! < chosen.length ? { size: asked.size!, everyMinutes: asked.everyMinutes! } : undefined;
        if (rounds && !roomForRounds(slot, rounds, londonParts(now))) {
          throw new HttpError(409, 'no_time_for_rounds', `There is not time for a second round before the shift. Ask everyone now, or make the rounds shorter than ${rounds.everyMinutes} minutes.`);
        }
        offers = chosen.map((r, i) => ({ employeeId: r.candidate.employee.id, marginal: Math.round(r.candidate.marginal * 100) / 100, borrowed: r.candidate.borrowed, round: roundOf(i, rounds) }));
      }
      if (s && !keep) {
        org.state.shifts = org.state.shifts.filter((x) => x.id !== s.id);
        audit(org, actorName(g), 'shift.deleted', { id: s.id });
        if (s.published) {
          notify(org, s.employeeId, 'shift_cancelled', 'A shift has been taken off you', `${shiftLine(s, names)} has been put out for cover. You are not needed for it.`, now);
          syncTold(org, [s.employeeId], [s]);
        }
      }
      const o: OpenShift = {
        ...slot,
        id: newId('open'),
        status: 'open',
        postedBy: actorName(g),
        postedAt: now.toISOString(),
        ...(body.note ? { note: body.note } : {}),
        ...(s ? (keep ? { heldBy: { shiftId: s.id, employeeId: s.employeeId } } : { releasedFrom: { shiftId: s.id, employeeId: s.employeeId } }) : {}),
        ...(body.fill === 'first_yes' ? { fill: 'first_yes' as const } : {}),
        ...(offers ? { offers } : {}),
        ...(rounds ? { rounds } : {}),
        ...(body.urgent ? { urgent: true } : {}),
      };
      openShiftsOf(org).push(o);
      audit(org, actorName(g), 'open_shift.posted', { id: o.id, siteId: o.siteId, fill: o.fill ?? 'claim', asked: offers?.length, rounds });
      let told: number;
      if (offers) told = askNextRound(org, o, actorName(g), now);
      else {
        // Offered cheapest first: those short of their contracted hours, then the cheapest few, then everyone.
        const eligible = eligibleFor(org.state, slotOf(o), exclude);
        o.offer = { waves: offerWaves(rankOffer(org.state, slotOf(o), eligible)), released: 0, told: [] };
        told = releaseWave(org, o, now, body.everyone === true || tooCloseForWaves(o, londonParts(now)));
      }
      return reply.code(201).send({ ...openShiftView(req, org, o), told });
    },
  );

  // The manager does not want to wait for the next round: ask the next one now, or everyone left.
  app.post<{ Params: { id: string }; Body: { everyone?: boolean } | null }>(
    '/v1/open-shifts/:id/next',
    { ...write, schema: { tags, description: 'Asks the next round now, or with `everyone: true` everyone not yet asked.', params: idParam } },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const o = openShiftsOf(org).find((x) => x.id === req.params.id);
      if (!o) throw notFound(`Open shift ${req.params.id}`);
      g.allow('rota.publish', o.siteId);
      if (goingStatus(o, londonParts(ctx.now())) !== 'open') throw new HttpError(409, 'not_open', 'This open shift is no longer open.');
      if (waiting(o).length === 0) throw new HttpError(409, 'nobody_left', 'Everyone who could take it has been asked.');
      askNextRound(org, o, actorName(g), ctx.now(), req.body?.everyone === true);
      return openShiftView(req, org, o);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/open-shifts/:id',
    { ...write, schema: { tags, description: 'Withdraws an open shift. Anyone who asked for it, or was asked, is told. A shift kept by its holder stays theirs.', params: idParam } },
    async (req, reply) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const o = openShiftsOf(org).find((x) => x.id === req.params.id);
      if (!o) throw notFound(`Open shift ${req.params.id}`);
      g.allow('rota.publish', o.siteId);
      if (o.status !== 'open') throw new HttpError(409, 'not_open', `This open shift was ${o.status} already.`);
      withdraw(org, o, actorName(g), ctx.now());
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/open-shifts/:id/offer-all',
    { ...write, schema: { tags, description: 'Tells everyone eligible now, without waiting for the cheaper waves to claim.', params: idParam } },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const o = openShiftsOf(org).find((x) => x.id === req.params.id);
      if (!o) throw notFound(`Open shift ${req.params.id}`);
      g.allow('rota.publish', o.siteId);
      if (o.status !== 'open') throw new HttpError(409, 'not_open', `This open shift was ${o.status} already.`);
      const told = releaseWave(org, o, ctx.now(), true);
      audit(org, actorName(g), 'open_shift.offered_all', { id: o.id, told });
      return { ...openShiftView(req, org, o), told };
    },
  );

  // Approving claims without a manager, site by site: off until someone who publishes the rota turns it on.
  app.get(
    '/v1/open-shifts/auto-approve',
    { ...read, schema: { tags, description: 'The sites, of those where the caller publishes the rota, whose open shift claims are approved automatically when inside the rules and the labour budget.' } },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const on = new Set(org.settings.openShiftAutoApprove ?? []);
      return org.state.sites.filter((x) => g.can('rota.publish', x.id)).map((x) => ({ siteId: x.id, siteName: x.name, on: on.has(x.id), labourTargetPct: x.labourTargetPct }));
    },
  );

  app.put<{ Body: { siteId: string; on: boolean } }>(
    '/v1/open-shifts/auto-approve',
    {
      ...write,
      schema: {
        tags,
        description:
          'Turns automatic approval of open shift claims on or off for a site. When on, a claim is approved the moment it is made if it breaks no rule, ' +
          "raises nothing to review, and the site's labour for that week stays at or under its target share of forecast sales. Anything else waits for a manager.",
        body: { type: 'object', required: ['siteId', 'on'], properties: { siteId: { type: 'string' }, on: { type: 'boolean' } }, additionalProperties: false },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      if (!org.state.sites.some((x) => x.id === req.body.siteId)) throw notFound(`Site ${req.body.siteId}`);
      g.allow('rota.publish', req.body.siteId);
      const on = new Set(org.settings.openShiftAutoApprove ?? []);
      if (req.body.on) on.add(req.body.siteId);
      else on.delete(req.body.siteId);
      org.settings.openShiftAutoApprove = [...on];
      audit(org, actorName(g), 'open_shift.auto_approve_set', { siteId: req.body.siteId, on: req.body.on });
      return { siteId: req.body.siteId, on: req.body.on };
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Staff side, on the staff app's own API. Everything here is the signed-in person's own: their
// requests, the open shifts they could take, the swaps offered to them.

export interface StaffCaller {
  org: OrgData;
  employee: Employee;
}

const dateBody = { type: 'string', format: 'date' } as const;

/** One of the person's own requests, as their phone shows it: colleagues by name only. */
export function ownRequestView(org: OrgData, r: StaffRequest) {
  const names = namesOf(org.state);
  const name = (id?: string) => (id ? org.state.employees.find((x) => x.id === id)?.name ?? null : null);
  const shift = r.shiftId ? org.state.shifts.find((s) => s.id === r.shiftId) : undefined;
  const back = r.returnShiftId ? org.state.shifts.find((s) => s.id === r.returnShiftId) : undefined;
  const os = r.openShiftId ? openShiftsOf(org).find((x) => x.id === r.openShiftId) : undefined;
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    createdAt: r.createdAt,
    from: r.from ?? null,
    to: r.to ?? null,
    hours: r.hours ?? null,
    absenceLabel: r.absenceType ? ABSENCE_LABEL[r.absenceType] : null,
    line: shift ? shiftLine(shift, names) : os ? shiftLine(os, names) : null,
    returnLine: back ? shiftLine(back, names) : null,
    withName: name(r.takerId ?? r.toEmployeeId),
    decidedBy: r.decidedBy ?? null,
    decisionNote: r.decisionNote ?? null,
    canCancel: open(r) && r.kind !== 'sickness',
  };
}

function overlapping(org: OrgData, e: Employee, kind: StaffRequest['kind'], from: string, to: string) {
  return requestsOf(org).some((r) => r.employeeId === e.id && r.kind === kind && open(r) && r.from! <= to && (r.to ?? r.from!) >= from);
}

function checkRange(from: string, to: string, today: string, past = false) {
  if (to < from) throw new HttpError(422, 'invalid_dates', 'The last day is before the first.');
  if (!past && from < today) throw new HttpError(422, 'in_the_past', 'Ask for days from today onwards.');
  if (datesBetween(from, to).length > MAX_REQUEST_DAYS) throw new HttpError(422, 'too_long', `Ask for at most ${MAX_REQUEST_DAYS} days at a time.`);
}

export function staffRequestRoutes(app: FastifyInstance, ctx: AppContext, signedIn: (req: FastifyRequest) => Promise<StaffCaller>) {
  const { store } = ctx;
  const hidden = { hide: true };
  const today = () => londonParts(new Date()).date;
  const actor = (e: Employee) => `staff:${e.id}`;

  /** Saves the person's change, emailing anyone it tells, and returns what their phone shows next. */
  async function done(org: OrgData, body: unknown) {
    await carryNotifications(ctx, org);
    await deliverNotifications(store, org);
    await store.save(org);
    return body;
  }

  app.get('/v1/staff/notifications', { schema: hidden }, async (req) => {
    const { org, employee } = await signedIn(req);
    return newestFirst((org.notifications ?? []).filter((n) => n.employeeId === employee.id))
      .map(({ id, kind, at, title, body, read }) => ({ id, kind, at, title, body, read: Boolean(read) }));
  });

  app.post<{ Body: { ids?: string[] } | null }>(
    '/v1/staff/notifications/read',
    { schema: { ...hidden, body: { type: ['object', 'null'], properties: { ids: { type: 'array', items: { type: 'string' }, maxItems: 200 } } } } },
    async (req) => {
      const { org, employee } = await signedIn(req);
      const ids = req.body?.ids ? new Set(req.body.ids) : null;
      for (const n of org.notifications ?? []) if (n.employeeId === employee.id && (!ids || ids.has(n.id))) n.read = true;
      await store.save(org);
      return { ok: true };
    },
  );

  // Who they are working with: names and times on their own published shifts. Never pay, never anyone else's week.
  app.get('/v1/staff/team', { schema: hidden }, async (req) => {
    const { org, employee } = await signedIn(req);
    const names = namesOf(org.state);
    const from = today();
    const to = addDays(from, 13);
    const published = org.state.shifts.filter((s) => s.published && s.date >= from && s.date <= to);
    return published
      .filter((s) => s.employeeId === employee.id)
      .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute)
      .map((s) => ({
        shiftId: s.id,
        date: s.date,
        line: shiftLine(s, names),
        startMinute: s.startMinute,
        endMinute: s.endMinute,
        role: names.role(s.roleId),
        siteName: names.site(s.siteId),
        team: published
          .filter((x) => x.siteId === s.siteId && x.date === s.date && x.employeeId !== employee.id && x.startMinute < s.endMinute && s.startMinute < x.endMinute)
          .sort((a, b) => a.startMinute - b.startMinute)
          .map((x) => ({ name: org.state.employees.find((e) => e.id === x.employeeId)?.name ?? '', role: names.role(x.roleId), startMinute: x.startMinute, endMinute: x.endMinute })),
      }));
  });

  // The board: open shifts they could take, and swaps offered to them.
  app.get('/v1/staff/board', { schema: hidden }, async (req) => {
    const { org, employee } = await signedIn(req);
    const names = namesOf(org.state);
    const now = londonParts(new Date());
    // One list of shifts going: those put to them, and any untargeted one they could take, each with
    // what taking it would do to them: their week's hours with it, the rest either side, anything to review.
    const own = org.state.shifts.filter((s) => s.employeeId === employee.id && s.published);
    const openShifts = shiftsGoingFor(org, employee, ctx.now()).map(({ open: o, claimed }) => {
      const effect = shiftEffect(employee, own, { ...slotOf(o), employeeId: employee.id });
      const warnings = claimed ? [] : claimCheck(org.state, employee, slotOf(o)).issues.filter((i) => i.severity === 'warn').map((i) => i.message);
      return {
        id: o.id,
        line: shiftLine(o, names),
        note: o.note ?? null,
        claimed,
        fill: o.fill ?? 'claim',
        urgent: !!o.urgent,
        // Put to them by name: a no moves it on to the next round.
        canDecline: !!o.offers && !claimed,
        effect: { ...effect, warnings },
      };
    });
    const offers = requestsOf(org)
      .filter((r) => r.kind === 'swap' && r.status === 'pending' && r.employeeId !== employee.id)
      .filter((r) => (r.toEmployeeId ? r.toEmployeeId === employee.id : true))
      .filter((r) => {
        const s = org.state.shifts.find((x) => x.id === r.shiftId);
        if (!tradeable(org, s, now)) return false;
        const check = swapCheck(org.state, r, employee.id);
        return !check.problem && blocking(check.issues).length === 0;
      })
      .map((r) => {
        const s = org.state.shifts.find((x) => x.id === r.shiftId)!;
        const back = r.returnShiftId ? org.state.shifts.find((x) => x.id === r.returnShiftId) : undefined;
        return {
          id: r.id,
          from: org.state.employees.find((e) => e.id === r.employeeId)?.name ?? '',
          line: shiftLine(s, names),
          returnLine: back ? shiftLine(back, names) : null,
          directed: Boolean(r.toEmployeeId),
          note: r.note ?? null,
        };
      });
    return { openShifts, offers };
  });

  // Who could take one of their shifts, and which of each person's shifts they could take back in an exchange.
  app.get<{ Params: { id: string } }>('/v1/staff/shifts/:id/swap-options', { schema: { ...hidden, params: idParam } }, async (req) => {
    const { org, employee } = await signedIn(req);
    const shift = org.state.shifts.find((s) => s.id === req.params.id && s.employeeId === employee.id);
    if (!tradeable(org, shift)) throw new HttpError(409, 'not_tradeable', 'Only your published shifts that have not started can be swapped.');
    const names = namesOf(org.state);
    const until = addDays(today(), 27);
    const people = org.state.employees
      .filter((e) => e.id !== employee.id && e.status !== 'leaver')
      .map((e) => {
        const give = swapCheck(org.state, { shiftId: shift.id, employeeId: employee.id }, e.id);
        if (give.problem || blocking(give.issues).length) return null;
        const theirs = org.state.shifts
          .filter((s) => s.employeeId === e.id && s.date <= until && tradeable(org, s))
          .filter((s) => {
            const both = swapCheck(org.state, { shiftId: shift.id, returnShiftId: s.id, employeeId: employee.id }, e.id);
            return !both.problem && blocking(both.issues).length === 0;
          })
          .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute)
          .map((s) => ({ id: s.id, line: shiftLine(s, names) }));
        return { id: e.id, name: e.name, role: names.role(e.roleIds[0] ?? ''), shifts: theirs };
      })
      .filter(Boolean);
    return { shift: { id: shift.id, line: shiftLine(shift, names) }, people };
  });

  app.post<{ Body: { shiftId: string; toEmployeeId?: string; returnShiftId?: string; note?: string } }>(
    '/v1/staff/swaps',
    {
      schema: {
        ...hidden,
        body: {
          type: 'object',
          required: ['shiftId'],
          properties: { shiftId: { type: 'string' }, toEmployeeId: { type: 'string' }, returnShiftId: { type: 'string' }, note: { type: 'string', maxLength: 300 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const { org, employee } = await signedIn(req);
      const { shiftId, toEmployeeId, returnShiftId } = req.body;
      const shift = org.state.shifts.find((s) => s.id === shiftId && s.employeeId === employee.id);
      if (!tradeable(org, shift)) throw new HttpError(409, 'not_tradeable', 'Only your published shifts that have not started can be swapped.');
      if (requestsOf(org).some((r) => r.kind === 'swap' && open(r) && (r.shiftId === shiftId || r.returnShiftId === shiftId))) {
        throw new HttpError(409, 'already_offered', 'This shift is already up for a swap. Cancel that one first.');
      }
      if (returnShiftId && !toEmployeeId) throw new HttpError(422, 'invalid_request', 'Name the colleague whose shift you would take in return.');
      const names = namesOf(org.state);
      if (toEmployeeId) {
        if (toEmployeeId === employee.id) throw new HttpError(422, 'invalid_request', 'Choose a colleague.');
        const to = employeeOf(org, toEmployeeId);
        if (returnShiftId && !tradeable(org, org.state.shifts.find((s) => s.id === returnShiftId && s.employeeId === to.id))) {
          throw new HttpError(409, 'not_tradeable', `That is not one of ${to.name}'s published shifts still to come.`);
        }
        const check = swapCheck(org.state, { shiftId, returnShiftId, employeeId: employee.id }, to.id);
        if (check.problem) throw new HttpError(409, 'not_eligible', check.problem);
        const blocks = blocking(check.issues);
        if (blocks.length) throw new HttpError(409, 'compliance_block', `This swap would break a rule: ${blocks.map((i) => i.message).join(' ')}`, blocks.map(issueView(org)));
      }
      const r = addRequest(org, { kind: 'swap', employeeId: employee.id, siteId: shift.siteId, shiftId, ...(toEmployeeId ? { toEmployeeId } : {}), ...(returnShiftId ? { returnShiftId } : {}), ...(req.body.note?.trim() ? { note: req.body.note.trim() } : {}) }, today());
      const now = new Date();
      const line = shiftLine(shift, names);
      if (toEmployeeId) {
        const back = returnShiftId ? org.state.shifts.find((s) => s.id === returnShiftId)! : undefined;
        notify(org, toEmployeeId, 'swap_offered', `${employee.name} asked you to swap`, back ? `They would take your ${shiftLine(back, names)} and you would take their ${line}.` : `They asked if you can take their ${line}.`, now);
      } else {
        for (const e of org.state.employees.filter((x) => x.id !== employee.id && x.status !== 'leaver')) {
          const check = swapCheck(org.state, r, e.id);
          if (!check.problem && blocking(check.issues).length === 0) notify(org, e.id, 'swap_offered', 'A shift up for grabs', `${employee.name} is looking for someone to take ${line}.`, now);
        }
      }
      reply.code(201);
      return done(org, ownRequestView(org, r));
    },
  );

  for (const answer of ['accept', 'decline'] as const) {
    app.post<{ Params: { id: string } }>(`/v1/staff/swaps/:id/${answer}`, { schema: { ...hidden, params: idParam } }, async (req) => {
      const { org, employee } = await signedIn(req);
      const r = requestsOf(org).find((x) => x.id === req.params.id && x.kind === 'swap');
      if (!r || r.employeeId === employee.id || (r.toEmployeeId && r.toEmployeeId !== employee.id)) throw notFound(`Swap ${req.params.id}`);
      if (r.status !== 'pending') throw new HttpError(409, 'already_taken', 'This swap has already been taken or withdrawn.');
      const now = new Date();
      if (answer === 'decline') {
        // Turning down an offer to everyone just hides it; only the colleague named can refuse it outright.
        if (!r.toEmployeeId) return { ok: true };
        Object.assign(r, { status: 'declined', decidedBy: employee.name, decidedAt: now.toISOString() });
        notify(org, r.employeeId, 'request_decided', 'Swap turned down', `${employee.name} cannot take it. You are still on the shift; try someone else.`, now);
        return done(org, { ok: true });
      }
      if (!tradeable(org, org.state.shifts.find((s) => s.id === r.shiftId))) throw new HttpError(409, 'not_tradeable', 'That shift has started or changed.');
      const check = swapCheck(org.state, r, employee.id);
      if (check.problem) throw new HttpError(409, 'not_eligible', check.problem);
      const blocks = blocking(check.issues);
      if (blocks.length) throw new HttpError(409, 'compliance_block', `You cannot take this shift: ${blocks.map((i) => i.message).join(' ')}`, blocks.map(issueView(org)));
      Object.assign(r, { status: 'accepted', takerId: employee.id });
      audit(org, actor(employee), 'request.accepted', { id: r.id, kind: r.kind, employeeId: r.employeeId });
      notify(org, r.employeeId, 'swap_accepted', `${employee.name} will take your shift`, 'Waiting for your manager to approve. Keep the shift until they do.', now);
      return done(org, { ok: true });
    });
  }

  app.post<{ Params: { id: string } }>('/v1/staff/open-shifts/:id/claim', { schema: { ...hidden, params: idParam } }, async (req, reply) => {
    const { org, employee } = await signedIn(req);
    const o = openShiftsOf(org).find((x) => x.id === req.params.id);
    if (!o || goingStatus(o, londonParts(ctx.now())) !== 'open') throw new HttpError(409, 'not_open', 'This shift has been filled or withdrawn.');
    if (requestsOf(org).some((r) => r.openShiftId === o.id && r.employeeId === employee.id && open(r))) throw new HttpError(409, 'already_claimed', 'You have already asked for this shift.');
    if (!wasAsked(o, employee.id)) throw new HttpError(409, 'not_offered', 'This shift has not been offered to you yet.');
    const check = claimCheck(org.state, employee, slotOf(o));
    if (check.problem) throw new HttpError(409, 'not_eligible', check.problem);
    const blocks = blocking(check.issues);
    if (blocks.length) throw new HttpError(409, 'compliance_block', `You cannot take this shift: ${blocks.map((i) => i.message).join(' ')}`, blocks.map(issueView(org)));
    const taken = takeOpenShift(org, o, employee, 'app', ctx.now());
    await afterYes(ctx, org, taken);
    if (taken.kind === 'refused') {
      // A yes that could not be given may leave everyone asked out of the running: the next round goes now.
      askDueRounds(org, ctx.now());
      await done(org, null);
      throw new HttpError(409, 'not_given', taken.reason);
    }
    if (taken.kind === 'filled') {
      // A request approved by the site's rule was made, as any claim is; the first yes makes none.
      if (taken.request) reply.code(201);
      // Approved by the site's own rule shows as the request it was; the first yes as the shift it gave.
      return done(org, { ...(taken.request ? ownRequestView(org, taken.request) : {}), outcome: 'filled', line: shiftLine(o, namesOf(org.state)) });
    }
    reply.code(201);
    return done(org, { ...ownRequestView(org, taken.request), outcome: 'claimed' });
  });

  // No thanks, to a shift put to them by name: when everyone asked has said no, the next round goes now.
  app.post<{ Params: { id: string } }>('/v1/staff/open-shifts/:id/decline', { schema: { ...hidden, params: idParam } }, async (req) => {
    const { org, employee } = await signedIn(req);
    const o = openShiftsOf(org).find((x) => x.id === req.params.id);
    const offer = o?.offers?.find((x) => x.employeeId === employee.id && x.offeredAt);
    if (!o || !offer) throw notFound('Open shift');
    if (!offer.declinedAt) {
      offer.declinedAt = ctx.now().toISOString();
      audit(org, actor(employee), 'open_shift.declined', { id: o.id, employeeId: employee.id });
      askDueRounds(org, ctx.now());
    }
    return done(org, { ok: true });
  });

  app.post<{ Body: { from: string; to: string; note?: string } }>(
    '/v1/staff/requests/holiday',
    { schema: { ...hidden, body: { type: 'object', required: ['from', 'to'], properties: { from: dateBody, to: dateBody, note: { type: 'string', maxLength: 300 } }, additionalProperties: false } } },
    async (req, reply) => {
      const { org, employee } = await signedIn(req);
      const { from, to } = req.body;
      checkRange(from, to, today());
      if (overlapping(org, employee, 'holiday', from, to)) throw new HttpError(409, 'overlaps', 'You have already asked for some of these days.');
      const dates = datesBetween(from, to);
      if (dates.every((d) => employee.leave.includes(d))) throw new HttpError(409, 'already_booked', 'These days are already booked as holiday.');
      const balance = balanceOf(org, employee, today());
      const hours = holidayHours(employee, dates, balance.dayHours);
      const r = addRequest(org, { kind: 'holiday', employeeId: employee.id, siteId: employee.siteId, from, to, hours, ...(req.body.note?.trim() ? { note: req.body.note.trim() } : {}) }, today());
      reply.code(201);
      return done(org, ownRequestView(org, r));
    },
  );

  app.post<{ Body: { absenceType: AbsenceType; from: string; to: string; note?: string } }>(
    '/v1/staff/requests/time-off',
    {
      schema: {
        ...hidden,
        body: {
          type: 'object',
          required: ['absenceType', 'from', 'to'],
          properties: { absenceType: { type: 'string', enum: REQUESTABLE_ABSENCE }, from: dateBody, to: dateBody, note: { type: 'string', maxLength: 500 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const { org, employee } = await signedIn(req);
      const { from, to, absenceType } = req.body;
      // Emergencies for dependants and bereavement are often asked for after the first day.
      checkRange(from, to, addDays(today(), -7));
      if (overlapping(org, employee, 'time_off', from, to)) throw new HttpError(409, 'overlaps', 'You have already asked for some of these days.');
      const r = addRequest(org, { kind: 'time_off', employeeId: employee.id, siteId: employee.siteId, absenceType, from, to, ...(req.body.note?.trim() ? { note: req.body.note.trim() } : {}) }, today());
      reply.code(201);
      return done(org, ownRequestView(org, r));
    },
  );

  app.post<{ Body: { availability: Availability[]; note?: string } }>(
    '/v1/staff/requests/availability',
    {
      schema: {
        ...hidden,
        body: {
          type: 'object',
          required: ['availability'],
          properties: {
            availability: {
              type: 'array',
              maxItems: 21,
              items: {
                type: 'object',
                required: ['weekday', 'fromMinute', 'toMinute'],
                properties: { weekday: { type: 'integer', minimum: 0, maximum: 6 }, fromMinute: { type: 'integer', minimum: 0, maximum: 1440 }, toMinute: { type: 'integer', minimum: 0, maximum: 2880 } },
                additionalProperties: false,
              },
            },
            note: { type: 'string', maxLength: 300 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const { org, employee } = await signedIn(req);
      const availability = req.body.availability;
      if (availability.some((a) => a.toMinute <= a.fromMinute)) throw new HttpError(422, 'invalid_times', 'Each time must end after it starts.');
      // A new pattern replaces any still waiting.
      for (const r of requestsOf(org).filter((x) => x.employeeId === employee.id && x.kind === 'availability' && open(x))) Object.assign(r, { status: 'cancelled' });
      const r = addRequest(org, { kind: 'availability', employeeId: employee.id, siteId: employee.siteId, availability: [...availability].sort((a, b) => a.weekday - b.weekday || a.fromMinute - b.fromMinute), ...(req.body.note?.trim() ? { note: req.body.note.trim() } : {}) }, today());
      reply.code(201);
      return done(org, ownRequestView(org, r));
    },
  );

  // One-off days they cannot work. Not a request: it is their say, and the rota warns on it and the build avoids it.
  app.put<{ Body: { dates: { date: string; note?: string }[] } }>(
    '/v1/staff/unavailable',
    {
      schema: {
        ...hidden,
        body: {
          type: 'object',
          required: ['dates'],
          properties: { dates: { type: 'array', maxItems: 60, items: { type: 'object', required: ['date'], properties: { date: dateBody, note: { type: 'string', maxLength: 120 } }, additionalProperties: false } } },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const { org, employee } = await signedIn(req);
      const from = today();
      const until = addDays(from, 365);
      const future = req.body.dates.filter((d) => d.date >= from && d.date <= until);
      const kept = (employee.unavailable ?? []).filter((u) => u.date < from);
      const unique = [...new Map(future.map((d) => [d.date, { date: d.date, ...(d.note?.trim() ? { note: d.note.trim() } : {}) }])).values()];
      employee.unavailable = [...kept, ...unique].sort((a, b) => a.date.localeCompare(b.date));
      audit(org, actor(employee), 'employee.updated', { id: employee.id, fields: ['unavailable'] });
      const names = namesOf(org.state);
      // Days they are already on: saying so does not take them off it. Swapping or asking for time off does.
      const rostered = org.state.shifts
        .filter((s) => s.employeeId === employee.id && s.published && unique.some((u) => u.date === s.date))
        .map((s) => shiftLine(s, names));
      return done(org, { unavailable: employee.unavailable.filter((u) => u.date >= from), rostered });
    },
  );

  app.post<{ Params: { id: string } }>('/v1/staff/requests/:id/cancel', { schema: { ...hidden, params: idParam } }, async (req) => {
    const { org, employee } = await signedIn(req);
    const r = requestsOf(org).find((x) => x.id === req.params.id && x.employeeId === employee.id);
    if (!r) throw notFound(`Request ${req.params.id}`);
    if (!open(r) || r.kind === 'sickness') throw new HttpError(409, 'already_decided', 'This request can no longer be withdrawn.');
    const taker = r.takerId;
    Object.assign(r, { status: 'cancelled', decidedBy: employee.name, decidedAt: new Date().toISOString() });
    audit(org, actor(employee), 'request.cancelled', { id: r.id, kind: r.kind, employeeId: r.employeeId });
    if (taker) notify(org, taker, 'request_decided', 'Swap withdrawn', `${employee.name} has kept their shift. Nothing changes for you.`);
    return done(org, ownRequestView(org, r));
  });

  // Sickness is told, not asked: it is recorded at once so the rota stops relying on them, and their manager acknowledges it.
  app.post<{ Body: { from?: string; note?: string } | null }>(
    '/v1/staff/sick',
    { schema: { ...hidden, body: { type: ['object', 'null'], properties: { from: dateBody, note: { type: 'string', maxLength: 500 } }, additionalProperties: false } } },
    async (req, reply) => {
      const { org, employee } = await signedIn(req);
      const from = req.body?.from ?? today();
      if (from > addDays(today(), 1) || from < addDays(today(), -3)) throw new HttpError(422, 'invalid_dates', 'Report sickness from today, tomorrow, or up to three days ago. Your manager can record anything earlier.');
      if ((employee.absences ?? []).some((a) => a.type === 'sickness' && !a.to)) throw new HttpError(409, 'already_off', 'You are already recorded as off sick. Tell us when you are back.');
      const note = req.body?.note?.trim();
      const absence: Absence = { id: newId('abs'), type: 'sickness', from, reportedBy: 'staff', ...(note ? { reason: note } : {}) };
      employee.absences = [...(employee.absences ?? []), absence].sort((a, b) => a.from.localeCompare(b.from));
      audit(org, actor(employee), 'hr.absence.created', { id: employee.id, absenceId: absence.id, type: absence.type, from: absence.from });
      const r = addRequest(org, { kind: 'sickness', employeeId: employee.id, siteId: employee.siteId, from, absenceId: absence.id, ...(note ? { note } : {}) }, today());
      reply.code(201);
      return done(org, ownRequestView(org, r));
    },
  );

  app.post<{ Body: { lastDayOff: string } }>(
    '/v1/staff/sick/back',
    { schema: { ...hidden, body: { type: 'object', required: ['lastDayOff'], properties: { lastDayOff: dateBody }, additionalProperties: false } } },
    async (req) => {
      const { org, employee } = await signedIn(req);
      const a = (employee.absences ?? []).find((x) => x.type === 'sickness' && !x.to);
      if (!a) throw new HttpError(409, 'not_off', 'You are not recorded as off sick.');
      if (req.body.lastDayOff < a.from) throw new HttpError(422, 'invalid_dates', `Your sickness began on ${dayLabel(a.from)}.`);
      if (req.body.lastDayOff > addDays(today(), 14)) throw new HttpError(422, 'invalid_dates', 'Tell us the last day off once you know it.');
      a.to = req.body.lastDayOff;
      const r = requestsOf(org).find((x) => x.absenceId === a.id);
      if (r) r.to = a.to;
      audit(org, actor(employee), 'hr.absence.updated', { id: employee.id, absenceId: a.id, fields: ['to'] });
      return done(org, { ok: true, from: a.from, to: a.to });
    },
  );
}
