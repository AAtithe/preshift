import { describe, expect, it } from 'vitest';
import { SCHEDULE_PRESETS } from '../src/engine/payPeriods';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

const KEYS = [{ key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*' as const] }];
const WEEKLY = '/v1/pay-periods/wdl/weekly/2026-10-19';

async function setup(at: string) {
  let now = new Date(at);
  const simulator = new TeamPaySimulator();
  const store = new MemoryStore(['demo'], '2026-10-21');
  const { app, ctx } = await buildApp({ apiKeys: KEYS, store, provider: simulator, autoDispatch: false, now: () => now });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: 'Bearer admin', ...(body ? { 'content-type': 'application/json' } : {}) },
      payload: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  const setNow = (iso: string) => { now = new Date(iso); };
  return { call, ctx, simulator, setNow };
}

type Call = Awaited<ReturnType<typeof setup>>['call'];

async function worked(call: Call, employeeId: string, date: string, shift = true) {
  if (shift) {
    const s = await call('POST', '/v1/shifts', { employeeId, siteId: 'mar', roleId: 'server', date, startMinute: 600, endMinute: 960, breakMinutes: 20 });
    expect(s.status).toBe(201);
  }
  const t = await call('POST', '/v1/time-entries', { employeeId, siteId: 'mar', roleId: 'server', date, clockIn: 600, clockOut: 975, breakMinutes: 20 });
  expect(t.status).toBe(201);
  return t.body.id as string;
}

describe('pay periods: lock the rota, approve time cards, pass to payroll', () => {
  it('runs a weekly period end to end, with the rota frozen and a correction passed again', async () => {
    const { call, ctx, simulator, setNow } = await setup('2026-10-21T09:00:00Z');
    const periods = (await call('GET', '/v1/pay-periods')).body as { id: string; status: string; payDate: string; cutoffAt: string }[];
    expect(periods.find((p) => p.id === 'wdl~weekly~2026-10-19')).toMatchObject({ status: 'open', payDate: '2026-10-30', cutoffAt: '2026-10-27T12:00:00.000Z' });

    await worked(call, 'mar-8', '2026-10-20');
    expect((await call('POST', `${WEEKLY}/approve`, {})).body.error).toBe('rota_not_locked');

    const locked = await call('POST', `${WEEKLY}/lock-rota`);
    expect(locked.status).toBe(200);
    expect(locked.body.status).toBe('rota_locked');
    // The rota is frozen for everyone this payroll pays: nothing added, moved or removed.
    expect((await call('POST', '/v1/shifts', { employeeId: 'mar-8', siteId: 'mar', roleId: 'server', date: '2026-10-22', startMinute: 600, endMinute: 900 })).body.error).toBe('rota_locked');
    const shift = ((await call('GET', '/v1/shifts?siteId=mar&from=2026-10-20&to=2026-10-20')).body as { id: string; employeeId: string }[]).find((s) => s.employeeId === 'mar-8')!;
    expect((await call('PATCH', `/v1/shifts/${shift.id}`, { endMinute: 1000 })).body.error).toBe('rota_locked');
    expect((await call('DELETE', `/v1/shifts/${shift.id}`)).body.error).toBe('rota_locked');
    expect((await call('POST', '/v1/rota/clear', { siteId: 'mar', weekStart: '2026-10-19' })).status).toBe(200);
    expect(((await call('GET', '/v1/shifts?siteId=mar&from=2026-10-20&to=2026-10-20')).body as { id: string }[]).some((s) => s.id === shift.id)).toBe(true);

    const approved = await call('POST', `${WEEKLY}/approve`, {});
    expect(approved.body).toMatchObject({ approved: 1, stillOpen: 0 });
    const card = (await call('GET', WEEKLY)).body;
    expect(card.status).toBe('ready');
    expect(card.timeCards[0]).toMatchObject({ employeeId: 'mar-8', rosteredHours: 5.67, clockedHours: 5.92, status: 'approved' });

    expect((await call('POST', `${WEEKLY}/pass`, {})).body.error).toBe('period_not_ended');
    setNow('2026-10-26T09:00:00Z');
    const passed = await call('POST', `${WEEKLY}/pass`, {});
    expect(passed.status).toBe(202);
    expect(passed.body.pass).toMatchObject({ version: 1, late: false, hours: 5.92, entries: 1 });
    expect(passed.body.submission).toMatchObject({ scheduleId: 'weekly', payDate: '2026-10-30', periodEnd: '2026-10-25' });
    expect(passed.body.period.status).toBe('passed');
    await ctx.dispatcher.processDue();
    expect(simulator.submissions.at(-1)!.batch).toMatchObject({ periodStart: '2026-10-19', payDate: '2026-10-30' });

    // Once paid, the rota is the record payroll was reconciled to.
    expect((await call('POST', `${WEEKLY}/unlock-rota`, { reason: 'Change the rota' })).body.error).toBe('period_passed');
    expect((await call('POST', '/v1/payroll/submissions', { weekStart: '2026-10-19', entityId: 'wdl' })).body.error).toBe('passed_by_period');

    // A missed shift found later goes in as a correction, approved, and passed again with a reason.
    await worked(call, 'mar-8', '2026-10-24', false);
    expect((await call('GET', WEEKLY)).body.status).toBe('changed');
    await call('POST', `${WEEKLY}/approve`, {});
    setNow('2026-10-28T09:00:00Z');
    expect((await call('POST', `${WEEKLY}/pass`, {})).body.error).toBe('reason_required');
    const again = await call('POST', `${WEEKLY}/pass`, { reason: 'Saturday close missed off the first pass' });
    expect(again.body.pass).toMatchObject({ version: 2, late: true, entries: 2 });
    const subs = ((await call('GET', '/v1/payroll/submissions')).body as { scheduleId?: string; version: number; status: string }[]).filter((s) => s.scheduleId === 'weekly');
    expect(subs.map((s) => [s.version, s.status])).toEqual([[2, 'queued'], [1, 'superseded']]);
    expect((await call('GET', WEEKLY)).body.history.map((h: { action: string }) => h.action)).toEqual(['rota_locked', 'timecards_approved', 'passed', 'timecards_approved', 'passed']);
  });

  it('lets an unlocked rota change again, with the reason kept', async () => {
    const { call } = await setup('2026-10-21T09:00:00Z');
    await call('POST', `${WEEKLY}/lock-rota`);
    expect((await call('POST', `${WEEKLY}/lock-rota`)).body.error).toBe('already_locked');
    expect((await call('POST', `${WEEKLY}/unlock-rota`, {})).status).toBe(400);
    expect((await call('POST', `${WEEKLY}/unlock-rota`, { reason: 'Sickness cover for Thursday' })).body.status).toBe('open');
    expect((await call('POST', '/v1/shifts', { employeeId: 'mar-8', siteId: 'mar', roleId: 'server', date: '2026-10-22', startMinute: 600, endMinute: 900 })).status).toBe(201);
    expect((await call('GET', WEEKLY)).body.history[1]).toMatchObject({ action: 'rota_unlocked', detail: { reason: 'Sickness cover for Thursday' } });
    expect((await call('GET', '/v1/pay-periods/wdl/weekly/2026-10-20')).body.error).toBe('not_a_period');
  });

  it('runs a monthly payroll beside the weekly one, and never pays the same hours twice', async () => {
    const { call, ctx, simulator, setNow } = await setup('2026-10-15T09:00:00Z');
    const weekly = { id: 'weekly', name: 'Weekly hourly', ...SCHEDULE_PRESETS.weekly };
    const monthly = { id: 'monthly', name: 'Monthly', ...SCHEDULE_PRESETS.monthly };
    const bad = await call('PUT', '/v1/entities/wdl/pay-schedules', { schedules: [weekly, { ...monthly, periodEndDay: 31, payDay: 31 }] });
    expect(bad.status).toBe(422);
    expect(bad.body.message).toMatch(/End the hours period earlier/);
    expect((await call('PUT', '/v1/entities/wdl/pay-schedules', { schedules: [weekly, monthly] })).status).toBe(200);
    expect((await call('PUT', '/v1/employees/mar-8/pay-schedule', { scheduleId: 'monthly' })).status).toBe(200);

    const listed = (await call('GET', '/v1/pay-schedules')).body as { entityId: string; schedules: { id: string; people: number; upcoming: { payDate: string }[] }[] }[];
    const wdl = listed.find((e) => e.entityId === 'wdl')!;
    expect(wdl.schedules.find((s) => s.id === 'monthly')).toMatchObject({ people: 1 });
    expect(wdl.schedules.find((s) => s.id === 'monthly')!.upcoming[0].payDate).toBe('2026-10-30');
    expect((await call('PUT', '/v1/entities/wdl/pay-schedules', { schedules: [weekly] })).body.error).toBe('schedule_in_use');
    // A company with its own calendars passes by pay period, so the old weekly send cannot pay monthly people weekly.
    expect((await call('POST', '/v1/payroll/submissions', { weekStart: '2026-10-12' })).body.error).toBe('pay_schedules_set');

    await worked(call, 'mar-8', '2026-10-13');
    await worked(call, 'mar-9', '2026-10-13');
    const MONTH = '/v1/pay-periods/wdl/monthly/2026-09-21';
    const period = (await call('GET', MONTH)).body;
    expect(period).toMatchObject({ periodEnd: '2026-10-20', payDate: '2026-10-30', people: 1 });
    expect(period.timeCards.map((c: { employeeId: string }) => c.employeeId)).toEqual(['mar-8']);

    await call('POST', `${MONTH}/lock-rota`);
    await call('POST', `${MONTH}/approve`, {});
    setNow('2026-10-21T09:00:00Z');
    const passed = await call('POST', `${MONTH}/pass`, {});
    expect(passed.status).toBe(202);
    await ctx.dispatcher.processDue();
    const batch = simulator.submissions.at(-1)!.batch;
    expect(batch).toMatchObject({ periodStart: '2026-09-21', periodEnd: '2026-10-20', payDate: '2026-10-30' });
    expect(batch.lines.map((l) => l.employeeId)).toEqual(['mar-8']);

    // The weekly payroll's week holding the same day pays only its own people.
    const WEEK = '/v1/pay-periods/wdl/weekly/2026-10-12';
    await call('POST', `${WEEK}/lock-rota`);
    await call('POST', `${WEEK}/approve`, {});
    await call('POST', `${WEEK}/pass`, {});
    await ctx.dispatcher.processDue();
    expect(simulator.submissions.at(-1)!.batch.lines.map((l) => l.employeeId)).toEqual(['mar-9']);

    // Moving someone back after their hours were passed leaves those hours with the payroll that paid them.
    await call('PUT', '/v1/employees/mar-8/pay-schedule', { scheduleId: 'weekly' });
    const week = (await call('GET', WEEK)).body;
    expect(week.timeCards.find((c: { employeeId: string }) => c.employeeId === 'mar-8')).toMatchObject({ clockedHours: 0, entries: 0 });
    expect(week.status).toBe('passed');
  });

  it('previews a last working Friday payroll before it is saved', async () => {
    const { call } = await setup('2026-10-21T09:00:00Z');
    const res = await call('POST', '/v1/pay-schedules/preview', { schedule: { id: 'lwf', name: 'Last Friday', ...SCHEDULE_PRESETS.last_friday } });
    expect(res.body.problems).toEqual([]);
    expect(res.body.upcoming.map((p: { payDate: string }) => p.payDate).slice(0, 3)).toEqual(['2026-10-30', '2026-11-27', '2026-12-24']);
  });
});
