import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PRICING, quote, type Interval } from '../../src/engine/pricing';
import { SAMPLE_SITE_IDS } from '../../src/engine/seed';
import {
  applySubscription,
  customerSetting,
  engaged,
  getBilling,
  putBilling,
  standingOf,
  stripeCall,
  StripeError,
  verifyStripeSignature,
  type BillingRecord,
  type StripeConfig,
  type StripeSubscription,
} from '../billing';
import { HttpError, orgOf, type AppContext } from '../context';
import { guard } from '../guard';
import { audit, type OrgData } from '../store';
import { orgName, secure } from './access';

// The Billing page and what it asks of Stripe. Paying is a settings decision: a person with
// settings.manage and their authenticator, never an API key. See server/billing.ts for the rules.

/** Sites billed: the organisation's own, never the sample group's, and at least one. */
export const billableSites = (org: OrgData) => Math.max(1, org.state.sites.filter((s) => !SAMPLE_SITE_IDS.includes(s.id)).length);

/** A subscription still in force, so a second one is never bought alongside it. */
const inForce = (r: BillingRecord) => !!r.subscriptionId && !!r.status && !['canceled', 'incomplete_expired'].includes(r.status);

/** A group plan is agreed with us, never bought by card. */
const groupPlan = (sites: number) =>
  new HttpError(409, 'group_plan', `You have ${sites} sites. Groups of more than ${PRICING.selfServeMaxSites} sites are on a group plan agreed with us. Contact hello@preshift.co.uk and we will set it up.`);

/** Stripe's refusal, said plainly; the detail goes to the log. */
function stripeFailed(err: unknown): never {
  if (err instanceof StripeError) {
    console.error(`Stripe refused: ${err.status} ${err.message}`);
    throw new HttpError(502, 'stripe_error', 'Stripe could not take that just now. Try again in a minute; if it keeps happening, tell us.');
  }
  throw err;
}

