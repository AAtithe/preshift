import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireScope } from '../auth';
import { HttpError, londonParts, notFound, type AppContext } from '../context';
import { acceptOffer, announceTaken, askDueRounds, askNextRound, coverOf, giveCover, labelOf } from '../cover';
import { reachOf } from '../messaging';
import { audit, type OrgData } from '../store';
import { employeeName, messenger, siteName } from './messages';
import { requireStaff } from './staff';
import {
  askable, coverCandidates, coverStatus, currentRound, MAX_NOTE, MAX_ROUND_SIZE, minutesUntil, notAskedBecause, openOffersFor, ROUND_MINUTES, roundOf, waiting,
  type CoverRequest,
} from '../../src/engine/cover';
import { hasStarted } from '../../src/engine/rotaWeek';
import { weekStart } from '../../src/engine/time';
import type { Opening } from '../../src/engine/candidates';

/** Shifts longer than this are not offered as cover: a typing slip, not a shift. */
const MAX_LENGTH = 16 * 60;

type Ask = { shiftId?: string; siteId?: string; roleId?: string; date?: string; startMinute?: number; endMinute?: number };

/**
 * The opening a manager asks cover for: a shift someone cannot work, or a gap given by site, role
 * and times. Refused if it has started, or the caller cannot edit that site's rota.
 */
function openingFor(ctx: AppContext, req: FastifyRequest, body: Ask | undefined) {
  const { g, org, name } = messenger(ctx, req);
  const now = londonParts(ctx.now());
  let opening: Opening;
  let original: { shiftId: string; employeeId: string; published: boolean } | undefined;
  if (body?.shiftId) {
    const shift = org.state.shifts.find((s) => s.id === body.shiftId);
    if (!shift) throw notFound('Shift');
    g.allow('rota.edit', shift.siteId);
    if (org.timeEntries.some((t) => t.shiftId === shift.id)) throw new HttpError(409, 'worked_shift', 'Someone has clocked in for this shift, so it cannot be offered.');
    opening = { siteId: shift.siteId, roleId: shift.roleId, date: shift.date, startMinute: shift.startMinute, endMinute: shift.endMinute };
    original = { shiftId: shift.id, employeeId: shift.employeeId, published: !!shift.published };
  } else {
    const { siteId = '', roleId = '', date = '', startMinute, endMinute } = body ?? {};
    if (!org.state.sites.some((s) => s.id === siteId)) throw notFound('Site');
    if (!org.state.roles.some((r) => r.id === roleId)) throw notFound('Role');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(startMinute) || !Number.isInteger(endMinute)) {
      throw new HttpError(400, 'invalid_opening', 'Give the shift to cover, or a site, role, date and start and end times.');
    }
    g.allow('rota.edit', siteId);
    opening = { siteId, roleId, date, startMinute: startMinute!, endMinute: endMinute! };
  }
  if (opening.endMinute <= opening.startMinute || opening.endMinute - opening.startMinute > MAX_LENGTH) {
    throw new HttpError(422, 'invalid_shift', 'A shift ends after it starts and lasts at most 16 hours.');
  }
  if (hasStarted(opening, now)) throw new HttpError(409, 'started', 'This shift has started. Cover can only be asked for a shift still to come.');
  return { g, org, name, opening, original };
}

function candidatesView(org: OrgData, opening: Opening, original: { shiftId: string; employeeId: string } | undefined, showCost: boolean, reach: Awaited<ReturnType<typeof reachOf>>) {
  return coverCandidates(org.state, opening, { shiftId: original?.shiftId, exclude: original?.employeeId }).map((c) => ({
    employeeId: c.employee.id,
    name: c.employee.name,
    homeSite: c.homeSite,
    borrowed: c.borrowed,
    askable: askable(c),
    reason: notAskedBecause(c),
    warnings: c.warnings.map((w) => w.message),
    // Pay shows only to those who see cost: a marginal cost gives a person's rate away.
    ...(showCost ? { marginal: Math.round(c.marginal * 100) / 100, siteCost: Math.round(c.siteCost * 100) / 100 } : {}),
    app: reach.get(c.employee.id)?.app ?? false,
    channel: reach.get(c.employee.id)?.channel ?? null,
  }));
}

