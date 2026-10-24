import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { can, heldPermissions } from '../../src/engine/access';
import { reviewEmployee } from '../../src/engine/employees';
import { backPayFor, payTermsOf, sameTerms } from '../../src/engine/payChanges';
import { approvalDigest, DEFAULT_PAY_POLICY, nextCutoff, standingOf, type PayPolicy } from '../../src/engine/payPolicy';
import { addDays } from '../../src/engine/time';
import { entriesAsShifts } from '../../src/engine/timesheet';
import { refreshReview } from '../../src/engine/payrollMatch';
import type { Employee, PayChange, PayChangeStatus, PayChangeSummary, PayTerms } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, kick, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard, type Guard } from '../guard';
import { emailSetting, linkFor, parseEmailSettings, payApprovalEmail, sendMail } from '../mail';
import { idParam, isoDate } from '../schemas';
import { audit, type OrgData, type Store } from '../store';
import { allowPay, PAYROLL_FIELDS, queueUpsert } from './employees';

// Pay changes need two people: one who sets pay proposes, finance approves (pay.approve). The rate in
// force stays until then, so the rota, the accrual and payroll never run on a number nobody checked.
// A key made in the app proposes like the person who made it: otherwise anyone who may make keys
// could set pay, their own included, with nobody checking. Only a deployment's own key, set in its
// environment rather than made by a person, still sets pay directly; every change is in the audit trail.

const termsBody = {
  payBasis: { type: 'string', enum: ['hourly', 'salaried'] },
  hourlyRate: { type: 'number', minimum: 0 },
  annualSalary: { type: 'number', minimum: 0 },
} as const;

const RATE_FIELDS = ['payBasis', 'hourlyRate', 'annualSalary'] as const;

export const NO_APPROVER = 'Nobody else can approve pay changes yet, so it applied at once. Appoint a finance director in Access.';
export const SET_BY_SYSTEM = 'Set directly by a system key, which acts for the organisation rather than a person.';

/** How far back or ahead a change may be dated: back pay beyond a year is a claim, not a pay change. */
const EFFECTIVE_REACH_DAYS = 365;

export const payPolicyOf = (org: OrgData): PayPolicy => ({ ...DEFAULT_PAY_POLICY, ...org.payPolicy });

/** Clocked and approved time as shifts: the hours back pay is worked out on, as payroll paid them. */
const workedShifts = (org: OrgData) => entriesAsShifts(org.timeEntries);

/**
 * Puts a change's terms on the person's record on a day, with back pay for any work done between
 * the date it was agreed from and that day. Payroll is told of the new pay, and of the arrears with
 * the next hours sent.
 */
export function applyTerms(org: OrgData, actor: string, c: PayChange, e: Employee, on: string) {
  const before = { ...e };
  Object.assign(e, c.after);
  // Linked to TeamPay with pay that differed: once Preshift's pay matches payroll's, nothing is left to decide.
  if (e.payrollReview) e.payrollReview = refreshReview(e, e.payrollReview);
  c.appliedOn = on;
  const owed = c.effectiveFrom ? backPayFor(c, c.effectiveFrom, on, workedShifts(org), org.state.shifts) : null;
  if (owed) c.backPay = owed;
  if (PAYROLL_FIELDS.some((f) => before[f] !== e[f])) queueUpsert(org, e);
  // The record itself changed now, so systems that follow employee changes hear of it now.
  audit(org, actor, 'employee.updated', { id: e.id, fields: RATE_FIELDS.filter((f) => before[f] !== e[f]) });
  if (owed) audit(org, actor, 'pay.back_pay_due', { id: c.id, employeeId: e.id });
}

/**
 * Records pay set without a second person, so the pay history is one list however a change was
 * made: by a system key, or by a person when nobody else could approve.
 */
