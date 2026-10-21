import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

const WEEK = '2026-10-19';
const KEYS = [
  { key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*' as const] },
  { key: 'gm', orgId: 'demo', name: 'GM', scopes: ['rota:read' as const, 'rota:write' as const] },
  { key: 'records', orgId: 'demo', name: 'Payroll bureau', scopes: ['rota:read' as const, 'employees:read' as const] },
  { key: 'hr', orgId: 'demo', name: 'HR system', scopes: ['rota:read' as const, 'hr:read' as const, 'hr:write' as const] },
  { key: 'other', orgId: 'acme', name: 'Other org', scopes: ['*' as const] },
];

async function setup() {
  const store = new MemoryStore(['demo'], '2026-10-21');
  const { app } = await buildApp({ apiKeys: KEYS, store, provider: new TeamPaySimulator(), autoDispatch: false });
  const call = async (method: string, url: string, body?: unknown, key = 'admin', cookie?: string) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: {
        ...(key && !cookie ? { authorization: `Bearer ${key}` } : {}),
        ...(cookie ? { cookie } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      payload: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined, headers: res.headers };
  };
  return { app, call };
}

describe('HR access', () => {
  it('keeps personnel files and health reasons away from rota keys', async () => {
    const { call } = await setup();
    // A rota key sees no staff records at all; one with employees:read sees them without the personnel file.
    expect((await call('GET', '/v1/employees/mar-3', undefined, 'gm')).status).toBe(403);
    const records = (await call('GET', '/v1/employees/mar-3', undefined, 'records')).body;
    expect(records.hr).toBeUndefined();
    expect(records.absences.length).toBe(4);
    expect(records.absences[0]).toEqual({ id: 'abs-1', type: 'sickness', from: expect.any(String), to: expect.any(String) });
    expect((await call('GET', '/v1/hr/records', undefined, 'gm')).status).toBe(403);
    expect((await call('GET', '/v1/hr/records', undefined, 'records')).status).toBe(403);
    expect((await call('PUT', '/v1/employees/mar-3/hr', {}, 'gm')).status).toBe(403);

    const full = (await call('GET', '/v1/employees/mar-3', undefined, 'hr')).body;
    expect(full.hr.niNumber).toMatch(/^QQ/);
    expect(full.absences[0].reason).toBe('Migraine');
    expect((await call('GET', '/v1/hr/records', undefined, 'other')).body).toEqual([]);
  });

  it('shows cases to signed-in admins but not members', async () => {
    const { app, call } = await setup();
    const form = (url: string, fields: Record<string, string>) =>
      app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(fields).toString() });
    const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie'] ?? '').split(';')[0];
    const owner = cookieOf(await form('/auth/setup', { email: 'owner@ws.example', password: 'correct horse battery', confirm: 'correct horse battery', next: '/app/' }));
    expect((await call('POST', '/v1/users', { email: 'gm@ws.example', password: 'another long password', role: 'member' }, '', owner)).status).toBe(201);
    const member = cookieOf(await form('/auth/login', { email: 'gm@ws.example', password: 'another long password', next: '/app/' }));

    const adminCases = (await call('GET', '/v1/hr/records?kind=case', undefined, '', owner)).body;
    expect(adminCases.length).toBe(3);
    expect((await call('GET', '/v1/hr/records?kind=case', undefined, '', member)).body).toEqual([]);
    expect((await call('GET', '/v1/hr/records?kind=training', undefined, '', member)).body.length).toBeGreaterThan(10);
    const opened = await call('POST', '/v1/hr/records', { employeeId: 'mar-2', kind: 'case', caseType: 'grievance', date: '2026-10-21', title: 'Rota' }, '', member);
    expect(opened.status).toBe(403);
    expect((await call('PATCH', `/v1/hr/records/${adminCases[0].id}`, { notes: 'x' }, '', member)).status).toBe(404);
    expect((await call('DELETE', `/v1/hr/records/${adminCases[0].id}`, undefined, '', member)).status).toBe(404);
  });
});

