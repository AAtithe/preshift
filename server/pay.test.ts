import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PayChange } from '../src/engine/types';
import { emailSetting } from './mail';
import { applyDuePayChanges, remindApprovers } from './routes/pay';
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

describe('pay changes from an agreed date', () => {
  it('takes effect on its date when approved ahead of it, and finance can take it back until then', async () => {
    const call = await setup();
    const change = (await call('POST', '/v1/employees/mar-8/pay-changes', { hourlyRate: 13.5, effectiveFrom: '2026-11-02', reason: 'Bar training' })).body;
    expect(change.effectiveFrom).toBe('2026-11-02');
    const approved = (await call('POST', `/v1/pay-changes/${change.id}/approve`, {}, 'nadia')).body;
    expect(approved).toMatchObject({ status: 'approved' });
    expect(approved.appliedOn).toBeUndefined();
    expect((await call('GET', '/v1/employees/mar-8')).body.hourlyRate).toBe(12.85);
    // Nothing more for them until it applies.
    expect((await call('POST', '/v1/employees/mar-8/pay-changes', { hourlyRate: 14 })).body.error).toBe('scheduled');

    const org = await k.store.load('demo');
    expect(applyDuePayChanges(org, '2026-11-01')).toBe(0);
    expect(applyDuePayChanges(org, '2026-11-02')).toBe(1);
    expect(org.state.employees.find((e) => e.id === 'mar-8')!.hourlyRate).toBe(13.5);
    expect(org.payChanges.find((c) => c.id === change.id)).toMatchObject({ appliedOn: '2026-11-02' });
    expect(org.payChanges.find((c) => c.id === change.id)!.backPay).toBeUndefined();

    // A second one, taken back by finance before its date.
    const next = (await call('POST', '/v1/employees/mar-8/pay-changes', { hourlyRate: 14, effectiveFrom: '2027-01-04' })).body;
    await call('POST', `/v1/pay-changes/${next.id}/approve`, {}, 'nadia');
    expect((await call('POST', `/v1/pay-changes/${next.id}/withdraw`)).status).toBe(403);
    expect((await call('POST', `/v1/pay-changes/${next.id}/withdraw`, undefined, 'nadia')).body.status).toBe('withdrawn');
  });

  it('applies a change approved after its date at once, with back pay for the hours worked in between', async () => {
    const call = await setup();
    const entry = (await call('POST', '/v1/time-entries', { employeeId: 'mar-8', siteId: 'mar', roleId: 'server', date: '2026-10-13', clockIn: 600, clockOut: 960, breakMinutes: 20 }, 'system')).body;
    await call('POST', '/v1/time-entries/approve', { ids: [entry.id] }, 'system');
    const change = (await call('POST', '/v1/employees/mar-8/pay-changes', { hourlyRate: 13.5, effectiveFrom: '2026-10-12' })).body;
    const approved = (await call('POST', `/v1/pay-changes/${change.id}/approve`, {}, 'nadia')).body;
    const hours = Math.round((340 / 60) * 100) / 100;
    expect(approved).toMatchObject({ appliedOn: '2026-10-21', backPay: { from: '2026-10-12', to: '2026-10-20', hours, basis: 'clocked' } });
    expect(approved.backPay.amount).toBeCloseTo(hours * 0.65, 2);
    const org = await k.store.load('demo');
    expect(org.audit.some((a) => a.action === 'pay.back_pay_due' && a.detail?.id === change.id)).toBe(true);
    expect((await call('POST', '/v1/employees/mar-8/pay-changes', { hourlyRate: 14, effectiveFrom: '2025-01-01' })).body.error).toBe('invalid_dates');
  });

  it('does not apply over pay that moved after approval, and marks it replaced', async () => {
    const call = await setup();
    const change = (await call('POST', '/v1/employees/mar-8/pay-changes', { hourlyRate: 13.5, effectiveFrom: '2026-11-02' })).body;
    await call('POST', `/v1/pay-changes/${change.id}/approve`, {}, 'nadia');
    await call('PATCH', '/v1/employees/mar-8', { hourlyRate: 14 }, 'system');
    const org = await k.store.load('demo');
    expect(applyDuePayChanges(org, '2026-11-02')).toBe(0);
    expect(org.payChanges.find((c) => c.id === change.id)).toMatchObject({ status: 'superseded' });
    expect(org.state.employees.find((e) => e.id === 'mar-8')!.hourlyRate).toBe(14);
  });
});

