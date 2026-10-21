import type { FastifyReply, FastifyRequest } from 'fastify';
import { coverView, reachOf, seesSite, type AccessScope, type Reach } from '../src/engine/access';
import type { Employee } from '../src/engine/types';
import { HttpError, notFound } from './context';
import type { OrgData } from './store';

/**
 * Manager access by employing company and site, enforced on the server for every route that reads
 * or changes staff data. The web app only ever receives what the scope allows, so the browser's own
 * engine works on the same limited picture and cannot leak the rest.
 */

/** The caller's scope, or null for the whole organisation. Admins and integration keys are never scoped. */
export function scopeOf(req: FastifyRequest): AccessScope | null {
  const user = req.principal?.user;
  if (!user || user.role === 'admin') return null;
  return user.access ?? null;
}

export const reach = (req: FastifyRequest, org: OrgData, e: Employee): Reach => reachOf(scopeOf(req), e, org.state.shifts);

/** People as this caller may see them: full records, cover records, or not at all. */
export function visibleEmployees(req: FastifyRequest, org: OrgData, view: (e: Employee) => Employee): Employee[] {
  const scope = scopeOf(req);
  if (!scope) return org.state.employees.map(view);
  return org.state.employees.flatMap((e) => {
    const r = reachOf(scope, e, org.state.shifts);
    return r === 'full' ? [view(e)] : r === 'cover' ? [coverView(e)] : [];
  });
}

/** One person as this caller may see them; not found when out of reach, so ids cannot be probed. */
export function visibleEmployee(req: FastifyRequest, org: OrgData, e: Employee, view: (e: Employee) => Employee): Employee {
  const r = reach(req, org, e);
  if (r === 'none') throw notFound(`Employee ${e.id}`);
  return r === 'full' ? view(e) : coverView(e);
}

/** The person, for a change that needs their full record (personnel details, card, login, leaving). */
export function fullEmployee(req: FastifyRequest, org: OrgData, id: string): Employee {
  const e = org.state.employees.find((x) => x.id === id);
  const r = e ? reach(req, org, e) : 'none';
  if (!e || r === 'none') throw notFound(`Employee ${id}`);
  if (r === 'cover') {
    throw new HttpError(403, 'out_of_scope', `${e.name} is employed outside your companies and sites. Their employer manages their record.`);
  }
  return e;
}

/** For rostering and clocking: anyone this caller can see, cover included. */
export function rosterableEmployee(req: FastifyRequest, org: OrgData, id: string): Employee {
  const e = org.state.employees.find((x) => x.id === id);
  if (!e || reach(req, org, e) === 'none') throw notFound(`Employee ${id}`);
  return e;
}

export function canSeeSite(req: FastifyRequest, siteId: string): boolean {
  return seesSite(scopeOf(req), siteId);
}

export function requireSiteAccess(req: FastifyRequest, ...siteIds: string[]) {
  const missing = siteIds.filter((id) => !canSeeSite(req, id));
  if (missing.length) throw new HttpError(403, 'out_of_scope', `You do not manage ${missing.length === 1 ? 'that site' : 'those sites'}.`);
}

/**
 * Whether a record tied to a site and a person is visible: always at the caller's own sites. Elsewhere,
 * a shift is visible for anyone they can see, since rest and weekly limits run across every site;
 * a time entry (clock times, locations) only for people they hold in full.
 */
export function seesRecord(req: FastifyRequest, org: OrgData, x: { siteId: string; employeeId: string }, kind: 'shift' | 'entry'): boolean {
  const scope = scopeOf(req);
  if (!scope || scope.siteIds.includes(x.siteId)) return true;
  const e = org.state.employees.find((p) => p.id === x.employeeId);
  const r = e ? reachOf(scope, e, org.state.shifts) : 'none';
  return kind === 'shift' ? r !== 'none' : r === 'full';
}

/** Payroll, the journal and group-wide settings are head office work: refused to restricted managers. */
export async function requireWholeOrg(req: FastifyRequest, reply: FastifyReply) {
  if (scopeOf(req)) {
    return reply.code(403).send({ error: 'out_of_scope', message: 'This is for people with access to the whole organisation.' });
  }
}
