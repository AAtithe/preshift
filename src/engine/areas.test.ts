import { describe, expect, it } from 'vitest';
import { roleArea, shiftArea, suggestedAreas } from './areas';
import { autoScheduleSites } from './autoschedule';
import { labourByArea, labourByRole } from './reports';
import { seedState } from './seed';
import { applySetup, draftFromState, validateSetup } from './setup';
import type { RotaState, SiteArea } from './types';

const WEEK = '2026-10-19'; // a Monday
const all = ['mar', 'fitz', 'shd'];
const base = seedState('2026-10-21');

// Marylebone split three ways: the floor and bar, the kitchen, and a bakery where the kitchen porter works.
const AREAS: SiteArea[] = [
  { id: 'foh', name: 'Front of house', roleIds: ['server', 'host', 'bar', 'gm'] },
  { id: 'boh', name: 'Back of house', roleIds: ['chef'] },
  { id: 'bakery', name: 'Bakery', roleIds: ['kp'] },
];
const split = (state: RotaState): RotaState => ({ ...state, sites: state.sites.map((s) => (s.id === 'mar' ? { ...s, areas: AREAS } : s)) });
const state = split({ ...base, shifts: autoScheduleSites(base, all, WEEK).shifts });
const mar = state.sites.find((s) => s.id === 'mar')!;

describe('site areas', () => {
  it('places a shift in its role’s area, or in the area the shift names', () => {
    const chef = state.shifts.find((s) => s.siteId === 'mar' && s.roleId === 'chef')!;
    expect(shiftArea(state, chef)?.name).toBe('Back of house');
    expect(shiftArea(state, { ...chef, areaId: 'bakery' })?.name).toBe('Bakery');
    // An area that is not at the shift's site is ignored, and a site with no areas has none.
    expect(shiftArea(state, { ...chef, areaId: 'nowhere' })?.name).toBe('Back of house');
    expect(shiftArea(state, { ...chef, siteId: 'fitz' })).toBeUndefined();
    expect(roleArea(mar, 'kp')?.name).toBe('Bakery');
  });

  it('splits a site’s labour by area to the same total as the split by role', () => {
    const byArea = labourByArea(state, ['mar'], WEEK);
    const byRole = labourByRole(state, ['mar'], WEEK);
    expect(byArea.total).toBeCloseTo(byRole.total, 1);
    expect(byArea.areas.map((a) => a.areaId)).toEqual(['foh', 'boh', 'bakery']);
    for (const a of byArea.areas) expect(a.roles.reduce((t, r) => t + r.total, 0)).toBeCloseTo(a.total, 1);
    expect(byArea.areas.find((a) => a.areaId === 'boh')!.roles.map((r) => r.roleId)).toEqual(['chef']);
  });

  it('moves a shift’s cost to the area it was worked in', () => {
    const chef = state.shifts.find((s) => s.siteId === 'mar' && s.roleId === 'chef')!;
    const before = labourByArea(state, ['mar'], WEEK);
    const after = labourByArea({ ...state, shifts: state.shifts.map((s) => (s.id === chef.id ? { ...s, areaId: 'bakery' } : s)) }, ['mar'], WEEK);
    const area = (r: typeof before, id: string) => r.areas.find((a) => a.areaId === id)!.total;
    expect(area(after, 'bakery')).toBeGreaterThan(area(before, 'bakery'));
    expect(area(after, 'boh')).toBeLessThan(area(before, 'boh'));
    expect(after.total).toBeCloseTo(before.total, 1);
  });

  it('keeps sites with no areas whole, and labour in no area last', () => {
    const unplaced = { ...state, sites: state.sites.map((s) => (s.id === 'mar' ? { ...s, areas: AREAS.map((a) => (a.id === 'bakery' ? { ...a, roleIds: [] } : a)) } : s)) };
    const report = labourByArea(unplaced, ['mar', 'fitz'], WEEK);
    const keys = report.areas.map((a) => `${a.siteId}:${a.areaId}`);
    expect(keys.slice(0, 2)).toEqual(['mar:foh', 'mar:boh']);
    expect(keys).toContain('mar:null');
    expect(keys.indexOf('mar:null')).toBeLessThan(keys.indexOf('fitz:null'));
    expect(report.areas.filter((a) => a.siteId === 'fitz').map((a) => a.areaId)).toEqual([null]);
    expect(report.total).toBeCloseTo(labourByRole(unplaced, ['mar', 'fitz'], WEEK).total, 1);
  });
});

describe('the sample group', () => {
  it('has Marylebone split into areas, with every role placed, so the demo shows labour by area', () => {
    const sample = base.sites.find((s) => s.id === 'mar')!;
    expect(sample.areas?.map((a) => a.name)).toEqual(['Front of house', 'Bar', 'Back of house']);
    for (const role of base.roles) expect(roleArea(sample, role.id)).toBeDefined();
    expect(validateSetup(draftFromState(base)).filter((i) => i.severity === 'block')).toEqual([]);
  });
});

describe('site areas in set-up', () => {
  it('blocks unnamed or duplicate areas and a role placed twice', () => {
    const draft = draftFromState(state);
    const bad = (areas: SiteArea[]) => validateSetup({ ...draft, sites: draft.sites.map((s) => (s.id === 'mar' ? { ...s, areas } : s)) }).filter((i) => i.severity === 'block').map((i) => i.message);
    expect(bad(AREAS)).toEqual([]);
    expect(bad([...AREAS, { id: 'x', name: ' ', roleIds: [] }])).toContain('Marylebone: every area needs a name.');
    expect(bad([...AREAS, { id: 'x', name: 'bakery', roleIds: [] }])).toContain('Marylebone: two areas are called bakery.');
    expect(bad([...AREAS, { id: 'x', name: 'Terrace', roleIds: ['chef'] }])).toContain('Marylebone: a role can sit in one area only.');
  });

  it('suggests front and back of house from each role’s department', () => {
    let n = 0;
    const [front, back] = suggestedAreas(base.roles, () => `a${n++}`);
    expect(back.roleIds.sort()).toEqual(['chef', 'kp']);
    expect(front.roleIds).toContain('server');
    expect(front.roleIds).not.toContain('chef');
  });

  it('returns a shift to its role’s area when the area it named is removed', () => {
    const chef = state.shifts.find((s) => s.siteId === 'mar' && s.roleId === 'chef')!;
    const placed = { ...state, shifts: state.shifts.map((s) => (s.id === chef.id ? { ...s, areaId: 'bakery' } : s)) };
    const draft = draftFromState(placed);
    const without = { ...draft, sites: draft.sites.map((s) => (s.id === 'mar' ? { ...s, areas: AREAS.filter((a) => a.id !== 'bakery') } : s)) };
    const next = applySetup(placed, without, '2026-10-21');
    expect(next.shifts.find((s) => s.id === chef.id)!.areaId).toBeUndefined();
    // Removing every area leaves the site with none at all.
    const none = applySetup(placed, { ...draft, sites: draft.sites.map((s) => (s.id === 'mar' ? { ...s, areas: [] } : s)) }, '2026-10-21');
    expect(none.sites.find((s) => s.id === 'mar')!.areas).toBeUndefined();
  });
});
