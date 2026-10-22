import { describe, expect, it } from 'vitest';
import { employeeWeekCost } from '../src/engine/cost';
import { seedState } from '../src/engine/seed';
import { payrollHours, type PayrollHoursBatch } from '../src/engine/timesheet';
import type { Shift, TimeEntry } from '../src/engine/types';
import { buildApp } from './app';
import { PayrollError, type PayRun, type PayrollEmployee, type PayrollProvider } from './integrations/payroll/provider';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { signHmac, verifyHmac } from './integrations/payroll/teampay';
import { employerStatus } from './payrollEmployers';
import { MemoryStore, upgradeState } from './store';

const WEEK = '2026-10-19';
const KEYS = [{ key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*' as const] }];

/** A payroll that records which employer every call was for, standing in for real TeamPay. */
class RecordingPayroll implements PayrollProvider {
  readonly name = 'TeamPay';
  readonly calls: { method: string; employerId: string; detail?: unknown }[] = [];
  readonly runs = new Map<string, PayRun>();
  private seq = 0;

  async upsertEmployee(employerId: string, e: PayrollEmployee, payrollId: string | undefined) {
    this.calls.push({ method: 'upsertEmployee', employerId, detail: e.externalRef });
    return { payrollId: payrollId ?? `p_${employerId}_${this.seq++}` };
  }
  async markLeaver(employerId: string, payrollId: string) {
    this.calls.push({ method: 'markLeaver', employerId, detail: payrollId });
  }
  async submitHours(employerId: string, batch: PayrollHoursBatch) {
    this.calls.push({ method: 'submitHours', employerId, detail: batch });
    return { submissionId: `s_${this.seq++}` };
  }
  async getPayRun(employerId: string, id: string) {
    const run = this.runs.get(id);
    if (!run || run.employerId !== employerId) throw new PayrollError('not found', false, 404);
    return run;
  }
  verifyWebhook(raw: string, sig: string | undefined) {
    return verifyHmac('secret', raw, sig);
  }
}

async function setup(provider: PayrollProvider, env: Record<string, string> = {}) {
  const store = new MemoryStore(['demo'], '2026-10-21');
  const { app, ctx } = await buildApp({ apiKeys: KEYS, store, provider, autoDispatch: false, env });
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: 'Bearer admin', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      payload: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    return { status: res.statusCode, body: res.body ? (res.headers['content-type']?.includes('json') ? res.json() : res.body) : undefined };
  };
  return { app, ctx, store, call };
}

/** Approved hours for one person on one day, entered by a manager. */
async function approvedShift(call: Awaited<ReturnType<typeof setup>>['call'], employeeId: string, siteId: string, roleId: string) {
  const made = await call('POST', '/v1/time-entries', { employeeId, siteId, roleId, date: WEEK, clockIn: 600, clockOut: 960, breakMinutes: 20 });
  expect(made.status).toBe(201);
  expect((await call('POST', '/v1/time-entries/approve', { ids: [made.body.id] })).body.approved).toBe(1);
}

describe('payroll per PAYE scheme', () => {
  it('runs a group payroll as one batch and one pay run per company, each through its own employer', async () => {
    const simulator = new TeamPaySimulator();
    const { call, ctx } = await setup(simulator);
    await call('POST', '/v1/rota/build', { siteIds: ['mar', 'fitz', 'shd'], weekStart: WEEK });
    await call('POST', '/v1/integrations/payroll/sync-employees', {});
    for (const siteId of ['mar', 'fitz', 'shd']) {
      await call('POST', '/v1/dev/simulate-clocking', { siteId, weekStart: WEEK });
      await call('POST', '/v1/time-entries/approve', { siteId, from: WEEK, to: '2026-10-25' });
    }

    const sub = await call('POST', '/v1/payroll/submissions', { weekStart: WEEK });
    expect(sub.status).toBe(202);
    expect(sub.body.submissions.map((s: { entityId: string }) => s.entityId)).toEqual(['wdl', 'eck']);
    await ctx.dispatcher.processDue();

    const employees = (await call('GET', '/v1/employees')).body as { id: string; entityId: string; payrollEmployerId?: string }[];
    const companyOf = new Map(employees.map((e) => [e.id, e.entityId]));
    expect(simulator.submissions.map((s) => s.employerId)).toEqual(['sim_er_wdl', 'sim_er_eck']);
    for (const s of simulator.submissions) {
      const company = s.employerId.replace('sim_er_', '');
      // Hours worked at another company's site are still paid by the employer.
      expect(s.batch.lines.every((l) => companyOf.get(l.employeeId) === company)).toBe(true);
    }
    expect(employees.every((e) => e.payrollEmployerId === `sim_er_${e.entityId}`)).toBe(true);

    const run = await call('POST', '/v1/dev/teampay/run-payroll', { weekStart: WEEK });
    expect(run.status).toBe(200);
    expect(run.body.payRuns.map((r: { entityId: string }) => r.entityId)).toEqual(['wdl', 'eck']);
    for (const payRun of run.body.payRuns) {
      expect(payRun.variance.lines.every((l: { employeeId: string }) => companyOf.get(l.employeeId) === payRun.entityId)).toBe(true);
      expect(Math.abs(payRun.variance.variancePct)).toBeLessThan(0.01);
    }

    // Resending one company supersedes only that company's batch.
    const again = await call('POST', '/v1/payroll/submissions', { weekStart: WEEK, entityId: 'eck' });
    expect(again.body.submissions).toHaveLength(1);
    const subs = (await call('GET', '/v1/payroll/submissions')).body as { entityId: string; status: string; version: number }[];
    expect(subs.filter((s) => s.entityId === 'wdl').map((s) => s.status)).toEqual(['sent']);
    expect(subs.filter((s) => s.entityId === 'eck').map((s) => [s.version, s.status])).toEqual([[2, 'queued'], [1, 'superseded']]);
  });

  it('refuses a group payroll outright until every company has its own employer', async () => {
    const payroll = new RecordingPayroll();
    const { call, ctx } = await setup(payroll, { TEAMPAY_EMPLOYER_ID: 'er_default' });
    await approvedShift(call, 'mar-8', 'mar', 'server');
    await approvedShift(call, 'shd-6', 'shd', 'server');

    // The organisation-wide employer is never used for a group: it would put two companies on one scheme.
    const health = (await call('GET', '/v1/integrations/payroll')).body;
    expect(health.employers.map((e: { employerId: string | null }) => e.employerId)).toEqual([null, null]);
    const refused = await call('POST', '/v1/payroll/submissions', { weekStart: WEEK });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('payroll_employer_missing');
    expect((await call('GET', '/v1/payroll/submissions')).body).toEqual([]);

    // Starters cannot slip through to a default scheme either: delivery stops with the reason.
    await call('POST', '/v1/integrations/payroll/sync-employees', {});
    await ctx.dispatcher.processDue();
    expect(payroll.calls).toEqual([]);
    const failed = (await call('GET', '/v1/integrations/payroll/outbox')).body.filter((i: { status: string }) => i.status === 'failed');
    expect(failed[0].lastError).toContain('has no TeamPay employer');

    expect((await call('PATCH', '/v1/entities/wdl', { payrollEmployerId: 'er_west' })).status).toBe(200);
    expect((await call('PATCH', '/v1/entities/eck', { payrollEmployerId: 'er_west' })).body.error).toBe('employer_in_use');
    expect((await call('PATCH', '/v1/entities/eck', { payrollEmployerId: 'er_east' })).status).toBe(200);
    for (const item of failed) await call('POST', `/v1/integrations/payroll/outbox/${item.id}/retry`, {});

    expect((await call('POST', '/v1/payroll/submissions', { weekStart: WEEK })).status).toBe(202);
    await ctx.dispatcher.processDue();
    const hours = payroll.calls.filter((c) => c.method === 'submitHours');
    expect(hours.map((c) => c.employerId)).toEqual(['er_west', 'er_east']);
    const starters = payroll.calls.filter((c) => c.method === 'upsertEmployee');
    expect(starters.filter((c) => String(c.detail).startsWith('shd-')).every((c) => c.employerId === 'er_east')).toBe(true);
    expect(starters.filter((c) => String(c.detail).startsWith('mar-')).every((c) => c.employerId === 'er_west')).toBe(true);
  });

  it('routes each pay run to its company by employer, and waits on an employer it does not know', async () => {
    const payroll = new RecordingPayroll();
    const { call, ctx } = await setup(payroll);
    await call('PATCH', '/v1/entities/wdl', { payrollEmployerId: 'er_west' });
    await call('PATCH', '/v1/entities/eck', { payrollEmployerId: 'er_east' });
    await approvedShift(call, 'mar-8', 'mar', 'server');
    await approvedShift(call, 'shd-6', 'shd', 'server');
    await call('POST', '/v1/payroll/submissions', { weekStart: WEEK });
    await ctx.dispatcher.processDue();

    const people = (await call('GET', '/v1/employees')).body as { id: string; payrollId: string }[];
    const shd6 = people.find((e) => e.id === 'shd-6')!;
    payroll.runs.set('run_east', {
      id: 'run_east', employerId: 'er_east', periodStart: WEEK, periodEnd: '2026-10-25', status: 'completed',
      employees: [{ payrollId: shd6.payrollId, employeeId: 'shd-6', gross: 100, holidayPay: 12, employerNi: 2, employerPension: 0 }],
    });
    const hook = (employer: string, id: string) => {
      const body = JSON.stringify({ id, type: 'payroll.run.completed', data: { pay_run_id: 'run_east', employer_id: employer } });
      return call('POST', '/v1/integrations/teampay/webhook/demo', body, { 'x-teampay-signature': signHmac('secret', body) });
    };

    const unknown = await hook('er_nobody', 'evt_1');
    expect(unknown.status).toBe(422);
    expect((await call('GET', '/v1/payroll/runs')).body).toEqual([]);

    expect((await hook('er_east', 'evt_2')).status).toBe(200);
    const [run] = (await call('GET', '/v1/payroll/runs')).body;
    expect(run).toMatchObject({ entityId: 'eck', employerId: 'er_east' });
    // Compared against East Canteen's accrual only (everyone it pays that week), never West End's people.
    const ids = run.variance.lines.map((l: { employeeId: string }) => l.employeeId) as string[];
    expect(ids).toContain('shd-6');
    expect(ids.every((id) => id.startsWith('shd-'))).toBe(true);
  });

  it('sends sickness with the hours, and checks the SSP payroll paid against what was due', async () => {
    const payroll = new RecordingPayroll();
    const { call, ctx } = await setup(payroll);
    await call('PATCH', '/v1/entities/wdl', { payrollEmployerId: 'er_west' });
    // Nothing on the rota before: earnings come from 24 contracted hours, the pattern is taken as Monday to Friday.
    await call('PATCH', '/v1/employees/mar-8', { contractedHours: 24 });
    // Off sick Monday and Tuesday of the week paid.
    expect((await call('POST', '/v1/employees/mar-8/absences', { type: 'sickness', from: WEEK, to: '2026-10-20' })).status).toBe(201);
    await approvedShift(call, 'mar-7', 'mar', 'server');
    await call('POST', '/v1/integrations/payroll/sync-employees', {});
    await ctx.dispatcher.processDue();
    await call('POST', '/v1/payroll/submissions', { weekStart: WEEK, entityId: 'wdl' });
    await ctx.dispatcher.processDue();

    const batch = payroll.calls.filter((c) => c.method === 'submitHours').at(-1)!.detail as PayrollHoursBatch;
    const sick = batch.sickness?.find((l) => l.employeeId === 'mar-8');
    expect(sick).toMatchObject({ dates: [WEEK, '2026-10-20'], qualifyingDaysPerWeek: 5, sspEstimate: 49.3 });
    const due = (await call('GET', `/v1/hr/sick-pay?from=${WEEK}&to=2026-10-25`)).body.find((x: { employeeId: string }) => x.employeeId === 'mar-8');
    expect(due.inPeriod).toBe(sick!.sspEstimate);

    // TeamPay paid a flat £50: the run is recorded with the difference, and the audit trail says so.
    const people = (await call('GET', '/v1/employees')).body as { id: string; payrollId: string }[];
    const payrollId = people.find((e) => e.id === 'mar-8')!.payrollId;
    payroll.runs.set('run_west', {
      id: 'run_west', employerId: 'er_west', periodStart: WEEK, periodEnd: '2026-10-25', status: 'completed',
      employees: [{ payrollId, employeeId: 'mar-8', gross: 50, holidayPay: 0, employerNi: 0, employerPension: 0, ssp: 50 }],
    });
    const body = JSON.stringify({ id: 'evt_ssp', type: 'payroll.run.completed', data: { pay_run_id: 'run_west', employer_id: 'er_west' } });
    expect((await call('POST', '/v1/integrations/teampay/webhook/demo', body, { 'x-teampay-signature': signHmac('secret', body) })).status).toBe(200);
    const [run] = (await call('GET', '/v1/payroll/runs')).body;
    // Others in the demo were off sick that week too; payroll reported nothing for them, so they show as unpaid.
    expect(run.ssp.find((l: { employeeId: string }) => l.employeeId === 'mar-8')).toEqual({ employeeId: 'mar-8', expected: sick!.sspEstimate, paid: 50, difference: Math.round((50 - sick!.sspEstimate) * 100) / 100 });
    const org = await ctx.store.load('demo');
    expect(org.audit.some((a) => a.action === 'payroll.ssp_mismatch')).toBe(true);
  });

  it('has the simulator pay SSP at the flat rate over the days a week the person works', () => {
    const state = seedState('2026-10-21');
    const person = { ...state.employees.find((e) => e.id === 'mar-8')!, payrollId: 'p1' };
    const batch: PayrollHoursBatch = {
      periodStart: WEEK, periodEnd: '2026-10-25', lines: [], salariedEntryIds: [], totalHours: 0,
      sickness: [{ employeeId: 'mar-8', payrollId: 'p1', dates: [WEEK, '2026-10-20'], qualifyingDaysPerWeek: 5, sspEstimate: 49.3 }],
    };
    const { run } = new TeamPaySimulator().runPayroll('er_1', WEEK, '2026-10-25', [person], batch);
    expect(run.employees[0].ssp).toBe(49.3);
  });

  it('keeps a person on the scheme that holds their record', async () => {
    const payroll = new RecordingPayroll();
    const { call, ctx } = await setup(payroll);
    await call('PATCH', '/v1/entities/wdl', { payrollEmployerId: 'er_west' });
    await call('PATCH', '/v1/entities/eck', { payrollEmployerId: 'er_east' });

    // Not yet in payroll: the employer can still be corrected.
    expect((await call('PATCH', '/v1/employees/mar-8', { entityId: 'eck' })).status).toBe(200);
    expect((await call('PATCH', '/v1/employees/mar-8', { entityId: 'wdl' })).status).toBe(200);

    await call('POST', '/v1/integrations/payroll/sync-employees', {});
    await ctx.dispatcher.processDue();
    const moved = await call('PATCH', '/v1/employees/mar-8', { entityId: 'eck' });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toBe('scheme_transfer');
    // Nor can the company be pointed at another scheme once its people are on this one.
    expect((await call('PATCH', '/v1/entities/wdl', { payrollEmployerId: 'er_other' })).body.error).toBe('employer_has_people');

    // A leaver is told to the scheme that holds them.
    await call('POST', '/v1/employees/mar-8/leaver', { leaveDate: '2026-11-01' });
    await ctx.dispatcher.processDue();
    expect(payroll.calls.filter((c) => c.method === 'markLeaver').map((c) => c.employerId)).toEqual(['er_west']);
  });

  it('keeps a single company on the organisation-wide employer, as before', () => {
    const legacy = upgradeState({
      sites: [{ id: 'a', name: 'A', labourTargetPct: 0.3, trackingCode: 'A', openMinute: 600, closeMinute: 1380 }],
      employees: [], roles: [], shifts: [], forecast: [], demandRules: [],
    } as unknown as Parameters<typeof upgradeState>[0]);
    const org = { state: legacy } as Parameters<typeof employerStatus>[0];
    const only = legacy.entities[0];
    expect(employerStatus(org, only, { defaultEmployerId: 'er_1', simulated: false }).employerId).toBe('er_1');
    expect(employerStatus(org, { ...only, payrollEmployerId: 'er_own' }, { defaultEmployerId: 'er_1', simulated: false }).employerId).toBe('er_own');
    expect(employerStatus(org, only, { simulated: false }).problem).toContain('no TeamPay employer');
  });
});

describe('payroll simulator', () => {
  it('pays each hours line at its own rate, so travel at a company rate is paid as the rota costed it', () => {
    const state = seedState(WEEK);
    const base = state.employees.find((e) => e.siteId === 'shd' && e.payBasis === 'hourly' && e.contractedHours === 0)!;
    const person = { ...base, hourlyRate: 16, dateOfBirth: '1990-01-01', payrollId: 'p_1' };
    const entities = state.entities.map((e) => (e.id === person.entityId ? { ...e, travelPay: { basis: 'fixed' as const, hourly: 13 } } : e));
    const entry = (id: string, siteId: string, start: number, end: number): TimeEntry =>
      ({ id, employeeId: person.id, siteId, roleId: 'server', date: WEEK, clockIn: start * 60, clockOut: end * 60, breakMinutes: 0, status: 'approved' }) as TimeEntry;
    const entries = [entry('a', 'shd', 12, 16), entry('b', 'mar', 17, 21)];
    const batch = payrollHours([person], entries, WEEK, '2026-10-25', state.sites, entities);
    expect(batch.lines.some((l) => l.travel && l.rate === 13)).toBe(true);

    const { run } = new TeamPaySimulator().runPayroll('er_1', WEEK, '2026-10-25', [person], batch);
    const shifts: Shift[] = entries.map((e) => ({ id: `te:${e.id}`, employeeId: e.employeeId, roleId: e.roleId, siteId: e.siteId, date: e.date, startMinute: e.clockIn, endMinute: e.clockOut!, breakMinutes: 0 }));
    const costed = employeeWeekCost(person, shifts, undefined, 1, state.sites, entities);
    const paid = run.employees[0];
    // Payroll hours are rounded to two decimals and the rota's are not, so allow a few pence.
    expect(Math.abs(paid.gross - costed.gross)).toBeLessThan(0.05);
    expect(paid.gross).toBeCloseTo(8 * 16 + 0.72 * 13, 2);
    expect(paid.holidayPay).toBeCloseTo(costed.holiday, 1);
  });

  it('still tops hourly pay up to guaranteed hours and pays salary as salary', () => {
    const state = seedState(WEEK);
    const hourly = { ...state.employees.find((e) => e.payBasis === 'hourly')!, hourlyRate: 15, contractedHours: 20, payrollId: 'p_2' };
    const salaried = { ...state.employees.find((e) => e.payBasis === 'salaried')!, annualSalary: 52_000, payrollId: 'p_3' };
    const batch: PayrollHoursBatch = {
      periodStart: WEEK, periodEnd: '2026-10-25', salariedEntryIds: [], totalHours: 10,
      lines: [{ employeeId: hourly.id, payrollId: 'p_2', siteId: hourly.siteId, roleId: 'server', hours: 10, rate: 15, entryIds: [] }],
    };
    const { run } = new TeamPaySimulator().runPayroll('er_1', WEEK, '2026-10-25', [hourly, salaried], batch);
    expect(run.employees.find((e) => e.employeeId === hourly.id)!.gross).toBe(300);
    expect(run.employees.find((e) => e.employeeId === salaried.id)!.gross).toBe(1000);
  });
});
