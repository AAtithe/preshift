import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { customerSetting, formEncode, getBilling, putBilling, signStripePayload, standingOf, verifyStripeSignature, type BillingRecord } from './billing';
import { emailSetting } from './mail';
import { kit, type Kit } from './testkit';

// Self sign-up and billing: a business starts a trial from the sign-in page, proving its email
// first; when the trial ends it pays through Stripe Checkout, per site, or its changes pause while
// everything stays readable. What Stripe says is believed only with its signature.

const OLIVIA = 'olivia@marylebonegroup.example';
const OLIVIA_MFA = 'demo-usr_owner';
const EMAIL = { resendApiKey: 're_test_1234567890abcd', from: 'Preshift <hello@preshift.example>', appUrl: 'https://rota.preshift.example' };
const STRIPE_ENV = { STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: 'whsec_test_secret', STRIPE_PRICE_ID: 'price_site', STRIPE_PRICE_ID_ANNUAL: 'price_site_year' };
const DAY = 86_400_000;

let mails: { to: string[]; subject: string; text: string }[] = [];
let stripe: { method: string; path: string; body: URLSearchParams; idempotency?: string }[] = [];

const fake = async (url: string, init: RequestInit = {}) => {
  if (url === 'https://api.resend.com/emails') {
    mails.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: `mail-${mails.length}` }), { status: 200 });
  }
  const u = new URL(url);
  if (u.hostname !== 'api.stripe.com') throw new Error(`unexpected fetch ${url}`);
  expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk_test_123');
  const path = u.pathname.replace(/^\/v1/, '');
  stripe.push({ method: init.method ?? 'GET', path, body: new URLSearchParams(String(init.body ?? u.search.slice(1))), idempotency: (init.headers as Record<string, string>)['idempotency-key'] });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (path === '/customers') return json({ id: 'cus_1' });
  if (path === '/checkout/sessions') return json({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
  if (path === '/billing_portal/sessions') return json({ url: 'https://billing.stripe.com/p/session_1' });
  if (path === '/prices/price_site') return json({ unit_amount: 4900, currency: 'gbp', recurring: { interval: 'month' } });
  if (path === '/subscriptions/sub_1') return json(subscription('active', 3));
  return new Response(JSON.stringify({ error: { message: 'No such thing' } }), { status: 404 });
};

beforeEach(() => {
  mails = [];
  stripe = [];
  vi.stubGlobal('fetch', fake);
});
afterEach(() => vi.unstubAllGlobals());

function subscription(status: string, quantity = 1, id = 'sub_1') {
  return { id, object: 'subscription', customer: 'cus_1', status, cancel_at_period_end: false, items: { data: [{ id: 'si_1', quantity, current_period_end: 1_800_000_000 }] } };
}

async function boot(options: { stripe?: boolean; signup?: boolean; email?: boolean; env?: Record<string, string> } = {}) {
  const k = await kit({ fetch: fake as typeof fetch, env: options.env ?? (options.stripe === false ? {} : STRIPE_ENV), signup: options.signup });
  if (options.email !== false) await k.store.setSetting(emailSetting('demo'), JSON.stringify(EMAIL));
  return k;
}

/** The demo group as if it had signed itself up, so its owner (who has an authenticator) can pay. */
async function selfServe(k: Kit, patch: Partial<BillingRecord> = {}) {
  await putBilling(k.store, 'demo', { trialEndsAt: new Date(Date.now() + 10 * DAY).toISOString(), createdAt: new Date().toISOString(), ...patch });
  return k.as(OLIVIA, OLIVIA_MFA);
}

async function webhook(k: Kit, event: Record<string, unknown>, secret = STRIPE_ENV.STRIPE_WEBHOOK_SECRET) {
  const raw = JSON.stringify({ id: `evt_${Math.random()}`, created: Math.floor(Date.now() / 1000), ...event });
  const res = await k.app.inject({ method: 'POST', url: '/v1/integrations/stripe/webhook', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(secret, raw) }, payload: raw });
  return { status: res.statusCode, body: res.json() };
}

const tokenIn = (text: string) => decodeURIComponent(text.split('#signup=')[1].split(/\s/)[0]);

