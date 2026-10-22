import { describe, expect, it } from 'vitest';
import { autoScheduleSites } from './autoschedule';
import { seedState } from './seed';
import {
  applySetup,
  draftFromState,
  emptyDraft,
  forecastForWeek,
  missingForecast,
  parseTeamPaste,
  pasteWarnings,
  reforecast,
  removalBlocks,
  validateSetup,
  type SetupDraft,
} from './setup';
import { addDays, weekDates } from './time';
import type { RotaState } from './types';

const TODAY = '2026-10-21';
const WEEK = '2026-10-19';
const EMPTY: RotaState = { entities: [], sites: [], roles: [], employees: [], shifts: [], forecast: [], demandRules: [] };

function ready(): SetupDraft {
  const d = emptyDraft();
  d.entities[0] = { ...d.entities[0], name: 'Clerkenwell Kitchen Ltd', companyNumber: '12345678', payeReference: '120/CK12345' };
  d.sites[0] = { ...d.sites[0], name: 'Clerkenwell', salesProfile: { dailySales: [3000, 3000, 3500, 4000, 6000, 7000, 4500], averageSpend: 40 } };
  return d;
}

describe('forecast from a typical week', () => {
  it('ties each day back to the pound, only in open hours, marked as a profile row', () => {
    const site = ready().sites[0];
    const rows = forecastForWeek(site, WEEK);
    weekDates(WEEK).forEach((date, day) => {
      const dayRows = rows.filter((r) => r.date === date);
      expect(dayRows.reduce((s, r) => s + r.sales, 0)).toBe(site.salesProfile!.dailySales[day]);
      expect(dayRows.every((r) => r.hour >= 12 && r.hour < 23 && r.source === 'profile')).toBe(true);
    });
  });

  it('never replaces a week a sales system has sent, and keeps the past', () => {
    const site = ready().sites[0];
    const sent = { siteId: site.id, date: addDays(WEEK, 7), hour: 13, sales: 999, covers: 20 };
    const oldProfile = { siteId: site.id, date: addDays(WEEK, -7), hour: 13, sales: 1, covers: 0, source: 'profile' as const };
    const next = reforecast([sent, oldProfile], [site], TODAY);
    expect(next).toContainEqual(sent);
    expect(next).toContainEqual(oldProfile);
    expect(next.filter((f) => weekDates(addDays(WEEK, 7)).includes(f.date))).toEqual([sent]);
    expect(next.some((f) => f.date === WEEK && f.source === 'profile')).toBe(true);
  });

  it('fills a week with no forecast at all, and only that', () => {
    const state = applySetup(EMPTY, ready(), TODAY);
    expect(missingForecast(state, [state.sites[0].id], WEEK)).toEqual([]);
    expect(missingForecast(state, [state.sites[0].id], addDays(WEEK, 7 * 20)).length).toBeGreaterThan(0);
  });
});

describe('validation', () => {
  it('asks each company with more than one site to choose how travel between sites is paid', () => {
    const one = ready();
    const travel = (d: SetupDraft) => validateSetup(d).filter((i) => i.message.includes('travel between sites is paid'));
    expect(travel(one)).toEqual([]);
    const two = { ...one, sites: [...one.sites, { ...one.sites[0], id: 'second', name: 'Farringdon' }] };
    expect(travel(two)).toEqual([expect.objectContaining({ severity: 'warn' })]);
    const chosen = { ...two, entities: two.entities.map((e) => ({ ...e, travelPay: { basis: 'normal' as const } })) };
    expect(travel(chosen)).toEqual([]);
  });

  it('passes a complete set-up and will not pass a blank trading week', () => {
    expect(validateSetup(ready()).filter((i) => i.severity === 'block')).toEqual([]);
    const blank = validateSetup(emptyDraft()).map((i) => i.message);
    expect(blank.some((m) => m.includes('typical net sales'))).toBe(true);
    expect(blank.some((m) => m.includes('registered name'))).toBe(true);
  });

  it('needs distinct intercompany codes once there are two companies', () => {
    const d = ready();
    d.entities.push({ ...d.entities[0], id: 'co_two', name: 'Second Ltd' });
    expect(validateSetup(d).some((i) => i.message.includes('intercompany balance code'))).toBe(true);
    d.entities[0].intercompanyCode = '1351';
    d.entities[1].intercompanyCode = '1351';
    expect(validateSetup(d).some((i) => i.message.includes('used by two companies'))).toBe(true);
  });
});

