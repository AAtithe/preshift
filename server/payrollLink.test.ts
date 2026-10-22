import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

const SAM = { name: 'Sam Cook', siteId: 'mar', roleIds: ['chef'], payBasis: 'hourly', hourlyRate: 15, dateOfBirth: '1990-01-01', contractedHours: 40 };

async function setup() {
  const simulator = new TeamPaySimulator();
  const store = new MemoryStore(['demo'], '2026-10-21');
  const { app, ctx } = await buildApp({
    apiKeys: [
      { key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*'] },
      // WS payroll may send payroll but not change anyone's pay.
      { key: 'payroll', orgId: 'demo', name: 'Ravi', scopes: ['*'], userId: 'usr_ws_payroll', mfa: true },
    ],
    store,
    provider: simulator,
    autoDispatch: false,
  });
  const call = async (method: string, url: string, body?: unknown, key = 'admin') => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  const employer = (await call('GET', '/v1/integrations/payroll/link?entityId=wdl')).body.employerId as string;
  const dispatch = async () => {
    const org = await store.load('demo');
    await ctx.dispatcher.processOrg(org);
    await store.save();
    return org;
  };
  const employee = async (id: string) => (await store.load('demo')).state.employees.find((e) => e.id === id)!;
  return { call, simulator, employer, dispatch, employee, store };
}

describe('starters already on TeamPay', () => {
  it('links a starter to the one record with the same name and date of birth instead of creating another', async () => {
    const t = await setup();
    const existing = t.simulator.addExisting(t.employer, { name: 'Sam Cook', dateOfBirth: '1990-01-01', hourlyRate: 15, contractedHours: 40 });
    const sam = (await t.call('POST', '/v1/employees', SAM)).body;
    const before = t.simulator.employees.size;
    await t.dispatch();
    expect((await t.employee(sam.id)).payrollId).toBe(existing);
    expect((await t.employee(sam.id)).payrollReview).toBeUndefined();
    expect(t.simulator.employees.size).toBe(before);
  });

  it('holds a difference for a decision, refuses pay edits meanwhile, and never overwrites either side', async () => {
    const t = await setup();
    t.simulator.addExisting(t.employer, { name: 'Sam Cook', dateOfBirth: '1990-01-01', hourlyRate: 14.25, contractedHours: 40 });
    const sam = (await t.call('POST', '/v1/employees', SAM)).body;
    await t.dispatch();
    const linked = await t.employee(sam.id);
    expect(linked.payrollReview).toMatchObject({ how: 'auto', differences: [{ field: 'hourlyRate', preshift: 15, payroll: 14.25, pay: true }] });
    expect([...t.simulator.employees.values()].find((r) => r.payrollId === linked.payrollId)!.hourlyRate).toBe(14.25);
    const edit = await t.call('PATCH', `/v1/employees/${sam.id}`, { hourlyRate: 16 });
    expect(edit.status).toBe(409);
    expect(edit.body.error).toBe('payroll_review');
  });

  it('stops rather than guess when two records match equally', async () => {
    const t = await setup();
    t.simulator.addExisting(t.employer, { name: 'Sam Cook', dateOfBirth: '1990-01-01' });
    t.simulator.addExisting(t.employer, { name: 'Sam Cook', dateOfBirth: '1990-01-01' });
    const sam = (await t.call('POST', '/v1/employees', SAM)).body;
    const before = t.simulator.employees.size;
    const org = await t.dispatch();
    expect((await t.employee(sam.id)).payrollId).toBeUndefined();
    expect(t.simulator.employees.size).toBe(before);
    expect(org.outbox.find((i) => i.type === 'employee.upsert' && i.payload.employeeId === sam.id)).toMatchObject({ status: 'failed', reason: 'ambiguous_match' });
  });

  it('holds a starter TeamPay may already hold under a different name, until someone links them or confirms they are new', async () => {
    const t = await setup();
    t.simulator.addExisting(t.employer, { name: 'S. Cook', dateOfBirth: '1990-01-01', hourlyRate: 15, contractedHours: 40 });
    const sam = (await t.call('POST', '/v1/employees', SAM)).body;
    const before = t.simulator.employees.size;
    await t.dispatch();
    expect((await t.employee(sam.id)).payrollId).toBeUndefined();
    expect(t.simulator.employees.size).toBe(before);
    const view = (await t.call('GET', '/v1/integrations/payroll/link?entityId=wdl')).body;
    expect(view.people.find((p: { employeeId: string }) => p.employeeId === sam.id)).toMatchObject({ held: 'possible_match', suggestions: [{ level: 'likely' }] });

    // Setting up everyone else does not slip past the hold.
    const samRecords = () => [...t.simulator.employees.values()].filter((r) => r.externalRef === sam.id).length;
    await t.call('POST', '/v1/integrations/payroll/sync-employees');
    await t.dispatch();
    expect(samRecords()).toBe(0);

    expect((await t.call('POST', `/v1/employees/${sam.id}/payroll-new-starter`)).status).toBe(200);
    await t.dispatch();
    expect(samRecords()).toBe(1);
    expect((await t.employee(sam.id)).payrollId).toBeDefined();
  });
});

describe('linking by hand', () => {
  it('suggests likely records, needs a decision on differences, and withdraws the queued starter', async () => {
    const t = await setup();
    const tp = t.simulator.addExisting(t.employer, { name: 'Samuel Cook', dateOfBirth: '1990-01-01', hourlyRate: 15, contractedHours: 40 });
    const sam = (await t.call('POST', '/v1/employees', SAM)).body;
    const view = (await t.call('GET', '/v1/integrations/payroll/link?entityId=wdl')).body;
    const row = view.people.find((p: { employeeId: string }) => p.employeeId === sam.id);
    expect(row.suggestions[0]).toMatchObject({ payrollId: tp, level: 'likely', differences: [{ field: 'name' }] });

    expect((await t.call('POST', `/v1/employees/${sam.id}/payroll-link`, { payrollId: tp })).status).toBe(422);
    const linked = await t.call('POST', `/v1/employees/${sam.id}/payroll-link`, { payrollId: tp, keep: 'payroll' });
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ employee: { name: 'Samuel Cook', payrollId: tp }, withdrawn: 1 });
    const before = t.simulator.employees.size;
    await t.dispatch();
    expect(t.simulator.employees.size).toBe(before);
  });

  it('refuses a record already linked to someone else, or one that has left', async () => {
    const t = await setup();
    const tp = t.simulator.addExisting(t.employer, { name: 'Sam Cook', dateOfBirth: '1990-01-01', hourlyRate: 15, contractedHours: 40 });
    const left = t.simulator.addExisting(t.employer, { name: 'Sam Cook', dateOfBirth: '1990-01-01', leaveDate: '2025-03-31' });
    const a = (await t.call('POST', '/v1/employees', SAM)).body;
    const b = (await t.call('POST', '/v1/employees', SAM)).body;
    expect((await t.call('POST', `/v1/employees/${a.id}/payroll-link`, { payrollId: tp })).status).toBe(200);
    expect((await t.call('POST', `/v1/employees/${b.id}/payroll-link`, { payrollId: tp })).body.error).toBe('linked_elsewhere');
    expect((await t.call('POST', `/v1/employees/${b.id}/payroll-link`, { payrollId: left })).body.error).toBe('payroll_leaver');
  });

  it('needs the right to change pay to settle a pay difference, and can send Preshift\'s pay to TeamPay', async () => {
    const t = await setup();
    const tp = t.simulator.addExisting(t.employer, { name: 'Sam Cook', dateOfBirth: '1990-01-01', hourlyRate: 14.25, contractedHours: 40 });
    const sam = (await t.call('POST', '/v1/employees', SAM)).body;
    const refused = await t.call('POST', `/v1/employees/${sam.id}/payroll-link`, { payrollId: tp, keep: 'preshift' }, 'payroll');
    expect(refused.status).toBe(403);
    expect((await t.call('POST', `/v1/employees/${sam.id}/payroll-link`, { payrollId: tp, keep: 'preshift' })).status).toBe(200);
    await t.dispatch();
    expect(t.simulator.employees.get(tp)!.hourlyRate).toBe(15);
  });

  it('can undo a link until hours have gone to payroll under it', async () => {
    const t = await setup();
    const tp = t.simulator.addExisting(t.employer, { name: 'Sam Cook', dateOfBirth: '1990-01-01', hourlyRate: 15, contractedHours: 40 });
    const sam = (await t.call('POST', '/v1/employees', SAM)).body;
    await t.call('POST', `/v1/employees/${sam.id}/payroll-link`, { payrollId: tp });
    expect((await t.call('DELETE', `/v1/employees/${sam.id}/payroll-link`)).status).toBe(200);
    await t.call('POST', `/v1/employees/${sam.id}/payroll-link`, { payrollId: tp });
    const org = await t.store.load('demo');
    org.outbox.push({
      id: 'sent', type: 'hours.submit', status: 'delivered', attempts: 1, nextAttemptAt: 0, createdAt: 0, idempotencyKey: 'k',
      payload: { submissionId: 's', batch: { periodStart: '2026-10-19', periodEnd: '2026-10-25', lines: [{ employeeId: sam.id, siteId: 'mar', roleId: 'chef', hours: 8, rate: 15, entryIds: [] }], salariedEntryIds: [], totalHours: 8 } },
    } as never);
    await t.store.save();
    expect((await t.call('DELETE', `/v1/employees/${sam.id}/payroll-link`)).body.error).toBe('payroll_history');
  });
});
