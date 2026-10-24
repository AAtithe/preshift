import { describe, expect, it } from 'vitest';
import { addDays, londonParts, weekStart } from '../src/engine/time';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

const PASSWORD = 'pint of best bitter';

async function boot() {
  const simulator = new TeamPaySimulator();
  const store = new MemoryStore(['demo'], '2026-10-21');
  const { app } = await buildApp({ apiKeys: [{ key: 'manager', orgId: 'demo', name: 'GM', scopes: ['*'] }], store, provider: simulator, autoDispatch: false });
  const call = async (method: string, url: string, body?: unknown, cookie?: string) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { ...(cookie ? { cookie } : { authorization: 'Bearer manager' }), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = String(res.headers['set-cookie'] ?? '').split(';')[0];
    return { status: res.statusCode, body: (res.headers['content-type'] ?? '').includes('json') ? res.json() : res.body, cookie: set };
  };
  const join = async (person: string) => {
    const inv = await call('POST', `/v1/staff-logins/${person}/invite`);
    const link = Object.fromEntries(new URLSearchParams(new URL(inv.body.path, 'https://x').hash.slice(1)));
    return (await call('POST', '/v1/staff/join', { ...link, email: `${person}@example.com`, password: PASSWORD })).cookie;
  };
  return { simulator, store, call, join };
}

describe('tips in the staff app', () => {
  it('shows the person their own share each week, paid or when it is due, and the site\'s policy', async () => {
    const { store, call, join } = await boot();
    const grace = await join('mar-7');
    const lastWeek = addDays(weekStart(londonParts(new Date()).date), -7);
    const org = await store.load('demo');
    org.state.troncSchemes = [{ siteId: 'mar', troncmaster: 'Head waiter', independent: true, pointsPerHour: { server: 1, host: 1 }, serviceCharge: 'discretionary', policyPublishedOn: '2026-01-05' }];
    org.state.tips = [{ id: 't1', siteId: 'mar', date: lastWeek, source: 'card-tip', amount: 60 }];
    const made = await call('POST', '/v1/time-entries', { employeeId: 'mar-7', siteId: 'mar', roleId: 'server', date: lastWeek, clockIn: 600, clockOut: 960, breakMinutes: 20 });
    await call('POST', '/v1/time-entries/approve', { ids: [made.body.id] });

    const tips = (await call('GET', '/v1/staff/tips', undefined, grace)).body;
    expect(tips.policy).toMatchObject({ troncmaster: 'Head waiter', independent: true, serviceCharge: 'discretionary', publishedOn: '2026-01-05' });
    expect(tips.policy.pointsPerHour).toEqual(expect.arrayContaining([{ role: 'Server', points: 1 }]));
    expect(tips.weeks).toEqual([expect.objectContaining({ weekStart: lastWeek, amount: 60, paidOn: null, payBy: expect.any(String) })]);
    expect(tips.total).toBe(60);

    org.state.tips[0].paidOn = addDays(lastWeek, 8);
    expect((await call('GET', '/v1/staff/tips', undefined, grace)).body.weeks[0].paidOn).toBe(addDays(lastWeek, 8));
    // Three years at most, the period the record is kept.
    expect((await call('GET', '/v1/staff/tips?weeks=200', undefined, grace)).status).toBe(400);
  });
});

describe('payslips in the staff app', () => {
  it('says why there are none until the person is in payroll, then lists their own from the pay runs', async () => {
    const { simulator, store, call, join } = await boot();
    const grace = await join('mar-7');
    const first = (await call('GET', '/v1/staff/payslips', undefined, grace)).body;
    expect(first).toMatchObject({ available: false, payslips: [] });
    expect(first.reason).toMatch(/not set up in payroll yet/);

    const org = await store.load('demo');
    const me = org.state.employees.find((e) => e.id === 'mar-7')!;
    me.payrollId = 'tp_emp_grace';
    me.payrollEmployerId = 'er_west';
    simulator.payRuns.set('run1', {
      id: 'run1', periodStart: '2026-10-12', periodEnd: '2026-10-18', status: 'completed', employerId: 'er_west',
      employees: [
        { employeeId: 'mar-7', payrollId: 'tp_emp_grace', gross: 420, holidayPay: 0, employerNi: 30, employerPension: 8 },
        { employeeId: 'mar-8', payrollId: 'tp_emp_other', gross: 999, holidayPay: 0, employerNi: 90, employerPension: 20 },
      ],
    });
    const slips = (await call('GET', '/v1/staff/payslips', undefined, grace)).body;
    expect(slips.available).toBe(true);
    expect(slips.payslips).toHaveLength(1);
    expect(slips.payslips[0]).toMatchObject({ kind: 'payslip', periodStart: '2026-10-12', periodEnd: '2026-10-18', gross: 420, sample: true, hasPdf: false });
    expect(slips.payslips[0].net).toBeLessThan(420);
    // Nobody else's pay, by any route.
    expect(JSON.stringify(slips)).not.toMatch(/999|tp_emp_other/);
    expect((await call('GET', '/v1/staff/payslips/slip_run1/pdf', undefined, grace)).status).toBe(404);
    expect((await call('GET', '/v1/staff/payslips', undefined, undefined)).status).toBe(401);
  });
});
