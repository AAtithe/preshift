import { describe, expect, it } from 'vitest';
import { kit, type Kit } from './testkit';

const person = (key: string, userId: string) => ({ key, orgId: 'demo', name: `${key} key`, scopes: ['*' as const], userId, mfa: true });
const KEYS = [
  person('kate', 'usr_people'),
  person('nadia', 'usr_fd'),
  person('owner', 'usr_owner'),
  person('priya', 'usr_gm_mar'),
  { key: 'system', orgId: 'demo', name: 'HR system', scopes: ['*' as const] },
];

let k: Kit;

/** The demo's finance director has an authenticator; one test takes it away. */
async function setup(options: { fdAuthenticator?: boolean } = {}) {
  k = await kit({ keys: KEYS as never });
  if (options.fdAuthenticator === false) {
    const org = await k.store.load('demo');
    org.users.find((u) => u.id === 'usr_fd')!.mfaEnrolled = false;
  }
  return (method: string, url: string, body?: unknown, key = 'kate') => k.call(method, url, { key }, body);
}

describe('pay changes need finance approval', () => {
  it('keeps the pay in force while a change waits, and shows it to those who set or approve pay', async () => {
    const call = await setup();
    const res = await call('PATCH', '/v1/employees/mar-8', { hourlyRate: 13.5, contractedHours: 20 });
    expect(res.status).toBe(200);
    expect(res.body.hourlyRate).toBe(12.85);
    expect(res.body.contractedHours).toBe(20);
    expect(res.body.pendingPay).toMatchObject({ after: { hourlyRate: 13.5 }, requestedBy: 'Kate Morgan' });
    // The record's update names what changed now, not the rate still waiting.
    const org = await k.store.load('demo');
    expect(org.audit.filter((a) => a.action === 'employee.updated').at(-1)?.detail?.fields).toEqual(['contractedHours']);

    const waiting = (await call('GET', '/v1/pay-changes?status=pending', undefined, 'nadia')).body as { employeeId: string }[];
    expect(waiting.map((c) => c.employeeId).sort()).toEqual(['mar-5', 'mar-8']);
    // A GM sets no pay, so sees no proposals, on the list or on the person.
    expect((await call('GET', '/v1/pay-changes', undefined, 'priya')).body).toEqual([]);
    expect((await call('GET', '/v1/employees/mar-8', undefined, 'priya')).body.pendingPay).toBeUndefined();
  });

  it('applies the change only when finance approves, and tells payroll then', async () => {
    const call = await setup();
    const change = (await call('POST', '/v1/employees/mar-8/pay-changes', { hourlyRate: 13.5, reason: 'Trained on the bar' })).body;
    expect(change).toMatchObject({ status: 'pending', before: { hourlyRate: 12.85 }, after: { hourlyRate: 13.5 }, reason: 'Trained on the bar' });
    const org = await k.store.load('demo');
    const queued = () => org.outbox.filter((o) => o.type === 'employee.upsert' && (o.payload as { employeeId: string }).employeeId === 'mar-8').length;
    const before = queued();

    const approved = await call('POST', `/v1/pay-changes/${change.id}/approve`, { note: 'In budget' }, 'nadia');
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'approved', decidedBy: 'Nadia Rahman', note: 'In budget' });
    expect((await call('GET', '/v1/employees/mar-8')).body.hourlyRate).toBe(13.5);
    expect(queued()).toBe(before + 1);
    expect(org.audit.map((a) => a.action)).toEqual(expect.arrayContaining(['pay.change_proposed', 'pay.change_approved']));
    // Systems that follow employee changes hear of the new pay when it applies, not when it was proposed.
    const updates = org.audit.filter((a) => a.action === 'employee.updated' && a.detail?.id === 'mar-8');
    expect(updates.at(-1)?.detail?.fields).toEqual(['hourlyRate']);
    expect((await call('POST', `/v1/pay-changes/${change.id}/approve`, {}, 'nadia')).status).toBe(409);
  });

  it('needs the finance director, with an authenticator, and never on their own proposal or pay', async () => {
    let call = await setup({ fdAuthenticator: false });
    const change = (await call('POST', '/v1/employees/mar-8/pay-changes', { hourlyRate: 13.5 })).body;
    const noMfa = await call('POST', `/v1/pay-changes/${change.id}/approve`, {}, 'nadia');
    expect(noMfa.status).toBe(403);
    expect(noMfa.body.message).toMatch(/authenticator/);
    // The owner sets pay but does not approve it, and neither does the person who proposed it.
    expect((await call('POST', `/v1/pay-changes/${change.id}/approve`, {}, 'owner')).status).toBe(403);
    expect((await call('POST', `/v1/pay-changes/${change.id}/approve`, {}, 'kate')).status).toBe(403);

    call = await setup();
    const org = await k.store.load('demo');
    // Someone holding both duties still cannot approve what they proposed.
    org.users.find((u) => u.id === 'usr_people')!.memberships.push({ ...org.users.find((u) => u.id === 'usr_fd')!.memberships[0], id: 'm_extra' });
    const mine = (await call('POST', '/v1/employees/mar-8/pay-changes', { hourlyRate: 14 })).body;
    const self = await call('POST', `/v1/pay-changes/${mine.id}/approve`, {});
    expect(self.status).toBe(403);
    expect(self.body.message).toMatch(/Somebody else approves a change you proposed/);
    // Nor decide their own pay: the demo's waiting change is for Lukas, so make him the approver.
    org.users.find((u) => u.id === 'usr_fd')!.employeeId = 'mar-5';
    expect((await call('POST', '/v1/pay-changes/pay_demo1/approve', {}, 'nadia')).body.message).toMatch(/your own pay/);
  });

  it('refuses to approve against pay that has moved, and supersedes an older proposal', async () => {
    const call = await setup();
    const first = (await call('POST', '/v1/employees/mar-8/pay-changes', { hourlyRate: 13.25 })).body;
    const second = (await call('POST', '/v1/employees/mar-8/pay-changes', { hourlyRate: 13.5 })).body;
    const list = (await call('GET', '/v1/pay-changes?employeeId=mar-8')).body as { id: string; status: string }[];
    expect(list.find((c) => c.id === first.id)?.status).toBe('superseded');
    expect((await call('POST', `/v1/pay-changes/${first.id}/approve`, {}, 'nadia')).status).toBe(409);
    // An integration sets pay directly; the waiting proposal was made against the old rate.
    expect((await call('PATCH', '/v1/employees/mar-8', { hourlyRate: 14 }, 'system')).body.hourlyRate).toBe(14);
    const stale = await call('POST', `/v1/pay-changes/${second.id}/approve`, {}, 'nadia');
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('stale');
  });

  it('refuses a rate below the legal minimum, and records rejections and withdrawals', async () => {
    const call = await setup();
    const low = await call('POST', '/v1/employees/mar-8/pay-changes', { hourlyRate: 9 });
    expect(low.status).toBe(422);
    expect(low.body.error).toBe('below_minimum');
    expect((await call('POST', '/v1/employees/mar-8/pay-changes', { hourlyRate: 12.85 })).body.error).toBe('no_change');

    const one = (await call('POST', '/v1/employees/mar-8/pay-changes', { hourlyRate: 15 })).body;
    expect((await call('POST', `/v1/pay-changes/${one.id}/reject`, {}, 'nadia')).status).toBe(400);
    const rejected = await call('POST', `/v1/pay-changes/${one.id}/reject`, { note: 'Above the band for the role' }, 'nadia');
    expect(rejected.body).toMatchObject({ status: 'rejected', note: 'Above the band for the role' });
    expect((await call('GET', '/v1/employees/mar-8')).body.hourlyRate).toBe(12.85);

    const two = (await call('POST', '/v1/employees/mar-8/pay-changes', { hourlyRate: 13 })).body;
    expect((await call('POST', `/v1/pay-changes/${two.id}/withdraw`)).body.status).toBe('withdrawn');
    expect((await call('GET', '/v1/employees/mar-8')).body.pendingPay).toBeUndefined();
  });

  it('starts a starter at nought with their rate proposed, and lets an integration set pay directly', async () => {
    const call = await setup();
    const starter = { name: 'New Starter', siteId: 'mar', roleIds: ['server'], payBasis: 'hourly', dateOfBirth: '2000-01-01', hourlyRate: 13 };
    const created = await call('POST', '/v1/employees', starter);
    expect(created.status).toBe(201);
    expect(created.body.hourlyRate).toBe(0);
    expect(created.body.pendingPay.after).toEqual({ payBasis: 'hourly', hourlyRate: 13, annualSalary: 0 });
    const direct = await call('POST', '/v1/employees', { ...starter, name: 'From the HR system' }, 'system');
    expect(direct.body.hourlyRate).toBe(13);
    expect(direct.body.pendingPay).toBeUndefined();
  });

  it('applies at once, and says so, when nobody else could approve', async () => {
    const call = await setup();
    const org = await k.store.load('demo');
    // A business with no finance director yet: the owner and the people manager both set pay.
    org.users.find((u) => u.id === 'usr_fd')!.status = 'suspended';
    const res = await call('PATCH', '/v1/employees/mar-8', { hourlyRate: 13.5 });
    expect(res.body.hourlyRate).toBe(13.5);
    expect(res.body.pendingPay).toBeUndefined();
    const change = (await call('POST', '/v1/employees/mar-8/pay-changes', { hourlyRate: 13.75, reason: 'Year end review' })).body;
    expect(change).toMatchObject({ status: 'approved', decidedBy: 'Kate Morgan' });
    expect(change.note).toMatch(/Nobody else can approve/);
    expect((await call('GET', '/v1/employees/mar-8')).body.hourlyRate).toBe(13.75);
  });
});
