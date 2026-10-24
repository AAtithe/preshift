import { describe, expect, it } from 'vitest';
import { addDays } from '../src/engine/time';
import type { Shift, TimeEntry } from '../src/engine/types';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

const WEEK = '2026-10-19';
const FUTURE_WEEK = '2027-03-01'; // a Monday, after the real clock, so no shift here has started
const NOW = '2027-03-02T10:00:00Z'; // Tuesday 10:00 in London (GMT): 26 hours before Wednesday's shift

const person = (key: string, userId: string) => ({ key, orgId: 'demo', name: `${key} key`, scopes: ['*' as const], userId, mfa: true });
const KEYS = [
  { key: 'system', orgId: 'demo', name: 'System', scopes: ['*' as const] },
  person('owner', 'usr_owner'),
  person('priya', 'usr_gm_mar'),
  person('nadia', 'usr_fd'),
];

async function setup(now = NOW) {
  const simulator = new TeamPaySimulator();
  const store = new MemoryStore(['demo'], '2026-10-21');
  let clock = new Date(now);
  const { app, ctx } = await buildApp({ apiKeys: KEYS, store, provider: simulator, autoDispatch: false, now: () => clock });
  const call = async (method: string, url: string, body?: unknown, key = 'system') => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      payload: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  const org = () => store.load('demo');
  return { call, ctx, simulator, store, org, setClock: (iso: string) => (clock = new Date(iso)) };
}


/**
 * Two published shifts for a zero hours worker at Marylebone: Tuesday 10:00 to 16:00, worked and
 * clocked, and Wednesday 12:00 to 18:00, the one changed at short notice.
 */
async function publishedWeek(t: Awaited<ReturnType<typeof setup>>) {
  const o = await t.org();
  const worker = o.state.employees.find((e) => e.siteId === 'mar' && e.payBasis === 'hourly' && e.contractedHours === 0 && e.status !== 'leaver')!;
  const base = { employeeId: worker.id, roleId: worker.roleIds[0], siteId: 'mar', breakMinutes: 0, published: true };
  const tuesday: Shift = { ...base, id: 'sn-tue', date: '2027-03-02', startMinute: 600, endMinute: 960 };
  const target: Shift = { ...base, id: 'sn-wed', date: '2027-03-03', startMinute: 720, endMinute: 1080 };
  o.state.shifts.push(tuesday, target);
  return target;
}

const rights = async (t: Awaited<ReturnType<typeof setup>>, key = 'system') => (await t.call('GET', '/v1/employment-rights?siteId=mar', undefined, key)).body;

describe('short notice changes', () => {
  it('logs a published shift cancelled inside the notice window, owed once the measure starts', async () => {
    const t = await setup();
    const target = await publishedWeek(t);
    expect((await t.call('DELETE', `/v1/shifts/${target.id}`)).status).toBe(204);
    let r = await rights(t);
    expect(r.shortNotice).toEqual([expect.objectContaining({ shiftId: target.id, change: 'cancelled', owed: false, status: 'open' })]);
    expect(r.totals.wouldHaveCost).toBeGreaterThan(0);
    expect(r.totals.owed).toBe(0);

    expect((await t.call('PUT', '/v1/employment-rights/settings', { shortNoticeFrom: '2026-10-01' }, 'priya')).status).toBe(403);
    expect((await t.call('PUT', '/v1/employment-rights/settings', { shortNoticeFrom: '2026-10-01' }, 'owner')).status).toBe(200);
    r = await rights(t);
    expect(r.shortNotice[0].owed).toBe(true);
    expect(r.totals.owed).toBe(r.shortNotice[0].amount);
  });

  it('measures against what the worker was first told, and clears when the time is given back', async () => {
    const t = await setup();
    const target = await publishedWeek(t);
    await t.call('PATCH', `/v1/shifts/${target.id}`, { endMinute: target.startMinute + 180 });
    let r = await rights(t);
    expect(r.shortNotice).toEqual([expect.objectContaining({ change: 'cut', original: expect.objectContaining({ endMinute: target.endMinute }) })]);
    // The edit unpublished the shift, but it is still measured against the original.
    await t.call('PATCH', `/v1/shifts/${target.id}`, { endMinute: target.endMinute });
    r = await rights(t);
    expect(r.shortNotice).toEqual([]);
  });

  it('logs nothing with enough notice, or for a leaver', async () => {
    const t = await setup('2027-02-25T10:00:00Z');
    const target = await publishedWeek(t);
    await t.call('DELETE', `/v1/shifts/${target.id}`);
    expect((await rights(t)).shortNotice).toEqual([]);

    const t2 = await setup();
    const other = await publishedWeek(t2);
    await t2.call('POST', `/v1/employees/${other.employeeId}/leaver`, { leaveDate: '2027-03-01' });
    expect((await rights(t2)).shortNotice).toEqual([]);
  });

  it('pays what is owed through TeamPay with the week, and reconciles', async () => {
    const t = await setup();
    await t.call('PUT', '/v1/employment-rights/settings', { shortNoticeFrom: '2026-10-01' }, 'owner');
    const target = await publishedWeek(t);
    await t.call('DELETE', `/v1/shifts/${target.id}`);
    const owed = (await rights(t)).shortNotice[0];
    await t.call('POST', '/v1/integrations/payroll/sync-employees', {});
    (await t.org()).timeEntries.push({
      id: 'te-tue', employeeId: target.employeeId, siteId: 'mar', roleId: target.roleId, shiftId: 'sn-tue', date: '2027-03-02',
      clockIn: 600, clockOut: 960, breakMinutes: 0, status: 'approved', source: 'clock',
    });
    const sub = await t.call('POST', '/v1/payroll/submissions', { weekStart: FUTURE_WEEK, entityId: 'wdl' });
    expect(sub.status).toBe(202);
    await t.ctx.dispatcher.processDue();
    const batch = t.simulator.submissions.find((s) => s.employerId === 'sim_er_wdl')!.batch;
    expect(batch.adjustments).toEqual(expect.arrayContaining([expect.objectContaining({ employeeId: target.employeeId, amount: owed.amount, reference: owed.id })]));
    const r = await rights(t);
    expect(r.shortNotice[0].sentIn).toBeDefined();
    expect(r.totals.paid).toBe(owed.amount);
    // Paid once: it cannot be waived now.
    expect((await t.call('POST', `/v1/employment-rights/short-notice/${owed.id}/waive`, { reason: 'Asked for it' }, 'nadia')).status).toBe(409);
    const run = await t.call('POST', '/v1/dev/teampay/run-payroll', { weekStart: FUTURE_WEEK });
    const payRun = run.body.payRuns.find((p: { entityId: string }) => p.entityId === 'wdl');
    expect(Math.abs(payRun.variance.variancePct)).toBeLessThan(0.01);
  });

  it('lets only someone who approves pay waive what is owed, with a reason', async () => {
    const t = await setup();
    const target = await publishedWeek(t);
    await t.call('DELETE', `/v1/shifts/${target.id}`);
    const id = (await rights(t)).shortNotice[0].id;
    expect((await t.call('POST', `/v1/employment-rights/short-notice/${id}/waive`, { reason: 'Worker asked' }, 'priya')).status).toBe(403);
    const ok = await t.call('POST', `/v1/employment-rights/short-notice/${id}/waive`, { reason: 'Worker asked to swap' }, 'nadia');
    expect(ok.body).toMatchObject({ status: 'waived', waiveReason: 'Worker asked to swap' });
  });
});

