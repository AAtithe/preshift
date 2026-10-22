import type { RotaState } from '../src/engine/types';

export type MemberRole = 'owner' | 'finance' | 'gm' | 'troncmaster' | 'staff';

export interface Membership {
  role: MemberRole;
  /** Null for every site in the organisation. */
  siteIds: string[] | null;
  employeeId: string | null;
}

export type Permission =
  | 'rota.edit'
  | 'rota.publish'
  | 'clock.self'
  | 'clock.others'
  | 'clock.approve'
  | 'cut.apply'
  | 'tronc.edit'
  | 'tronc.policy'
  | 'tips.markPaid'
  | 'org.invite'
  | 'org.seedDemo'
  | 'view.all';

/**
 * What each role may do. Two choices worth knowing:
 * - Only a troncmaster sets the allocation (points and department split). The
 *   owner cannot, because an allocation the business decides is not
 *   independent and loses the NI exemption. The owner keeps the business's
 *   own decisions: the service charge, who the troncmaster is, the policy
 *   dates. The product enforces what the policy claims.
 * - Finance approves clockings and pays tips but cannot touch the rota: the
 *   people who sign off labour cost are not the people who create it.
 */
const GRANTS: Record<MemberRole, Permission[]> = {
  owner: ['rota.edit', 'rota.publish', 'clock.self', 'clock.others', 'clock.approve', 'cut.apply', 'tronc.policy', 'tips.markPaid', 'org.invite', 'org.seedDemo', 'view.all'],
  finance: ['clock.approve', 'tips.markPaid', 'view.all'],
  gm: ['rota.edit', 'rota.publish', 'clock.self', 'clock.others', 'clock.approve', 'cut.apply', 'view.all'],
  troncmaster: ['tronc.edit', 'clock.self'],
  staff: ['clock.self'],
};

export function can(m: Membership, permission: Permission, siteId?: string): boolean {
  if (!GRANTS[m.role].includes(permission)) return false;
  return siteId === undefined || m.siteIds === null || m.siteIds.includes(siteId);
}

export function permissionsFor(m: Membership): Permission[] {
  return GRANTS[m.role];
}

/**
 * The slice of the organisation's state a member may see. Managers and
 * finance see their sites in full. Staff and troncmasters see their sites'
 * shape and their own record; a troncmaster also sees who worked and the
 * tips, which the allocation needs, but never anyone's pay.
 */
export function visibleState(state: RotaState, m: Membership): RotaState {
  const inScope = (siteId: string) => m.siteIds === null || m.siteIds.includes(siteId);
  const sites = state.sites.filter((s) => inScope(s.id));
  const bySite = <T extends { siteId: string }>(rows: T[]) => rows.filter((r) => inScope(r.siteId));
  const scoped: RotaState = {
    ...state,
    sites,
    employees: state.employees.filter(
      (e) => inScope(e.siteId) || state.shifts.some((s) => s.employeeId === e.id && inScope(s.siteId)),
    ),
    shifts: bySite(state.shifts),
    clocks: bySite(state.clocks),
    forecast: bySite(state.forecast),
    actuals: bySite(state.actuals),
    demandRules: bySite(state.demandRules),
    tips: bySite(state.tips),
    troncSchemes: bySite(state.troncSchemes),
    dishes: bySite(state.dishes),
    dishSales: bySite(state.dishSales),
    purchases: bySite(state.purchases),
    stockCounts: bySite(state.stockCounts),
  };
  if (can(m, 'view.all')) return scoped;

  const own = (employeeId: string) => employeeId === m.employeeId;
  const redact = <T extends { hourlyRate: number; annualSalary: number }>(e: T): T => ({ ...e, hourlyRate: 0, annualSalary: 0 });
  const empty = { forecast: [], actuals: [], demandRules: [], dishes: [], dishSales: [], purchases: [], stockCounts: [] };
  if (m.role === 'troncmaster') {
    return {
      ...scoped,
      ...empty,
      employees: scoped.employees.map((e) => (own(e.id) ? e : redact(e))),
      shifts: scoped.shifts.filter((s) => own(s.employeeId)),
    };
  }
  return {
    ...scoped,
    ...empty,
    employees: scoped.employees.filter((e) => own(e.id)),
    shifts: scoped.shifts.filter((s) => own(s.employeeId) && s.published),
    clocks: scoped.clocks.filter((c) => own(c.employeeId)),
    tips: [],
    troncSchemes: [],
  };
}
