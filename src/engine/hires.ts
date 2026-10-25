import type { Role, Site } from './types';

// New hires handed over by a recruitment system (Talent Funnel, or any applicant tracking system that
// can send a webhook). The candidate's details arrive once, already typed by the applicant, and wait
// for a manager at the site to check them and add the starter: nothing reaches payroll unchecked.

export type HireSource = 'talent_funnel' | 'other';

export interface Hire {
  id: string;
  source: HireSource;
  /** The recruitment system's own id for the candidate, so a resent hire updates rather than doubles. */
  externalId: string;
  name: string;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  /** Matched from the site the candidate was hired for, when it could be. */
  siteId?: string;
  /** What the recruitment system called the site, kept so a manager can see why it was not matched. */
  siteGiven?: string;
  roleId?: string;
  roleGiven?: string;
  startDate?: string;
  /** The rate in the offer, in pounds an hour, when the system sent one. */
  hourlyRate?: number;
  receivedAt: string;
  status: 'waiting' | 'added' | 'dismissed';
  employeeId?: string;
  decidedBy?: string;
  decidedAt?: string;
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const date = (v: unknown) => {
  const t = text(v).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : undefined;
};
const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** The first field present, by any of the names recruitment systems use for it. */
function pick(o: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) if (o[n] !== undefined && o[n] !== null && o[n] !== '') return o[n];
  return undefined;
}

/**
 * Reads a hired candidate from a recruitment system's webhook body. Accepts the candidate at the top
 * level or under `candidate`, with snake or camel case names. The site is matched by its id, name or
 * tracking code, and the role by id or name; a miss is kept as given for the manager to choose.
 */
export function readHire(body: unknown, sites: Pick<Site, 'id' | 'name' | 'trackingCode'>[], roles: Pick<Role, 'id' | 'name'>[]): { hire: Omit<Hire, 'id' | 'source' | 'receivedAt' | 'status'> | null; problem?: string } {
  if (!body || typeof body !== 'object') return { hire: null, problem: 'The body is not a JSON object.' };
  const outer = body as Record<string, unknown>;
  const c = (typeof outer.candidate === 'object' && outer.candidate ? outer.candidate : outer) as Record<string, unknown>;
  const externalId = text(pick(c, 'id', 'candidate_id', 'candidateId', 'applicant_id', 'applicantId'));
  if (!externalId) return { hire: null, problem: 'The candidate has no id.' };
  const name = text(pick(c, 'name', 'full_name', 'fullName')) || [text(pick(c, 'first_name', 'firstName', 'forename')), text(pick(c, 'last_name', 'lastName', 'surname'))].filter(Boolean).join(' ');
  if (!name) return { hire: null, problem: 'The candidate has no name.' };
  const siteGiven = text(pick(c, 'site_id', 'siteId', 'site', 'location', 'venue', 'site_name', 'location_name') ?? pick(outer, 'site', 'location'));
  const roleGiven = text(pick(c, 'role_id', 'roleId', 'role', 'job_title', 'jobTitle', 'position', 'job') ?? pick(outer, 'role', 'job_title'));
  const site = siteGiven ? sites.find((s) => s.id === siteGiven || fold(s.name) === fold(siteGiven) || (s.trackingCode && fold(s.trackingCode) === fold(siteGiven))) : undefined;
  const role = roleGiven ? roles.find((r) => r.id === roleGiven || fold(r.name) === fold(roleGiven) || fold(roleGiven).includes(fold(r.name))) : undefined;
  const rate = Number(pick(c, 'hourly_rate', 'hourlyRate', 'pay_rate', 'payRate', 'rate'));
  const email = text(pick(c, 'email', 'email_address', 'emailAddress'));
  const phone = text(pick(c, 'phone', 'mobile', 'phone_number', 'phoneNumber'));
  return {
    hire: {
      externalId,
      name,
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      ...(date(pick(c, 'date_of_birth', 'dateOfBirth', 'dob')) ? { dateOfBirth: date(pick(c, 'date_of_birth', 'dateOfBirth', 'dob')) } : {}),
      ...(site ? { siteId: site.id } : {}),
      ...(siteGiven ? { siteGiven } : {}),
      ...(role ? { roleId: role.id } : {}),
      ...(roleGiven ? { roleGiven } : {}),
      ...(date(pick(c, 'start_date', 'startDate')) ? { startDate: date(pick(c, 'start_date', 'startDate')) } : {}),
      ...(Number.isFinite(rate) && rate > 0 && rate < 200 ? { hourlyRate: Math.round(rate * 100) / 100 } : {}),
    },
  };
}