describe('guaranteed hours offers', () => {
  const entry = (employeeId: string, date: string): TimeEntry => ({
    id: `te-${employeeId}-${date}`, employeeId, siteId: 'mar', roleId: 'server', date, clockIn: 600, clockOut: 1200, breakMinutes: 0, status: 'approved', source: 'clock',
  });

  it('offers, drafts the letter, and raises contracted hours when accepted', async () => {
    const t = await setup();
    const o = await t.org();
    const worker = o.state.employees.find((e) => e.siteId === 'mar' && e.payBasis === 'hourly' && e.contractedHours === 0)!;
    // Twenty hours a week for twelve weeks.
    for (let w = 1; w <= 12; w++) {
      const monday = addDays(FUTURE_WEEK, -7 * w);
      o.timeEntries.push(entry(worker.id, monday), entry(worker.id, addDays(monday, 2)));
    }
    const r = await rights(t, 'priya');
    const candidate = r.candidates.find((c: { employeeId: string }) => c.employeeId === worker.id);
    expect(candidate).toMatchObject({ averageHours: 20, suggestedHours: 20, due: false });

    const made = await t.call('POST', '/v1/employment-rights/offers', { employeeId: worker.id, offeredHours: 20 }, 'priya');
    expect(made.status).toBe(201);
    expect(made.body.letter).toContain('guaranteeing 20 hours a week');
    expect(made.body.offer.respondBy).toBe('2027-03-30');
    // Offered: not a candidate again until the reference period comes round.
    expect((await rights(t, 'priya')).candidates.some((c: { employeeId: string }) => c.employeeId === worker.id)).toBe(false);

    const answered = await t.call('POST', `/v1/employment-rights/offers/${made.body.offer.id}/response`, { response: 'accepted' }, 'priya');
    expect(answered.body.employee.contractedHours).toBe(20);
    expect((await t.org()).outbox.some((i) => i.type === 'employee.upsert' && (i.payload as { employeeId: string }).employeeId === worker.id)).toBe(true);
    expect((await t.call('POST', `/v1/employment-rights/offers/${made.body.offer.id}/response`, { response: 'declined' }, 'priya')).status).toBe(409);
  });
});

describe('the 48 hour average on the rota week', () => {
  it('warns on the rota week when the rolling average would go over 48', async () => {
    const t = await setup();
    const o = await t.org();
    const worker = o.state.employees.find((e) => e.siteId === 'mar' && e.payBasis === 'hourly' && !e.optedOutOf48 && e.dateOfBirth < '2000-01-01')!;
    for (let w = 1; w <= 16; w++) {
      for (let d = 0; d < 5; d++) {
        const date = addDays(addDays(WEEK, -7 * w), d);
        o.timeEntries.push({ id: `te-${date}`, employeeId: worker.id, siteId: 'mar', roleId: worker.roleIds[0], date, clockIn: 480, clockOut: 1080, breakMinutes: 0, status: 'approved', source: 'clock' });
      }
    }
    o.state.shifts = o.state.shifts.filter((s) => s.employeeId !== worker.id);
    for (let d = 0; d < 5; d++) {
      o.state.shifts.push({ id: `w${d}`, employeeId: worker.id, roleId: worker.roleIds[0], siteId: 'mar', date: addDays(WEEK, d), startMinute: 480, endMinute: 1080, breakMinutes: 0 } as Shift);
    }
    const week = (await t.call('GET', `/v1/rota/week?siteId=mar&weekStart=${WEEK}`)).body;
    const issue = week.issues.find((i: { code: string; employeeId: string }) => i.code === 'wtr-average' && i.employeeId === worker.id);
    expect(issue).toMatchObject({ severity: 'warn' });
  });
});
