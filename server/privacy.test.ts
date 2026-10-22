import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { londonParts } from './context';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';
import { codeAt, stepAt } from './totp';

const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };

async function boot() {
  const store = new MemoryStore(['demo'], '2026-10-21');
  const { app } = await buildApp({
    apiKeys: [
      { key: 'integration', orgId: 'demo', name: 'Integration', scopes: ['*'] },
      // The Marylebone GM, having entered their code: runs a site, does not handle data requests.
      { key: 'gm', orgId: 'demo', name: 'GM', scopes: ['*'], userId: 'usr_gm_mar', mfa: true },
    ],
    store,
    provider: new TeamPaySimulator(),
    autoDispatch: false,
  });
  const setup = await app.inject({
    method: 'POST',
    url: '/auth/setup',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ email: OWNER.email, password: OWNER.password, confirm: OWNER.password, next: '/app/' }).toString(),
  });
  const first = String(setup.headers['set-cookie']).split(';')[0];
  // privacy.manage needs the authenticator: the owner sets one up, as they would on day one.
  const enrolCall = (url: string, cookie: string, body?: unknown) =>
    app.inject({ method: 'POST', url, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });
  const secret = (await enrolCall('/v1/me/authenticator/start', first)).json().secret as string;
  const confirmed = await enrolCall('/v1/me/authenticator/confirm', first, { code: codeAt(secret, stepAt(Date.now())) });
  const admin = String(confirmed.headers['set-cookie']).split(';')[0];
  const call = async (method: string, url: string, body?: unknown, auth: { cookie?: string; key?: string } = { cookie: admin }) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: {
        ...(auth.cookie ? { cookie: auth.cookie } : {}),
        ...(auth.key ? { authorization: `Bearer ${auth.key}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  return { store, call, unproved: first };
}

/** A person who left long enough ago that every retention period has run out, clocked with a location. */
async function oldLeaver(t: Awaited<ReturnType<typeof boot>>) {
  const created = await t.call('POST', '/v1/employees', {
    name: 'Old Leaver', siteId: 'mar', roleIds: ['server'], payBasis: 'hourly', hourlyRate: 13, dateOfBirth: '1990-06-15',
    email: 'old@example.com', phone: '07700 900001', rightToWork: { checked: true, checkedOn: '2018-01-01', evidence: 'British passport' },
  });
  const id = created.body.id as string;
  await t.call('POST', `/v1/employees/${id}/leaver`, { leaveDate: '2018-06-30' });
  const org = await t.store.load('demo');
  org.timeEntries.push({
    id: 'te-old', employeeId: id, siteId: 'mar', roleId: 'server', date: '2018-06-01', clockIn: 600, clockOut: 900,
    breakMinutes: 0, status: 'approved', source: 'clock', method: 'phone', clockInLocation: { lat: 51.52, lng: -0.15, accuracyMetres: 10 },
  });
  return id;
}

describe('GDPR', () => {
  it('shows the register to readers, and keeps everything naming a person to privacy.manage', async () => {
    const t = await boot();
    const reg = await t.call('GET', '/v1/privacy/register', undefined, { key: 'integration' });
    expect(reg.status).toBe(200);
    expect(reg.body.activities.map((a: { activity: string }) => a.activity)).toContain('Clocking location');
    expect(reg.body.processors.find((p: { name: string }) => p.name === 'TeamPay').active).toBe(false);
    expect((await t.call('GET', '/v1/privacy/retention')).status).toBe(200);
    for (const [method, url] of [['GET', '/v1/privacy/retention'], ['GET', '/v1/privacy/requests'], ['POST', '/v1/privacy/retention/apply'], ['POST', '/v1/privacy/subjects/mar-1/export']]) {
      expect((await t.call(method, url, undefined, { key: 'integration' })).status).toBe(403);
      expect((await t.call(method, url, undefined, { key: 'gm' })).status).toBe(403);
    }
    // The owner without a code this session does not hold it either: it needs the authenticator.
    expect((await t.call('GET', '/v1/privacy/requests', undefined, { cookie: t.unproved })).status).toBe(403);
  });

  it('logs a request with its one month deadline, extends it and closes it', async () => {
    const t = await boot();
    const today = londonParts(new Date()).date;
    const logged = await t.call('POST', '/v1/privacy/requests', { kind: 'access', subject: 'A Person', receivedOn: '2026-01-31' });
    expect(logged.status).toBe(201);
    expect(logged.body).toMatchObject({ status: 'open', dueOn: '2026-02-28', loggedBy: OWNER.email });
    expect((await t.call('POST', '/v1/privacy/requests', { kind: 'access', subject: 'X', receivedOn: '2999-01-01' })).status).toBe(400);
    const extended = await t.call('PATCH', `/v1/privacy/requests/${logged.body.id}`, { extended: true });
    expect(extended.body.dueOn).toBe('2026-04-30');
    const closed = await t.call('PATCH', `/v1/privacy/requests/${logged.body.id}`, { status: 'closed' });
    expect(closed.body).toMatchObject({ status: 'closed', closedOn: today });
    expect((await t.call('GET', '/v1/privacy/requests')).body).toHaveLength(1);
  });

  it('exports everything held on a person, without their password hash', async () => {
    const t = await boot();
    const id = await oldLeaver(t);
    await t.call('POST', '/v1/privacy/requests', { kind: 'access', subject: 'Old Leaver', employeeId: id, receivedOn: '2026-10-01' });
    await t.call('POST', '/v1/hr/records', { employeeId: id, kind: 'case', caseType: 'grievance', date: '2018-06-01', title: 'Rota fairness' });
    const res = await t.call('POST', `/v1/privacy/subjects/${id}/export`);
    expect(res.status).toBe(200);
    expect(res.body.hrRecords.map((r: { title: string }) => r.title)).toEqual(['Rota fairness']);
    expect(res.body.person).toMatchObject({ id, name: 'Old Leaver', email: 'old@example.com' });
    expect(res.body.timeEntries[0].clockInLocation).toBeDefined();
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.changes.map((c: { action: string }) => c.action)).toEqual(expect.arrayContaining(['employee.created', 'employee.leaver']));
    expect(res.body.yourRights).toMatch(/ico\.org\.uk/);
    expect(JSON.stringify(res.body)).not.toMatch(/"hash"|"salt"/);
  });

  it('refuses erasure for current staff and erases what it can for a leaver', async () => {
    const t = await boot();
    expect((await t.call('POST', '/v1/privacy/subjects/mar-1/erase')).status).toBe(409);
    const id = await oldLeaver(t);
    const res = await t.call('POST', `/v1/privacy/subjects/${id}/erase`);
    expect(res.status).toBe(200);
    expect(res.body.locationsRemoved).toBe(1);
    expect(res.body.employee.email).toBeUndefined();
    expect(res.body.employee.name).toBe('Old Leaver');
    expect(res.body.employee.rightToWork.evidence).toBe('British passport');
  });

  it('applies the retention schedule and records ids only in the audit', async () => {
    const t = await boot();
    const id = await oldLeaver(t);
    await t.call('PUT', `/v1/employees/${id}/hr`, { niNumber: 'QQ123456C', address: '1 High St', emergencyContact: { name: 'Kin', phone: '07700 900001' } });
    await t.call('POST', `/v1/employees/${id}/absences`, { type: 'sickness', from: '2018-05-01', to: '2018-05-02', reason: 'Back injury' });
    await t.call('POST', '/v1/hr/records', { employeeId: id, kind: 'note', date: '2018-05-03', title: 'Return to work' });
    const before = await t.call('GET', '/v1/privacy/retention');
    expect(before.body.items.filter((i: { employeeId: string; due: boolean }) => i.employeeId === id && i.due).map((i: { code: string }) => i.code).sort())
      .toEqual(['anonymise', 'contact', 'location', 'right-to-work']);
    const applied = await t.call('POST', '/v1/privacy/retention/apply');
    expect(applied.status).toBe(200);
    const person = (await t.call('GET', `/v1/employees/${id}`)).body;
    expect(person).toMatchObject({ name: `Former employee ${id.slice(-6)}`, dateOfBirth: '1990-01-01', rightToWork: { checked: true } });
    // The personnel file goes with the name: no NI number, address, emergency contact, sickness reason or HR records.
    expect(person.hr).toEqual({});
    expect(person.absences).toEqual([{ id: expect.any(String), type: 'sickness', from: '2018-05-01', to: '2018-05-02' }]);
    expect((await t.call('GET', `/v1/hr/records?employeeId=${id}`)).body).toEqual([]);
    const org = await t.store.load('demo');
    expect(org.timeEntries.find((x) => x.id === 'te-old')?.clockInLocation).toBeUndefined();
    expect(JSON.stringify(org.audit.at(-1))).not.toMatch(/Old Leaver|old@example/);
    const after = await t.call('GET', '/v1/privacy/retention');
    expect(after.body.items.filter((i: { employeeId: string }) => i.employeeId === id)).toEqual([]);
  });

  it('will not shorten retention below the legal minimums', async () => {
    const t = await boot();
    const policy = { locationMonths: 1, contactMonthsAfterLeaving: 3, rightToWorkYearsAfterLeaving: 1, payrollYearsAfterTaxYear: 6 };
    expect((await t.call('PUT', '/v1/privacy/policy', policy)).status).toBe(400);
    const ok = await t.call('PUT', '/v1/privacy/policy', { ...policy, rightToWorkYearsAfterLeaving: 2 });
    expect(ok.body.policy.locationMonths).toBe(1);
    expect((await t.call('GET', '/v1/privacy/retention')).body.policy.locationMonths).toBe(1);
  });
});