describe('one pay history, however pay was set', () => {
  it('records pay set by a system key, and by a person with nobody to approve', async () => {
    const call = await setup();
    await call('PATCH', '/v1/employees/mar-8', { hourlyRate: 14 }, 'system');
    const history = (await call('GET', '/v1/pay-changes?employeeId=mar-8', undefined, 'nadia')).body as PayChangeView[];
    expect(history[0]).toMatchObject({ status: 'approved', direct: 'system', before: { hourlyRate: 12.85 }, after: { hourlyRate: 14 }, appliedOn: '2026-10-21' });
    const starter = (await call('POST', '/v1/employees', { name: 'Direct Starter', siteId: 'mar', roleIds: ['server'], payBasis: 'hourly', dateOfBirth: '2000-01-01', hourlyRate: 13 }, 'system')).body;
    expect((await call('GET', `/v1/pay-changes?employeeId=${starter.id}`, undefined, 'nadia')).body[0]).toMatchObject({ direct: 'system', after: { hourlyRate: 13 } });

    const org = await k.store.load('demo');
    org.users.find((u) => u.id === 'usr_fd')!.status = 'suspended';
    await call('PATCH', '/v1/employees/mar-8', { hourlyRate: 14.25 });
    const latest = (await call('GET', '/v1/pay-changes?employeeId=mar-8')).body[0];
    expect(latest).toMatchObject({ direct: 'no_approver', decidedBy: 'Kate Morgan', after: { hourlyRate: 14.25 } });
    expect(org.audit.filter((a) => a.action === 'pay.change_direct')).toHaveLength(3);
  });
});

describe('the rule for pay approvals', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('says who can approve, keeps the turnaround and cut-off, and shows where each change stands', async () => {
    const call = await setup({ fdAuthenticator: false });
    const policy = (await call('GET', '/v1/pay-policy')).body;
    expect(policy).toMatchObject({ policy: { turnaroundDays: 2, cutoffWeekday: 0 }, nextCutoff: '2026-10-26', canApprove: false });
    expect(policy.approvers).toEqual([{ id: 'usr_fd', name: 'Nadia Rahman', ready: false }]);
    // Kate sets pay, so she reads the rule, but finance or the owner sets it.
    expect((await call('PUT', '/v1/pay-policy', { turnaroundDays: 3 })).status).toBe(403);
    expect((await call('PUT', '/v1/pay-policy', { turnaroundDays: 3, cutoffWeekday: 2 }, 'owner')).body).toEqual({ turnaroundDays: 3, cutoffWeekday: 2 });
    expect((await call('GET', '/v1/pay-policy', undefined, 'priya')).status).toBe(403);

    const waiting = (await call('GET', '/v1/pay-changes?status=pending')).body as PayChangeView[];
    expect(waiting[0].standing).toMatchObject({ cutoff: '2026-10-21', daysToCutoff: 0 });
  });

  it('reminds finance by email, and copies the owner in once a change is overdue', async () => {
    const call = await setup();
    const sent: { to: string[]; subject: string; text: string }[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit = {}) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: `m_${sent.length}` }), { status: 200 });
    });
    await k.store.setSetting(emailSetting('demo'), JSON.stringify({ resendApiKey: 're_test_1234567890abcd', from: 'Preshift <rota@ws.example>', appUrl: 'https://rota.ws.example' }));
    const org = await k.store.load('demo');
    // The demo's waiting change was proposed today: inside the turnaround, but the cut-off is days away.
    let done = await remindApprovers(k.store, org, '2026-10-21');
    expect(done).toEqual({ sent: 1, escalated: false });
    expect(sent[0].to).toEqual(['nadia@marylebonegroup.example']);
    expect(sent[0].text).toContain('https://rota.ws.example/app/?view=pay');
    expect(sent[0].text).not.toContain('Lukas');
    expect(sent[0].text).not.toMatch(/£/);

    sent.length = 0;
    done = await remindApprovers(k.store, org, '2026-10-29');
    expect(done?.escalated).toBe(true);
    expect(sent.map((m) => m.to[0]).sort()).toEqual(['nadia@marylebonegroup.example', 'olivia@marylebonegroup.example']);
    expect(sent.find((m) => m.to[0].startsWith('olivia'))!.subject).toMatch(/^Overdue/);

    expect((await call('POST', '/v1/pay-changes/remind', undefined, 'nadia')).status).toBe(200);
    expect((await call('POST', '/v1/pay-changes/remind', undefined, 'priya')).status).toBe(403);
  });
});

type PayChangeView = PayChange & { standing?: { cutoff: string; daysToCutoff: number } };
