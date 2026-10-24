import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PRICING, quote } from '../../src/engine/pricing';
import { SAMPLE_SITE_IDS } from '../../src/engine/seed';
import { addDays } from '../../src/engine/time';
import { applySubscription, engaged, getBilling, putBilling, standingOf, stripeCall, StripeError, type BillingRecord, type Standing, type StripeConfig, type StripeSubscription } from '../billing';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { guard } from '../guard';
import { isSandbox } from '../sandbox';
import { audit, type OrgData } from '../store';
import { FIRST_ORG, orgName } from './access';
import { summarise } from './clients';

// Customers, for Williams, Stanley & Co.: every organisation that signed itself up, its trial,
// subscription and revenue, on one page. The funnel the business is run on: who signed up, who reached
// a published rota, who converted, what that is worth, and who needs a call this week.
//
// The rules:
// - Every customer at once breaks the rule that a person sees only the organisations they work in, so
//   it is one permission (customers.view), on one role (WS customer operations), with an authenticator,
//   and only counted in the system's own organisation, the first one, where Williams, Stanley & Co.
//   runs Preshift. The role granted anywhere else shows nothing: no client can grant itself a view of
//   every other client. Never an API key.
// - Counts and billing standing only. The owner's name and email, so someone can call them; never a
//   customer's staff, pay or personnel data.
// - Read only, but for one action: moving a customer onto a WS engagement when the firm takes them on.
//   That needs a second permission (customers.billing). It never charges or refunds anyone: it only sets
//   the Stripe subscription to end when the period already paid for runs out, so nobody pays twice.
//   Paying, refunds and cancelling otherwise stay in Stripe.
// - Every view is in the audit log, with who looked.
// - Only self sign-ups: organisations billed under a WS engagement have no billing record and are
//   managed from Clients.

export interface CustomerRow {
  orgId: string;
  name: string;
  owner: { name: string; email: string } | null;
  signedUpAt: string;
  standing: Standing;
  locked: boolean;
  trialEndsAt: string;
  trialDaysLeft: number;
  interval: 'month' | 'year' | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  /** The customer's own sites set up, the sample group's never counted. */
  sites: number;
  /** Sites on the subscription, when there is one. */
  sitesBilled: number | null;
  /** What the subscription is worth a month at list price before VAT; nought while not paying. */
  mrrPence: number;
  lastInvoice: BillingRecord['lastInvoice'] | null;
  /** How far through onboarding: steps done of the steps, and the next one. */
  onboarding: { done: number; of: number; next: string | null };
  rotaPublished: boolean;
  lastActivity: string | null;
  attention: string[];
  /** Moving to, or billed under, a WS engagement: from when, and who moved them. */
  engagement: { from: string; by: string; at: string } | null;
  /** Came off a WS engagement onto paying by card. */
  fromEngagement: boolean;
}

export interface CustomerTotals {
  customers: number;
  trials: number;
  paying: number;
  pastDue: number;
  lapsed: number;
  /** Signed up in the last 7 and 30 days. */
  signups7: number;
  signups30: number;
  /** Of the customers whose trial has ended, the share paying now. Null until one has. */
  conversion: number | null;
  mrrPence: number;
  arrPence: number;
  sitesBilled: number;
  /** Trials that have published a rota: the moment a customer has seen what the product does. */
  trialsWithRota: number;
  /** Started on a card and taken on by the firm: moved, or moving, to a WS engagement. */
  toEngagement: number;
  /** Former WS clients now paying, or due to pay, by card. */
  fromEngagement: number;
}

/** Monthly value at list price before VAT. Founding and promotion discounts show on Stripe's invoices, not here. */
const mrrOf = (r: BillingRecord, standing: Standing) => {
  if ((standing !== 'active' && standing !== 'past_due') || !r.quantity) return 0;
  const q = quote(r.quantity, r.interval ?? 'month');
  return q.interval === 'year' ? Math.round(q.netPence / 12) : q.netPence;
};

