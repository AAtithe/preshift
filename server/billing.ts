import { createHmac, timingSafeEqual } from 'node:crypto';
import { PRICING, type Interval } from '../src/engine/pricing';
import type { Store } from './store';

// Billing for organisations that signed themselves up. Preshift sells to them through Stripe: one
// subscription per organisation, priced per site, paid by card through Stripe Checkout, with cards,
// invoices and cancelling handled in Stripe's own customer portal. Preshift never sees a card number.
//
// The rules:
// - Only an organisation that signed itself up has a billing record. Everyone else (the first
//   organisation on a system, Williams, Stanley & Co. clients) is billed under their engagement and
//   is never asked to pay here, nor ever locked.
// - A new sign-up has a free trial. When it ends without a subscription, or a subscription ends or
//   stays unpaid, changes are paused and everything stays readable: nobody is ever cut off from their
//   own staff records, pay history or data requests, and paying lifts the pause at once.
// - Nobody is paused who has no way to pay: without Stripe configured the trial ending changes nothing.
// - A failed payment is a grace period, not a pause: Stripe retries the card, and only marks the
//   subscription unpaid or cancelled once its retries are spent.
// - What Stripe says is believed only with its signature over the exact bytes it sent.

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  /** The monthly price, graduated per site as src/engine/pricing.ts says: the subscription's quantity is the site count. */
  priceId: string;
  /** The same, paid yearly. Without it only monthly billing is offered. */
  annualPriceId?: string;
}

/** Stripe is configured only when all three are set: a half-configured Stripe charges nobody and pauses nobody. */
export function stripeFromEnv(env: NodeJS.ProcessEnv): StripeConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  const priceId = env.STRIPE_PRICE_ID?.trim();
  const annualPriceId = env.STRIPE_PRICE_ID_ANNUAL?.trim() || undefined;
  return secretKey && webhookSecret && priceId ? { secretKey, webhookSecret, priceId, ...(annualPriceId ? { annualPriceId } : {}) } : null;
}

export const DEFAULT_TRIAL_DAYS = PRICING.trialDays;

export function trialDaysFromEnv(env: NodeJS.ProcessEnv): number {
  const days = Number(env.PRESHIFT_TRIAL_DAYS);
  return Number.isInteger(days) && days >= 0 && days <= 90 ? days : DEFAULT_TRIAL_DAYS;
}

/** Stripe's subscription statuses, as it reports them. */
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'unpaid' | 'canceled' | 'incomplete' | 'incomplete_expired' | 'paused';

export interface BillingRecord {
  /** When the free trial ends, ISO. A subscription bought during it starts charging then. */
  trialEndsAt: string;
  createdAt: string;
  customerId?: string;
  subscriptionId?: string;
  /** The subscription's one item, so the site count can be changed. */
  itemId?: string;
  status?: SubscriptionStatus;
  /** Sites paid for. */
  quantity?: number;
  /** Paid monthly or yearly. */
  interval?: Interval;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  /** The last invoice Stripe told us about, for the Billing page. Never card details. */
  lastInvoice?: { status: 'paid' | 'failed'; amountPence: number; currency: string; at: string; url?: string };
  /** Stripe's created time (unix seconds) of the newest event applied, so an older one arriving late is ignored. */
  lastEventAt?: number;
}

export const billingSetting = (orgId: string) => `billing:${orgId}`;
/** Which organisation a Stripe customer belongs to, written when Preshift makes the customer. */
export const customerSetting = (customerId: string) => `stripe_customer:${customerId}`;

