import type { FastifyRequest } from 'fastify';
import type { Employee } from '../src/engine/types';
import { HttpError, notFound, orgOf } from './context';
import type { OrgData } from './store';

/**
 * Site-scoped access: a site manager (or an API key given `siteIds`) works on named sites only.
 *
 * Three layers, so no single forgotten check opens the group up:
 * 1. Allowlist. A scoped caller reaches only the site-level routes below. Payroll, the journal,
 *    company settings, GDPR and user management are group-level and refused, and so is any route
 *    added later until it is listed here.
 * 2. Reads. A GET runs against a copy of the organisation cut down to the caller's sites, so every
 *    read route is filtered without each one having to remember to.
 * 3. Writes. Each write route checks the sites and people it touches with the asserts below.
 */
export const SCOPED_ROUTES = new Set([
  'GET /v1/entities',
  'GET /v1/sites',
  'GET /v1/roles',
  'GET /v1/demand-rules',
  'GET /v1/shifts',
  'POST /v1/shifts',
  'PATCH /v1/shifts/:id',
  'DELETE /v1/shifts/:id',
  'GET /v1/rota/week',
  'PUT /v1/rota/week',
  'POST /v1/rota/build',
  'POST /v1/rota/clear',
  'POST /v1/rota/publish',
  'GET /v1/forecast',
  'PUT /v1/forecast',
  'GET /v1/employees',
  'GET /v1/employees/:id',
  'POST /v1/employees',
  'PATCH /v1/employees/:id',
  'POST /v1/employees/:id/leaver',
  'PUT /v1/employees/:id/badge',
  'DELETE /v1/employees/:id/badge',
  'PUT /v1/sites/:id/geofence',
  'DELETE /v1/sites/:id/geofence',
  'GET /v1/time-entries',
  'POST /v1/time-entries',
  'POST /v1/time-entries/clock-in',
  'POST /v1/time-entries/:id/clock-out',
  'PATCH /v1/time-entries/:id',
  'POST /v1/time-entries/approve',
  'POST /v1/time-entries/tap',
  'GET /v1/time-entries/break-check',
  'GET /v1/time-entries/compare',
  'GET /v1/hr/overview',
  'GET /v1/hr/records',
  'POST /v1/hr/records',
  'PATCH /v1/hr/records/:id',
  'DELETE /v1/hr/records/:id',
  'PUT /v1/employees/:id/hr',
  'POST /v1/employees/:id/absences',
  'PATCH /v1/employees/:id/absences/:absenceId',
  'DELETE /v1/employees/:id/absences/:absenceId',
  'GET /v1/staff-logins',
  'POST /v1/staff-logins/:id/invite',
  'DELETE /v1/staff-logins/:id',
]);

/** The caller's sites, or null when they work across the whole organisation. */
export function siteScope(req: FastifyRequest): Set<string> | null {
  const ids = req.principal?.siteIds;
  return ids ? new Set(ids) : null;
}

const outside = (what: string) => new HttpError(403, 'outside_scope', `${what} is outside the sites you manage`);

/** Refuses unless every site given is one the caller manages. */
export function assertSites(req: FastifyRequest, siteIds: Iterable<string | undefined>) {
  const scope = siteScope(req);
  if (!scope) return;
  for (const id of siteIds) if (!id || !scope.has(id)) throw outside(id ? `Site ${id}` : 'That site');
}

/** Refuses unless the person's home site is one the caller manages. Their personnel file goes with it. */
export function assertHomeSite(req: FastifyRequest, employee: Employee) {
  const scope = siteScope(req);
  if (scope && !scope.has(employee.siteId)) throw outside(employee.name);
}

/** The person by id, for a write the caller may make: their own site's staff only. */
export function scopedEmployee(req: FastifyRequest, id: string): Employee {
  const employee = orgOf(req).state.employees.find((e) => e.id === id);
  if (!employee) throw notFound(`Employee ${id}`);
  assertHomeSite(req, employee);
  return employee;
}

/** Whether a scoped caller may roster this person at this site: their own staff, or someone who has agreed to cover it. */
export function assertRosterable(req: FastifyRequest, employee: Employee | undefined, siteId: string) {
  const scope = siteScope(req);
  if (!scope || !employee) return;
  if (!scope.has(employee.siteId) && !employee.coverSiteIds.includes(siteId)) {
    throw outside(`${employee.name}, who has not agreed to cover this site,`);
  }
}

/**
 * What a scoped caller can read. Their own staff in full; people from other sites who cover theirs,
 * or have worked there, without contact details or personnel file. Those people's shifts elsewhere
 * stay in, because rest breaks, the 48 hour average and on-costs are worked across every site.
 */
export function scopedOrg(org: OrgData, scope: Set<string>): OrgData {
  const { state } = org;
  const home = new Set(state.employees.filter((e) => scope.has(e.siteId)).map((e) => e.id));
  const worked = new Set([
    ...state.shifts.filter((s) => scope.has(s.siteId)).map((s) => s.employeeId),
    ...org.timeEntries.filter((t) => scope.has(t.siteId)).map((t) => t.employeeId),
  ]);
  const visible = state.employees.filter((e) => home.has(e.id) || worked.has(e.id) || e.coverSiteIds.some((id) => scope.has(id)));
  const ids = new Set(visible.map((e) => e.id));
  const sites = state.sites.filter((s) => scope.has(s.id));
  const entityIds = new Set([...sites.map((s) => s.entityId), ...visible.map((e) => e.entityId)]);
  const employees = visible.map((e) => {
    if (home.has(e.id)) return e;
    const { hr: _hr, email: _email, phone: _phone, absences, ...rest } = e;
    return absences ? { ...rest, absences: absences.map(({ id, type, from, to }) => ({ id, type, from, to })) } : rest;
  });
  return {
    ...org,
    state: {
      ...state,
      entities: state.entities.filter((x) => entityIds.has(x.id)),
      sites,
      employees,
      shifts: state.shifts.filter((s) => ids.has(s.employeeId) || scope.has(s.siteId)),
      forecast: state.forecast.filter((f) => scope.has(f.siteId)),
      demandRules: state.demandRules.filter((r) => scope.has(r.siteId)),
    },
    timeEntries: org.timeEntries.filter((t) => scope.has(t.siteId) || home.has(t.employeeId)),
    hrRecords: org.hrRecords.filter((r) => home.has(r.employeeId)),
    submissions: [],
    payRuns: [],
    outbox: [],
    audit: [],
  };
}
