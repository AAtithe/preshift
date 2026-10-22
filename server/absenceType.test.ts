import { describe, expect, it } from 'vitest';
import { isAbsentOn } from '../src/engine/hr';
import type { Employee } from '../src/engine/types';
import { kit } from './testkit';

// Whether someone was off sick is health data. Before these tests every reader of the rota saw each
// colleague's absences typed: a supervisor read four spells of "sickness" for one of her team.
const KEYS = [
  { key: 'grace', orgId: 'demo', name: 'Grace', scopes: ['*'] as ['*'], userId: 'usr_sup' }, // supervisor
  { key: 'marco', orgId: 'demo', name: 'Marco', scopes: ['*'] as ['*'], userId: 'usr_chef' }, // head chef: rota and cost, no HR
  { key: 'nadia', orgId: 'demo', name: 'Nadia', scopes: ['*'] as ['*'], userId: 'usr_fd', mfa: true }, // finance director
  { key: 'priya', orgId: 'demo', name: 'Priya', scopes: ['*'] as ['*'], userId: 'usr_gm_mar' }, // GM: reads HR files
];
const SICK = { type: 'sickness', from: '2026-10-21', to: '2026-10-22', reason: 'Migraine' };

async function aisha(key: string) {
  const k = await kit({ keys: KEYS });
  const org = await k.store.load('demo');
  org.users.find((u) => u.id === 'usr_fd')!.mfaEnrolled = true;
  await k.store.save(org);
  expect((await k.call('POST', '/v1/employees/mar-3/absences', { key: 'priya' }, SICK)).status).toBe(201);
  return (await k.call('GET', '/v1/employees/mar-3', { key })).body as Employee;
}

describe('the type of an absence', () => {
  it('is withheld from those who only run the floor or the rota: they get the days', async () => {
    for (const key of ['grace', 'marco']) {
      const e = await aisha(key);
      expect(e.absences!.length).toBeGreaterThan(0);
      for (const a of e.absences!) expect(Object.keys(a).sort()).toEqual(['from', 'id', 'to']);
      // The rota still knows she is off.
      expect(isAbsentOn(e, '2026-10-21')).toBe(true);
    }
  });

  it('goes to those who run pay, as sick pay turns on it, without the reason', async () => {
    const e = await aisha('nadia');
    expect(e.absences!.find((a) => a.from === '2026-10-21')).toEqual({ id: expect.any(String), type: 'sickness', from: '2026-10-21', to: '2026-10-22' });
  });

  it('stays in full with those who read the HR file', async () => {
    const e = await aisha('priya');
    expect(e.absences!.find((a) => a.from === '2026-10-21')).toMatchObject({ type: 'sickness', reason: 'Migraine' });
  });
});