export async function getBilling(store: Store, orgId: string): Promise<BillingRecord | null> {
  const raw = await store.getSetting(billingSetting(orgId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as BillingRecord;
    return typeof parsed?.trialEndsAt === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export const putBilling = (store: Store, orgId: string, record: BillingRecord) => store.setSetting(billingSetting(orgId), JSON.stringify(record));

export type Standing = 'managed' | 'trial' | 'active' | 'past_due' | 'lapsed';

export interface BillingStanding {
  standing: Standing;
  /** Changes are refused until someone pays. */
  locked: boolean;
  trialEndsAt?: string;
  /** Whole days of trial left, rounded up; 0 once it has ended. */
  trialDaysLeft?: number;
}

const PAYING: SubscriptionStatus[] = ['active', 'trialing'];
/** Statuses that mean no subscription is in force: the trial, if any is left, still counts. */
const NOT_STARTED: SubscriptionStatus[] = ['incomplete', 'incomplete_expired'];

export function standingOf(record: BillingRecord | null, now: Date, stripe: boolean): BillingStanding {
  if (!record) return { standing: 'managed', locked: false };
  const left = Date.parse(record.trialEndsAt) - now.getTime();
  const trial = { trialEndsAt: record.trialEndsAt, trialDaysLeft: Math.max(0, Math.ceil(left / 86_400_000)) };
  if (record.status && PAYING.includes(record.status)) return { standing: 'active', locked: false, ...trial };
  if (record.status === 'past_due') return { standing: 'past_due', locked: false, ...trial };
  const subscribed = record.status && !NOT_STARTED.includes(record.status);
  if (!subscribed && left > 0) return { standing: 'trial', locked: false, ...trial };
  return { standing: 'lapsed', locked: stripe, ...trial };
}

/**
 * Routes a paused organisation still reaches: paying, the person's own sign-in and authenticator
 * (the owner needs it to pay), and data protection duties, which do not wait on an invoice.
 */
export function allowedWhileLocked(route: string | undefined): boolean {
  if (!route) return false;
  // Marking a message read changes nothing anyone relies on: reading stays open, as everything else does.
  return route.startsWith('/v1/billing') || route === '/v1/me' || route.startsWith('/v1/me/') || route.startsWith('/v1/privacy/') || route === '/v1/messages/:id/read';
}

export const LOCKED_MESSAGE =
  'This organisation\'s subscription has lapsed, so changes are paused. Everything stays readable. Whoever looks after billing can restart it under Organisation, Billing.';

// Stripe's API takes form-encoded bodies with nested keys: a[b][0][c]=v.
export type FormValue = string | number | boolean | undefined | FormValue[] | { [k: string]: FormValue };

export function formEncode(params: Record<string, FormValue>): string {
  const out = new URLSearchParams();
  const walk = (key: string, value: FormValue) => {
    if (value === undefined) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(`${key}[${i}]`, v));
    else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(`${key}[${k}]`, v);
    else out.append(key, String(value));
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.toString();
}

export class StripeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** One call to Stripe's API. Failures carry Stripe's own message, which never includes the key. */
export async function stripeCall<T>(
  config: StripeConfig,
  fetcher: typeof fetch,
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, FormValue> = {},
  idempotencyKey?: string,
): Promise<T> {
  const body = formEncode(params);
  const url = `https://api.stripe.com/v1${path}${method === 'GET' && body ? `?${body}` : ''}`;
  const res = await fetcher(url, {
    method,
    headers: {
      authorization: `Bearer ${config.secretKey}`,
      ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    ...(method === 'POST' ? { body } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new StripeError(res.status, json.error?.message ?? `Stripe returned ${res.status}`);
  return json;
}

/** Five minutes either way, as Stripe's own libraries allow. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Stripe's `stripe-signature` header: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">, possibly several v1. */
export function verifyStripeSignature(secret: string, header: string | undefined, raw: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex'));
  return parts
    .filter(([k]) => k === 'v1')
    .some(([, v]) => {
      const given = Buffer.from(v ?? '');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}

/** Signs a payload as Stripe does. For tests and for checking a webhook set-up by hand. */
export function signStripePayload(secret: string, raw: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
}

interface StripeSubscription {
  id: string;
  customer: string;
  status: SubscriptionStatus;
  cancel_at_period_end?: boolean;
  current_period_end?: number;
  metadata?: Record<string, string>;
  items?: { data?: { id: string; quantity?: number; current_period_end?: number; price?: { recurring?: { interval?: string } } }[] };
}

const iso = (unix: number | undefined) => (unix ? new Date(unix * 1000).toISOString() : undefined);

/** The subscription as Stripe reports it, laid over what we hold. */
export function applySubscription(record: BillingRecord, sub: StripeSubscription, deleted = false): BillingRecord {
  const item = sub.items?.data?.[0];
  return {
    ...record,
    customerId: sub.customer || record.customerId,
    subscriptionId: sub.id,
    itemId: item?.id ?? record.itemId,
    status: deleted ? 'canceled' : sub.status,
    quantity: item?.quantity ?? record.quantity,
    interval: item?.price?.recurring?.interval === 'year' ? 'year' : item?.price?.recurring?.interval === 'month' ? 'month' : record.interval,
    // Newer Stripe API versions report the period on the item, older ones on the subscription.
    currentPeriodEnd: iso(item?.current_period_end ?? sub.current_period_end) ?? record.currentPeriodEnd,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
  };
}

export type { StripeSubscription };
