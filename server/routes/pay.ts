import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { reviewEmployee } from '../../src/engine/employees';
import { payTermsOf, sameTerms } from '../../src/engine/payChanges';
import type { Employee, PayChange, PayChangeStatus, PayChangeSummary, PayTerms } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, kick, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard, type Guard } from '../guard';
import { idParam } from '../schemas';
import { audit, type OrgData } from '../store';
import { allowPay, PAYROLL_FIELDS, queueUpsert } from './employees';

// Pay changes need two people: one who sets pay proposes, finance approves (pay.approve). The rate in
// force stays until then, so the rota, the accrual and payroll never run on a number nobody checked.
// A system key, which acts for the organisation rather than a person, still sets pay directly: it
// has no second person to ask, and every change it makes is in the audit trail.

const termsBody = {
  payBasis: { type: 'string', enum: ['hourly', 'salaried'] },
  hourlyRate: { type: 'number', minimum: 0 },
  annualSalary: { type: 'number', minimum: 0 },
} as const;

const RATE_FIELDS = ['payBasis', 'hourlyRate', 'annualSalary'] as const;

/** The terms a body asks for, on top of the terms in force. */
export const proposedTerms = (e: Employee, body: Partial<PayTerms>): PayTerms => ({ ...payTermsOf(e), ...pick(body) });

function pick(body: Partial<PayTerms>): Partial<PayTerms> {
  return Object.fromEntries(RATE_FIELDS.filter((f) => body[f] !== undefined).map((f) => [f, body[f]])) as Partial<PayTerms>;
}

/** Whether a body changes the rate, salary or basis, rather than the employer. */
export const changesRate = (e: Employee, body: Partial<Employee>) => RATE_FIELDS.some((f) => body[f] !== undefined && body[f] !== e[f]);

/** Whether this caller proposes rather than sets: anyone acting as a person. */
export const proposes = (g: Guard) => g.actor.kind === 'user';

/**
 * Records a proposal. The caller must already hold pay.edit for the person (allowPay). A rate below
 * the legal minimum is refused here rather than left for finance to catch. An earlier proposal still
 * waiting for the same person is superseded: finance only ever sees the latest.
 */
export function proposePayChange(org: OrgData, g: Guard, e: Employee, after: PayTerms, reason: string | undefined, today: string): PayChange {
  const before = payTermsOf(e);
  if (sameTerms(before, after)) throw new HttpError(422, 'no_change', `That is ${e.name}'s pay already.`);
  const below = reviewEmployee({ ...e, ...after }, today).find((c) => c.code === 'minimum-wage');
  if (below) throw new HttpError(422, 'below_minimum', below.message);
  for (const c of org.payChanges) {
    if (c.employeeId === e.id && c.status === 'pending') c.status = 'superseded';
  }
  const change: PayChange = {
    id: `pay_${randomUUID().slice(0, 12)}`,
    employeeId: e.id,
    siteId: e.siteId,
    before,
    after,
    ...(reason?.trim() ? { reason: reason.trim() } : {}),
    status: 'pending',
    requestedBy: actorName(g),
    ...(g.user ? { requestedById: g.user.id } : {}),
    requestedAt: new Date().toISOString(),
  };
  org.payChanges.push(change);
  audit(org, actorName(g), 'pay.change_proposed', { id: change.id, employeeId: e.id });
  return change;
}

/** What a person's record shows of a change waiting for finance. */
export function pendingFor(org: OrgData, employeeId: string): PayChangeSummary | undefined {
  const c = org.payChanges.find((x) => x.employeeId === employeeId && x.status === 'pending');
  return c && { id: c.id, after: c.after, reason: c.reason, requestedBy: c.requestedBy, requestedAt: c.requestedAt };
}

/** Who sees a proposal: whoever sets or approves pay at the person's site. */
const sees = (g: Guard, c: PayChange) => g.can('pay.approve', c.siteId) || g.can('pay.edit', c.siteId);

