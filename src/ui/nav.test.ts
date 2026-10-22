import { NAV, NAV_ITEMS } from './nav';

describe('management bar', () => {
  it('lists each section once', () => {
    const ids = NAV_ITEMS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no empty groups', () => {
    for (const g of NAV) expect(g.items.length).toBeGreaterThan(0);
  });

  it('only offers build and clear on week sections', () => {
    for (const t of NAV_ITEMS.filter((t) => t.plans)) expect(t.scope).toBe('week');
  });

  it('never asks for a site on an organisation section', () => {
    for (const t of NAV_ITEMS.filter((t) => t.siteOnly)) expect(t.scope).not.toBe('org');
  });

  it('only gives organisation sections a heading of their own', () => {
    for (const t of NAV_ITEMS.filter((t) => t.title)) expect(t.scope).toBe('org');
  });
});
