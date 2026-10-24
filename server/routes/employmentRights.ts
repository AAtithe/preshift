import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_ERA_SETTINGS, offerCandidates, offerLetter, offerStanding, type EraSettings, type HoursOffer } from '../../src/engine/employmentRights';
import { addDays } from '../../src/engine/time';
import { requireScope } from '../auth';
import { HttpError, kick, londonToday, notFound, orgOf, type AppContext } from '../context';
import { eraOf, eraSettings } from '../employmentRights';
import { actorName, guard } from '../guard';
import { idParam, isoDate } from '../schemas';
import { audit, type OrgData } from '../store';
import { queueUpsert } from './employees';

const companyOf = (org: OrgData, employeeId: string) => {
  const e = org.state.employees.find((x) => x.id === employeeId);
  return org.state.entities.find((x) => x.id === e?.entityId)?.name ?? 'The company';
};

export function employmentRightsRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('rota:write') };

  app.get<{ Querystring: { siteId: string } }>(
    '/v1/employment-rights',
    {
      ...read,
      schema: {
        tags: ['Employment rights'],
        description:
          "A site's Employment Rights Act position for zero and low hours workers: the settings in force (assumptions until the regulations are made), " +
          'published shifts changed at short notice and what each owes, who is owed or would be owed a guaranteed hours offer, and the offers made. ' +
          'Pay amounts need costs.view at the site.',
        querystring: { type: 'object', required: ['siteId'], properties: { siteId: { type: 'string' } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const { siteId } = req.query;
      if (!org.state.sites.some((s) => s.id === siteId)) throw notFound(`Site ${siteId}`);
      const g = guard(ctx, req, org);
      g.allow('rota.view', siteId);
      const money = g.can('costs.view', siteId);
      const settings = eraSettings(org);
      const today = londonToday(ctx);
      const era = org.era ?? { shortNotice: [], offers: [] };
      const shortNotice = era.shortNotice
        .filter((r) => r.siteId === siteId)
        .map((r) => (money ? r : { ...r, amount: 0 }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const open = shortNotice.filter((r) => r.status === 'open');
      const sum = (rs: typeof shortNotice) => Math.round(rs.reduce((s, r) => s + r.amount, 0) * 100) / 100;
      const offers = era.offers
        .filter((o) => o.siteId === siteId)
        .map((o) => {
          const e = org.state.employees.find((x) => x.id === o.employeeId);
          return { ...o, standing: offerStanding(o, today), letter: e ? offerLetter(e, o, companyOf(org, o.employeeId)) : '' };
        })
        .sort((a, b) => b.offeredOn.localeCompare(a.offeredOn));
      const candidates = offerCandidates(org.state, org.timeEntries, siteId, today, era.offers, settings).map((c) =>
        money ? c : { ...c, weeklyFixedCost: 0 },
      );
      return {
        settings,
        assumptions: DEFAULT_ERA_SETTINGS,
        canEditSettings: g.can('settings.manage'),
        canOffer: g.can('team.manage', siteId),
        canWaive: g.can('pay.approve'),
        shortNotice,
        totals: {
          owed: sum(open.filter((r) => r.owed && !r.sentIn)),
          paid: sum(open.filter((r) => r.owed && r.sentIn)),
          wouldHaveCost: sum(open.filter((r) => !r.owed)),
          waived: sum(shortNotice.filter((r) => r.status === 'waived')),
        },
        candidates,
        offers,
      };
    },
  );

  app.get('/v1/employment-rights/settings', { ...read, schema: { tags: ['Employment rights'], description: 'The settings in force, for checking a change before it is saved.' } }, async (req) => {
    const org = orgOf(req);
    guard(ctx, req, org).allow('rota.view');
    return eraSettings(org);
  });

  app.put<{ Body: Partial<EraSettings> & { shortNoticeFrom?: string | null; guaranteedHoursFrom?: string | null } }>(
    '/v1/employment-rights/settings',
    {
      ...write,
      schema: {
        tags: ['Employment rights'],
        description:
          'Sets the numbers the regulations will fix, and the date each measure starts. Until a start date is set nothing is owed; figures are shown as what it would cost. ' +
          'Setting or moving the short notice start date updates whether each unpaid change is owed.',
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            lowHoursThreshold: { type: 'number', minimum: 0, maximum: 48 },
            referenceWeeks: { type: 'integer', minimum: 4, maximum: 52 },
            compensationShare: { type: 'number', minimum: 0, maximum: 2 },
            shortNoticeHours: { type: 'number', minimum: 1, maximum: 336 },
            responseDays: { type: 'integer', minimum: 1, maximum: 90 },
            shortNoticeFrom: { anyOf: [isoDate, { type: 'null' }] },
            guaranteedHoursFrom: { anyOf: [isoDate, { type: 'null' }] },
          },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      g.allow('settings.manage');
      const era = eraOf(org);
      const before = eraSettings(org);
      const next: EraSettings = { ...before };
      for (const [k, v] of Object.entries(req.body)) {
        if (v === null) delete (next as unknown as Record<string, unknown>)[k];
        else (next as unknown as Record<string, unknown>)[k] = v;
      }
      era.settings = next;
      // Whether a change is owed follows the start date; one already paid stays paid.
      for (const r of era.shortNotice) if (!r.sentIn) r.owed = !!next.shortNoticeFrom && r.original.date >= next.shortNoticeFrom;
      audit(org, actorName(g), 'era.settings_set', { before, after: next });
      return next;
    },
  );

  app.post<{ Body: { employeeId: string; offeredHours: number } }>(
    '/v1/employment-rights/offers',
    {
      ...write,
      schema: {
        tags: ['Employment rights'],
        description: 'Records a guaranteed hours offer made to a worker, worked out on their clocked hours, and returns the offer letter to check, sign and give.',
        body: {
          type: 'object',
          required: ['employeeId', 'offeredHours'],
          additionalProperties: false,
          properties: { employeeId: { type: 'string' }, offeredHours: { type: 'number', minimum: 0.5, maximum: 60 } },
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const employee = org.state.employees.find((e) => e.id === req.body.employeeId);
      if (!employee) throw notFound(`Employee ${req.body.employeeId}`);
      const g = guard(ctx, req, org);
      g.allow('team.manage', employee.siteId);
      const settings = eraSettings(org);
      const today = londonToday(ctx);
      const era = eraOf(org);
      const candidate = offerCandidates(org.state, org.timeEntries, employee.siteId, today, era.offers, settings).find((c) => c.employeeId === employee.id);
      if (!candidate) {
        throw new HttpError(409, 'no_offer_due', `${employee.name} has not worked beyond their contract over the reference weeks, or was offered within them.`);
      }
      if (req.body.offeredHours <= employee.contractedHours) {
        throw new HttpError(400, 'offer_too_low', `An offer must guarantee more than the ${employee.contractedHours} hours ${employee.name} already has.`);
      }
      const offer: HoursOffer = {
        id: `ho_${randomUUID().slice(0, 10)}`,
        employeeId: employee.id,
        siteId: employee.siteId,
        referenceFrom: candidate.referenceFrom,
        referenceTo: candidate.referenceTo,
        averageHours: candidate.averageHours,
        contractedBefore: employee.contractedHours,
        offeredHours: Math.round(req.body.offeredHours * 2) / 2,
        status: 'offered',
        offeredOn: today,
        respondBy: addDays(today, settings.responseDays),
        by: actorName(g),
      };
      era.offers.push(offer);
      audit(org, actorName(g), 'era.offer_made', { id: offer.id, employeeId: employee.id, offeredHours: offer.offeredHours, averageHours: offer.averageHours });
      return reply.code(201).send({ offer, letter: offerLetter(employee, offer, companyOf(org, employee.id)) });
    },
  );

  app.post<{ Params: { id: string }; Body: { response: 'accepted' | 'declined' } }>(
    '/v1/employment-rights/offers/:id/response',
    {
      ...write,
      schema: {
        tags: ['Employment rights'],
        description: "Records the worker's answer. Accepting raises their contracted hours to the offer, and TeamPay is told.",
        params: idParam,
        body: { type: 'object', required: ['response'], additionalProperties: false, properties: { response: { type: 'string', enum: ['accepted', 'declined'] } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const era = eraOf(org);
      const offer = era.offers.find((o) => o.id === req.params.id);
      if (!offer) throw notFound(`Offer ${req.params.id}`);
      const g = guard(ctx, req, org);
      g.allow('team.manage', offer.siteId);
      const today = londonToday(ctx);
      const standing = offerStanding(offer, today);
      if (standing !== 'offered') throw new HttpError(409, 'offer_closed', standing === 'lapsed' ? `This offer lapsed on ${offer.respondBy}.` : `This offer was already ${standing}.`);
      offer.status = req.body.response;
      offer.respondedOn = today;
      offer.respondedBy = actorName(g);
      const employee = org.state.employees.find((e) => e.id === offer.employeeId);
      if (req.body.response === 'accepted' && employee && employee.contractedHours < offer.offeredHours) {
        const before = employee.contractedHours;
        employee.contractedHours = offer.offeredHours;
        queueUpsert(org, employee);
        audit(org, actorName(g), 'employee.updated', { id: employee.id, fields: ['contractedHours'], before, after: offer.offeredHours, reason: `Guaranteed hours offer ${offer.id} accepted` });
      }
      audit(org, actorName(g), `era.offer_${req.body.response}`, { id: offer.id, employeeId: offer.employeeId });
      await kick(ctx, org);
      return { offer, employee };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/v1/employment-rights/short-notice/:id/waive',
    {
      ...write,
      schema: {
        tags: ['Employment rights'],
        description: 'Records that a short notice change owes nothing, for example because the worker asked for it, with the reason. Not possible once paid.',
        params: idParam,
        body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', minLength: 3, maxLength: 300 } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const record = eraOf(org).shortNotice.find((r) => r.id === req.params.id);
      if (!record) throw notFound(`Short notice change ${req.params.id}`);
      const g = guard(ctx, req, org);
      // Waiving pay owed is a pay decision.
      g.allow('pay.approve');
      if (record.sentIn) throw new HttpError(409, 'already_paid', 'This has already gone to payroll.');
      record.status = 'waived';
      record.waivedBy = actorName(g);
      record.waiveReason = req.body.reason.trim();
      record.updatedAt = ctx.now().toISOString();
      audit(org, actorName(g), 'era.short_notice_waived', { id: record.id, amount: record.amount, reason: record.waiveReason });
      return record;
    },
  );
}