describe('self sign-up', () => {
  it('is off unless switched on and email can confirm it', async () => {
    const off = await boot();
    expect((await off.call('GET', '/auth/status', null)).body.signupAvailable).toBeUndefined();
    expect((await off.form('/auth/signup', { business: 'Harbour', name: 'Ben', email: 'ben@harbour.example' })).location).toContain('error=nosignup');

    const noEmail = await boot({ signup: true, email: false });
    expect((await noEmail.call('GET', '/auth/status', null)).body.signupAvailable).toBeUndefined();
    expect((await noEmail.form('/auth/signup', { business: 'Harbour', name: 'Ben', email: 'ben@harbour.example' })).location).toContain('error=nosignup');
    expect(mails).toEqual([]);

    const on = await boot({ signup: true });
    expect((await on.call('GET', '/auth/status', null)).body.signupAvailable).toBe(true);
  });

  it('confirms the email, then makes an organisation with the person as owner on a free trial', async () => {
    const k = await boot({ signup: true });
    const sent = await k.form('/auth/signup', { business: 'Harbour Kitchens Ltd', name: 'Ben Shaw', email: 'Ben@Harbour.example' });
    expect(sent.location).toBe('/login?signupsent=1');
    expect(sent.cookie).toBeUndefined();
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual(['ben@harbour.example']);
    expect(mails[0].text).toContain('https://rota.preshift.example/login#signup=');
    // Nothing exists until the link is used.
    expect(await k.store.getUser('ben@harbour.example')).toBeNull();

    const token = tokenIn(mails[0].text);
    expect((await k.call('POST', '/auth/signup/link', null, { token })).body).toEqual({ email: 'ben@harbour.example', name: 'Ben Shaw', business: 'Harbour Kitchens Ltd' });
    expect((await k.call('POST', '/auth/signup/link', null, { token: 'forged' })).status).toBe(404);

    const weak = await k.form('/auth/signup/complete', { token, password: 'short', confirm: 'short' });
    expect(weak.location).toContain('error=weak');
    expect(weak.location).toContain('#signup=');

    const done = await k.form('/auth/signup/complete', { token, password: 'bens own long password', confirm: 'bens own long password' });
    expect(done.status).toBe(303);
    expect(done.location).toBe('/app/?view=setup');
    const account = (await k.store.getUser('ben@harbour.example'))!;
    expect(account.orgId).toMatch(/^org-[0-9a-f]{12}$/);
    const org = await k.store.load(account.orgId);
    expect(org.state.entities.map((e) => e.name)).toEqual(['Harbour Kitchens Ltd']);
    expect(org.state.sites).toEqual([]);
    expect(org.users).toHaveLength(1);
    expect(org.users[0]).toMatchObject({ email: 'ben@harbour.example', name: 'Ben Shaw', status: 'active', audience: 'operator' });
    expect(org.users[0].memberships.map((m) => m.roleId)).toEqual(['owner']);
    expect(org.audit.map((a) => a.action)).toEqual(expect.arrayContaining(['org.signed_up', 'access.owner_created']));

    const billing = (await getBilling(k.store, account.orgId))!;
    expect(Date.parse(billing.trialEndsAt) - Date.now()).toBeGreaterThan(13 * DAY);

    const me = await k.call('GET', '/auth/me', done.cookie!);
    expect(me.body).toMatchObject({ email: 'ben@harbour.example', orgId: account.orgId, billing: { standing: 'trial', locked: false, trialDaysLeft: 14 } });
    // Their own organisation only.
    expect((await k.call('GET', '/v1/employees', done.cookie!)).body).toEqual([]);

    // The link works once.
    expect((await k.form('/auth/signup/complete', { token, password: 'another long password', confirm: 'another long password' })).location).toContain('error=badlink');
  });

  it('answers the same for an email that already has an account, and tells only its inbox', async () => {
    const k = await boot({ signup: true });
    const res = await k.form('/auth/signup', { business: 'Anything', name: 'Someone', email: OLIVIA });
    expect(res.location).toBe('/login?signupsent=1');
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe('You already have a Preshift account');
    expect(mails[0].text).not.toContain('#signup=');
    expect((await k.store.getUser(OLIVIA))!.orgId).toBe('demo');
  });

  it('caps the emails one address can be sent', async () => {
    const k = await boot({ signup: true });
    for (let i = 0; i < 4; i++) await k.form('/auth/signup', { business: 'Harbour', name: 'Ben', email: 'ben@harbour.example' });
    expect(mails).toHaveLength(3);
  }, 15_000);

  it('refuses a form with no business or name', async () => {
    const k = await boot({ signup: true });
    expect((await k.form('/auth/signup', { business: '', name: 'Ben', email: 'ben@harbour.example' })).location).toContain('error=details');
    expect(mails).toEqual([]);
  });
});

