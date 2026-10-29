import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { customerSetting, getBilling, putBilling, signStripePayload, standingOf, type BillingRecord } from './billing';
import { account, kit, type Kit } from './testkit';

// Moving a customer between paying by card through Stripe and being billed under a Williams, Stanley &
// Co. engagement. To the engagement: Stripe stops at the end of the period already paid, so nobody pays
// twice, and from then nothing pauses them. To card: a former client gets a date to subscribe by.

const SAM = 'sam.okoro@williamsstanley.example';
const SAM_MFA = 'demo-usr_ws_partner';
const STRIPE_ENV = { STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: 'whsec_test_secret', STRIPE_PRICE_ID: 'price_site' };
const DAY = 86_400_000;
const PERIOD_END = Math.floor((Date.now() + 20 * DAY) / 1000);

let stripe: { path: string; body: URLSearchParams; idempotency?: string }[] = [];
const fake = async (url: string, init: RequestInit = {}) => {
  const u = new URL(url);
  if (u.hostname !== 'api.stripe.com') throw new Error(`unexpected fetch ${url}`);
  const path = u.pathname.replace(/^\/v1/, '');
  const body = new URLSearchParams(String(init.body ?? ''));
  stripe.push({ path, body, idempotency: (init.headers as Record<string, string>)['idempotency-key'] });
  if (path === '/subscriptions/sub_1') {
    return new Response(JSON.stringify({
      id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: body.get('cancel_at_period_end') === 'true',
      items: { data: [{ id: 'si_1', quantity: 2, current_period_end: PERIOD_END, price: { recurring: { interval: 'month' } } }] },
    }));
  }
  return new Response(JSON.stringify({ error: { message: 'No such thing' } }), { status: 404 });
};

beforeEach(() => {
  stripe = [];
  vi.stubGlobal('fetch', fake);
});
afterEach(() => vi.unstubAllGlobals());

/** A clock the test can move forward. */
function clock() {
  let at = Date.now();
  return { now: () => new Date(at), advance: (days: number) => { at += days * DAY; } };
}

async function boot(options: { stripe?: boolean } = {}) {
  const c = clock();
  const k = await kit({ fetch: fake as typeof fetch, env: options.stripe === false ? {} : STRIPE_ENV, now: c.now });
  return { k, c };
}

/** Sam, the WS client partner in the system's own organisation, also holds customer operations. */
async function grantCustomers(k: Kit) {
  const org = await k.store.load('demo');
  org.users.find((u) => u.email === SAM)!.memberships.push({ id: 'mem_cust', roleId: 'ws_customers', siteIds: null, starts: '2026-01-01', active: true, grantedBy: 'test', grantedAt: new Date().toISOString() });
  await k.store.save(org);
}

/**
 * A customer organisation with an owner who can sign in with an authenticator, and optionally Sam as
 * its WS client partner. Returns the owner's proved session.
 */
async function customer(k: Kit, orgId: string, options: { partner?: boolean; billing?: BillingRecord } = {}) {
  const org = await k.store.load(orgId);
  const at = new Date().toISOString();
  org.state.entities.push({ id: 'main', name: `Customer ${orgId}`, companyNumber: '', payeReference: '', intercompanyCode: '1350' });
  org.users.push({
    id: `usr_${orgId}`, email: `owner@${orgId}.example`, name: `Owner ${orgId}`, audience: 'operator', status: 'active', mfaEnrolled: true, createdAt: at, activatedAt: at,
    memberships: [{ id: `mem_${orgId}`, roleId: 'owner', siteIds: null, starts: '2026-01-01', active: true, grantedBy: 'Sign-up', grantedAt: at }],
  });
  org.authenticators[`usr_${orgId}`] = { id: `enr-${orgId}`, secret: 'sealed', lastStep: -1, recovery: [], failures: [] } as never;
  if (options.partner) {
    org.users.push({
      id: `usr_sam_${orgId}`, email: SAM, name: 'Sam Okoro', audience: 'ws', status: 'active', mfaEnrolled: true, createdAt: at, activatedAt: at,
      memberships: [{ id: `mem_sam_${orgId}`, roleId: 'ws_partner', siteIds: null, starts: '2026-01-01', active: true, grantedBy: 'Client set-up', grantedAt: at }],
    });
    const sam = (await k.store.getUser(SAM))!;
    await k.store.updateUser(SAM, { orgs: [...new Set([...(sam.orgs ?? [sam.orgId]), orgId])] });
  }
  await k.store.save(org);
  await k.store.createUser(account(`owner@${orgId}.example`, orgId));
  if (options.billing) await putBilling(k.store, orgId, options.billing);
  // As Checkout records it: which organisation a Stripe customer belongs to.
  if (options.billing?.customerId) await k.store.setSetting(customerSetting(options.billing.customerId), orgId);
  return k.as(`owner@${orgId}.example`, `enr-${orgId}`);
}

