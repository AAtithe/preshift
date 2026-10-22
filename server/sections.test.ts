import { describe, expect, it } from 'vitest';
import type { User } from '../src/engine/access';
import type { Employee, Entity } from '../src/engine/types';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore, type PayrollSubmission } from './store';

// What the API hands people whose roles reach only part of the business. Hiding a section in the
// bar is a courtesy; these are the controls behind it.

const TODAY = '2026-10-21';
const person = (key: string, userId: string) => ({ key, orgId: 'demo', name: `${key} key`, scopes: ['*' as const], userId, mfa: true });

function siteRole(id: string, roleId: string, siteIds: string[]): User {
  return {
    id, email: `${id}@example.com`, name: id, audience: 'operator', status: 'active', mfaEnrolled: true, createdAt: TODAY,
    memberships: [{ id: `${id}-m`, roleId, siteIds, starts: '2026-01-01', active: true, grantedBy: 'test', grantedAt: TODAY }],
  };
}

const submission = (id: string, entityId: string): PayrollSubmission => ({
  id, periodStart: '2026-10-12', periodEnd: '2026-10-18', version: 1, status: 'sent', totalHours: 100, lineCount: 10,
  createdAt: `${TODAY}T09:00:00.000Z`, createdBy: 'test', accrued: { someone: 500 }, entityId,
});

async function setup() {
  const store = new MemoryStore(['demo'], TODAY);
  const org = await store.load('demo');
  // An area manager over the West End company's two sites, and a GM at Fitzrovia only.
  org.users.push(siteRole('usr_area_we', 'area_manager', ['mar', 'fitz']), siteRole('usr_gm_fitz', 'general_manager', ['fitz']));
  org.submissions.push(submission('sub-we', 'wdl'), submission('sub-eck', 'eck'));
  const keys = [
    { key: 'system', orgId: 'demo', name: 'System', scopes: ['*' as const] },
    person('area', 'usr_area_we'),
    person('gmfitz', 'usr_gm_fitz'),
    person('grace', 'usr_sup'),
    person('leah', 'usr_ws_ma'),
  ];
  const { app } = await buildApp({ apiKeys: keys, store, provider: new TeamPaySimulator(), autoDispatch: false });
  return async (url: string, key: string) => {
    const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });
    return { status: res.statusCode, body: res.json() };
  };
}

describe('payroll for part of the business', () => {
  it('shows a company payroll only to someone who holds payroll at every one of its sites', async () => {
    const get = await setup();
    const ids = (r: { body: PayrollSubmission[] }) => r.body.map((s) => s.id).sort();
    expect(ids(await get('/v1/payroll/submissions', 'system'))).toEqual(['sub-eck', 'sub-we']);
    expect(ids(await get('/v1/payroll/submissions', 'area'))).toEqual(['sub-we']);
  });

  it('keeps the outbox, which spans every company, to those who read every company', async () => {
    const get = await setup();
    expect((await get('/v1/integrations/payroll/outbox', 'area')).body).toEqual([]);
    const status = (await get('/v1/integrations/payroll', 'area')).body as { employers: { entityId: string }[] };
    expect(status.employers.map((e) => e.entityId)).toEqual(['wdl']);
  });
});

describe('people someone only covers for', () => {
  it('costs their shifts at the site they cover, but keeps their personal details at home', async () => {
    const get = await setup();
    const all = (await get('/v1/employees', 'system')).body as Employee[];
    const coverer = all.find((e) => e.siteId === 'mar' && e.coverSiteIds.includes('fitz') && e.dateOfBirth < '2007-01-01')!;
    const seen = ((await get('/v1/employees', 'gmfitz')).body as Employee[]).find((e) => e.id === coverer.id)!;
    expect(seen.hourlyRate).toBe(coverer.hourlyRate);
    expect(seen.personalHidden).toBe(true);
    expect(seen.dateOfBirth).toBe('');
    expect(seen.badgeId).toBeUndefined();
  });
});

describe('companies', () => {
  it('lists only the companies whose sites a person can see, without their registration', async () => {
    const get = await setup();
    const forGrace = (await get('/v1/entities', 'grace')).body as Entity[];
    expect(forGrace.map((e) => e.id)).toEqual(['wdl']);
    expect(forGrace[0]).toMatchObject({ companyNumber: '', payeReference: '', intercompanyCode: '' });
    expect(forGrace[0].employmentAllowance).toBeUndefined();
  });

  it('gives the registration to those who run payroll or the close', async () => {
    const get = await setup();
    const forLeah = (await get('/v1/entities', 'leah')).body as Entity[];
    expect(forLeah).toHaveLength(2);
    expect(forLeah.every((e) => e.payeReference)).toBe(true);
  });
});