async function rowFor(ctx: AppContext, org: OrgData, r: BillingRecord, stripe: boolean, now: Date, today: string): Promise<CustomerRow> {
  const s = standingOf(r, now, stripe);
  const summary = await summarise(ctx, org, [], false, today);
  const ownerRecord = org.users.find((u) => u.audience === 'operator' && u.status !== 'suspended' && u.memberships.some((m) => m.roleId === 'owner' && m.active));
  const sites = org.state.sites.filter((x) => !SAMPLE_SITE_IDS.includes(x.id)).length;
  const done = summary.steps.filter((x) => x.done).length;
  const rotaPublished = summary.steps.find((x) => x.code === 'rota')?.done ?? false;
  const attention: string[] = [];
  if (s.standing === 'past_due') attention.push('Payment failed: Stripe is retrying the card.');
  if (s.standing === 'lapsed') attention.push(s.locked ? 'Lapsed: changes are paused until they subscribe.' : 'Trial over and not paying.');
  if (s.standing === 'trial' && (s.trialDaysLeft ?? 0) <= 3) attention.push(`Trial ends in ${s.trialDaysLeft} day${s.trialDaysLeft === 1 ? '' : 's'} and no subscription yet.`);
  if (s.standing === 'trial' && !rotaPublished && r.createdAt.slice(0, 10) <= addDays(today, -7)) attention.push('A week in and no rota published.');
  if (r.quantity && sites > r.quantity && (s.standing === 'active' || s.standing === 'past_due')) attention.push(`${sites} sites set up, ${r.quantity} billed.`);
  const moving = r.engagement && !engaged(r, now);
  if (moving) attention.push(`Moving to WS engagement billing on ${r.engagement!.from.slice(0, 10)}: Stripe stops then.`);
  if (r.engagement && r.subscriptionId && r.status && ['active', 'trialing', 'past_due'].includes(r.status) && !r.cancelAtPeriodEnd) {
    attention.push('On a WS engagement but the Stripe subscription is set to renew: end it in Stripe so they are not billed twice.');
  }
  else if (r.cancelAtPeriodEnd && !r.engagement) attention.push(`Cancelled: ends ${r.currentPeriodEnd?.slice(0, 10) ?? 'at the period end'}.`);
  if (r.fromEngagement && s.standing === 'trial') attention.push(`Off a WS engagement: to subscribe by ${r.trialEndsAt.slice(0, 10)}.`);
  return {
    orgId: org.orgId,
    name: orgName(org),
    owner: ownerRecord ? { name: ownerRecord.name, email: ownerRecord.email } : null,
    signedUpAt: r.createdAt,
    standing: s.standing,
    locked: s.locked,
    trialEndsAt: r.trialEndsAt,
    trialDaysLeft: s.trialDaysLeft ?? 0,
    interval: r.interval ?? null,
    cancelAtPeriodEnd: !!r.cancelAtPeriodEnd,
    currentPeriodEnd: r.currentPeriodEnd ?? null,
    sites,
    sitesBilled: r.subscriptionId ? r.quantity ?? null : null,
    mrrPence: mrrOf(r, s.standing),
    lastInvoice: r.lastInvoice ?? null,
    onboarding: { done, of: summary.steps.length, next: summary.steps.find((x) => !x.done)?.label ?? null },
    rotaPublished,
    lastActivity: summary.lastActivity,
    attention,
    engagement: r.engagement ? { from: r.engagement.from, by: r.engagement.by, at: r.engagement.at } : null,
    fromEngagement: !!r.fromEngagement,
  };
}

export function totalsOf(rows: CustomerRow[], now: Date): CustomerTotals {
  const since = (days: number) => rows.filter((r) => Date.parse(r.signedUpAt) >= now.getTime() - days * 86_400_000).length;
  const paying = rows.filter((r) => r.standing === 'active' || r.standing === 'past_due');
  // A customer the firm took on is a win for the funnel, not a lost trial.
  const ended = rows.filter((r) => Date.parse(r.trialEndsAt) <= now.getTime() && !r.fromEngagement);
  const won = (r: CustomerRow) => r.standing === 'active' || r.standing === 'past_due' || !!r.engagement;
  const mrrPence = rows.reduce((sum, r) => sum + r.mrrPence, 0);
  return {
    customers: rows.length,
    trials: rows.filter((r) => r.standing === 'trial').length,
    paying: rows.filter((r) => r.standing === 'active').length,
    pastDue: rows.filter((r) => r.standing === 'past_due').length,
    lapsed: rows.filter((r) => r.standing === 'lapsed').length,
    signups7: since(7),
    signups30: since(30),
    conversion: ended.length ? ended.filter(won).length / ended.length : null,
    mrrPence,
    arrPence: mrrPence * 12,
    sitesBilled: paying.reduce((sum, r) => sum + (r.sitesBilled ?? 0), 0),
    trialsWithRota: rows.filter((r) => r.standing === 'trial' && r.rotaPublished).length,
    toEngagement: rows.filter((r) => !!r.engagement).length,
    fromEngagement: rows.filter((r) => r.fromEngagement).length,
  };
}