export function recordDirect(org: OrgData, g: Guard, e: Employee, before: PayTerms, direct: NonNullable<PayChange['direct']>, today: string): PayChange | null {
  if (sameTerms(before, payTermsOf(e))) return null;
  const at = new Date().toISOString();
  const change: PayChange = {
    id: `pay_${randomUUID().slice(0, 12)}`,
    employeeId: e.id,
    siteId: e.siteId,
    before,
    after: payTermsOf(e),
    status: 'approved',
    requestedBy: actorName(g),
    ...(g.behind ? { requestedById: g.behind.id } : {}),
    requestedAt: at,
    decidedBy: actorName(g),
    ...(g.behind ? { decidedById: g.behind.id } : {}),
    decidedAt: at,
    appliedOn: today,
    direct,
    note: direct === 'system' ? SET_BY_SYSTEM : NO_APPROVER,
  };
  org.payChanges.push(change);
  audit(org, actorName(g), 'pay.change_direct', { id: change.id, employeeId: e.id, direct });
  return change;
}

/**
 * Applies approved changes whose date has come. A change whose starting pay has moved since it was
 * approved is not applied over the later pay: it is marked replaced, for finance to look at again.
 */
export function applyDuePayChanges(org: OrgData, today: string): number {
  let applied = 0;
  for (const c of org.payChanges) {
    if (c.status !== 'approved' || c.appliedOn || !c.effectiveFrom || c.effectiveFrom > today) continue;
    const e = org.state.employees.find((x) => x.id === c.employeeId);
    if (!e) continue;
    if (!sameTerms(payTermsOf(e), c.before)) {
      Object.assign(c, { status: 'superseded', note: `${e.name}'s pay changed before this took effect on ${c.effectiveFrom}, so it was not applied. Propose it again from the pay in force.` });
      audit(org, 'Preshift', 'pay.change_withdrawn', { id: c.id, employeeId: e.id });
      continue;
    }
    applyTerms(org, 'Preshift', c, e, today);
    audit(org, 'Preshift', 'pay.change_applied', { id: c.id, employeeId: e.id });
    applied++;
  }
  return applied;
}

/** Everyone active whose role approves pay, whether or not their authenticator is set up yet. */
export const approversOf = (org: OrgData, today: string) => org.users.filter((u) => u.status === 'active' && heldPermissions(u, today).has('pay.approve'));

/**
 * The daily reminder: each approver hears how many changes wait and how old the oldest is. When one
 * is past the turnaround, or the payroll cut-off is today or tomorrow with changes waiting, the owner
 * is copied in. Without email set up, nothing is sent and the screen carries the same message.
 */
export async function remindApprovers(store: Store, org: OrgData, today: string): Promise<{ sent: number; escalated: boolean } | null> {
  const pending = org.payChanges.filter((c) => c.status === 'pending');
  if (!pending.length) return null;
  const digest = approvalDigest(pending, today, payPolicyOf(org));
  const settings = parseEmailSettings(await store.getSetting(emailSetting(org.orgId)));
  const owners = digest.escalate ? org.users.filter((u) => u.status === 'active' && can(u, 'settings.manage', today)) : [];
  const to = [...new Map([...approversOf(org, today), ...owners].map((u) => [u.id, u])).values()];
  let sent = 0;
  if (settings) {
    for (const u of to) {
      const escalated = owners.includes(u) && !approversOf(org, today).includes(u);
      if ((await sendMail(settings, payApprovalEmail(u.email, u.name, digest, linkFor(settings, '/app/?view=pay'), escalated))) !== null) sent++;
    }
  }
  audit(org, 'Preshift', 'pay.reminder_sent', { waiting: digest.waiting, overdue: digest.overdue, people: sent, escalated: digest.escalate });
  return { sent, escalated: digest.escalate };
}

/** Once a day for each organisation: changes whose date has come take effect, and finance is reminded. */
export async function payDaily(store: Store, org: OrgData, today: string) {
  const applied = applyDuePayChanges(org, today);
  const reminded = await remindApprovers(store, org, today);
  org.payDailyOn = today;
  return { applied, reminded };
}

