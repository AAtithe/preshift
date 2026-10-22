import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { signHmac, TeamPayProvider } from './integrations/payroll/teampay';
import { PayrollError } from './integrations/payroll/provider';
import { MemoryStore, upgradeState } from './store';

const WEEK = '2026-10-19';
const KEYS = [
  { key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*' as const] },
  { key: 'gm', orgId: 'demo', name: 'GM', scopes: ['rota:read' as const, 'rota:write' as const, 'time:approve' as const] },
  { key: 'other', orgId: 'acme', name: 'Other org', scopes: ['*' as const] },
];

async function setup() {
  const simulator = new TeamPaySimulator();
  const { app, ctx } = await buildApp({
    apiKeys: KEYS,
    store: new MemoryStore(['demo'], '2026-10-21'),
    provider: simulator,
    autoDispatch: false,
  });
  const call = async (method: string, url: string, body?: unknown, key = 'admin') => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      payload: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? (res.headers['content-type']?.includes('json') ? res.json() : res.body) : undefined };
  };
  return { app, ctx, simulator, call };
}

describe('auth and tenancy', () => {
  it('rejects missing keys and missing scopes, and isolates organisations', async () => {
    const { call } = await setup();
    expect((await call('GET', '/v1/sites', undefined, 'nope')).status).toBe(401);
    expect((await call('POST', '/v1/payroll/submissions', { weekStart: WEEK }, 'gm')).status).toBe(403);
    expect((await call('GET', '/v1/sites', undefined, 'other')).body).toEqual([]);
  });
});

describe('rota', () => {
  it('returns compliance issues with a saved shift and blocks publishing on a breach', async () => {
    const { call } = await setup();
    const res = await call('POST', '/v1/shifts', {
      employeeId: 'mar-2', roleId: 'chef', siteId: 'mar', date: WEEK, startMinute: 600, endMinute: 1080, breakMinutes: 0,
    });
    expect(res.status).toBe(201);
    expect(res.body.issues.map((i: { code: string }) => i.code)).toContain('break');
    const pub = await call('POST', '/v1/rota/publish', { siteId: 'mar', weekStart: WEEK });
    expect(pub.status).toBe(409);
    expect(pub.body.error).toBe('compliance_block');
  });

  it('builds from the forecast and reports the week', async () => {
    const { call } = await setup();
    const build = await call('POST', '/v1/rota/build', { siteId: 'mar', weekStart: WEEK });
    expect(build.body.added.length).toBeGreaterThan(20);
    const week = await call('GET', `/v1/rota/week?siteId=mar&weekStart=${WEEK}`);
    expect(week.body.metrics.labourPct).toBeGreaterThan(0.15);
    expect(Object.keys(week.body.metrics.cost.shifts).length).toBe(week.body.shifts.length);
    expect((await call('POST', '/v1/rota/publish', { siteId: 'mar', weekStart: WEEK })).status).toBe(200);
  });

  it('replaces a week in one go, as when a rota assistant draft is applied', async () => {
    const { call } = await setup();
    await call('POST', '/v1/rota/build', { siteId: 'mar', weekStart: WEEK });
    const draft = [{ id: 'd1', employeeId: 'mar-2', roleId: 'chef', siteId: 'mar', date: WEEK, startMinute: 600, endMinute: 960, breakMinutes: 0 }];
    const res = await call('PUT', '/v1/rota/week', { siteId: 'mar', weekStart: WEEK, shifts: draft });
    expect(res.status).toBe(200);
    const week = await call('GET', `/v1/shifts?siteId=mar&from=${WEEK}&to=2026-10-25`);
    expect(week.body.map((s: { id: string }) => s.id)).toEqual(['d1']);
    const outside = await call('PUT', '/v1/rota/week', { siteId: 'mar', weekStart: WEEK, shifts: [{ ...draft[0], date: '2026-11-02' }] });
    expect(outside.status).toBe(422);
  });

  it('validates input', async () => {
    const { call } = await setup();
    expect((await call('POST', '/v1/shifts', { employeeId: 'mar-2' })).status).toBe(400);
    expect((await call('POST', '/v1/shifts', { employeeId: 'ghost', roleId: 'chef', siteId: 'mar', date: WEEK, startMinute: 600, endMinute: 900 })).status).toBe(404);
  });
});