function requestView(org: OrgData, r: CoverRequest, now: { date: string; minute: number }, showCost: boolean) {
  return {
    id: r.id,
    status: coverStatus(r, now),
    siteId: r.siteId,
    siteName: siteName(org, r.siteId),
    roleId: r.roleId,
    date: r.date,
    startMinute: r.startMinute,
    endMinute: r.endMinute,
    label: labelOf(org, r),
    shiftId: r.shiftId ?? null,
    originalName: r.originalEmployeeId ? employeeName(org, r.originalEmployeeId) : null,
    note: r.note ?? null,
    firstToAccept: r.firstToAccept,
    publish: r.publish,
    closes: r.closes,
    rounds: r.rounds ?? null,
    round: currentRound(r),
    nextRoundAt: coverStatus(r, now) === 'open' ? r.nextRoundAt ?? null : null,
    waiting: waiting(r).length,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    filledBy: r.filledBy ? employeeName(org, r.filledBy) : null,
    filledAt: r.filledAt ?? null,
    closedBy: r.closedBy ?? null,
    offers: r.offers.map((o) => ({
      employeeId: o.employeeId,
      name: employeeName(org, o.employeeId),
      borrowed: o.borrowed,
      round: o.round ?? 1,
      asked: !!o.offeredAt,
      skipped: o.skipped ?? null,
      response: o.response ?? null,
      respondedAt: o.respondedAt ?? null,
      via: o.via ?? null,
      refused: o.refused ?? null,
      ...(showCost ? { marginal: o.marginal } : {}),
    })),
  };
}

