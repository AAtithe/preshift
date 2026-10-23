import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { breakFor, complianceOptions, type Issue } from '../../src/engine/compliance';
import { holidayBalance, workedShifts } from '../../src/engine/holiday';
import { ABSENCE_LABEL } from '../../src/engine/hr';
import {
  newestFirst,
  blocking, claimCheck, datesBetween, dayLabel, decisionText, eligibleFor, holidayHours, MAX_REQUEST_DAYS, namesOf,
  REQUESTABLE_ABSENCE, shiftLine, swapCheck, swapped,
} from '../../src/engine/requests';
import { shiftEffect } from '../../src/engine/rotaViews';
import { hasStarted } from '../../src/engine/rotaWeek';
import { addDays, londonParts } from '../../src/engine/time';
import { entriesAsShifts } from '../../src/engine/timesheet';
import type { Absence, AbsenceType, Availability, Employee, OpenShift, Shift, StaffRequest } from '../../src/engine/types';
import { hasScope, requireScope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard, type Guard } from '../guard';
import { managerDigests } from '../digest';
import { emailNotifications, notify, syncTold } from '../notify';
import { idParam } from '../schemas';
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

function slotOf(o: OpenShift): Shift {
  return { id: `open:${o.id}`, employeeId: '', siteId: o.siteId, roleId: o.roleId, date: o.date, startMinute: o.startMinute, endMinute: o.endMinute, breakMinutes: o.breakMinutes };
}