export function billingRoutes(app: FastifyInstance, ctx: AppContext, options: { stripe: StripeConfig | null; appUrl?: string }) {
  const { store } = ctx;
  const { stripe } = options;
  const tags = ['Billing'];
  const hidden = { hide: true, tags };

  function billingPerson(req: FastifyRequest) {
    if (!req.principal.email) throw new HttpError(403, 'forbidden', 'Billing is managed by a person signed in, not an API key.');
    const g = guard(ctx, req, orgOf(req));
    g.allow('settings.manage');
    return g.actor.kind === 'user' ? g.actor.user.name : req.principal.name;
  }

  /** Where Stripe sends the person back to: the deployment's own address, else the one they came in on. */
  const appUrl = (req: FastifyRequest) => options.appUrl ?? `${secure(req) ? 'https' : 'http'}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;

  async function record(req: FastifyRequest) {
    const r = await getBilling(store, req.principal.orgId);
    if (!r || engaged(r, ctx.now())) throw new HttpError(409, 'managed', 'This organisation is billed under its engagement with Williams, Stanley & Co., not by card here.');
    return r;
  }

  function needStripe(): StripeConfig {
    if (!stripe) throw new HttpError(503, 'billing_not_set_up', 'Card payments are not set up on this system yet. Contact hello@preshift.co.uk and we will invoice you.');
    return stripe;
  }

  app.get('/v1/billing', { schema: { ...hidden } }, async (req) => {
    billingPerson(req);
    const org = orgOf(req);
    const all = await getBilling(store, org.orgId);
    // Once billed under a WS engagement, the card side is history: nothing to quote, buy or change here.
    const r = all && !engaged(all, ctx.now()) ? all : null;
    const standing = standingOf(all, ctx.now(), !!stripe);
    const sites = billableSites(org);
    return {
      ...standing,
      stripe: !!stripe,
      // What the sites set up cost, from src/engine/pricing.ts, which the Stripe prices are made from.
      quotes: r ? { month: quote(sites, 'month'), ...(stripe?.annualPriceId || !stripe ? { year: quote(sites, 'year') } : {}) } : null,
      pricing: r ? { bands: PRICING.bands, selfServeMaxSites: PRICING.selfServeMaxSites, annualMonthsCharged: PRICING.annualMonthsCharged } : null,
      sites: { now: sites, billed: r?.quantity ?? null },
      subscription: r && r.subscriptionId
        ? { status: r.status ?? null, interval: r.interval ?? null, currentPeriodEnd: r.currentPeriodEnd ?? null, cancelAtPeriodEnd: !!r.cancelAtPeriodEnd }
        : null,
      lastInvoice: r?.lastInvoice ?? null,
      // Moving to a WS engagement: the period paid for runs out, then WS bills them.
      engagement: all?.engagement ? { from: all.engagement.from } : null,
      canSubscribe: !!stripe && !!r && !inForce(r) && !r.engagement,
      // Not while moving to a WS engagement, so the ending subscription cannot be renewed and paid twice;
      // once the move has happened, the portal is open again for the VAT invoices already paid.
      canManage: !!stripe && !!all?.customerId && !(all.engagement && !engaged(all, ctx.now())),
    };
  });

  // Stripe Checkout: the card is taken on Stripe's own page. Any trial left carries over, so paying
  // early never costs the free days.
  app.post<{ Body: { interval?: Interval } | undefined }>('/v1/billing/checkout', {
    schema: { ...hidden, body: { type: ['object', 'null'], additionalProperties: false, properties: { interval: { type: 'string', enum: ['month', 'year'] } } } },
  }, async (req) => {
    const who = billingPerson(req);
    const org = orgOf(req);
    const r = await record(req);
    const config = needStripe();
    if (r.engagement) throw new HttpError(409, 'managed', 'This organisation is moving to billing under its engagement with Williams, Stanley & Co., so there is no card subscription to start.');
    if (inForce(r)) throw new HttpError(409, 'subscribed', 'There is already a subscription. Change the card or plan from Manage billing.');
    const interval: Interval = req.body?.interval ?? 'month';
    const priceId = interval === 'year' ? config.annualPriceId : config.priceId;
    if (!priceId) throw new HttpError(409, 'no_annual', 'Annual billing is not offered on this system yet. Choose monthly.');
    if (billableSites(org) > PRICING.selfServeMaxSites) throw groupPlan(billableSites(org));
    try {
      if (!r.customerId) {
        // One customer per organisation, even if two people press the button together.
        const customer = await stripeCall<{ id: string }>(config, ctx.fetch, 'POST', '/customers', {
          email: req.principal.email,
          name: orgName(org),
          metadata: { orgId: org.orgId },
        }, `customer-${org.orgId}`);
        r.customerId = customer.id;
        await store.setSetting(customerSetting(customer.id), org.orgId);
        await putBilling(store, org.orgId, r);
      }
      const sites = billableSites(org);
      const trialEnd = Math.floor(Date.parse(r.trialEndsAt) / 1000);
      // Stripe takes a trial end only at least two days ahead; a shorter remainder starts billing now.
      const carryTrial = trialEnd - Math.floor(ctx.now().getTime() / 1000) > 49 * 3600;
      const base = appUrl(req);
      const session = await stripeCall<{ url: string }>(config, ctx.fetch, 'POST', '/checkout/sessions', {
        mode: 'subscription',
        customer: r.customerId,
        client_reference_id: org.orgId,
        line_items: [{ price: priceId, quantity: sites }],
        subscription_data: { metadata: { orgId: org.orgId }, ...(carryTrial ? { trial_end: trialEnd } : {}) },
        metadata: { orgId: org.orgId },
        // UK businesses reclaim VAT: the invoice carries their address and VAT number.
        billing_address_collection: 'required',
        tax_id_collection: { enabled: true },
        customer_update: { address: 'auto', name: 'auto' },
        allow_promotion_codes: true,
        success_url: `${base}/app/?view=billing&checkout=done`,
        cancel_url: `${base}/app/?view=billing`,
      });
      audit(org, who, 'billing.checkout_started', { sites, interval });
      return { url: session.url };
    } catch (err) {
      return stripeFailed(err);
    }
  });

  // Stripe's customer portal: cards, invoices, VAT details and cancelling, on Stripe's own pages.
  app.post('/v1/billing/portal', { schema: { ...hidden } }, async (req) => {
    const who = billingPerson(req);
    // Still open after a move to a WS engagement, for the VAT invoices already paid; closed while it is pending.
    const r = (await getBilling(store, req.principal.orgId)) ?? (await record(req));
    const config = needStripe();
    if (r.engagement && !engaged(r, ctx.now())) {
      throw new HttpError(409, 'moving', 'Your card subscription is ending as you move to billing under your WS engagement. Manage billing opens again once that has happened.');
    }
    if (!r.customerId) throw new HttpError(409, 'no_customer', 'There is nothing to manage yet. Subscribe first.');
    try {
      const session = await stripeCall<{ url: string }>(config, ctx.fetch, 'POST', '/billing_portal/sessions', {
        customer: r.customerId,
        return_url: `${appUrl(req)}/app/?view=billing`,
      });
      audit(orgOf(req), who, 'billing.portal_opened');
      return { url: session.url };
    } catch (err) {
      return stripeFailed(err);
    }
  });

  // Brings the sites paid for into line with the sites set up. Stripe prorates the difference on the next invoice.
  app.post('/v1/billing/sites', { schema: { ...hidden } }, async (req) => {
    const who = billingPerson(req);
    const org = orgOf(req);
    const r = await record(req);
    const config = needStripe();
    if (!inForce(r) || !r.itemId) throw new HttpError(409, 'not_subscribed', 'There is no subscription to change. Subscribe first.');
    const sites = billableSites(org);
    if (r.quantity === sites) return { sites: { now: sites, billed: sites } };
    if (sites > PRICING.selfServeMaxSites) throw groupPlan(sites);
    try {
      const sub = await stripeCall<StripeSubscription>(config, ctx.fetch, 'POST', `/subscriptions/${encodeURIComponent(r.subscriptionId!)}`, {
        items: [{ id: r.itemId, quantity: sites }],
        proration_behavior: 'create_prorations',
      });
      const next = applySubscription(r, sub);
      await putBilling(store, org.orgId, next);
      audit(org, who, 'billing.sites_changed', { from: r.quantity ?? null, to: sites });
      return { sites: { now: sites, billed: next.quantity ?? sites } };
    } catch (err) {
      return stripeFailed(err);
    }
  });
}

interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data?: { object?: Record<string, unknown> };
}

/**
 * What Stripe reports: checkouts completed, subscriptions changing and invoices paid or failed.
 * Believed only with Stripe's signature over the exact bytes, and applied to the organisation that
 * owns the Stripe customer, as Preshift recorded when it made the customer, never as the event says.
 */
export function stripeWebhookRoutes(app: FastifyInstance, ctx: AppContext, stripe: StripeConfig | null) {
  const { store } = ctx;
  app.post('/v1/integrations/stripe/webhook', { schema: { hide: true } }, async (req, reply) => {
    if (!stripe) return reply.code(404).send({ error: 'not_found', message: 'Billing is not set up on this system.' });
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
    if (!verifyStripeSignature(stripe.webhookSecret, req.headers['stripe-signature'] as string | undefined, raw)) {
      return reply.code(401).send({ error: 'unauthorised', message: 'Signature not valid' });
    }
    const event = req.body as StripeEvent;
    const obj = event?.data?.object ?? {};
    const customerId = typeof obj.customer === 'string' ? obj.customer : '';
    const orgId = customerId ? await store.getSetting(customerSetting(customerId)) : null;
    // A customer Preshift did not make, or an organisation since gone: acknowledged, so Stripe stops sending it.
    if (!orgId || !(await store.has(orgId))) return { ok: true, recorded: false };
    const current = await getBilling(store, orgId);
    if (!current) return { ok: true, recorded: false };

    let next: BillingRecord | null = null;
    let note: [string, Record<string, unknown>?] | null = null;
    switch (event.type) {
      case 'checkout.session.completed': {
        const subscriptionId = typeof obj.subscription === 'string' ? obj.subscription : undefined;
        next = { ...current, customerId, ...(subscriptionId ? { subscriptionId } : {}) };
        note = ['billing.checkout_completed'];
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = obj as unknown as StripeSubscription;
        // Late news is ignored: an older event, or one about a subscription already replaced by one in force.
        if (current.lastEventAt && event.created < current.lastEventAt) return { ok: true, recorded: false };
        if (current.subscriptionId && sub.id !== current.subscriptionId && inForce(current)) return { ok: true, recorded: false };
        // A subscription that ended with a move to a WS engagement never speaks for the card billing that followed.
        if (sub.id === current.previousSubscriptionId) return { ok: true, recorded: false };
        next = { ...applySubscription(current, sub, event.type.endsWith('deleted')), lastEventAt: event.created };
        if (next.status !== current.status) note = [`billing.subscription_${next.status}`, { sites: next.quantity }];
        break;
      }
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const paid = event.type === 'invoice.paid';
        next = {
          ...current,
          lastInvoice: {
            status: paid ? 'paid' : 'failed',
            amountPence: Number(paid ? obj.amount_paid : obj.amount_due) || 0,
            currency: String(obj.currency ?? 'gbp'),
            at: new Date(event.created * 1000).toISOString(),
            ...(typeof obj.hosted_invoice_url === 'string' ? { url: obj.hosted_invoice_url } : {}),
          },
        };
        note = [paid ? 'billing.invoice_paid' : 'billing.payment_failed', { amountPence: next.lastInvoice!.amountPence }];
        break;
      }
      default:
        return { ok: true, recorded: false };
    }
    await putBilling(store, orgId, next);
    if (note) {
      const org = await store.load(orgId);
      audit(org, 'Stripe', note[0], note[1]);
      // A conflicting save answers 409, and Stripe sends the event again; the billing record is already right.
      await store.save(org);
    }
    return { ok: true, recorded: true };
  });
}