export function payRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('rota:write') };
  const tags = ['Pay'];
  const today = () => ctx.store.todayISO();

  function changeOf(org: OrgData, id: string) {
    const c = org.payChanges.find((x) => x.id === id);
    if (!c) throw notFound(`Pay change ${id}`);
    return c;
  }

  /** Finance decides, and never on a change they proposed or on their own pay. */
  function allowDecision(g: Guard, c: PayChange) {
    g.allow('pay.approve', c.siteId);
    if (g.user && g.user.id === c.requestedById) throw new HttpError(403, 'forbidden', 'Somebody else approves a change you proposed.');
    if (g.user?.employeeId === c.employeeId) throw new HttpError(403, 'forbidden', 'Somebody else decides your own pay.');
    if (c.status !== 'pending') throw new HttpError(409, 'decided', `This change was already ${c.status}.`);
  }

  app.get<{ Querystring: { status?: PayChangeStatus; employeeId?: string } }>(
    '/v1/pay-changes',
    {
      ...read,
      schema: {
        tags,
        description: 'Pay changes proposed and decided, newest first, for the sites where the caller sets or approves pay.',
        querystring: {
          type: 'object',
          properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'withdrawn', 'superseded'] }, employeeId: { type: 'string' } },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      return org.payChanges
        .filter((c) => sees(g, c) && (!req.query.status || c.status === req.query.status) && (!req.query.employeeId || c.employeeId === req.query.employeeId))
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    },
  );

  app.post<{ Params: { id: string }; Body: Partial<PayTerms> & { reason?: string } }>(
    '/v1/employees/:id/pay-changes',
    {
      ...write,
      schema: {
        tags,
        description: 'Proposes new pay for one person. Their pay stays as it is until finance approves.',
        params: idParam,
        body: { type: 'object', additionalProperties: false, properties: { ...termsBody, reason: { type: 'string', maxLength: 500 } } },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const e = org.state.employees.find((x) => x.id === req.params.id);
      if (!e) throw notFound(`Employee ${req.params.id}`);
      const g = guard(ctx, req, org);
      allowPay(g, e);
      const change = proposePayChange(org, g, e, proposedTerms(e, req.body), req.body.reason, today());
      return reply.code(201).send(change);
    },
  );

  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    '/v1/pay-changes/:id/approve',
    {
      ...write,
      schema: {
        tags,
        description: 'Finance approves: the new pay applies from now, and payroll is told.',
        params: idParam,
        body: { type: 'object', additionalProperties: false, properties: { note: { type: 'string', maxLength: 500 } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const c = changeOf(org, req.params.id);
      allowDecision(g, c);
      const e = org.state.employees.find((x) => x.id === c.employeeId);
      if (!e) throw notFound(`Employee ${c.employeeId}`);
      // Approving what was asked against pay that has since moved would undo the later change.
      if (!sameTerms(payTermsOf(e), c.before)) {
        throw new HttpError(409, 'stale', `${e.name}'s pay changed after this was proposed. Reject it and propose again from the pay in force.`);
      }
      const before = { ...e };
      Object.assign(e, c.after);
      Object.assign(c, { status: 'approved', decidedBy: actorName(g), ...(g.user ? { decidedById: g.user.id } : {}), decidedAt: new Date().toISOString(), ...(req.body?.note ? { note: req.body.note } : {}) });
      if (PAYROLL_FIELDS.some((f) => before[f] !== e[f])) queueUpsert(org, e);
      audit(org, actorName(g), 'pay.change_approved', { id: c.id, employeeId: e.id });
      await kick(ctx, org);
      return c;
    },
  );

  app.post<{ Params: { id: string }; Body: { note: string } }>(
    '/v1/pay-changes/:id/reject',
    {
      ...write,
      schema: {
        tags,
        description: 'Finance rejects, with the reason, which the proposer sees. Pay stays as it is.',
        params: idParam,
        body: { type: 'object', required: ['note'], additionalProperties: false, properties: { note: { type: 'string', minLength: 1, maxLength: 500 } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const c = changeOf(org, req.params.id);
      allowDecision(g, c);
      Object.assign(c, { status: 'rejected', decidedBy: actorName(g), ...(g.user ? { decidedById: g.user.id } : {}), decidedAt: new Date().toISOString(), note: req.body.note.trim() });
      audit(org, actorName(g), 'pay.change_rejected', { id: c.id, employeeId: c.employeeId });
      return c;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/pay-changes/:id/withdraw',
    { ...write, schema: { tags, description: 'The proposer, or anyone who sets pay there, takes a waiting change back.', params: idParam } },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const c = changeOf(org, req.params.id);
      g.allow('pay.edit', c.siteId);
      if (c.status !== 'pending') throw new HttpError(409, 'decided', `This change was already ${c.status}.`);
      Object.assign(c, { status: 'withdrawn', decidedBy: actorName(g), ...(g.user ? { decidedById: g.user.id } : {}), decidedAt: new Date().toISOString() });
      audit(org, actorName(g), 'pay.change_withdrawn', { id: c.id, employeeId: c.employeeId });
      return c;
    },
  );
}