describe('billing', () => {
  it('leaves an organisation billed under its engagement alone', async () => {
    const k = await boot();
    const olivia = await k.as(OLIVIA, OLIVIA_MFA);
    const view = await k.call('GET', '/v1/billing', olivia);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ standing: 'managed', locked: false, canSubscribe: false, canManage: false });
    expect((await k.call('POST', '/v1/billing/checkout', olivia)).status).toBe(409);
    expect((await k.call('GET', '/auth/me', olivia)).body.billing).toBeUndefined();
  });

  it('is for people who manage settings, never a key', async () => {
    const k = await boot();
    const supervisor = await k.as('grace@marylebonegroup.example');
    expect((await k.call('GET', '/v1/billing', supervisor)).status).toBe(403);
    const keyed = await kit({ keys: [{ key: 'sys', orgId: 'demo', name: 'System', scopes: ['*'] }], env: STRIPE_ENV });
    expect((await keyed.call('GET', '/v1/billing', { key: 'sys' })).status).toBe(403);
  });

  it('sends the owner to Stripe Checkout per site, carrying the trial left, with one customer per organisation', async () => {
    const k = await boot();
    const olivia = await selfServe(k);
    const view = await k.call('GET', '/v1/billing', olivia);
    expect(view.body).toMatchObject({ standing: 'trial', trialDaysLeft: 10, stripe: true, canSubscribe: true });
    // The quote is the published price for the sites set up, monthly and yearly.
    expect(view.body.quotes.month).toMatchObject({ sites: 1, netPence: 11_900, vatPence: 2_380, grossPence: 14_280 });
    expect(view.body.quotes.year).toMatchObject({ sites: 1, netPence: 119_000 });

    const res = await k.call('POST', '/v1/billing/checkout', olivia);
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://checkout.stripe.com/c/pay/cs_1');
    const customer = stripe.find((c) => c.path === '/customers')!;
    expect(customer.body.get('metadata[orgId]')).toBe('demo');
    expect(customer.idempotency).toBe('customer-demo');
    expect(await k.store.getSetting(customerSetting('cus_1'))).toBe('demo');
    const session = stripe.find((c) => c.path === '/checkout/sessions')!;
    expect(session.body.get('mode')).toBe('subscription');
    expect(session.body.get('customer')).toBe('cus_1');
    expect(session.body.get('line_items[0][price]')).toBe('price_site');
    // The demo group's sites are the sample's, so it pays for the minimum of one.
    expect(session.body.get('line_items[0][quantity]')).toBe('1');
    expect(Number(session.body.get('subscription_data[trial_end]'))).toBe(Math.floor(Date.parse((await getBilling(k.store, 'demo'))!.trialEndsAt) / 1000));
    expect(session.body.get('subscription_data[metadata][orgId]')).toBe('demo');
    expect(session.body.get('tax_id_collection[enabled]')).toBe('true');

    // A second go reuses the customer.
    stripe = [];
    await k.call('POST', '/v1/billing/checkout', olivia);
    expect(stripe.map((c) => c.path)).toEqual(['/checkout/sessions']);
  });

  it('starts billing at once when under two days of trial are left', async () => {
    const k = await boot();
    const olivia = await selfServe(k, { trialEndsAt: new Date(Date.now() + DAY).toISOString() });
    await k.call('POST', '/v1/billing/checkout', olivia);
    expect(stripe.find((c) => c.path === '/checkout/sessions')!.body.has('subscription_data[trial_end]')).toBe(false);
  });

  it('believes Stripe only with its signature, and only for a customer Preshift made', async () => {
    const k = await boot();
    await selfServe(k, { customerId: 'cus_1' });
    await k.store.setSetting(customerSetting('cus_1'), 'demo');
    const event = { type: 'customer.subscription.updated', data: { object: subscription('active', 1) } };

    expect((await webhook(k, event, 'whsec_wrong')).status).toBe(401);
    expect((await getBilling(k.store, 'demo'))!.status).toBeUndefined();

    const res = await webhook(k, event);
    expect(res).toEqual({ status: 200, body: { ok: true, recorded: true } });
    const record = (await getBilling(k.store, 'demo'))!;
    expect(record).toMatchObject({ subscriptionId: 'sub_1', itemId: 'si_1', status: 'active', quantity: 1, currentPeriodEnd: new Date(1_800_000_000_000).toISOString() });
    expect((await k.store.load('demo')).audit.at(-1)).toMatchObject({ actor: 'Stripe', action: 'billing.subscription_active' });

    // Someone else's customer is acknowledged and ignored.
    const stranger = await webhook(k, { type: 'customer.subscription.updated', data: { object: { ...subscription('canceled'), customer: 'cus_other' } } });
    expect(stranger.body.recorded).toBe(false);

    // Older news arriving late changes nothing.
    const late = await webhook(k, { ...event, created: Math.floor(Date.now() / 1000) - 3600, data: { object: subscription('canceled') } });
    expect(late.body.recorded).toBe(false);
    expect((await getBilling(k.store, 'demo'))!.status).toBe('active');

    const failed = await webhook(k, { type: 'invoice.payment_failed', data: { object: { customer: 'cus_1', amount_due: 4900, currency: 'gbp', hosted_invoice_url: 'https://invoice.stripe.com/i/1' } } });
    expect(failed.body.recorded).toBe(true);
    expect((await getBilling(k.store, 'demo'))!.lastInvoice).toMatchObject({ status: 'failed', amountPence: 4900, url: 'https://invoice.stripe.com/i/1' });
  });

  it('pauses changes once the trial lapses unpaid, keeps everything readable, and lifts the pause on payment', async () => {
    const k = await boot();
    const olivia = await selfServe(k, { trialEndsAt: new Date(Date.now() - DAY).toISOString(), customerId: 'cus_1' });
    await k.store.setSetting(customerSetting('cus_1'), 'demo');

    const change = () => k.call('PUT', '/v1/settings/claude-limits', olivia, { monthlyUsd: 50 });
    const refused = await change();
    expect(refused.status).toBe(402);
    expect(refused.body.error).toBe('billing_required');
    expect((await k.call('GET', '/v1/employees', olivia)).status).toBe(200);
    expect((await k.call('GET', '/auth/me', olivia)).body.billing).toMatchObject({ standing: 'lapsed', locked: true, trialDaysLeft: 0 });
    // Paying is never paused.
    expect((await k.call('POST', '/v1/billing/checkout', olivia)).status).toBe(200);
    expect((await k.call('POST', '/v1/billing/portal', olivia)).status).toBe(200);

    await webhook(k, { type: 'customer.subscription.created', data: { object: subscription('active') } });
    expect((await change()).status).toBe(200);

    // A failed payment is a grace period while Stripe retries; unpaid after that pauses again.
    await webhook(k, { type: 'customer.subscription.updated', data: { object: subscription('past_due') } });
    expect((await change()).status).toBe(200);
    await webhook(k, { type: 'customer.subscription.updated', data: { object: subscription('unpaid') } });
    expect((await change()).status).toBe(402);
  });

  it('never pauses an organisation that has no way to pay', async () => {
    const k = await boot({ stripe: false });
    const olivia = await selfServe(k, { trialEndsAt: new Date(Date.now() - DAY).toISOString() });
    expect((await k.call('PUT', '/v1/settings/claude-limits', olivia, { monthlyUsd: 50 })).status).toBe(200);
    const view = await k.call('GET', '/v1/billing', olivia);
    expect(view.body).toMatchObject({ standing: 'lapsed', locked: false, stripe: false, canSubscribe: false });
    expect((await k.call('POST', '/v1/billing/checkout', olivia)).status).toBe(503);
    expect((await k.call('POST', '/v1/integrations/stripe/webhook', null, {})).status).toBe(404);
  });

  it('brings the sites paid for into line with the sites set up', async () => {
    const k = await boot();
    const olivia = await selfServe(k, { customerId: 'cus_1', subscriptionId: 'sub_1', itemId: 'si_1', status: 'active', quantity: 3 });
    const res = await k.call('POST', '/v1/billing/sites', olivia);
    expect(res.status).toBe(200);
    const call = stripe.find((c) => c.path === '/subscriptions/sub_1')!;
    expect(call.body.get('items[0][id]')).toBe('si_1');
    expect(call.body.get('items[0][quantity]')).toBe('1');
    expect(call.body.get('proration_behavior')).toBe('create_prorations');
    // A subscription in force is never bought twice.
    expect((await k.call('POST', '/v1/billing/checkout', olivia)).status).toBe(409);
  });
});