/** The terms a body asks for, on top of the terms in force. */
export const proposedTerms = (e: Employee, body: Partial<PayTerms>): PayTerms => ({ ...payTermsOf(e), ...pick(body) });

function pick(body: Partial<PayTerms>): Partial<PayTerms> {
  return Object.fromEntries(RATE_FIELDS.filter((f) => body[f] !== undefined).map((f) => [f, body[f]])) as Partial<PayTerms>;
}

/** Whether a body changes the rate, salary or basis, rather than the employer. */
export const changesRate = (e: Employee, body: Partial<Employee>) => RATE_FIELDS.some((f) => body[f] !== undefined && body[f] !== e[f]);

/**
 * Whether someone other than the caller holds pay.approve: an active person whose role carries it,
 * even if their authenticator is still to be set up. Without one (a new business run by its owner
 * alone) a change has nobody to wait for, so it applies at once and is recorded as such; the Access
 * overview flags that nobody can approve pay.
 */
export function approverExists(org: OrgData, g: Guard, today: string): boolean {
  return org.users.some((u) => u.status === 'active' && u.id !== g.behind?.id && heldPermissions(u, today).has('pay.approve'));
}

/** Whether this caller proposes rather than sets: a person, or a key a person made, when someone else can approve. */
export const proposes = (g: Guard, org: OrgData, today: string) => (g.actor.kind === 'user' || g.appKey) && approverExists(org, g, today);

/**
 * Records a proposal. The caller must already hold pay.edit for the person (allowPay). A rate below
 * the legal minimum is refused here rather than left for finance to catch. An earlier proposal still
 * waiting for the same person is superseded: finance only ever sees the latest.
 */
export function proposePayChange(org: OrgData, g: Guard, e: Employee, after: PayTerms, reason: string | undefined, today: string, effectiveFrom?: string): PayChange {
  const before = payTermsOf(e);
  if (sameTerms(before, after)) throw new HttpError(422, 'no_change', `That is ${e.name}'s pay already.`);
  if (effectiveFrom) {
    if (effectiveFrom < addDays(today, -EFFECTIVE_REACH_DAYS) || effectiveFrom > addDays(today, EFFECTIVE_REACH_DAYS)) {
      throw new HttpError(422, 'invalid_dates', 'A pay change takes effect within a year either side of today.');
    }
    if (e.startDate && effectiveFrom < e.startDate) throw new HttpError(422, 'invalid_dates', `${e.name} started on ${e.startDate}: a change cannot take effect before that.`);
  }
  // A change already approved and still to take effect would be undone by this one: take it back first.
  const scheduled = org.payChanges.find((c) => c.employeeId === e.id && c.status === 'approved' && !c.appliedOn);
  if (scheduled) {
    throw new HttpError(409, 'scheduled', `${e.name} already has new pay approved from ${scheduled.effectiveFrom}. Withdraw that first, or propose this after it takes effect.`);
  }
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
    ...(effectiveFrom ? { effectiveFrom } : {}),
    status: 'pending',
    requestedBy: actorName(g),
    ...(g.behind ? { requestedById: g.behind.id } : {}),
    requestedAt: new Date().toISOString(),
  };
  org.payChanges.push(change);
  audit(org, actorName(g), 'pay.change_proposed', { id: change.id, employeeId: e.id });
  return change;
}

/** What a person's record shows of a change waiting for finance. */
export function pendingFor(org: OrgData, employeeId: string): PayChangeSummary | undefined {
  const c = org.payChanges.find((x) => x.employeeId === employeeId && x.status === 'pending');
  return c && { id: c.id, after: c.after, reason: c.reason, requestedBy: c.requestedBy, requestedAt: c.requestedAt, ...(c.effectiveFrom ? { effectiveFrom: c.effectiveFrom } : {}) };
}

