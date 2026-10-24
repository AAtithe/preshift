import { describe, expect, it } from 'vitest';
import { putBilling, type BillingRecord } from './billing';
import { kit, type Kit } from './testkit';
import { holdClock } from './testClock';

holdClock();

// Customers: every self sign-up's trial, subscription and revenue on one page, for WS customer
// operations alone, only in the organisation that runs Preshift, counts and billing standing only.

const SAM = 'sam.okoro@williamsstanley.example';
const SAM_MFA = 'demo-usr_ws_partner';
const OLIVIA = 'olivia@marylebonegroup.example';
const OLIVIA_MFA = 'demo-usr_owner';
const DAY = 86_400_000;
const STRIPE_ENV = { STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_PRICE_ID: 'price_site' };
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/** Gives Sam, the WS client partner in the system's own organisation, the customer operations role. */
async function grantCustomers(k: Kit, orgId = 'demo', email = SAM) {
  const org = await k.store.load(orgId);
  const sam = org.users.find((u) => u.email === email)!;
  sam.memberships.push({ id: 'mem_customers', roleId: 'ws_customers', siteIds: null, starts: '2026-01-01', active: true, grantedBy: 'test', grantedAt: ago(1) });
  await k.store.save(org);
}

/** A self sign-up: its own organisation, an owner, some sites, and a billing record. */
async function customer(k: Kit, orgId: string, name: string, sites: number, billing: Partial<BillingRecord> & { createdAt: string }) {
  const org = await k.store.load(orgId);
  org.state.entities.push({ id: 'main', name, companyNumber: '', payeReference: '', intercompanyCode: '1350' });
  const demo = await k.store.load('demo');
  for (let i = 0; i < sites; i++) org.state.sites.push({ ...demo.state.sites[0], id: `${orgId}-s${i}`, name: `${name} ${i}`, entityId: 'main' });
  org.users.push({
    id: `usr_${orgId}`, email: `owner@${orgId}.example`, name: `Owner of ${name}`, jobTitle: 'Owner', audience: 'operator', status: 'active', mfaEnrolled: false, createdAt: billing.createdAt,
    memberships: [{ id: `mem_${orgId}`, roleId: 'owner', siteIds: null, starts: '2026-01-01', active: true, grantedBy: 'Sign-up', grantedAt: billing.createdAt }],
  });
  org.publications = [];
  await k.store.save(org);
  await putBilling(k.store, orgId, { trialEndsAt: new Date(Date.parse(billing.createdAt) + 14 * DAY).toISOString(), ...billing });
}

async function seeded() {
  const k = await kit({ env: STRIPE_ENV });
  await customer(k, 'org-trial', 'Harbour Kitchens', 2, { createdAt: ago(3) });
  await customer(k, 'org-ending', 'Quay Bar', 1, { createdAt: ago(12) });
  await customer(k, 'org-paying', 'Northern Group', 8, { createdAt: ago(40), subscriptionId: 'sub_1', status: 'active', quantity: 8, interval: 'month', customerId: 'cus_1' });
  await customer(k, 'org-yearly', 'Coast Cafes', 3, { createdAt: ago(60), subscriptionId: 'sub_2', status: 'active', quantity: 3, interval: 'year', customerId: 'cus_2' });
  await customer(k, 'org-failed', 'Hill Pubs', 2, { createdAt: ago(50), subscriptionId: 'sub_3', status: 'past_due', quantity: 1, interval: 'month', customerId: 'cus_3' });
  await customer(k, 'org-lapsed', 'Gone Grill', 1, { createdAt: ago(30) });
  // A client billed under its WS engagement has no billing record: managed from Clients, not here.
  const managed = await k.store.load('org-managed');
  managed.state.entities.push({ id: 'main', name: 'Managed Client', companyNumber: '', payeReference: '', intercompanyCode: '1350' });
  await k.store.save(managed);
  return k;
}