const paying = (): BillingRecord => ({
  trialEndsAt: new Date(Date.now() - 30 * DAY).toISOString(), createdAt: new Date(Date.now() - 44 * DAY).toISOString(),
  customerId: 'cus_1', subscriptionId: 'sub_1', itemId: 'si_1', status: 'active', quantity: 2, interval: 'month',
  currentPeriodEnd: new Date(PERIOD_END * 1000).toISOString(),
});

async function webhook(k: Kit, event: Record<string, unknown>) {
  const raw = JSON.stringify({ id: `evt_${Math.random()}`, created: Math.floor(Date.now() / 1000) + 60 * 86_400, ...event });
  const res = await k.app.inject({ method: 'POST', url: '/v1/integrations/stripe/webhook', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(STRIPE_ENV.STRIPE_WEBHOOK_SECRET, raw) }, payload: raw });
  return res.json();
}

describe('moving a card customer to a WS engagement', () => {
  it('ends the subscription at the period end, then bills them under the engagement and never pauses them', async () => {
    const { k, c } = await boot();
    await grantCustomers(k);
    const owner = await customer(k, 'org-card', { billing: paying() });
    const sam = await k.as(SAM, SAM_MFA);

    const listed = (await k.call('GET', '/v1/customers', sam)).body;
    expect(listed.canMove).toBe(true);
    const res = await k.call('POST', '/v1/customers/org-card/engagement', sam, { note: 'EL-2026-114' });
    expect(res.status).toBe(200);
    // Stripe is asked only to stop renewing: nothing charged or refunded now, and safe to repeat.
    expect(stripe).toHaveLength(1);
    expect(stripe[0].path).toBe('/subscriptions/sub_1');
    expect(stripe[0].body.get('cancel_at_period_end')).toBe('true');
    expect(stripe[0].idempotency).toBe('engagement-org-card-sub_1');
    expect(res.body.engagement.from).toBe(new Date(PERIOD_END * 1000).toISOString());
    expect(res.body.attention.join(' ')).toContain('Moving to partner engagement billing');

    // Until then they have paid, so nothing changes, but the portal is closed so the subscription cannot be renewed.
    const before = (await k.call('GET', '/v1/billing', owner)).body;
    expect(before).toMatchObject({ standing: 'active', canSubscribe: false, canManage: false, engagement: { from: res.body.engagement.from } });
    expect((await k.call('POST', '/v1/billing/portal', owner)).status).toBe(409);

    // The period ends and Stripe reports the subscription gone: billed by WS, never lapsed, never paused.
    c.advance(21);
    await webhook(k, { type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled', items: { data: [{ id: 'si_1', quantity: 2 }] } } } });
    const r = (await getBilling(k.store, 'org-card'))!;
    expect(r.status).toBe('canceled');
    expect(standingOf(r, c.now(), true)).toMatchObject({ standing: 'managed', locked: false });
    const after = (await k.call('GET', '/v1/billing', owner)).body;
    expect(after).toMatchObject({ standing: 'managed', canSubscribe: false, quotes: null });
    expect((await k.call('POST', '/v1/billing/checkout', owner, {})).status).toBe(409);

    // Customers counts it as taken on by the firm, out of MRR, and as a win for the funnel.
    const view = (await k.call('GET', '/v1/customers', sam)).body;
    expect(view.customers[0]).toMatchObject({ standing: 'managed', mrrPence: 0, engagement: { by: 'Sam Okoro' } });
    expect(view.totals).toMatchObject({ toEngagement: 1, conversion: 1 });
    // On the record in both organisations.
    expect((await k.store.load('org-card')).audit.map((a) => a.action)).toContain('billing.moved_to_engagement');
    expect((await k.store.load('demo')).audit.map((a) => a.action)).toContain('customers.moved_to_engagement');
    // Once is enough.
    expect((await k.call('POST', '/v1/customers/org-card/engagement', sam)).status).toBe(409);
  });

  it('moves a trial with no subscription from today, without calling Stripe', async () => {
    const { k, c } = await boot();
    await grantCustomers(k);
    await customer(k, 'org-trial', { billing: { trialEndsAt: new Date(Date.now() + 5 * DAY).toISOString(), createdAt: new Date().toISOString() } });
    const res = await k.call('POST', '/v1/customers/org-trial/engagement', await k.as(SAM, SAM_MFA));
    expect(res.status).toBe(200);
    expect(stripe).toHaveLength(0);
    expect(res.body.standing).toBe('managed');
    c.advance(30);
    expect(standingOf((await getBilling(k.store, 'org-trial'))!, c.now(), true).locked).toBe(false);
  });

  it('is for customer operations alone, with the authenticator, and only on a card customer', async () => {
    const { k } = await boot();
    await customer(k, 'org-card', { billing: paying() });
    await customer(k, 'org-client');
    // Sam without the customer operations role.
    expect((await k.call('POST', '/v1/customers/org-card/engagement', await k.as(SAM, SAM_MFA))).status).toBe(403);
    await grantCustomers(k);
    expect((await k.call('POST', '/v1/customers/org-card/engagement', await k.as(SAM))).status).toBe(403);
    const sam = await k.as(SAM, SAM_MFA);
    expect((await k.call('POST', '/v1/customers/org-client/engagement', sam)).body.error).toBe('managed');
    expect((await k.call('POST', '/v1/customers/demo/engagement', sam)).status).toBe(404);
    expect((await k.call('POST', '/v1/customers/org-nowhere/engagement', sam)).status).toBe(404);
    expect(stripe).toHaveLength(0);
  });
});

describe('moving a WS client to card billing', () => {
  it('gives the client a date to subscribe by, then pauses changes if it has not', async () => {
    const { k, c } = await boot();
    await grantCustomers(k);
    const owner = await customer(k, 'org-client', { partner: true });
    const sam = await k.as(SAM, SAM_MFA);
    const listed = (await k.call('GET', '/v1/clients', sam)).body.clients.find((x: { orgId: string }) => x.orgId === 'org-client');
    expect(listed.billing).toMatchObject({ mode: 'engagement', standing: 'managed' });

    const payBy = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10);
    const res = await k.call('POST', '/v1/clients/org-client/card-billing', sam, { payBy });
    expect(res.status).toBe(200);
    expect(res.body.billing).toMatchObject({ mode: 'to-card' });
    expect(res.body.attention.join(' ')).toContain('to subscribe by card');

    // The owner sees a Billing page asking them to subscribe, not a free trial.
    const page = (await k.call('GET', '/v1/billing', owner)).body;
    expect(page).toMatchObject({ standing: 'trial', fromEngagement: true, canSubscribe: true });
    // Customers sees where they came from, and does not count them as a lost trial.
    const view = (await k.call('GET', '/v1/customers', sam)).body;
    expect(view.customers.find((x: { orgId: string }) => x.orgId === 'org-client')).toMatchObject({ fromEngagement: true, standing: 'trial' });
    expect(view.totals.fromEngagement).toBe(1);

    c.advance(11);
    const lapsed = standingOf((await getBilling(k.store, 'org-client'))!, c.now(), true);
    expect(lapsed).toMatchObject({ standing: 'lapsed', locked: true });
    expect((await k.call('POST', '/v1/clients/org-client/card-billing', sam, {})).body.error).toBe('card');
    expect((await k.store.load('org-client')).audit.map((a) => a.action)).toContain('billing.moved_to_card');
  });

  it('refuses without Stripe, without an owner who has signed in, or for a date outside 90 days', async () => {
    const off = await boot({ stripe: false });
    await customer(off.k, 'org-client', { partner: true });
    expect((await off.k.call('POST', '/v1/clients/org-client/card-billing', await off.k.as(SAM, SAM_MFA), {})).status).toBe(503);

    const { k } = await boot();
    await customer(k, 'org-client', { partner: true });
    const sam = await k.as(SAM, SAM_MFA);
    const far = new Date(Date.now() + 120 * DAY).toISOString().slice(0, 10);
    expect((await k.call('POST', '/v1/clients/org-client/card-billing', sam, { payBy: far })).status).toBe(400);
    const org = await k.store.load('org-client');
    org.users.find((u) => u.id === 'usr_org-client')!.status = 'suspended';
    await k.store.save(org);
    expect((await k.call('POST', '/v1/clients/org-client/card-billing', sam, {})).body.error).toBe('no_owner');
    // Only the client's own WS partner: anywhere else it is not found.
    expect((await k.call('POST', '/v1/clients/org-elsewhere/card-billing', sam, {})).status).toBe(404);
  });

  it('ignores late news about the subscription that ended with the earlier move to the engagement', async () => {
    const { k, c } = await boot();
    const owner = await customer(k, 'org-back', { partner: true, billing: { ...paying(), status: 'canceled', engagement: { from: new Date(Date.now() - DAY).toISOString(), at: new Date().toISOString(), by: 'Ops' } } });
    const sam = await k.as(SAM, SAM_MFA);
    expect((await k.call('POST', '/v1/clients/org-back/card-billing', sam, {})).status).toBe(200);
    const r = (await getBilling(k.store, 'org-back'))!;
    expect(r).toMatchObject({ customerId: 'cus_1', previousSubscriptionId: 'sub_1' });
    expect(r.subscriptionId).toBeUndefined();
    await webhook(k, { type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled', items: { data: [] } } } });
    expect((await k.call('GET', '/v1/billing', owner)).body.standing).toBe('trial');
    c.advance(1);
    expect(standingOf((await getBilling(k.store, 'org-back'))!, c.now(), true).standing).toBe('trial');
  });

  it('warns the partner when a client also pays Preshift by card, so the firm does not bill it twice', async () => {
    const { k } = await boot();
    await customer(k, 'org-card', { partner: true, billing: paying() });
    const row = (await k.call('GET', '/v1/clients', await k.as(SAM, SAM_MFA))).body.clients.find((x: { orgId: string }) => x.orgId === 'org-card');
    expect(row.billing).toMatchObject({ mode: 'card', standing: 'active' });
    expect(row.attention.join(' ')).toContain('Pays Preshift by card through Stripe');
  });
});