describe('rota to TeamPay, end to end', () => {
  it('flows rota, clocking, approval, hours, pay run and variance', async () => {
    const { call, ctx, simulator } = await setup();
    await call('POST', '/v1/rota/build', { siteId: 'mar', weekStart: WEEK });
    await call('POST', '/v1/integrations/payroll/sync-employees', {});
    const clock = await call('POST', '/v1/dev/simulate-clocking', { siteId: 'mar', weekStart: WEEK });
    expect(clock.body.created).toBeGreaterThan(20);

    // Unapproved time never reaches payroll.
    const early = await call('POST', '/v1/payroll/submissions', { weekStart: WEEK });
    expect(early.status).toBe(409);
    expect(early.body.error).toBe('unapproved_time');

    const approved = await call('POST', '/v1/time-entries/approve', { siteId: 'mar', from: WEEK, to: '2026-10-25' }, 'gm');
    expect(approved.body.approved).toBe(clock.body.created);

    const sub = await call('POST', '/v1/payroll/submissions', { weekStart: WEEK });
    expect(sub.status).toBe(202);
    await ctx.dispatcher.processDue();

    // One batch per company with hours, each to its own employer, holding only that company's people.
    expect(simulator.submissions).toHaveLength(sub.body.submissions.length);
    expect(new Set(simulator.submissions.map((s) => s.employerId)).size).toBe(simulator.submissions.length);
    for (const s of simulator.submissions) {
      expect(s.batch.lines.every((l) => l.payrollId?.startsWith('tp_emp_'))).toBe(true);
      expect(s.batch.lines.every((l) => simulator.employees.get(l.payrollId!)?.employerId === s.employerId)).toBe(true);
    }
    expect(simulator.submissions.reduce((t, s) => t + s.batch.totalHours, 0)).toBeCloseTo(sub.body.totalHours, 2);
    const subs = await call('GET', '/v1/payroll/submissions');
    expect(subs.body[0].status).toBe('sent');

    // Approved time in a sent period is locked.
    const entries = await call('GET', `/v1/time-entries?siteId=mar&from=${WEEK}&to=2026-10-25`);
    const locked = await call('PATCH', `/v1/time-entries/${entries.body[0].id}`, { breakMinutes: 0 });
    expect(locked.status).toBe(409);

    const run = await call('POST', '/v1/dev/teampay/run-payroll', { weekStart: WEEK });
    expect(run.status).toBe(200);
    expect(run.body.payRuns.length).toBe(sub.body.submissions.length);
    for (const payRun of run.body.payRuns) {
      expect(payRun.variance.actual).toBeGreaterThan(0);
      expect(Math.abs(payRun.variance.variancePct)).toBeLessThan(0.01);
    }

    // Accrual journal now uses approved actuals.
    const journal = await call('GET', `/v1/journal?weekStart=${WEEK}`);
    expect(journal.body.basis).toBe('actual');
    // A Xero file is one company's books, so the group has to ask per company.
    expect((await call('GET', `/v1/journal?weekStart=${WEEK}&format=xero-csv`)).status).toBe(400);
    const csv = await call('GET', `/v1/journal?weekStart=${WEEK}&format=xero-csv&entityId=wdl`);
    expect(csv.body).toContain('*AccountCode');
    expect(journal.body.lines.every((l: { entityId: string }) => ['wdl', 'eck'].includes(l.entityId))).toBe(true);
  });

  it('survives a TeamPay outage and delivers in order once it recovers', async () => {
    const { call, ctx, simulator } = await setup();
    const created = await call('POST', '/v1/employees', {
      name: 'New Starter', siteId: 'mar', roleIds: ['server'], payBasis: 'hourly', hourlyRate: 12.71, dateOfBirth: '2000-01-01',
    });
    expect(created.status).toBe(201);
    simulator.failNext = 2;
    await ctx.dispatcher.processDue();
    let outbox = (await call('GET', '/v1/integrations/payroll/outbox')).body;
    expect(outbox[0].status).toBe('pending');
    expect(outbox[0].attempts).toBe(1);
    await ctx.dispatcher.processDue(Date.now() + 60_000);
    await ctx.dispatcher.processDue(Date.now() + 10 * 60_000);
    outbox = (await call('GET', '/v1/integrations/payroll/outbox')).body;
    expect(outbox[0].status).toBe('delivered');
    const person = (await call('GET', `/v1/employees/${created.body.id}`)).body;
    expect(simulator.employees.has(person.payrollId)).toBe(true);
  });

  it('marks leavers in TeamPay and removes their future shifts', async () => {
    const { call, ctx, simulator } = await setup();
    await call('POST', '/v1/integrations/payroll/sync-employees', {});
    await call('POST', '/v1/rota/build', { siteId: 'mar', weekStart: WEEK });
    const someone = (await call('GET', `/v1/shifts?siteId=mar&from=2026-10-23&to=2026-10-25`)).body[0].employeeId;
    const res = await call('POST', `/v1/employees/${someone}/leaver`, { leaveDate: '2026-10-22' });
    expect(res.body.shiftsRemoved).toBeGreaterThan(0);
    await ctx.dispatcher.processDue();
    const payrollId = (await call('GET', `/v1/employees/${someone}`)).body.payrollId;
    expect(simulator.employees.get(payrollId)?.leaveDate).toBe('2026-10-22');
  });
});

