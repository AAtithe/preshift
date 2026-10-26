// Areas within a site: front of house, back of house, a bakery, a terrace. A site's areas each hold
// the roles that work in them there, so every shift lands in an area without anyone choosing one,
// and a shift worked somewhere else that day says so on the shift itself.

import type { RotaState, Shift, Site, SiteArea } from './types';

/** The area a role works in at a site, if the site is split into areas and the role is placed in one. */
export function roleArea(site: Site | undefined, roleId: string): SiteArea | undefined {
  return site?.areas?.find((a) => a.roleIds.includes(roleId));
}

/**
 * The area a shift is worked in: the one the shift names, while that area is still at its site,
 * otherwise the one its role sits in there. Undefined when the site has no areas, or the role none.
 */
export function shiftArea(state: Pick<RotaState, 'sites'>, shift: Pick<Shift, 'siteId' | 'roleId' | 'areaId'>): SiteArea | undefined {
  const site = state.sites.find((s) => s.id === shift.siteId);
  return (shift.areaId && site?.areas?.find((a) => a.id === shift.areaId)) || roleArea(site, shift.roleId);
}

/** Whether a shift's own area, if it names one, is an area of its site. */
export function areaBelongs(site: Site | undefined, areaId: string | undefined): boolean {
  return !areaId || !!site?.areas?.some((a) => a.id === areaId);
}

/** Problems with a site's areas, in the words set-up shows. */
export function areaProblems(site: Site): string[] {
  const label = site.name.trim() || 'A site';
  const problems: string[] = [];
  const names = new Set<string>();
  const placed = new Set<string>();
  for (const area of site.areas ?? []) {
    const name = area.name.trim().toLowerCase();
    if (!name) problems.push(`${label}: every area needs a name.`);
    else if (names.has(name)) problems.push(`${label}: two areas are called ${area.name.trim()}.`);
    names.add(name);
    for (const roleId of area.roleIds) {
      if (placed.has(roleId)) problems.push(`${label}: a role can sit in one area only.`);
      placed.add(roleId);
    }
  }
  return [...new Set(problems)];
}

/** Starting areas for a site being split for the first time, with each role placed by its department. */
export function suggestedAreas(roles: RotaState['roles'], makeId: () => string): SiteArea[] {
  const front = roles.filter((r) => r.department !== 'BOH').map((r) => r.id);
  const back = roles.filter((r) => r.department === 'BOH').map((r) => r.id);
  return [
    { id: makeId(), name: 'Front of house', roleIds: front },
    { id: makeId(), name: 'Back of house', roleIds: back },
  ];
}