/** The shift an approved claim becomes: the posted times, with at least the break this person is owed. */
function claimedShift(org: OrgData, o: OpenShift, e: Employee): Shift {
  const owed = breakFor(e, o.date, o.endMinute - o.startMinute, complianceOptions(org.state, e).nation);
  return { id: `s_${randomUUID()}`, employeeId: e.id, siteId: o.siteId, roleId: o.roleId, date: o.date, startMinute: o.startMinute, endMinute: o.endMinute, breakMinutes: Math.max(o.breakMinutes, owed), published: true };
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
      org.state.shifts = swapped(org.state, r, r.takerId!);
      for (const s of touched) audit(org, by, 'shift.updated', { id: s.id });
      syncTold(org, [r.employeeId, r.takerId!], touched);
      break;
    }
    case 'open_shift': {
      const o = openShiftsOf(org).find((x) => x.id === r.openShiftId)!;
      const shift = claimedShift(org, o, e);
      org.state.shifts.push(shift);
      Object.assign(o, { status: 'filled', filledBy: e.id, shiftId: shift.id });
      audit(org, by, 'shift.created', { id: shift.id });
      syncTold(org, [e.id], [shift]);
      // Everyone else who asked for it hears it has gone.
      for (const other of requestsOf(org).filter((x) => x.openShiftId === o.id && x.id !== r.id && open(x))) {
        Object.assign(other, { status: 'cancelled', decidedBy: by, decidedAt: now.toISOString(), decisionNote: 'Filled by someone else.' });
        notify(org, other.employeeId, 'request_decided', 'Open shift filled', `${shiftLine(o, namesOf(org.state))} has gone to someone else. Thanks for offering.`, now);
      }
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

  const openShiftView = (req: FastifyRequest, org: OrgData, o: OpenShift) => {
    const names = namesOf(org.state);
    const g = guard(ctx, req, org);
    return {
      ...o,
      line: shiftLine(o, names),
      filledByName: o.filledBy ? org.state.employees.find((e) => e.id === o.filledBy)?.name ?? null : null,
      claims: requestsOf(org)
        .filter((r) => r.openShiftId === o.id)
        .map((r) => managerView(req, g, org, r, today())),
      // Whoever it was released from is not offered it back.
      eligible: o.status === 'open' ? eligibleFor(org.state, slotOf(o), o.releasedFrom ? [o.releasedFrom.employeeId] : []).map((e) => e.name) : [],
    };
  };

  app.get<{ Querystring: { siteId?: string } }>(
    '/v1/open-shifts',
    { ...read, schema: { tags, description: 'Open shifts posted for staff to claim, at the sites where the caller publishes the rota, with claims and who is eligible.', querystring: { type: 'object', properties: { siteId: { type: 'string' } } } } },
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

  app.post<{ Body: Partial<OpenShift> & { fromShiftId?: string } }>(
    '/v1/open-shifts',
    {
      ...write,
      schema: {
        tags,
        description:
          'Posts a shift for anyone eligible to claim: trained for the role, set up for the site, free and legal. Each of them is told. ' +
          'With `fromShiftId`, the shift is taken off whoever has it (they are told) and posted as it was: how a sick person\'s shift is put out for cover.',
        body: {
          type: 'object',
          properties: {
            siteId: { type: 'string' }, roleId: { type: 'string' }, date: { type: 'string', format: 'date' },
            startMinute: { type: 'integer', minimum: 0, maximum: 2880 }, endMinute: { type: 'integer', minimum: 1, maximum: 2880 },
            breakMinutes: { type: 'integer', minimum: 0, maximum: 240 }, note: { type: 'string', maxLength: 300 }, fromShiftId: { type: 'string' },
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
      let slot: Omit<OpenShift, 'id' | 'status' | 'postedBy' | 'postedAt'>;
      if (req.body.fromShiftId) {
        const s = org.state.shifts.find((x) => x.id === req.body.fromShiftId);
        if (!s) throw notFound(`Shift ${req.body.fromShiftId}`);
        g.allow('rota.publish', s.siteId);
        if (hasStarted(s, londonParts(now)) || org.timeEntries.some((t) => t.shiftId === s.id)) throw new HttpError(409, 'worked_shift', 'This shift has started or been clocked against, so it cannot be put out for cover.');
        org.state.shifts = org.state.shifts.filter((x) => x.id !== s.id);
        audit(org, actorName(g), 'shift.deleted', { id: s.id });
        if (s.published) {
          notify(org, s.employeeId, 'shift_cancelled', 'A shift has been taken off you', `${shiftLine(s, names)} has been put out for cover. You are not needed for it.`, now);
          syncTold(org, [s.employeeId], [s]);
        }
        slot = { siteId: s.siteId, roleId: s.roleId, date: s.date, startMinute: s.startMinute, endMinute: s.endMinute, breakMinutes: s.breakMinutes, releasedFrom: { shiftId: s.id, employeeId: s.employeeId }, ...(req.body.note ? { note: req.body.note } : {}) };
      } else {
        const { siteId, roleId, date, startMinute, endMinute } = req.body;
        if (!siteId || !roleId || !date || startMinute === undefined || endMinute === undefined) throw new HttpError(400, 'invalid_request', 'Give siteId, roleId, date, startMinute and endMinute, or fromShiftId.');
        if (!org.state.sites.some((s) => s.id === siteId)) throw notFound(`Site ${siteId}`);
        if (!org.state.roles.some((r) => r.id === roleId)) throw notFound(`Role ${roleId}`);
        g.allow('rota.publish', siteId);
        if (endMinute <= startMinute) throw new HttpError(422, 'invalid_shift', 'Shift must end after it starts');
        slot = { siteId, roleId, date, startMinute, endMinute, breakMinutes: req.body.breakMinutes ?? 0, ...(req.body.note ? { note: req.body.note } : {}) };
      }
      if (slot.date < today()) throw new HttpError(422, 'in_the_past', 'That day has gone.');
      const o: OpenShift = { ...slot, id: newId('open'), status: 'open', postedBy: actorName(g), postedAt: now.toISOString() };
      openShiftsOf(org).push(o);
      audit(org, actorName(g), 'open_shift.posted', { id: o.id, siteId: o.siteId });
      const eligible = eligibleFor(org.state, slotOf(o), o.releasedFrom ? [o.releasedFrom.employeeId] : []);
      for (const e of eligible) notify(org, e.id, 'open_shift', 'An open shift you could take', `${shiftLine(o, names)}.${o.note ? ` ${o.note}` : ''} Claim it in the app; your manager confirms.`, now);
      return reply.code(201).send({ ...openShiftView(req, org, o), told: eligible.length });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/open-shifts/:id',
    { ...write, schema: { tags, description: 'Withdraws an open shift. Anyone who claimed it is told.', params: idParam } },
    async (req, reply) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const o = openShiftsOf(org).find((x) => x.id === req.params.id);
      if (!o) throw notFound(`Open shift ${req.params.id}`);
      g.allow('rota.publish', o.siteId);
      if (o.status !== 'open') throw new HttpError(409, 'not_open', `This open shift was ${o.status} already.`);
      o.status = 'withdrawn';
      const now = ctx.now();
      for (const r of requestsOf(org).filter((x) => x.openShiftId === o.id && open(x))) {
        Object.assign(r, { status: 'cancelled', decidedBy: actorName(g), decidedAt: now.toISOString(), decisionNote: 'The shift was withdrawn.' });
        notify(org, r.employeeId, 'request_decided', 'Open shift withdrawn', `${shiftLine(o, namesOf(org.state))} is no longer needed.`, now);
      }
      audit(org, actorName(g), 'open_shift.withdrawn', { id: o.id });
      return reply.code(204).send();
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
    await emailNotifications(store, org);
    await store.save(org);
    return body;
  }

  function addRequest(org: OrgData, r: Omit<StaffRequest, 'id' | 'createdAt' | 'status'>, status: StaffRequest['status'] = 'pending') {
    const request: StaffRequest = { ...r, id: newId('req'), status, createdAt: new Date().toISOString() };
    const cutoff = addDays(today(), -DECIDED_KEPT_DAYS);
    org.requests = [...requestsOf(org).filter((x) => open(x) || (x.decidedAt ?? x.createdAt).slice(0, 10) >= cutoff), request];
    audit(org, actor(employeeOf(org, r.employeeId)), 'request.created', { id: request.id, kind: request.kind, employeeId: request.employeeId });
    return request;
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
    const mine = new Set(requestsOf(org).filter((r) => r.employeeId === employee.id && open(r) && r.openShiftId).map((r) => r.openShiftId));
    const openShifts = openShiftsOf(org)
      .filter((o) => o.status === 'open' && !hasStarted(o, now))
      .filter((o) => {
        if (mine.has(o.id)) return true;
        const check = claimCheck(org.state, employee, slotOf(o));
        return !check.problem && blocking(check.issues).length === 0;
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute)
      .map((o) => {
        // What taking it would do to them: their week's hours with it, the rest either side, and anything to review.
        const own = org.state.shifts.filter((s) => s.employeeId === employee.id && s.published);
        const effect = shiftEffect(employee, own, { ...slotOf(o), employeeId: employee.id });
        const warnings = mine.has(o.id) ? [] : claimCheck(org.state, employee, slotOf(o)).issues.filter((i) => i.severity === 'warn').map((i) => i.message);
        return { id: o.id, line: shiftLine(o, names), note: o.note ?? null, claimed: mine.has(o.id), effect: { ...effect, warnings } };
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
      const r = addRequest(org, { kind: 'swap', employeeId: employee.id, siteId: shift.siteId, shiftId, ...(toEmployeeId ? { toEmployeeId } : {}), ...(returnShiftId ? { returnShiftId } : {}), ...(req.body.note?.trim() ? { note: req.body.note.trim() } : {}) });
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
    if (!o || o.status !== 'open' || hasStarted(o, londonParts(new Date()))) throw new HttpError(409, 'not_open', 'This shift has been filled or withdrawn.');
    if (requestsOf(org).some((r) => r.openShiftId === o.id && r.employeeId === employee.id && open(r))) throw new HttpError(409, 'already_claimed', 'You have already asked for this shift.');
    const check = claimCheck(org.state, employee, slotOf(o));
    if (check.problem) throw new HttpError(409, 'not_eligible', check.problem);
    const blocks = blocking(check.issues);
    if (blocks.length) throw new HttpError(409, 'compliance_block', `You cannot take this shift: ${blocks.map((i) => i.message).join(' ')}`, blocks.map(issueView(org)));
    const r = addRequest(org, { kind: 'open_shift', employeeId: employee.id, siteId: o.siteId, openShiftId: o.id });
    reply.code(201);
    return done(org, ownRequestView(org, r));
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
      const r = addRequest(org, { kind: 'holiday', employeeId: employee.id, siteId: employee.siteId, from, to, hours, ...(req.body.note?.trim() ? { note: req.body.note.trim() } : {}) });
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
      const r = addRequest(org, { kind: 'time_off', employeeId: employee.id, siteId: employee.siteId, absenceType, from, to, ...(req.body.note?.trim() ? { note: req.body.note.trim() } : {}) });
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
      const r = addRequest(org, { kind: 'availability', employeeId: employee.id, siteId: employee.siteId, availability: [...availability].sort((a, b) => a.weekday - b.weekday || a.fromMinute - b.fromMinute), ...(req.body.note?.trim() ? { note: req.body.note.trim() } : {}) });
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
      const r = addRequest(org, { kind: 'sickness', employeeId: employee.id, siteId: employee.siteId, from, absenceId: absence.id, ...(note ? { note } : {}) });
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
