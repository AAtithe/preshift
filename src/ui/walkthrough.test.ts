import { readFileSync } from 'node:fs';
import { NAV_ITEMS } from './nav';
import { currentRelease, isMonday, RELEASES, releaseLabel, releasesOut, stepsFor, type Release } from './walkthrough';

describe("what's new walkthrough", () => {
  it('lists releases newest first, one per week, each on a Monday', () => {
    const weeks = RELEASES.map((r) => r.week);
    for (const w of weeks) expect(isMonday(w)).toBe(true);
    expect(weeks).toEqual([...new Set(weeks)].sort().reverse());
  });

  it('gives every release steps, a test, and steps that open real sections', () => {
    const tabs = new Set(NAV_ITEMS.map((t) => t.id));
    for (const r of RELEASES) {
      expect(r.steps.length).toBeGreaterThan(0);
      expect(r.test.length).toBeGreaterThan(0);
      expect(new Set(r.steps.map((s) => s.title)).size).toBe(r.steps.length);
      for (const s of r.steps) {
        if (s.tab) expect(tabs.has(s.tab)).toBe(true);
        if (s.lens) expect(s.tab).toBe('rota');
      }
    }
  });

  // The README card is written every week; the walkthrough must go out with it.
  it("has a release for the week on the README card", () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    const heading = readme.match(/^## What's new: week of (.+)$/m)?.[1];
    expect(heading).toBeDefined();
    expect(RELEASES.map((r) => releaseLabel(r.week))).toContain(`Week of ${heading}`);
  });

  const sample: Release[] = [
    { week: '2026-11-02', test: 't', steps: [{ for: 'GMs', title: 'Later', body: 'b' }] },
    { week: '2026-10-26', test: 't', steps: [{ for: 'GMs', title: 'Now', body: 'b', tab: 'rota' }, { for: 'Finance', title: 'Cash', body: 'b', tab: 'cash' }, { for: 'Staff', title: 'App', body: 'b' }] },
    { week: '2026-10-19', test: 't', steps: [{ for: 'GMs', title: 'Before', body: 'b' }] },
  ];

  it('holds a release back until its Monday', () => {
    expect(currentRelease('2026-11-01', sample)?.week).toBe('2026-10-26');
    expect(currentRelease('2026-11-02', sample)?.week).toBe('2026-11-02');
    expect(releasesOut('2026-10-27', sample).map((r) => r.week)).toEqual(['2026-10-26', '2026-10-19']);
    expect(currentRelease('2026-10-01', sample)).toBeNull();
  });

  it('shows each person only the steps for sections they are offered', () => {
    const titles = stepsFor(sample[1], (t) => t === 'rota').map((s) => s.title);
    expect(titles).toEqual(['Now', 'App']);
  });

  it('names a release by its week', () => {
    expect(releaseLabel('2026-10-19')).toBe('Week of 19 October 2026');
  });
});