describe('removing what is in use', () => {
  it('refuses to drop a site, company or role that people, shifts or clocked time still use', () => {
    const seeded = seedState(TODAY);
    const state = { ...seeded, shifts: autoScheduleSites(seeded, ['mar'], WEEK).shifts };
    const draft = draftFromState(state);
    expect(removalBlocks(state, draft)).toEqual([]);
    const without = { ...draft, sites: draft.sites.filter((s) => s.id !== 'mar'), roles: draft.roles.filter((r) => r.id !== 'kp') };
    const reasons = removalBlocks(state, without);
    expect(reasons.some((r) => r.startsWith('Marylebone is home or cover site'))).toBe(true);
    expect(reasons.some((r) => r.startsWith('Kitchen Porter is held by'))).toBe(true);
  });

  it('allows removing a role nobody holds and nothing used', () => {
    const state = seedState(TODAY);
    const draft = draftFromState(state);
    draft.roles.push({ id: 'somm', name: 'Sommelier', department: 'BAR', nominalCode: '7002' });
    const withSomm = applySetup(state, draft, TODAY);
    expect(removalBlocks(withSomm, draftFromState(state))).toEqual([]);
  });
});

describe('applying set-up', () => {
  it('produces a state the auto-build can roster once people exist', () => {
    const state = applySetup(EMPTY, ready(), TODAY);
    expect(state.sites[0].trackingCode).toBe('Clerkenwell');
    expect(state.forecast.length).toBeGreaterThan(0);
    expect(state.demandRules.length).toBe(5);
  });
});

describe('team paste', () => {
  const roles = emptyDraft().roles;

  it('reads tab or comma rows, salaries and UK dates', () => {
    const text = 'Name,Roles,Pay,DOB,Hours\nAlex Doe,Server/Host,13.25,01/02/1999,32\nPat Lee\tGeneral Manager\t£48,000\t1985-06-30\t45';
    const { people, errors } = parseTeamPaste(text, roles);
    expect(errors).toEqual([]);
    expect(people[0].person).toMatchObject({ name: 'Alex Doe', roleIds: ['server', 'host'], hourlyRate: 13.25, dateOfBirth: '1999-02-01', contractedHours: 32 });
    expect(people[1].person).toMatchObject({ payBasis: 'salaried', annualSalary: 48000, roleIds: ['gm'] });
    expect(people[0].person.startDate).toBeUndefined();
    expect(parseTeamPaste('Sam,Chef,15,01/01/1990,40,03/11/2026', roles).people[0].person.startDate).toBe('2026-11-03');
    expect(people[0].person.rightToWork).toEqual({ checked: false });
    expect(parseTeamPaste('Sam,Chef,15,01/01/1990,40,,12/05/2024', roles).people[0].person).toMatchObject({ rightToWork: { checked: true, checkedOn: '2024-05-12' } });
  });

  it('holds back rows with problems instead of adding half a record', () => {
    const { people, errors } = parseTeamPaste('Alex,Sommelier,13,31/02/1999,0\nSam,Chef,15,01/01/1990,40', roles);
    expect(people.map((p) => p.person.name)).toEqual(['Sam']);
    expect(errors).toHaveLength(2);
  });

  it('warns on pay below the minimum wage band', () => {
    const { people } = parseTeamPaste('Zara,Bartender,12.50,17/02/1998,0', roles);
    expect(pasteWarnings(people, TODAY)[0]).toMatch(/below the National Living Wage/);
  });
});