describe('HR records', () => {
  it('records, corrects and removes training, with an audit trail', async () => {
    const { call } = await setup();
    const res = await call('POST', '/v1/hr/records', { employeeId: 'fitz-4', kind: 'training', date: '2026-10-20', title: 'Food hygiene level 2', expiresOn: '2029-10-20' }, 'hr');
    expect(res.status).toBe(201);
    expect(res.body.createdBy).toBe('HR system');
    const fixed = await call('PATCH', `/v1/hr/records/${res.body.id}`, { expiresOn: '2029-10-19' }, 'hr');
    expect(fixed.body.expiresOn).toBe('2029-10-19');
    expect((await call('PATCH', `/v1/hr/records/${res.body.id}`, { kind: 'note' }, 'hr')).status).toBe(422);
    const overview = (await call('GET', '/v1/hr/overview?siteId=fitz', undefined, 'hr')).body;
    const joe = overview.checks.find((c: { employeeId: string }) => c.employeeId === 'fitz-4');
    expect(joe?.checks.map((c: { code: string }) => c.code) ?? []).not.toContain('training:Food hygiene level 2');
    expect((await call('DELETE', `/v1/hr/records/${res.body.id}`, undefined, 'hr')).status).toBe(204);
  });

  it('validates records', async () => {
    const { call } = await setup();
    expect((await call('POST', '/v1/hr/records', { employeeId: 'nobody', kind: 'note', date: '2026-10-21', title: 'x' })).status).toBe(404);
    expect((await call('POST', '/v1/hr/records', { employeeId: 'mar-2', kind: 'training', date: '2026-10-21', title: 'COSHH', expiresOn: '2026-01-01' })).status).toBe(422);
    expect((await call('POST', '/v1/hr/records', { employeeId: 'mar-2', kind: 'case', date: '2026-10-21', title: 'x' })).status).toBe(422);
    expect((await call('POST', '/v1/hr/records', { employeeId: 'mar-2', kind: 'payslip', date: '2026-10-21', title: 'x' })).status).toBe(400);
    const opened = await call('POST', '/v1/hr/records', { employeeId: 'mar-2', kind: 'case', caseType: 'investigation', date: '2026-10-21', title: 'Stock loss' });
    expect(opened.body.caseStatus).toBe('open');
  });

  it('keeps the personnel file details and checks the line manager', async () => {
    const { call } = await setup();
    const res = await call('PUT', '/v1/employees/mar-2/hr', { niNumber: 'qq 12 34 56 c', contractType: 'permanent', managerId: 'mar-1', contractIssuedOn: '2024-01-02' }, 'hr');
    expect(res.status).toBe(200);
    expect(res.body.hr.niNumber).toBe('QQ123456C');
    expect((await call('PUT', '/v1/employees/mar-2/hr', { managerId: 'mar-2' }, 'hr')).status).toBe(422);
    expect((await call('PUT', '/v1/employees/mar-2/hr', { managerId: 'ghost' }, 'hr')).status).toBe(404);
    expect((await call('PUT', '/v1/employees/mar-2/hr', { contractType: 'fixed-term' }, 'hr')).status).toBe(422);
    expect((await call('PUT', '/v1/employees/mar-2/hr', { niNumber: '12345' }, 'hr')).status).toBe(400);
    // A rota save never touches the file.
    await call('PATCH', '/v1/employees/mar-2', { hourlyRate: 17, hr: {} }, 'gm');
    expect((await call('GET', '/v1/employees/mar-2', undefined, 'hr')).body.hr.niNumber).toBe('QQ123456C');
  });
});

describe('absence', () => {
  it('returns rostered shifts it clashes with and blocks publishing until they are re-covered', async () => {
    const { call } = await setup();
    await call('POST', '/v1/shifts', { employeeId: 'mar-2', roleId: 'chef', siteId: 'mar', date: '2026-10-23', startMinute: 600, endMinute: 900, breakMinutes: 0 });
    const res = await call('POST', '/v1/employees/mar-2/absences', { type: 'sickness', from: '2026-10-22', to: '2026-10-24', reason: 'Flu' }, 'hr');
    expect(res.status).toBe(201);
    expect(res.body.clashes.length).toBe(1);
    const publish = await call('POST', '/v1/rota/publish', { siteId: 'mar', weekStart: WEEK });
    expect(publish.status).toBe(409);

    const id = res.body.absence.id;
    const back = await call('PATCH', `/v1/employees/mar-2/absences/${id}`, { to: '2026-10-22', returnToWorkOn: '2026-10-23' }, 'hr');
    expect(back.body.clashes).toEqual([]);
    expect((await call('PATCH', `/v1/employees/mar-2/absences/${id}`, { to: '2026-10-01' }, 'hr')).status).toBe(422);
    expect((await call('DELETE', `/v1/employees/mar-2/absences/${id}`, undefined, 'hr')).body.absences ?? []).toEqual([]);
    expect((await call('DELETE', `/v1/employees/mar-2/absences/${id}`, undefined, 'hr')).status).toBe(404);
  });

  it('keeps the auto-build off people who are off', async () => {
    const { call } = await setup();
    await call('POST', '/v1/rota/build', { siteId: 'fitz', weekStart: WEEK });
    const shifts = (await call('GET', `/v1/shifts?siteId=fitz&from=${WEEK}&to=2026-10-25`)).body;
    // Hana Kim is off sick with no return date in the demo.
    expect(shifts.some((s: { employeeId: string; date: string }) => s.employeeId === 'fitz-5' && s.date >= '2026-10-21')).toBe(false);
  });
});