/** Who sees a proposal: whoever sets or approves pay at the person's site. */
const sees = (g: Guard, c: PayChange) => g.can('pay.approve', c.siteId) || g.can('pay.edit', c.siteId);

export function payRoutes(app: FastifyInstance, ctx: AppContext) {
  // Proposals carry pay: a key reads them with employees:read, as it reads staff records and rates.
  const read = { preHandler: requireScope('employees:read') };
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
    if (!g.user) throw new HttpError(403, 'forbidden', 'A person decides pay, not an API key.');
    if (g.behind && g.behind.id === c.requestedById) throw new HttpError(403, 'forbidden', 'Somebody else approves a change you proposed.');
    if (g.behind?.employeeId === c.employeeId) throw new HttpError(403, 'forbidden', 'Somebody else decides your own pay.');
    if (c.status !== 'pending') throw new HttpError(409, 'decided', `This change was already ${c.status}.`);
  }

  /** Whoever sets or approves pay anywhere reads the rule; finance, or whoever runs the organisation's settings, changes it. */
  function seesPolicy(g: Guard) {
    const reach = g.sites('pay.edit', 'pay.approve');
    if (reach !== 'all' && reach.size === 0) g.allow('pay.approve');
  }

  /** A waiting change with where it stands against the turnaround and the next payroll cut-off. */
  const withStanding = (org: OrgData, c: PayChange) => (c.status === 'pending' ? { ...c, standing: standingOf(c, today(), payPolicyOf(org)) } : c);

  app.get<{ Querystring: { status?: PayChangeStatus; employeeId?: string } }>(
    '/v1/pay-changes',
    {
      ...read,
      schema: {
        tags,
        description:
          'Pay changes proposed and decided, newest first, for the sites where the caller sets or approves pay. Every change ' +
          'to pay is here, including those set directly (direct: system or no_approver). A waiting change carries its standing ' +
          'against the turnaround and the next payroll cut-off.',
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
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
        .map((c) => withStanding(org, c));
    },
  );

  app.get(
    '/v1/pay-policy',
    {
      ...read,
      schema: {
        tags,
        description:
          'The rule for pay approvals: the working days finance has to decide, and the day hours go to payroll. With it, who ' +
          'can approve: each finance approver and whether their authenticator is set up. canApprove is false when nobody is ready, ' +
          'in which case changes either wait for someone to set one up or, with no approver at all, apply at once.',
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      seesPolicy(g);
      const approvers = approversOf(org, today()).map((u) => ({ id: u.id, name: u.name, ready: can(u, 'pay.approve', today()) }));
      const policy = payPolicyOf(org);
      return { policy, nextCutoff: nextCutoff(today(), policy), approvers, canApprove: approvers.some((a) => a.ready) };
    },
  );

  app.put<{ Body: Partial<PayPolicy> }>(
    '/v1/pay-policy',
    {
      ...write,
      schema: {
        tags,
        description: 'Sets the turnaround for pay approvals (1 to 10 working days) and the weekday hours go to payroll (0 = Monday). Finance or the owner.',
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { turnaroundDays: { type: 'integer', minimum: 1, maximum: 10 }, cutoffWeekday: { type: 'integer', minimum: 0, maximum: 6 } },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      if (!g.can('settings.manage')) g.allow('pay.approve');
      org.payPolicy = { ...payPolicyOf(org), ...req.body };
      audit(org, actorName(g), 'pay.policy_updated', { ...org.payPolicy });
      return org.payPolicy;
    },
  );

  app.post<{ Params: { id: string }; Body: Partial<PayTerms> & { reason?: string; effectiveFrom?: string } }>(
    '/v1/employees/:id/pay-changes',
    {
      ...write,
      schema: {
        tags,
        description:
          'Proposes new pay for one person, optionally from an agreed date (effectiveFrom). Their pay stays as it is until finance ' +
          'approves. Approved before that date, it takes effect on the day; approved after it, it applies at once with back pay for the gap.',
        params: idParam,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { ...termsBody, reason: { type: 'string', maxLength: 500 }, effectiveFrom: isoDate },
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const e = org.state.employees.find((x) => x.id === req.params.id);
      if (!e) throw notFound(`Employee ${req.params.id}`);
      const g = guard(ctx, req, org);
      allowPay(g, e);
      const change = proposePayChange(org, g, e, proposedTerms(e, req.body), req.body.reason, today(), req.body.effectiveFrom);
      if (!proposes(g, org, today())) {
        // Nobody else can approve, or a deployment's own key set it: it applies now, or on its date, and its record says why.
        const direct = approverExists(org, g, today()) ? 'system' : 'no_approver';
        Object.assign(change, { status: 'approved', direct, decidedBy: actorName(g), ...(g.behind ? { decidedById: g.behind.id } : {}), decidedAt: change.requestedAt, note: direct === 'system' ? SET_BY_SYSTEM : NO_APPROVER });
        if (!change.effectiveFrom || change.effectiveFrom <= today()) applyTerms(org, actorName(g), change, e, today());
        audit(org, actorName(g), 'pay.change_direct', { id: change.id, employeeId: e.id, direct });
        await kick(ctx, org);
      }
      return reply.code(201).send(withStanding(org, change));
    },
  );

  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    '/v1/pay-changes/:id/approve',
    {
      ...write,
      schema: {
        tags,
        description:
          'Finance approves. The new pay applies now, or on its effective date if that is ahead; payroll is told when it applies. ' +
          'Approved after its effective date, back pay for the work in between goes to payroll with the next hours.',
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
      Object.assign(c, { status: 'approved', decidedBy: actorName(g), ...(g.user ? { decidedById: g.user.id } : {}), decidedAt: new Date().toISOString(), ...(req.body?.note ? { note: req.body.note } : {}) });
      audit(org, actorName(g), 'pay.change_approved', { id: c.id, employeeId: e.id, ...(c.effectiveFrom ? { effectiveFrom: c.effectiveFrom } : {}) });
      if (!c.effectiveFrom || c.effectiveFrom <= today()) applyTerms(org, actorName(g), c, e, today());
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
    {
      ...write,
      schema: {
        tags,
        description:
          'Takes a change back. A waiting one: the proposer, or anyone who sets pay there. One approved and still to take effect: finance, never on their own pay.',
        params: idParam,
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const c = changeOf(org, req.params.id);
      const scheduled = c.status === 'approved' && !c.appliedOn;
      if (scheduled) {
        g.allow('pay.approve', c.siteId);
        if (g.behind?.employeeId === c.employeeId) throw new HttpError(403, 'forbidden', 'Somebody else decides your own pay.');
      } else {
        g.allow('pay.edit', c.siteId);
        if (c.status !== 'pending') throw new HttpError(409, 'decided', `This change was already ${c.status}.`);
      }
      Object.assign(c, { status: 'withdrawn', decidedBy: actorName(g), ...(g.user ? { decidedById: g.user.id } : {}), decidedAt: new Date().toISOString() });
      audit(org, actorName(g), 'pay.change_withdrawn', { id: c.id, employeeId: c.employeeId });
      return c;
    },
  );

  app.post(
    '/v1/pay-changes/remind',
    {
      ...write,
      schema: {
        tags,
        description: 'Sends the reminder of waiting pay changes now, as the daily run does: to finance, and the owner too when something is overdue or the cut-off is close.',
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      seesPolicy(g);
      if (!g.user && !g.behind) throw new HttpError(403, 'forbidden', 'A person sends reminders, not an API key.');
      const done = await remindApprovers(ctx.store, org, today());
      if (!done) throw new HttpError(409, 'nothing_waiting', 'No pay changes are waiting.');
      return done;
    },
  );
}