describe('pricing in billing', () => {
  it('takes an annual subscription on the annual price, and offers it only when that price is set', async () => {
    const k = await boot();
    const olivia = await selfServe(k);
    expect((await k.call('POST', '/v1/billing/checkout', olivia, { interval: 'year' })).status).toBe(200);
    expect(stripe.find((c) => c.path === '/checkout/sessions')!.body.get('line_items[0][price]')).toBe('price_site_year');
    expect((await k.call('POST', '/v1/billing/checkout', olivia, { interval: 'fortnight' })).status).toBe(400);

    const monthlyOnly = await boot({ env: { STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: 'whsec_test_secret', STRIPE_PRICE_ID: 'price_site' } });
    const o2 = await selfServe(monthlyOnly);
    expect((await monthlyOnly.call('GET', '/v1/billing', o2)).body.quotes.year).toBeUndefined();
    expect((await monthlyOnly.call('POST', '/v1/billing/checkout', o2, { interval: 'year' })).body.error).toBe('no_annual');
  });

  it('sends a group above the self-serve limit to a group plan rather than a card form', async () => {
    const k = await boot();
    const olivia = await selfServe(k);
    const org = await k.store.load('demo');
    const template = org.state.sites[0];
    for (let i = 0; i < 21; i++) org.state.sites.push({ ...template, id: `own-${i}`, name: `Own ${i}` });
    await k.store.save(org);
    const view = await k.call('GET', '/v1/billing', olivia);
    expect(view.body.quotes.month).toMatchObject({ sites: 21, groupPlan: true });
    const res = await k.call('POST', '/v1/billing/checkout', olivia);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('group_plan');
    expect(stripe).toEqual([]);
  });

  it('records whether the subscription is paid monthly or yearly', async () => {
    const k = await boot();
    await selfServe(k, { customerId: 'cus_1' });
    await k.store.setSetting(customerSetting('cus_1'), 'demo');
    const sub = subscription('active');
    (sub.items.data[0] as Record<string, unknown>).price = { recurring: { interval: 'year' } };
    await webhook(k, { type: 'customer.subscription.created', data: { object: sub } });
    expect((await getBilling(k.store, 'demo'))!.interval).toBe('year');
  });
});

