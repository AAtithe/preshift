import { describe, expect, it } from 'vitest';
import { drawProblem, earnedPayPosition } from '../src/engine/earnedPay';
import type { EarnedPayDraw, Employee, Entity, TimeEntry } from '../src/engine/types';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

const TODAY = '2026-10-21'; // Wednesday: the weekly period runs Monday 19th to Sunday 25th, paid Friday 30th
const NOW = new Date('2026-10-21T12:00:00Z');
const PASSWORD = 'pint of best bitter';

const person = (over: Partial<Employee> = {}): Employee => ({
  id: 'e1', name: 'Sam Lee', siteId: 'mar', entityId: 'wdl', coverSiteIds: [], roleIds: ['bar'], payBasis: 'hourly', hourlyRate: 13.75, annualSalary: 0,
  dateOfBirth: '1994-10-10', contractedHours: 0, maxWeeklyHours: 48, optedOutOf48: false, irregularHours: true, pensionEnrolled: true,
  availability: [], leave: [], payrollId: 'tp-1', ...over,
});
const company = (on = true): Entity => ({ id: 'wdl', name: 'West End Dining Ltd', companyNumber: '1', payeReference: '120/X', earnedPay: { on, sharePct: 50, minDraw: 10, maxDrawsPerPeriod: 3 } }) as Entity;
const entry = (date: string, hours: number, status: TimeEntry['status'] = 'approved', employeeId = 'e1'): TimeEntry => ({
  id: `te-${employeeId}-${date}-${status}`, employeeId, siteId: 'mar', roleId: 'bar', date, clockIn: 17 * 60, clockOut: 17 * 60 + hours * 60, breakMinutes: 0, status, source: 'clock',
});

describe('what a person may draw', () => {
  // Twenty approved hours at £13.75 is £275 gross. Allowing for basic rate tax, NI and a 5% pension
  // leaves £184.25; half of that, in whole pounds, is £92.
  const hours = [entry('2026-10-19', 10), entry('2026-10-20', 10), entry('2026-10-21', 6, 'submitted')];

  it('offers half of a cautious estimate of earned net pay, from approved time only', () => {
    const p = earnedPayPosition(person(), company(), hours, [], TODAY);
    expect(p).toMatchObject({ allowed: true, earnedGross: 275, earnedNet: 184.25, available: 92, drawsLeft: 3, period: { periodStart: '2026-10-19', periodEnd: '2026-10-25', payDate: '2026-10-30' } });
    expect(drawProblem(p, 92)).toBeNull();
    expect(drawProblem(p, 93)).toMatch(/up to £92/);
    expect(drawProblem(p, 5)).toMatch(/smallest draw is £10/);
    expect(drawProblem(p, 20.5)).toMatch(/whole pounds/);
  });

  it('takes earlier draws off, counts failed and cancelled ones as never made, and stops at the limit of draws', () => {
    const draw = (amount: number, status: EarnedPayDraw['status']): EarnedPayDraw => ({ id: `d${amount}${status}`, employeeId: 'e1', entityId: 'wdl', scheduleId: 'weekly', periodStart: '2026-10-19', periodEnd: '2026-10-25', payDate: '2026-10-30', amount, requestedAt: NOW.toISOString(), status });
    expect(earnedPayPosition(person(), company(), hours, [draw(40, 'paid'), draw(30, 'failed'), draw(20, 'cancelled')], TODAY).available).toBe(52);
    const three = [draw(10, 'paid'), draw(11, 'paid'), draw(12, 'requested')];
    expect(earnedPayPosition(person(), company(), hours, three, TODAY)).toMatchObject({ allowed: false, reason: expect.stringMatching(/3 draws allowed/) });
  });

  it('is refused when it is off, before payroll knows the person, for a leaver, close to payday, or under the smallest draw', () => {
    expect(earnedPayPosition(person(), company(false), hours, [], TODAY).reason).toMatch(/not turned on/);
    expect(earnedPayPosition(person({ payrollId: undefined }), company(), hours, [], TODAY).reason).toMatch(/not set up in payroll/);
    expect(earnedPayPosition(person({ leaveDate: '2026-10-20' }), company(), hours, [], TODAY).reason).toMatch(/still working here/);
    // A calendar month paid on the 28th: from the 27th, and after payday to the month's end, no draw can come off it.
    const monthly = { ...company(), paySchedules: [{ id: 'monthly', name: 'Monthly', frequency: 'monthly', periodEndDay: 31, payDay: 28, payMonthOffset: 0, cutoffDaysBeforePay: 3, cutoffTime: '12:00' }] } as Entity;
    expect(earnedPayPosition(person(), monthly, hours, [], '2026-10-24').allowed).toBe(true);
    expect(earnedPayPosition(person(), monthly, hours, [], '2026-10-27').reason).toMatch(/Payday for this pay period is here/);
    expect(earnedPayPosition(person(), monthly, hours, [], '2026-10-29').reason).toMatch(/Payday for this pay period is here/);
    expect(earnedPayPosition(person(), company(), [entry('2026-10-19', 1)], [], TODAY)).toMatchObject({ allowed: false, available: 0 });
  });

  it('counts salary to date for salaried staff', () => {
    // £36,500 a year is £100 a day: three days into the week is £300 gross.
    const p = earnedPayPosition(person({ payBasis: 'salaried', annualSalary: 36_500, pensionEnrolled: false }), company(), [], [], TODAY);
    expect(p.earnedGross).toBe(300);
    expect(p.available).toBe(108);
  });
});

