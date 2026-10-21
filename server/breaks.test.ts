import { describe, expect, it } from 'vitest';
import { checkBreak } from '../src/engine/breaks';
import type { Employee, TimeEntry } from '../src/engine/types';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';

const adult = { id: 'e1', dateOfBirth: '1990-01-01' } as Employee;
const teen = { id: 'e2', dateOfBirth: '2010-06-01' } as Employee;
const entry = (clockIn: number, clockOut: number, breakMinutes: number, extra: Partial<TimeEntry> = {}): TimeEntry => ({
  id: 't1', employeeId: 'e1', siteId: 'mar', roleId: 'bar', date: '2026-10-21', clockIn, clockOut, breakMinutes,
  status: 'submitted', source: 'clock', ...extra,
});

describe('legal minimum break', () => {
  it('needs 20 minutes over 6 hours of work, counting work without the break itself', () => {
    expect(checkBreak(entry(600, 960, 0), adult)).toBeNull(); // exactly 6h: not over
    expect(checkBreak(entry(600, 961, 0), adult)).toMatchObject({ code: 'short', requiredMinutes: 20, takenMinutes: 0, workedMinutes: 361 });
    expect(checkBreak(entry(600, 970, 20), adult)).toBeNull(); // 6h10 on site, 5h50 worked
    expect(checkBreak(entry(600, 1080, 15), adult)).toMatchObject({ code: 'short', requiredMinutes: 20 });
    expect(checkBreak(entry(600, 1080, 30), adult)).toBeNull();
  });

  it('gives under 18s 30 minutes over 4.5 hours', () => {
    const shift = { ...entry(600, 900, 20), employeeId: 'e2' };
    expect(checkBreak(shift, teen)).toMatchObject({ code: 'short', requiredMinutes: 30, under18: true });
    expect(checkBreak({ ...shift, breakMinutes: 30 }, teen)).toBeNull();
    expect(checkBreak({ ...shift, breakMinutes: 0, clockOut: 870 }, teen)).toBeNull(); // 4.5h exactly
  });

  it('needs the break in one block, using the breaks the person recorded', () => {
    const split = entry(600, 1080, 20, { breaks: [{ start: 720, end: 730 }, { start: 900, end: 910 }] });
    expect(checkBreak(split, adult)).toMatchObject({ code: 'split', takenMinutes: 20, longestMinutes: 10 });
    expect(checkBreak(entry(600, 1080, 25, { breaks: [{ start: 720, end: 745 }] }), adult)).toBeNull();
    // Once a manager has corrected the total, the recorded pieces no longer describe it.
    expect(checkBreak({ ...split, breakMinutes: 30 }, adult)).toBeNull();
  });

  it('only judges finished shifts', () => {
    expect(checkBreak({ ...entry(600, 1080, 0), status: 'open', clockOut: undefined }, adult)).toBeNull();
    expect(checkBreak({ ...entry(600, 1080, 0), status: 'rejected' }, adult)).toBeNull();
    expect(checkBreak({ ...entry(600, 1080, 0), status: 'approved' }, adult)).not.toBeNull();
  });
});

describe('break check in the API', () => {
  it('lists shortfalls, reports and audits them on approval, and never blocks it', async () => {
    const store = new MemoryStore(['demo'], '2026-10-21');
    const { app } = await buildApp({ apiKeys: [{ key: 'gm', orgId: 'demo', name: 'GM', scopes: ['*'] }], store, provider: new TeamPaySimulator(), autoDispatch: false });
    const call = (method: string, url: string, body?: unknown) =>
      app.inject({ method: method as 'GET', url, headers: { authorization: 'Bearer gm', ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined })
        .then((r) => ({ status: r.statusCode, body: r.json() }));
    const manual = (employeeId: string, breakMinutes: number) =>
      call('POST', '/v1/time-entries', { employeeId, siteId: 'mar', roleId: 'bar', date: '2026-10-21', clockIn: 600, clockOut: 1080, breakMinutes });
    const short = (await manual('mar-1', 10)).body;
    await manual('mar-2', 30);

    const check = await call('GET', '/v1/time-entries/break-check?siteId=mar&from=2026-10-19&to=2026-10-25');
    expect(check.body).toEqual([expect.objectContaining({ entryId: short.id, employeeId: 'mar-1', code: 'short', requiredMinutes: 20, takenMinutes: 10 })]);

    const approved = await call('POST', '/v1/time-entries/approve', { siteId: 'mar', from: '2026-10-19', to: '2026-10-25' });
    expect(approved.body).toMatchObject({ approved: 2, belowBreakMinimum: 1 });
    const org = await store.load('demo');
    expect(org.audit.at(-1)).toMatchObject({ action: 'time.approved', detail: { approved: 2, belowBreakMinimum: [short.id] } });
  });
});