export function coverRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('rota:write') };
  const hidden = { schema: { hide: true } };
  const london = () => londonParts(ctx.now());

  // Who would be asked, and why anyone is not: the manager sees it before anything is sent.
  app.post<{ Body: Ask }>('/v1/cover/preview', { ...read, ...hidden }, async (req) => {
    const { g, org, opening, original } = openingFor(ctx, req, req.body);
    const reach = await reachOf(ctx.store, org);
    return {
      opening,
      label: labelOf(org, opening),
      original: original ? { ...original, name: employeeName(org, original.employeeId) } : null,
      candidates: candidatesView(org, opening, original, g.can('costs.view', opening.siteId), reach),
    };
  });

  app.post<{ Body: Ask & { employeeIds?: string[]; note?: string; firstToAccept?: boolean; urgent?: boolean; closes?: { date: string; minute: number }; rounds?: { size?: number; everyMinutes?: number } | null } }>(
    '/v1/cover',
    { ...write, ...hidden },
    async (req, reply) => {
      const { g, org, name, opening, original } = openingFor(ctx, req, req.body);
      const requests = coverOf(org);
      const now = london();
      if (original && requests.some((r) => r.shiftId === original.shiftId && coverStatus(r, now) === 'open')) {
        throw new HttpError(409, 'already_asked', 'Cover has already been asked for this shift. Call that request off first to ask again.');
      }
      const note = (req.body?.note ?? '').trim();
      if (note.length > MAX_NOTE) throw new HttpError(400, 'invalid_note', `Keep the note under ${MAX_NOTE} characters.`);
      const askableNow = coverCandidates(org.state, opening, { shiftId: original?.shiftId, exclude: original?.employeeId }).filter(askable);
      const chosen = req.body?.employeeIds;
      const offered = chosen ? askableNow.filter((c) => chosen.includes(c.employee.id)) : askableNow;
      const notAskable = (chosen ?? []).filter((id) => !askableNow.some((c) => c.employee.id === id));
      if (notAskable.length) {
        throw new HttpError(409, 'not_askable', `${notAskable.map((id) => employeeName(org, id)).join(', ')} cannot work this shift under the rota rules, so cannot be asked.`);
      }
      if (offered.length === 0) throw new HttpError(409, 'nobody_free', 'Nobody trained for this role can legally work this shift. It is a gap to fill by hiring or cross-training.');
      const closes = req.body?.closes ?? { date: opening.date, minute: opening.startMinute };
      if (closes.date > opening.date || (closes.date === opening.date && closes.minute > opening.startMinute)) {
        throw new HttpError(400, 'invalid_close', 'Close the request before the shift starts.');
      }
      if (closes.date < now.date || (closes.date === now.date && closes.minute <= now.minute)) throw new HttpError(400, 'invalid_close', 'The close is already past.');
      // The filled shift goes straight to the team only if it would be published anyway, and the requester may publish.
      const weekOut = original ? original.published : org.publications.some((p) => p.siteId === opening.siteId && p.weekStart === weekStart(opening.date));
      // Rounds: the cheapest few first, more as time passes. Pointless when one round would ask everyone.
      const asked = req.body?.rounds;
      if (asked && (!Number.isInteger(asked.size) || asked.size! < 1 || asked.size! > MAX_ROUND_SIZE || !(ROUND_MINUTES as readonly number[]).includes(asked.everyMinutes!))) {
        throw new HttpError(400, 'invalid_rounds', `Ask between 1 and ${MAX_ROUND_SIZE} people a round, every ${ROUND_MINUTES.join(', ')} minutes.`);
      }
      const rounds = asked && asked.size! < offered.length ? { size: asked.size!, everyMinutes: asked.everyMinutes! } : undefined;
      if (rounds && minutesUntil(now, closes) <= rounds.everyMinutes) {
        throw new HttpError(409, 'no_time_for_rounds', `There is not time for a second round before it closes. Ask everyone now, or make the rounds shorter than ${rounds.everyMinutes} minutes.`);
      }
      const at = ctx.now().toISOString();
      const request: CoverRequest = {
        id: `cov_${randomUUID()}`,
        ...opening,
        ...(original ? { shiftId: original.shiftId, originalEmployeeId: original.employeeId } : {}),
        ...(note ? { note } : {}),
        firstToAccept: req.body?.firstToAccept !== false,
        publish: weekOut && g.can('rota.publish', opening.siteId),
        closes,
        offers: offered.map((c, i) => ({ employeeId: c.employee.id, marginal: Math.round(c.marginal * 100) / 100, borrowed: c.borrowed, round: roundOf(i, rounds) })),
        ...(rounds ? { rounds } : {}),
        ...(req.body?.urgent === true ? { urgent: true } : {}),
        status: 'open',
        createdAt: at,
        createdBy: name,
      };
      requests.push(request);
      audit(org, name, 'cover.requested', { id: request.id, siteId: request.siteId, shiftId: request.shiftId, offered: request.offers.length, rounds });
      await askNextRound(ctx, org, request, name);
      return reply.code(201).send(requestView(org, request, now, g.can('costs.view', request.siteId)));
    },
  );

  app.get<{ Querystring: { siteId?: string } }>('/v1/cover', { ...read, ...hidden }, async (req) => {
    const { g, org } = messenger(ctx, req);
    const now = london();
    return coverOf(org)
      .filter((r) => g.can('rota.edit', r.siteId) && (!req.query.siteId || r.siteId === req.query.siteId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100)
      .map((r) => requestView(org, r, now, g.can('costs.view', r.siteId)));
  });

  /** The request, if the caller edits its site's rota. */
  function requestOf(req: FastifyRequest<{ Params: { id: string } }>) {
    const p = messenger(ctx, req);
    const r = coverOf(p.org).find((x) => x.id === req.params.id);
    if (!r) throw notFound('Cover request');
    p.g.allow('rota.edit', r.siteId);
    return { ...p, r };
  }

  // When the manager chooses: one of those who said yes.
  app.post<{ Params: { id: string }; Body: { employeeId?: string } }>('/v1/cover/:id/assign', { ...write, ...hidden }, async (req) => {
    const { g, org, r, name } = requestOf(req);
    const offer = r.offers.find((o) => o.employeeId === req.body?.employeeId);
    if (!offer || offer.response !== 'accepted') throw new HttpError(409, 'not_accepted', 'Choose someone who has said yes.');
    const employee = org.state.employees.find((e) => e.id === offer.employeeId);
    if (!employee) throw notFound('Employee');
    const taken = giveCover(org, r, employee, name, ctx.now());
    if (taken.kind === 'refused') {
      offer.refused = taken.reason;
      throw new HttpError(409, 'not_given', `${employee.name} cannot be given it: ${taken.reason}`);
    }
    await announceTaken(ctx, org, taken);
    return requestView(org, r, london(), g.can('costs.view', r.siteId));
  });

  // The manager does not want to wait for the next round: ask the next one now, or everyone left.
  app.post<{ Params: { id: string }; Body: { everyone?: boolean } }>('/v1/cover/:id/next', { ...write, ...hidden }, async (req) => {
    const { g, org, r, name } = requestOf(req);
    if (coverStatus(r, london()) !== 'open') throw new HttpError(409, 'not_open', 'This request is no longer open.');
    if (waiting(r).length === 0) throw new HttpError(409, 'nobody_left', 'Everyone who could work it has been asked.');
    await askNextRound(ctx, org, r, name, req.body?.everyone === true);
    return requestView(org, r, london(), g.can('costs.view', r.siteId));
  });

  app.post<{ Params: { id: string } }>('/v1/cover/:id/cancel', { ...write, ...hidden }, async (req) => {
    const { g, org, r, name } = requestOf(req);
    if (coverStatus(r, london()) !== 'open') throw new HttpError(409, 'not_open', 'This request is no longer open.');
    r.status = 'cancelled';
    r.closedAt = ctx.now().toISOString();
    r.closedBy = name;
    audit(org, name, 'cover.cancelled', { id: r.id });
    return requestView(org, r, london(), g.can('costs.view', r.siteId));
  });
}

