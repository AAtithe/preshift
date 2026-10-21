import type { Employee, RotaState, Shift } from './types';

/**
 * What a manager may see and change. Absent (null) means the whole organisation: admins, integration
 * keys, and members nobody has restricted yet. A restricted manager runs the sites in `siteIds` and
 * holds the full records of people employed by a company in `entityIds` whose home site is one of
 * those sites. Everyone else they meet is someone covering their sites from elsewhere, and they see
 * only what the staff data sharing agreement allows for cover.
 */
export interface AccessScope {
  siteIds: string[];
  entityIds: string[];
}

/** How much of a person's record a manager reaches. */
export type Reach = 'full' | 'cover' | 'none';

export function seesSite(scope: AccessScope | null, siteId: string): boolean {
  return !scope || scope.siteIds.includes(siteId);
}

export function reachOf(scope: AccessScope | null, e: Employee, shifts: Shift[]): Reach {
  if (!scope) return 'full';
  if (scope.entityIds.includes(e.entityId) && scope.siteIds.includes(e.siteId)) return 'full';
  const covers =
    e.coverSiteIds.some((id) => scope.siteIds.includes(id)) ||
    scope.siteIds.includes(e.siteId) ||
    shifts.some((s) => s.employeeId === e.id && scope.siteIds.includes(s.siteId));
  return covers ? 'cover' : 'none';
}

/**
 * The record a host site's manager sees for someone covering from another company or site: what
 * rostering, the working time checks and costing need, and nothing else. No contact details, right
 * to work, holiday record, payroll link, card, HR file or absence reasons.
 *
 * The date of birth becomes 31 December of the birth year. That shows the person as up to a year
 * younger than they are, never older, so young worker limits and break rules are applied at least as
 * strictly as the real date would. Minimum wage stays the employer's check, on the real date.
 */
export function coverView(e: Employee): Employee {
  return {
    id: e.id,
    name: e.name,
    siteId: e.siteId,
    entityId: e.entityId,
    coverSiteIds: e.coverSiteIds,
    roleIds: e.roleIds,
    payBasis: e.payBasis,
    hourlyRate: e.hourlyRate,
    annualSalary: e.annualSalary,
    dateOfBirth: e.dateOfBirth ? `${e.dateOfBirth.slice(0, 4)}-12-31` : '',
    contractedHours: e.contractedHours,
    maxWeeklyHours: e.maxWeeklyHours,
    optedOutOf48: e.optedOutOf48,
    irregularHours: e.irregularHours,
    pensionEnrolled: e.pensionEnrolled,
    availability: e.availability,
    leave: e.leave,
    ...(e.startDate ? { startDate: e.startDate } : {}),
    ...(e.status ? { status: e.status } : {}),
    ...(e.leaveDate ? { leaveDate: e.leaveDate } : {}),
    // Days off only: why someone is absent (sickness above all) stays with their employer.
    ...(e.absences?.length ? { absences: e.absences.map(({ id, from, to }) => ({ id, type: 'other' as const, from, to })) } : {}),
    restricted: true,
  };
}

/** Why a scope cannot be saved, or null. */
export function scopeProblem(scope: AccessScope, state: Pick<RotaState, 'sites' | 'entities'>): string | null {
  if (scope.siteIds.length === 0) return 'Choose at least one site.';
  if (scope.entityIds.length === 0) return 'Choose at least one employing company.';
  const site = scope.siteIds.find((id) => !state.sites.some((s) => s.id === id));
  if (site) return `There is no site ${site}.`;
  const entity = scope.entityIds.find((id) => !state.entities.some((x) => x.id === id));
  if (entity) return `There is no company ${entity}.`;
  return null;
}

/** The companies whose staff a manager of these sites would normally hold: the ones the sites trade in. */
export function defaultEntities(siteIds: string[], state: Pick<RotaState, 'sites'>): string[] {
  return [...new Set(state.sites.filter((s) => siteIds.includes(s.id)).map((s) => s.entityId))];
}