describe('early pay end to end', () => {
  async function setup() {
    const simulator = new TeamPaySimulator();
    const store = new MemoryStore(['demo'], TODAY);
    const { app, ctx } = await buildApp({
      apiKeys: [
        { key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*'] },
        { key: 'finance', orgId: 'demo', name: 'Nadia', scopes: ['*'], userId: 'usr_fd', mfa: true },
      ],
      store,
      provider: simulator,
      autoDispatch: false,
      now: () => NOW,
    });
    const call = async (method: string, url: string, body?: unknown, auth: { key?: string; cookie?: string } = { key: 'admin' }) => {
      const res = await app.inject({
        method: method as 'GET',
        url,
        headers: { ...(auth.key ? { authorization: `Bearer ${auth.key}` } : { cookie: auth.cookie! }), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        payload: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.statusCode, body: res.body ? res.json() : undefined, cookie: String(res.headers['set-cookie'] ?? '').split(';')[0] };
    };
    const org = await store.load('demo');
    org.users.find((u) => u.id === 'usr_fd')!.mfaEnrolled = true;
    const ben = org.state.employees.find((e) => e.id === 'mar-12')!;
    ben.payrollId = 'tp-ben';
    org.timeEntries = [entry('2026-10-19', 10, 'approved', 'mar-12'), entry('2026-10-20', 10, 'approved', 'mar-12')];
    await store.save();
    const invite = await call('POST', '/v1/staff-logins/mar-12/invite');
    const link = Object.fromEntries(new URLSearchParams(new URL(invite.body.path, 'https://x').hash.slice(1)));
    const joined = await call('POST', '/v1/staff/join', { ...link, email: 'ben@example.com', password: PASSWORD }, { key: 'admin' });
    const staff = { cookie: joined.cookie };
    const dispatch = async () => {
      const o = await store.load('demo');
      await ctx.dispatcher.processOrg(o);
      await store.save();
      return o;
    };
    return { call, staff, simulator, dispatch, store };
  }

  it('stays off until payroll switches it on, and only someone who may send payroll can', async () => {
    const { call, staff } = await setup();
    const off = await call('GET', '/v1/staff/earned-pay', undefined, staff);
    expect(off.body).toMatchObject({ on: false, allowed: false, available: 0 });
    expect((await call('POST', '/v1/staff/earned-pay', { amount: 20 }, staff)).status).toBe(422);
    expect((await call('PUT', '/v1/entities/wdl/earned-pay', { on: true, sharePct: 80, minDraw: 10, maxDrawsPerPeriod: 3 }, { key: 'finance' })).status).toBe(422);
    expect((await call('PUT', '/v1/entities/wdl/earned-pay', { on: true, sharePct: 50, minDraw: 10, maxDrawsPerPeriod: 3 }, { key: 'finance' })).status).toBe(200);
  });

  it('pays a draw through TeamPay and takes it off that payday’s net pay, once', async () => {
    const { call, staff, simulator, dispatch } = await setup();
    await call('PUT', '/v1/entities/wdl/earned-pay', { on: true, sharePct: 50, minDraw: 10, maxDrawsPerPeriod: 3 }, { key: 'finance' });
    // Ben: 20 hours at £13.75, pension enrolled, so £92 is available.
    const position = (await call('GET', '/v1/staff/earned-pay', undefined, staff)).body;
    expect(position).toMatchObject({ on: true, allowed: true, available: 92, period: { payDate: '2026-10-30' } });
    expect((await call('POST', '/v1/staff/earned-pay', { amount: 93 }, staff)).body.message).toMatch(/up to £92/);
    const draw = await call('POST', '/v1/staff/earned-pay', { amount: 50 }, staff);
    expect(draw.status).toBe(200);
    expect(draw.body).toMatchObject({ amount: 50, status: 'requested', payDate: '2026-10-30' });

    const org = await dispatch();
    expect(simulator.earnedPayments).toEqual([expect.objectContaining({ payrollId: 'tp-ben', amount: 50, reference: draw.body.id, payDate: '2026-10-30' })]);
    expect(org.earnedPay!.draws[0].status).toBe('paid');
    expect((await call('GET', '/v1/staff/earned-pay', undefined, staff)).body).toMatchObject({ drawn: 50, available: 42 });

    // Finance sees it, with what is still to come off a payslip.
    const finance = (await call('GET', '/v1/earned-pay', undefined, { key: 'finance' })).body;
    expect(finance.companies.find((c: { entityId: string }) => c.entityId === 'wdl').outstanding).toBe(50);

    // The week's hours go to payroll with the draw to take off net pay, and only once.
    const sent = await call('POST', '/v1/payroll/submissions', { weekStart: '2026-10-19', entityId: 'wdl' }, { key: 'finance' });
    expect(sent.status).toBe(202);
    const after = await dispatch();
    const item = after.outbox.filter((i) => i.type === 'hours.submit').at(-1)!;
    expect((item.payload as { batch: { deductions: unknown[] } }).batch.deductions).toEqual([expect.objectContaining({ employeeId: 'mar-12', amount: 50, reference: draw.body.id })]);
    expect(after.earnedPay!.draws[0].deductedIn).toBe(sent.body.submissions[0].id);
    // Sent again, the replacement batch carries it instead: never two deductions.
    const again = await call('POST', '/v1/payroll/submissions', { weekStart: '2026-10-19', entityId: 'wdl' }, { key: 'finance' });
    const latest = (await dispatch()).outbox.filter((i) => i.type === 'hours.submit').at(-1)!;
    expect((latest.payload as { batch: { deductions: unknown[] } }).batch.deductions).toHaveLength(1);
    expect((await call('GET', '/v1/earned-pay', undefined, { key: 'finance' })).body.draws[0].deductedIn).toBe(again.body.submissions[0].id);
  });

  it('lets finance cancel a draw before it reaches payroll, and not after', async () => {
    const { call, staff, dispatch } = await setup();
    await call('PUT', '/v1/entities/wdl/earned-pay', { on: true, sharePct: 50, minDraw: 10, maxDrawsPerPeriod: 3 }, { key: 'finance' });
    const first = await call('POST', '/v1/staff/earned-pay', { amount: 20 }, staff);
    expect((await call('POST', `/v1/earned-pay/${first.body.id}/cancel`, undefined, { key: 'finance' })).body.status).toBe('cancelled');
    const second = await call('POST', '/v1/staff/earned-pay', { amount: 20 }, staff);
    await dispatch();
    expect((await call('POST', `/v1/earned-pay/${second.body.id}/cancel`, undefined, { key: 'finance' })).status).toBe(409);
    expect((await call('GET', '/v1/staff/earned-pay', undefined, staff)).body).toMatchObject({ drawn: 20 });
  });
});