/** The staff app's side: offers made to the person, and their yes or no. */
export function staffCoverRoutes(app: FastifyInstance, ctx: AppContext) {
  const { store } = ctx;
  const hidden = { schema: { hide: true } };

  const offersView = (org: OrgData, employeeId: string) => {
    const now = londonParts(ctx.now());
    return openOffersFor(coverOf(org), employeeId, now).map((r) => ({ id: r.id, label: labelOf(org, r), note: r.note ?? null, firstToAccept: r.firstToAccept, closes: r.closes }));
  };

  app.get('/v1/staff/cover', hidden, async (req) => {
    const { org, employee } = await requireStaff(req, store);
    return { offers: offersView(org, employee.id) };
  });

  app.post<{ Params: { id: string } }>('/v1/staff/cover/:id/accept', hidden, async (req) => {
    const { org, employee } = await requireStaff(req, store);
    const r = coverOf(org).find((x) => x.id === req.params.id && x.offers.some((o) => o.employeeId === employee.id));
    if (!r) throw notFound('Cover offer');
    const taken = acceptOffer(org, r, employee, 'app', ctx.now());
    await announceTaken(ctx, org, taken);
    // A yes that could not be given may leave everyone asked out of the running: the next round goes now.
    if (taken.kind === 'refused') await askDueRounds(ctx, org);
    await store.save(org);
    return {
      outcome: taken.kind,
      ...(taken.kind === 'refused' ? { reason: taken.reason } : {}),
      offers: offersView(org, employee.id),
    };
  });

  app.post<{ Params: { id: string } }>('/v1/staff/cover/:id/decline', hidden, async (req) => {
    const { org, employee } = await requireStaff(req, store);
    const r = coverOf(org).find((x) => x.id === req.params.id);
    const offer = r?.offers.find((o) => o.employeeId === employee.id);
    if (!r || !offer) throw notFound('Cover offer');
    if (!offer.response) {
      offer.response = 'declined';
      offer.respondedAt = ctx.now().toISOString();
      offer.via = 'app';
      audit(org, `staff:${employee.id}`, 'cover.declined', { id: r.id, employeeId: employee.id });
      // When everyone asked so far has said no, the next round need not wait for its time.
      await askDueRounds(ctx, org);
      await store.save(org);
    }
    return { offers: offersView(org, employee.id) };
  });
}
