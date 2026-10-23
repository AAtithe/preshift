import type { FastifyInstance } from 'fastify';
import { adoptPayroll, candidates, differences, type MatchLevel } from '../../src/engine/payrollMatch';
import { payTermsOf, sameTerms } from '../../src/engine/payChanges';
import type { Employee } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, kick, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import type { PayrollRecord } from '../integrations/payroll/provider';
import { PayrollError } from '../integrations/payroll/provider';
import { enqueue } from '../outbox';
import { employerStatus } from '../payrollEmployers';
import { idParam } from '../schemas';
import { audit, type OrgData } from '../store';
import { approverExists, NO_APPROVER, pendingFor, proposePayChange, proposes } from './pay';

// Linking a person in Preshift to the record their payroll already holds, for a team that was on
// TeamPay before Preshift. Linking decides where their hours are paid, so it needs payroll.send.
// A difference in pay is settled under the same two-person rule as any pay change: taking
// TeamPay's pay into Preshift is a proposal finance approves, and sending Preshift's pay to TeamPay
// changes what the person is actually paid, so finance (pay.approve) decides it themselves. A
// business with nobody else who can approve applies either at once, as pay changes do there.

type Keep = 'payroll' | 'preshift';

function employerOf(ctx: AppContext, org: OrgData, entityId: string) {
  const entity = org.state.entities.find((e) => e.id === entityId);
  if (!entity) throw notFound(`Company ${entityId}`);
  const status = employerStatus(org, entity, ctx.employers);
  if (!status.employerId) throw new HttpError(409, 'payroll_employer_missing', status.problem ?? `${entity.name} has no TeamPay employer`);
  return status.employerId;
}

async function payrollRecords(ctx: AppContext, org: OrgData, employerId: string): Promise<PayrollRecord[]> {
  try {
    return await ctx.providerFor(org.orgId).listEmployees(employerId);
  } catch (err) {
    if (err instanceof PayrollError) throw new HttpError(502, 'payroll_unavailable', `Could not read TeamPay: ${err.message}`);
    throw err;
  }
}

/** Payroll ids already linked to someone in Preshift other than `except`. */
const linkedElsewhere = (org: OrgData, except?: string) =>
  new Map(org.state.employees.filter((e) => e.payrollId && e.id !== except).map((e) => [e.payrollId!, e]));

/** Whether any of this person's hours have gone to payroll or come back in a pay run under their current link. */
function hasPayrollHistory(org: OrgData, e: Employee) {
  const sent = org.outbox.some(
    (i) => i.type === 'hours.submit' && i.status === 'delivered' && i.payload.batch.lines.some((l) => l.employeeId === e.id),
  );
  const paid = org.payRuns.some((r) => r.variance.lines.some((l) => l.employeeId === e.id));
  return sent || paid;
}

