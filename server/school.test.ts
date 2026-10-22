import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

const TODAY = '2026-10-21';
const HALF_TERM = '2026-10-26';
const KEYS = [{ key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*' as const] }];
const COUNCIL = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT', 'UID:ht', 'DTSTART;VALUE=DATE:20261026', 'DTEND;VALUE=DATE:20261031', 'SUMMARY:Autumn Half Term', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:xm', 'DTSTART;VALUE=DATE:20261221', 'DTEND;VALUE=DATE:20270104', 'SUMMARY:Christmas Holiday', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

async function setup() {
  const store = new MemoryStore(['demo'], TODAY);
  const fetchCouncil = (async (input: string | URL | Request) => {
    if (String(input).startsWith('https://council.example/')) return new Response(COUNCIL, { status: 200 });
    throw new Error(`Unexpected ${String(input)}`);
  }) as typeof fetch;
  const { app } = await buildApp({ apiKeys: KEYS, store, provider: new TeamPaySimulator(), autoDispatch: false, now: () => new Date(`${TODAY}T07:00:00Z`), fetch: fetchCouncil });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url, headers: { authorization: 'Bearer admin', ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  return { call, store };
}

const child = {
  name: 'Sam Young',
  siteId: 'mar',
  roleIds: ['host'],
  payBasis: 'hourly',
  hourlyRate: 9,
  dateOfBirth: '2011-05-01',
  contractedHours: 0,
  rightToWork: { checked: true, checkedOn: '2026-09-01', evidence: 'British passport' },
};

describe('school holidays for a site', () => {
  it('shows the estimate until the council’s dates are in, then the council’s', async () => {
    const { call } = await setup();
    const est = (await call('GET', '/v1/school-holidays?siteId=mar&from=2026-10-01&to=2026-12-31')).body;
    expect(est.map((p: { start: string; source: string }) => [p.start, p.source])).toEqual([['2026-10-26', 'estimate'], ['2026-12-19', 'estimate']]);
    await call('POST', '/v1/event-feeds', { siteId: 'mar', kind: 'school', label: 'Westminster term dates', url: 'https://council.example/terms.ics' });
    const refreshed = await call('POST', '/v1/outside/refresh', { siteIds: ['mar'] });
    expect(refreshed.body.sites[0].errors).toEqual([]);
    const council = (await call('GET', '/v1/school-holidays?siteId=mar&from=2026-10-01&to=2026-12-31')).body;
    expect(council.map((p: { start: string; end: string; source: string }) => [p.start, p.end, p.source])).toEqual([
      ['2026-10-26', '2026-10-30', 'council'],
      ['2026-12-21', '2027-01-03', 'council'],
    ]);
  });

  it('takes holidays by hand, and no estimate in Scotland', async () => {
    const { call } = await setup();
    await call('PUT', '/v1/sites/shd/nation', { nation: 'scotland' });
    expect((await call('GET', '/v1/school-holidays?siteId=shd&from=2026-10-01&to=2026-12-31')).body).toEqual([]);
    const added = await call('POST', '/v1/school-holidays', { siteId: 'shd', start: '2026-10-12', end: '2026-10-23', name: 'October holiday' });
    expect(added.status).toBe(201);
    expect((await call('GET', '/v1/school-holidays?siteId=shd&from=2026-10-01&to=2026-12-31')).body.map((p: { id: string }) => p.id)).toEqual([added.body.id]);
    expect((await call('POST', '/v1/school-holidays', { siteId: 'shd', start: '2026-10-23', end: '2026-10-12', name: 'x' })).body.error).toBe('invalid_period');
    expect((await call('DELETE', `/v1/school-holidays/${added.body.id}`)).status).toBe(204);
  });

  it('reminds before half term, and applies what holidays do to Marylebone lunches', async () => {
    const { call } = await setup();
    const due = (await call('GET', '/v1/reminders?siteIds=mar')).body as { key: string; title: string; advice: string }[];
    const ht = due.find((r) => r.key === 'school:est:2026:autumn')!;
    expect(ht.title).toBe('October half term starts (estimated)');
    expect(ht.advice).toMatch(/add the council's dates/);
    // The calendar shows what the site has learnt and applies it; at Marylebone the model run then lets bookings
    // stand in for it on the hours they cover, so the holiday is not counted twice.
    const cal = (await call('GET', `/v1/calendar?siteId=mar&from=${HALF_TERM}&to=${HALF_TERM}`)).body;
    const lunch = cal.days[0].adjustments.find((a: { kind: string; fromHour: number }) => a.kind === 'school' && a.fromHour === 11);
    expect(lunch).toBeDefined();
    expect(lunch.factor).toBeGreaterThan(1.05);
    expect(lunch.evidence).toMatch(/^Lunch in the school holidays here has traded \+\d+% on term time/);
    expect(cal.days[0].school.name).toBe('October half term');
    const run = await call('POST', '/v1/forecast/model', { siteId: 'mar', weekStart: HALF_TERM });
    const booked = run.body.automatic.filter((a: { kind: string; date: string; fromHour: number }) => a.date === HALF_TERM && a.fromHour === 11);
    expect(booked.map((a: { kind: string }) => a.kind)).toEqual(['bookings']);
  });
});

describe('a school-age employee', () => {
  it('cannot be rostered in school hours in half term until the council’s dates are in', async () => {
    const { call } = await setup();
    const person = await call('POST', '/v1/employees', child);
    expect(person.status).toBe(201);
    const shift = { employeeId: person.body.id, roleId: 'host', siteId: 'mar', date: '2026-10-27', startMinute: 11 * 60, endMinute: 15 * 60, breakMinutes: 0 };
    const before = await call('POST', '/v1/shifts', shift);
    expect(before.body.issues.map((i: { code: string }) => i.code)).toContain('child-school-hours');
    await call('POST', '/v1/event-feeds', { siteId: 'mar', kind: 'school', label: 'Council', url: 'https://council.example/terms.ics' });
    await call('POST', '/v1/outside/refresh', { siteIds: ['mar'] });
    const after = await call('PATCH', `/v1/shifts/${before.body.shift.id}`, { startMinute: 11 * 60 });
    expect(after.body.issues.filter((i: { severity: string }) => i.severity === 'block')).toEqual([]);
    expect(after.body.issues.map((i: { code: string }) => i.code)).toContain('child-permit');
  });
});