describe('customers', () => {
  it('lists every self sign-up with its standing, sites and revenue, newest first', async () => {
    const k = await seeded();
    await grantCustomers(k);
    const res = await k.call('GET', '/v1/customers', await k.as(SAM, SAM_MFA));
    expect(res.status).toBe(200);
    expect(res.body.customers.map((c: { orgId: string }) => c.orgId)).toEqual(['org-trial', 'org-ending', 'org-lapsed', 'org-paying', 'org-failed', 'org-yearly']);
    const by = Object.fromEntries(res.body.customers.map((c: { orgId: string }) => [c.orgId, c]));
    expect(by['org-trial']).toMatchObject({ name: 'Harbour Kitchens', standing: 'trial', sites: 2, sitesBilled: null, mrrPence: 0, owner: { name: 'Owner of Harbour Kitchens', email: 'owner@org-trial.example' } });
    // Eight sites monthly: 5 x £119 + 3 x £99.
    expect(by['org-paying']).toMatchObject({ standing: 'active', sitesBilled: 8, mrrPence: 89_200, interval: 'month' });
    // Three sites yearly is ten months' price, spread over twelve.
    expect(by['org-yearly'].mrrPence).toBe(Math.round((3 * 11_900 * 10) / 12));
    expect(by['org-failed']).toMatchObject({ standing: 'past_due', mrrPence: 11_900 });
    expect(by['org-failed'].attention).toEqual(expect.arrayContaining(['Payment failed: Stripe is retrying the card.', '2 sites set up, 1 billed.']));
    expect(by['org-ending'].attention).toEqual(expect.arrayContaining(['Trial ends in 2 days and no subscription yet.', 'A week in and no rota published.']));
    expect(by['org-lapsed']).toMatchObject({ standing: 'lapsed', locked: true });
    expect(by['org-trial'].onboarding).toMatchObject({ of: 7 });

    expect(res.body.totals).toMatchObject({
      customers: 6, trials: 2, paying: 2, pastDue: 1, lapsed: 1, signups7: 1, signups30: 2,
      mrrPence: 89_200 + Math.round((3 * 11_900 * 10) / 12) + 11_900, sitesBilled: 12,
    });
    expect(res.body.totals.arrPence).toBe(res.body.totals.mrrPence * 12);
    // Of the four whose trial has ended, three are paying.
    expect(res.body.totals.conversion).toBe(0.75);
  });

  it('never shows a customer staff, pay or personnel data', async () => {
    const k = await seeded();
    await grantCustomers(k);
    const res = await k.call('GET', '/v1/customers', await k.as(SAM, SAM_MFA));
    expect(res.raw).not.toMatch(/hourlyRate|annualSalary|dateOfBirth|employees|niNumber/);
  });

  it('records who looked, in the system organisation', async () => {
    const k = await seeded();
    await grantCustomers(k);
    await k.call('GET', '/v1/customers', await k.as(SAM, SAM_MFA));
    expect((await k.store.load('demo')).audit.at(-1)).toMatchObject({ action: 'customers.viewed', detail: { customers: 6 } });
  });

  it('is refused to anyone without the role, including the system organisation owner and a client partner', async () => {
    const k = await seeded();
    expect((await k.call('GET', '/v1/customers', await k.as(SAM, SAM_MFA))).status).toBe(403);
    expect((await k.call('GET', '/v1/customers', await k.as(OLIVIA, OLIVIA_MFA))).status).toBe(403);
  });

  it('needs the authenticator', async () => {
    const k = await seeded();
    await grantCustomers(k);
    const res = await k.call('GET', '/v1/customers', await k.as(SAM));
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/authenticator/);
  });

  it('shows nothing when the role is granted inside a customer, so no client can see the others', async () => {
    const k = await seeded();
    // A customer's owner gives a ws record in their own organisation the role.
    const org = await k.store.load('org-paying');
    org.users.push({
      id: 'usr_sam_here', email: SAM, name: 'Sam Okoro', audience: 'ws', status: 'active', mfaEnrolled: true, createdAt: ago(1),
      memberships: [{ id: 'mem_x', roleId: 'ws_customers', siteIds: null, starts: '2026-01-01', active: true, grantedBy: 'owner', grantedAt: ago(1) }],
    });
    await k.store.save(org);
    await k.store.updateUser(SAM, { orgs: ['demo', 'org-paying'] });
    const { COOKIE, createSession } = await import('./session');
    const there = `${COOKIE}=${await createSession({ email: SAM, orgId: 'org-paying' }, await k.store.sessionSecret(), Date.now(), SAM_MFA)}`;
    const res = await k.call('GET', '/v1/customers', there);
    expect(res.status).toBe(403);
    expect(res.raw).not.toContain('Harbour Kitchens');
  });

  it('is never reached with an API key', async () => {
    const k = await kit({ keys: [{ key: 'sys', orgId: 'demo', name: 'System', scopes: ['*'] }] });
    expect((await k.call('GET', '/v1/customers', { key: 'sys' })).status).toBe(403);
  });

  it('counts nothing while nobody has signed up', async () => {
    const k = await kit();
    await grantCustomers(k);
    const res = await k.call('GET', '/v1/customers', await k.as(SAM, SAM_MFA));
    expect(res.body).toMatchObject({ customers: [], totals: { customers: 0, conversion: null, mrrPence: 0 } });
  });
});