export function payrollLinkRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('employees:read') };
  const write = { preHandler: requireScope('payroll:write') };

  app.get<{ Querystring: { entityId: string } }>(
    '/v1/integrations/payroll/link',
    {
      ...read,
      schema: {
        tags: ['Payroll'],
        description:
          "One company's TeamPay records beside its people in Preshift: who is linked to which record, who is not, " +
          'the records that could be each unlinked person, and any links waiting for a decision on differences.',
        querystring: { type: 'object', required: ['entityId'], properties: { entityId: { type: 'string' } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      guard(ctx, req, org).allow('payroll.view');
      const employerId = employerOf(ctx, org, req.query.entityId);
      const records = await payrollRecords(ctx, org, employerId);
      const linked = linkedElsewhere(org);
      const people = org.state.employees.filter((e) => e.entityId === req.query.entityId && e.status !== 'leaver');
      const held = new Map(
        org.outbox
          .filter((i) => i.type === 'employee.upsert' && i.status === 'failed' && i.reason)
          .map((i) => [(i.payload as { employeeId: string }).employeeId, i.reason!]),
      );
      return {
        employerId,
        records: records.map((r) => ({ ...r, linkedTo: linked.get(r.payrollId)?.id ?? null })),
        people: people.map((e) => {
          const record = e.payrollId ? records.find((r) => r.payrollId === e.payrollId) : undefined;
          return {
            employeeId: e.id,
            name: e.name,
            siteId: e.siteId,
            payrollId: e.payrollId ?? null,
            // A link to an id the payroll no longer holds is shown, never quietly dropped.
            missingFromPayroll: !!e.payrollId && !record,
            review: e.payrollReview ?? null,
            // The proposal raised to take TeamPay's pay, while finance has it.
            pendingPay: e.payrollReview?.payChangeId ? pendingFor(org, e.id) ?? null : null,
            // A starter stopped because TeamPay may already hold them, or holds two equally likely records.
            held: e.payrollId ? null : held.get(e.id) ?? null,
            suggestions: e.payrollId
              ? []
              : candidates(e, records, new Set(linked.keys())).map((m) => ({
                  payrollId: m.record.payrollId,
                  level: m.level as MatchLevel,
                  differences: differences(e, m.record),
                })),
          };
        }),
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { payrollId: string; keep?: Keep } }>(
    '/v1/employees/:id/payroll-link',
    {
      ...write,
      schema: {
        tags: ['Payroll'],
        description:
          'Links a person to the record TeamPay already holds for them, instead of setting them up again. Where the two ' +
          'differ, keep says which is right: payroll takes TeamPay\'s values into Preshift, preshift sends Preshift\'s to TeamPay. ' +
          'Sent again with the same payrollId, it settles the differences of an existing link.',
        params: idParam,
        body: {
          type: 'object',
          required: ['payrollId'],
          additionalProperties: false,
          properties: { payrollId: { type: 'string', minLength: 1 }, keep: { enum: ['payroll', 'preshift'] } },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      g.allow('payroll.send');
      const i = org.state.employees.findIndex((e) => e.id === req.params.id);
      if (i < 0) throw notFound(`Employee ${req.params.id}`);
      const e = org.state.employees[i];
      const { payrollId, keep } = req.body;
      if (e.payrollId && e.payrollId !== payrollId) {
        throw new HttpError(409, 'already_linked', `${e.name} is already linked to TeamPay record ${e.payrollId}. Unlink them first.`);
      }
      const employerId = e.payrollId && e.payrollEmployerId ? e.payrollEmployerId : employerOf(ctx, org, e.entityId);
      const record = (await payrollRecords(ctx, org, employerId)).find((r) => r.payrollId === payrollId);
      if (!record) throw new HttpError(404, 'not_on_payroll', `TeamPay has no record ${payrollId} for this company`);
      const other = linkedElsewhere(org, e.id).get(payrollId);
      if (other) throw new HttpError(409, 'linked_elsewhere', `That TeamPay record is already linked to ${other.name}.`);
      if (record.leaveDate) throw new HttpError(409, 'payroll_leaver', `That TeamPay record left on ${record.leaveDate}. Re-employ them in TeamPay first.`);

      const diffs = differences(e, record);
      if (diffs.length && !keep) {
        throw new HttpError(422, 'differences', `${e.name} differs from TeamPay. Say which is right.`, diffs);
      }
      const today = ctx.store.todayISO();
      const pay = diffs.filter((d) => d.pay);
      const twoPeople = approverExists(org, g, today);
      // Duties stay split as they are for pay: whoever links raises TeamPay's figure as a proposal for
      // finance, and only finance sends Preshift's figure over what payroll pays. Never on your own pay.
      if (pay.length && g.behind?.employeeId === e.id) throw new HttpError(403, 'forbidden', 'Somebody else decides your own pay.');
      if (pay.length && keep === 'preshift' && twoPeople && g.actor.kind === 'user') g.allow('pay.approve', e.siteId);

      const now = new Date().toISOString();
      let next: Employee = { ...e, payrollId, payrollEmployerId: employerId, payrollReview: undefined };
      let proposal: { id: string } | null = null;
      if (diffs.length && keep === 'payroll') {
        // Everything but pay is taken now. Pay is taken now only where nobody else could approve it.
        const propose = pay.length > 0 && proposes(g, org, today);
        const adopted = adoptPayroll(next, propose ? diffs.filter((d) => !d.pay) : diffs, record);
        next = { ...adopted, payrollReview: undefined };
        if (propose) {
          const after = payTermsOf(adoptPayroll(next, pay, record));
          if (!sameTerms(after, payTermsOf(next))) {
            // Raised by whoever links, without pay.edit: it proposes payroll's own figure, not a rate of their choosing.
            proposal = proposePayChange(org, g, next, after, `To match their TeamPay record (${payrollId})`, today);
            // Hours wait while finance has it: the review keeps the pay differences until it is approved.
            next = { ...next, payrollReview: { linkedAt: now, how: e.payrollReview?.how ?? 'manual', differences: pay, payChangeId: proposal.id } };
          }
        }
      }
      org.state.employees[i] = next;

      // A starter still waiting to be created would now make a second record: it is withdrawn.
      const before = org.outbox.length;
      org.outbox = org.outbox.filter((item) => !(item.type === 'employee.upsert' && item.payload.employeeId === e.id && item.status !== 'delivered'));
      const withdrawn = before - org.outbox.length;
      if (diffs.length && keep === 'preshift') {
        enqueue(org, { type: 'employee.upsert', payload: { employeeId: e.id }, idempotencyKey: `emp:${e.id}:link:${payrollId}:${now}` });
      }
      audit(org, actorName(g), e.payrollId ? 'payroll.review_settled' : 'payroll.linked', {
        employeeId: e.id,
        payrollId,
        keep: diffs.length ? keep : undefined,
        differences: diffs.map((d) => d.field),
        withdrawn,
        ...(proposal ? { payChange: proposal.id } : {}),
        ...(pay.length && !twoPeople ? { note: NO_APPROVER } : {}),
      });
      await kick(ctx, org);
      return { employee: next, differences: diffs, kept: diffs.length ? keep : null, withdrawn, payChange: proposal };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/employees/:id/payroll-new-starter',
    {
      ...write,
      schema: {
        tags: ['Payroll'],
        description:
          'Confirms a person is not any record TeamPay already holds, so a starter held for a possible match is set up as new.',
        params: idParam,
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      g.allow('payroll.send');
      const e = org.state.employees.find((x) => x.id === req.params.id);
      if (!e) throw notFound(`Employee ${req.params.id}`);
      if (e.payrollId) throw new HttpError(409, 'already_linked', `${e.name} is already linked to TeamPay`);
      if (e.status === 'leaver') throw new HttpError(409, 'leaver', `${e.name} has left`);
      org.outbox = org.outbox.filter((i) => !(i.type === 'employee.upsert' && i.payload.employeeId === e.id && i.status !== 'delivered'));
      enqueue(org, { type: 'employee.upsert', payload: { employeeId: e.id, confirmedNew: true }, idempotencyKey: `emp:${e.id}:confirmed-new` });
      audit(org, actorName(g), 'payroll.confirmed_new', { employeeId: e.id });
      await kick(ctx, org);
      return { employee: e };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/employees/:id/payroll-link',
    {
      ...write,
      schema: {
        tags: ['Payroll'],
        description: 'Undoes a link made in error, before any hours have gone to payroll under it. TeamPay is not changed.',
        params: idParam,
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      g.allow('payroll.send');
      const e = org.state.employees.find((x) => x.id === req.params.id);
      if (!e) throw notFound(`Employee ${req.params.id}`);
      if (!e.payrollId) throw new HttpError(409, 'not_linked', `${e.name} is not linked to TeamPay`);
      if (hasPayrollHistory(org, e)) {
        throw new HttpError(409, 'payroll_history', `Hours for ${e.name} have already gone to TeamPay under this link, so it stays. Correct it in TeamPay.`);
      }
      const payrollId = e.payrollId;
      e.payrollId = undefined;
      e.payrollEmployerId = undefined;
      e.payrollReview = undefined;
      audit(org, actorName(g), 'payroll.unlinked', { employeeId: e.id, payrollId });
      return { employee: e };
    },
  );
}