export function customerRoutes(app: FastifyInstance, ctx: AppContext, options: { stripe: StripeConfig | null }) {
  const stripe = !!options.stripe;
  /** A person holding customers.view (and any further permission asked), with their authenticator, in the system's own organisation. */
  function customersPerson(req: FastifyRequest, also?: 'customers.billing') {
    if (!req.principal.email) throw new HttpError(403, 'forbidden', 'Customers are listed for a signed-in person, never an API key.');
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    // A system key never reaches here (no email); a person without a record has no role to hold.
    if (g.actor.kind !== 'user') throw new HttpError(403, 'forbidden', 'Customers are listed for WS customer operations only.');
    g.allow('customers.view');
    if (also) g.allow(also);
    if (org.orgId !== FIRST_ORG) throw new HttpError(403, 'forbidden', 'Customers are listed only in the organisation that runs Preshift. Switch to it first.');
    return g.actor.user.name;
  }

  app.get('/v1/customers', { schema: { hide: true } }, async (req) => {
    const who = customersPerson(req);
    const now = ctx.now();
    const today = ctx.store.todayISO();
    const rows: CustomerRow[] = [];
    for (const orgId of await ctx.store.orgIds()) {
      if (isSandbox(orgId) || orgId === FIRST_ORG) continue;
      const record = await getBilling(ctx.store, orgId);
      if (!record) continue;
      rows.push(await rowFor(ctx, await ctx.store.load(orgId), record, stripe, now, today));
    }
    rows.sort((a, b) => b.signedUpAt.localeCompare(a.signedUpAt));
    // Who looked at every customer, kept with the system's own audit trail.
    audit(orgOf(req), who, 'customers.viewed', { customers: rows.length });
    req.orgChanged = true;
    return {
      customers: rows,
      totals: totalsOf(rows, now),
      pricing: { bands: PRICING.bands, version: PRICING.version },
      stripe,
      canMove: (() => {
        try {
          customersPerson(req, 'customers.billing');
          return true;
        } catch {
          return false;
        }
      })(),
    };
  });

  // The firm takes on a customer who signed up by card. Stripe ends their subscription when the period
  // already paid for runs out (a trial ends without charging), and from that day WS bills them and
  // nothing here pauses them. Nothing is refunded or charged now, so nobody ever pays twice.
  app.post<{ Params: { orgId: string }; Body: { note?: string } | undefined }>(
    '/v1/customers/:orgId/engagement',
    {
      schema: {
        hide: true,
        params: { type: 'object', required: ['orgId'], properties: { orgId: { type: 'string' } } },
        body: { type: ['object', 'null'], additionalProperties: false, properties: { note: { type: 'string', maxLength: 300 } } },
      },
    },
    async (req) => {
      const who = customersPerson(req, 'customers.billing');
      const { orgId } = req.params;
      if (isSandbox(orgId) || orgId === FIRST_ORG || !(await ctx.store.has(orgId))) throw notFound(`Customer ${orgId}`);
      const record = await getBilling(ctx.store, orgId);
      if (!record) throw new HttpError(409, 'managed', 'This organisation is already billed under a WS engagement.');
      if (record.engagement) throw new HttpError(409, 'moving', `Already moving to WS engagement billing on ${record.engagement.from.slice(0, 10)}.`);

      const now = ctx.now();
      let next: BillingRecord = record;
      const live = !!record.subscriptionId && !!record.status && !['canceled', 'incomplete_expired'].includes(record.status);
      if (live) {
        if (!options.stripe) throw new HttpError(503, 'billing_not_set_up', 'Stripe is not set up on this system, so the subscription cannot be ended from here.');
        try {
          const sub = await stripeCall<StripeSubscription>(options.stripe, ctx.fetch, 'POST', `/subscriptions/${encodeURIComponent(record.subscriptionId!)}`, {
            cancel_at_period_end: true,
            metadata: { movedToEngagement: now.toISOString() },
          }, `engagement-${orgId}-${record.subscriptionId}`);
          next = applySubscription(record, sub);
        } catch (err) {
          if (err instanceof StripeError) {
            console.error(`Stripe refused: ${err.status} ${err.message}`);
            throw new HttpError(502, 'stripe_error', 'Stripe could not end the subscription just now, so nothing has changed. Try again in a minute.');
          }
          throw err;
        }
      }
      // Paid up to the period end, so WS bills from then; with nothing in force, from now.
      const periodEnd = live && next.currentPeriodEnd && Date.parse(next.currentPeriodEnd) > now.getTime() ? next.currentPeriodEnd : now.toISOString();
      const note = req.body?.note?.trim() || undefined;
      next = { ...next, engagement: { from: periodEnd, at: now.toISOString(), by: who, ...(note ? { note } : {}) } };
      await putBilling(ctx.store, orgId, next);

      const customer = await ctx.store.load(orgId);
      audit(customer, who, 'billing.moved_to_engagement', { from: periodEnd });
      await ctx.store.save(customer);
      audit(orgOf(req), who, 'customers.moved_to_engagement', { orgId, name: orgName(customer), from: periodEnd });
      return rowFor(ctx, customer, next, stripe, now, ctx.store.todayISO());
    },
  );
}