describe('billing rules', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  const base: BillingRecord = { trialEndsAt: '2026-10-30T12:00:00Z', createdAt: '2026-10-16T12:00:00Z' };

  it('reads the standing from the record', () => {
    expect(standingOf(null, now, true)).toEqual({ standing: 'managed', locked: false });
    expect(standingOf(base, now, true)).toMatchObject({ standing: 'trial', locked: false, trialDaysLeft: 8 });
    expect(standingOf({ ...base, status: 'incomplete' }, now, true).standing).toBe('trial');
    expect(standingOf({ ...base, status: 'trialing' }, now, true).standing).toBe('active');
    expect(standingOf({ ...base, status: 'past_due' }, now, true)).toMatchObject({ standing: 'past_due', locked: false });
    // Cancelling ends the subscription even with trial days left on the clock.
    expect(standingOf({ ...base, status: 'canceled' }, now, true)).toMatchObject({ standing: 'lapsed', locked: true });
    expect(standingOf({ ...base, trialEndsAt: '2026-10-21T12:00:00Z' }, now, true)).toMatchObject({ standing: 'lapsed', locked: true, trialDaysLeft: 0 });
    expect(standingOf({ ...base, trialEndsAt: '2026-10-21T12:00:00Z' }, now, false).locked).toBe(false);
  });

  it('checks signatures as Stripe makes them, within five minutes', () => {
    const raw = '{"id":"evt_1"}';
    const t = 1_800_000_000;
    const header = signStripePayload('whsec_x', raw, t);
    expect(verifyStripeSignature('whsec_x', header, raw, t + 10)).toBe(true);
    expect(verifyStripeSignature('whsec_x', `${header},v1=deadbeef`, raw, t)).toBe(true);
    expect(verifyStripeSignature('whsec_x', header, `${raw} `, t)).toBe(false);
    expect(verifyStripeSignature('whsec_y', header, raw, t)).toBe(false);
    expect(verifyStripeSignature('whsec_x', header, raw, t + 301)).toBe(false);
    expect(verifyStripeSignature('whsec_x', undefined, raw, t)).toBe(false);
  });

  it('form-encodes nested parameters as Stripe reads them', () => {
    expect(decodeURIComponent(formEncode({ a: 1, b: { c: 'x', d: [{ e: true }] }, skip: undefined }))).toBe('a=1&b[c]=x&b[d][0][e]=true');
  });
});