describe('TeamPay webhooks', () => {
  it('rejects bad signatures and ignores duplicates', async () => {
    const { app, simulator } = await setup();
    const body = JSON.stringify({ id: 'evt_1', type: 'payroll.run.flagged', data: { reason: 'NMW shortfall' } });
    const post = (signature: string) =>
      app.inject({ method: 'POST', url: '/v1/integrations/teampay/webhook/demo', headers: { 'content-type': 'application/json', 'x-teampay-signature': signature }, payload: body });
    expect((await post('sha256=bad')).statusCode).toBe(401);
    const good = signHmac(simulator.webhookSecret, body);
    expect((await post(good)).json()).toEqual({ received: true });
    expect((await post(good)).json()).toEqual({ received: true, duplicate: true });
  });
});

describe('TeamPay client', () => {
  it('sends authenticated, idempotent requests and classifies failures', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 201;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'tp_1' }), { status });
    }) as unknown as typeof fetch;
    const tp = new TeamPayProvider({ baseUrl: 'https://tp.test/v1', apiKey: 'k', webhookSecret: 's', employerId: 'er_1', fetchImpl });

    await tp.submitHours(
      'er_2',
      { periodStart: WEEK, periodEnd: '2026-10-25', totalHours: 8, salariedEntryIds: [], lines: [{ employeeId: 'e', payrollId: 'tp_e', siteId: 'mar', roleId: 'server', hours: 8, rate: 13, entryIds: ['a'] }] },
      'hours:demo:v1',
    );
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe('https://tp.test/v1/hours');
    expect(headers.authorization).toBe('Bearer k');
    expect(headers['idempotency-key']).toBe('hours:demo:v1');
    // The employer named on the call wins: a group sends each company's hours to its own scheme.
    expect(headers['x-teampay-employer']).toBe('er_2');
    expect(JSON.parse(calls[0].init.body as string).lines[0]).toMatchObject({ employee_id: 'tp_e', hours: 8, cost_centre: 'mar' });

    status = 503;
    await expect(tp.getPayRun('er_1', 'r1')).rejects.toMatchObject({ retryable: true, status: 503 });
    status = 422;
    await expect(tp.getPayRun('er_1', 'r1')).rejects.toBeInstanceOf(PayrollError);
    await expect(tp.getPayRun('er_1', 'r1')).rejects.toMatchObject({ retryable: false });
    // Never a call without an employer, so nothing can land on a default scheme by accident.
    const before = calls.length;
    await expect(tp.getPayRun('', 'r1')).rejects.toMatchObject({ retryable: false });
    expect(calls.length).toBe(before);
  });
});

describe('multi-site and multi-entity', () => {
  it('serves the group, builds several sites in one call and publishes them together', async () => {
    const { call } = await setup();
    const entities = (await call('GET', '/v1/entities')).body;
    expect(entities.map((e: { id: string }) => e.id)).toEqual(['wdl', 'eck']);
    const build = await call('POST', '/v1/rota/build', { siteIds: ['mar', 'fitz', 'shd'], weekStart: WEEK });
    expect(build.status).toBe(200);
    const shifts = (await call('GET', `/v1/shifts?from=${WEEK}&to=2026-10-25`)).body as { siteId: string; published?: boolean }[];
    expect(new Set(shifts.map((s) => s.siteId))).toEqual(new Set(['mar', 'fitz', 'shd']));
    expect((await call('POST', '/v1/rota/build', { weekStart: WEEK })).status).toBe(400);
    expect((await call('POST', '/v1/rota/build', { siteIds: ['mar', 'nowhere'], weekStart: WEEK })).status).toBe(404);
    expect((await call('POST', '/v1/rota/publish', { siteIds: ['mar', 'fitz'], weekStart: WEEK })).status).toBe(200);
    const after = (await call('GET', `/v1/shifts?from=${WEEK}&to=2026-10-25`)).body as { siteId: string; published?: boolean }[];
    expect(after.filter((s) => s.siteId !== 'shd').every((s) => s.published)).toBe(true);
    expect(after.filter((s) => s.siteId === 'shd').some((s) => s.published)).toBe(false);
  });

  it('journals per company with the allowance, and checks employers on starters', async () => {
    const { call } = await setup();
    await call('POST', '/v1/rota/build', { siteIds: ['mar', 'fitz', 'shd'], weekStart: WEEK });
    const journal = (await call('GET', `/v1/journal?weekStart=${WEEK}`)).body;
    expect(journal.employmentAllowance).toMatchObject({ entityId: 'wdl', available: 1850 });
    expect(journal.lines.some((l: { description: string }) => l.description === 'Employment Allowance')).toBe(true);
    const eck = (await call('GET', `/v1/journal?weekStart=${WEEK}&entityId=eck`)).body;
    expect(eck.lines.every((l: { entityId: string }) => l.entityId === 'eck')).toBe(true);
    expect((await call('GET', `/v1/journal?weekStart=${WEEK}&entityId=ghost`)).status).toBe(404);

    const starter = { name: 'Cover Bar', siteId: 'shd', roleIds: ['bar'], payBasis: 'hourly', hourlyRate: 13, dateOfBirth: '1999-01-01' };
    const made = await call('POST', '/v1/employees', starter);
    expect(made.body).toMatchObject({ entityId: 'eck', coverSiteIds: [] });
    expect((await call('POST', '/v1/employees', { ...starter, entityId: 'ghost' })).status).toBe(404);
    expect((await call('PATCH', `/v1/employees/${made.body.id}`, { coverSiteIds: ['nowhere'] })).status).toBe(404);
  });

  it('upgrades data saved before entities existed to one company, without changing its costs', () => {
    const legacy = {
      sites: [{ id: 'a', name: 'A', labourTargetPct: 0.3, trackingCode: 'A', openMinute: 600, closeMinute: 1380 }],
      employees: [{ id: 'e1', siteId: 'a' }],
      roles: [], shifts: [], forecast: [], demandRules: [],
    } as unknown as Parameters<typeof upgradeState>[0];
    const up = upgradeState(legacy);
    expect(up.entities).toHaveLength(1);
    expect(up.sites[0].entityId).toBe(up.entities[0].id);
    expect(up.employees[0]).toMatchObject({ entityId: up.entities[0].id, coverSiteIds: [] });
    expect(up.entities[0].employmentAllowance).toBeUndefined();
  });
});

describe('holiday', () => {
  it('stores a holiday record on an employee and a leave year on a company', async () => {
    const { call } = await setup();
    const holiday = { entitlementWeeks: 6, carriedOverHours: 8, openingTakenHours: 16, dayHours: { '2026-11-02': 4 } };
    const saved = await call('PATCH', '/v1/employees/mar-2', { holiday });
    expect(saved.status).toBe(200);
    expect(saved.body.holiday).toEqual(holiday);
    expect((await call('PATCH', '/v1/employees/mar-2', { holiday: { entitlementWeeks: 4 } })).status).toBe(400);

    const entity = await call('PATCH', '/v1/entities/wdl', { leaveYearStart: '04-01' });
    expect(entity.body.leaveYearStart).toBe('04-01');
    expect((await call('PATCH', '/v1/entities/wdl', { leaveYearStart: '13-01' })).status).toBe(400);
  });
});

describe('takings', () => {
  it('upserts, filters, removes and checks the site', async () => {
    const { call } = await setup();
    const seeded = (await call('GET', '/v1/sales?siteId=mar&from=2026-10-19&to=2026-10-25')).body as unknown[];
    expect(seeded).toHaveLength(2);
    const put = await call('PUT', '/v1/sales', { rows: [{ siteId: 'mar', date: '2026-10-19', netSales: 5000.456, covers: 120 }, { siteId: 'mar', date: '2026-10-21', netSales: 4200, source: 'manual' }] });
    expect(put.body).toEqual({ upserted: 2 });
    const week = (await call('GET', '/v1/sales?siteId=mar&from=2026-10-19&to=2026-10-25')).body as { date: string; netSales: number; source: string }[];
    expect(week).toHaveLength(3);
    expect(week.find((r) => r.date === '2026-10-19')).toMatchObject({ netSales: 5000.46, source: 'till' });
    expect(week.find((r) => r.date === '2026-10-21')?.source).toBe('manual');
    expect((await call('PUT', '/v1/sales', { rows: [{ siteId: 'nowhere', date: '2026-10-19', netSales: 1 }] })).status).toBe(404);
    expect((await call('PUT', '/v1/sales', { rows: [{ siteId: 'mar', date: '2026-10-19', netSales: -1 }] })).status).toBe(400);
    expect((await call('DELETE', '/v1/sales?siteId=mar&date=2026-10-21')).status).toBe(204);
    expect((await call('DELETE', '/v1/sales?siteId=mar&date=2026-10-21')).status).toBe(404);
    expect((await call('PUT', '/v1/sales', { rows: [] }, 'other')).status).toBe(200);
    expect((await call('GET', '/v1/sales', undefined, 'other')).body).toEqual([]);
  });
});
