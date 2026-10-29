// Who can do what in Preshift. Pure logic, shared by the API (which enforces it)
// and the browser (which uses it to explain a grant before it is made).
//
// A user record grants nothing on its own. Access comes from memberships: a role,
// optionally narrowed to sites, live between a start and an optional end date.
// The model follows Signal: nobody grants beyond what they hold, paired duties
// are checked across everything a person holds, strong permissions need an
// authenticator, and nobody changes their own access.

import { addDays } from './time';

export type Audience = 'operator' | 'ws' | 'external';

export type Permission =
  | 'rota.view' | 'rota.edit' | 'rota.publish' | 'demand.manage'
  | 'costs.view'
  | 'time.record' | 'time.approve' | 'time.lock'
  | 'team.manage' | 'pay.edit' | 'pay.approve'
  | 'hr.view' | 'hr.manage' | 'hr.cases'
  | 'payroll.view' | 'payroll.send'
  | 'close.export'
  | 'users.manage' | 'users.sites' | 'audit.view'
  | 'settings.manage' | 'privacy.manage'
  | 'programme.lead'
  | 'customers.view' | 'customers.billing';

export interface PermissionDef {
  area: 'Rota' | 'Labour cost' | 'Time' | 'Team' | 'HR' | 'Payroll' | 'Finance' | 'Access' | 'Settings';
  label: string;
}

export const PERMISSIONS: Record<Permission, PermissionDef> = {
  'rota.view': { area: 'Rota', label: 'See the rota' },
  'rota.edit': { area: 'Rota', label: 'Build and edit the rota' },
  'rota.publish': { area: 'Rota', label: 'Publish the rota to the team' },
  'demand.manage': { area: 'Rota', label: 'Change forecasts and staffing rules' },
  'costs.view': { area: 'Labour cost', label: 'See pay rates, labour cost and labour %' },
  'time.record': { area: 'Time', label: 'Record clock-ins and manual time entries' },
  'time.approve': { area: 'Time', label: 'Approve hours for pay' },
  'time.lock': { area: 'Time', label: 'Lock a pay period once sent' },
  'team.manage': { area: 'Team', label: 'Add starters, mark leavers, change availability' },
  'pay.edit': { area: 'Team', label: 'Propose changes to pay rates and salaries' },
  'pay.approve': { area: 'Finance', label: 'Approve pay rate changes proposed by someone else' },
  'hr.view': { area: 'HR', label: 'Read personnel files, absence reasons, training and reviews' },
  'hr.manage': { area: 'HR', label: 'Record absence, training, reviews and personnel details' },
  'hr.cases': { area: 'HR', label: 'See and record disciplinary, grievance and capability cases' },
  'payroll.view': { area: 'Payroll', label: 'See payroll submissions and pay runs' },
  'payroll.send': { area: 'Payroll', label: 'Send approved hours to TeamPay' },
  'close.export': { area: 'Finance', label: 'Export the labour accrual journal' },
  'users.manage': { area: 'Access', label: 'Invite people and grant roles, up to their own access' },
  'users.sites': { area: 'Access', label: 'Give people a site role at their own sites' },
  'audit.view': { area: 'Access', label: 'Read the access audit trail and record access reviews' },
  'settings.manage': { area: 'Settings', label: 'Change sites, targets, integrations and API keys' },
  'privacy.manage': { area: 'Settings', label: "Answer staff data requests, export or erase a person's data, set retention" },
  'programme.lead': { area: 'Finance', label: 'Sign off the labour programme: its baseline, milestones, verified saving and gain share' },
  'customers.view': { area: 'Finance', label: "See every self sign-up customer's trial, subscription and revenue, as counts and billing standing only" },
  'customers.billing': { area: 'Finance', label: 'Move a card-paying customer onto a partner engagement, ending their Stripe subscription at the period end' },
};

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** Refused to a session without an authenticator when the role requires one. */
export const STRONG: Permission[] = ['pay.edit', 'pay.approve', 'payroll.send', 'time.lock', 'close.export', 'users.manage', 'users.sites', 'settings.manage', 'hr.cases', 'privacy.manage', 'programme.lead', 'customers.view', 'customers.billing'];

export interface RoleDef {
  id: string;
  name: string;
  audience: Audience;
  about: string;
  permissions: Permission[];
  /** 'sites' roles are always granted for named sites, never the whole organisation. */
  scope: 'org' | 'sites';
  mfa: boolean;
  requiresEnd?: boolean;
  /** May appoint any role of the audiences it manages without holding the duty itself. */
  appoints?: Audience[];
}

const VIEW: Permission[] = ['rota.view', 'costs.view'];
const SITE_RUN: Permission[] = ['rota.view', 'rota.edit', 'rota.publish', 'demand.manage', 'costs.view', 'time.record', 'time.approve'];

export const ROLES: RoleDef[] = [
  {
    id: 'owner', name: 'Owner', audience: 'operator', scope: 'org', mfa: true, appoints: ['operator', 'external'],
    about: 'Runs the business. Everything except approving hours, approving pay changes and sending pay, which stay with the people who check them, and signing off the labour programme, which sets the partner fee.',
    permissions: ALL_PERMISSIONS.filter((p) => p !== 'payroll.send' && p !== 'time.approve' && p !== 'pay.approve' && p !== 'programme.lead' && p !== 'customers.view' && p !== 'customers.billing'),
  },
  {
    id: 'ops_director', name: 'Operations director', audience: 'operator', scope: 'org', mfa: true,
    about: 'Runs every site. Owns the rota, the team and who has access, but not pay rates or payroll.',
    permissions: [...SITE_RUN, 'time.lock', 'team.manage', 'hr.view', 'hr.manage', 'payroll.view', 'users.manage', 'users.sites', 'audit.view'],
  },
  {
    id: 'finance_director', name: 'Finance director', audience: 'operator', scope: 'org', mfa: true,
    about: 'Owns labour cost and the close. Approves pay rate changes, sends pay and exports the journal, but cannot propose who is paid what.',
    permissions: [...VIEW, 'pay.approve', 'payroll.view', 'payroll.send', 'time.lock', 'close.export', 'audit.view'],
  },
  {
    id: 'payroll_manager', name: 'Payroll manager', audience: 'operator', scope: 'org', mfa: true,
    about: 'Checks approved hours, sends them to TeamPay and locks the period.',
    permissions: [...VIEW, 'payroll.view', 'payroll.send', 'time.lock'],
  },
  {
    id: 'people_manager', name: 'People manager', audience: 'operator', scope: 'org', mfa: true,
    about: 'Starters, leavers, pay rates, personnel files, HR cases and staff data requests. Never sends pay.',
    permissions: [...VIEW, 'team.manage', 'pay.edit', 'hr.view', 'hr.manage', 'hr.cases', 'privacy.manage'],
  },
  {
    id: 'area_manager', name: 'Area manager', audience: 'operator', scope: 'sites', mfa: true,
    about: 'Runs a group of sites: rota, hours, team, and site roles for their GMs.',
    permissions: [...SITE_RUN, 'team.manage', 'hr.view', 'hr.manage', 'payroll.view', 'users.sites'],
  },
  {
    id: 'general_manager', name: 'General manager', audience: 'operator', scope: 'sites', mfa: false,
    about: 'Runs a site: builds and publishes the rota, approves hours, gives their team site roles.',
    permissions: [...SITE_RUN, 'team.manage', 'hr.view', 'hr.manage', 'users.sites'],
  },
  {
    id: 'assistant_manager', name: 'Assistant manager', audience: 'operator', scope: 'sites', mfa: false,
    about: 'Builds the rota and approves hours, but does not publish or change the team.',
    permissions: ['rota.view', 'rota.edit', 'costs.view', 'time.record', 'time.approve'],
  },
  {
    id: 'head_chef', name: 'Head chef', audience: 'operator', scope: 'sites', mfa: false,
    about: 'Rotas the kitchen and approves kitchen hours.',
    permissions: ['rota.view', 'rota.edit', 'costs.view', 'time.record', 'time.approve'],
  },
  {
    id: 'supervisor', name: 'Supervisor', audience: 'operator', scope: 'sites', mfa: false,
    about: 'Sees the rota and records clock-ins on shift. No cost, no approval.',
    permissions: ['rota.view', 'time.record'],
  },
  {
    id: 'viewer', name: 'Viewer', audience: 'operator', scope: 'org', mfa: false,
    about: 'Reads the rota and labour cost. Changes nothing.',
    permissions: VIEW,
  },
  {
    id: 'ws_partner', name: 'Client partner', audience: 'ws', scope: 'org', mfa: true, appoints: ['ws', 'external'],
    about: 'Lead on the account for the accounting partner. Reads everything, locks periods, exports the close, manages partner access and signs off the labour programme.',
    permissions: [...VIEW, 'payroll.view', 'time.lock', 'close.export', 'users.manage', 'audit.view', 'programme.lead'],
  },
  {
    id: 'ws_accountant', name: 'Partner management accountant', audience: 'ws', scope: 'org', mfa: true,
    about: 'Runs the 3-day close: reads labour and payroll, exports the accrual.',
    permissions: [...VIEW, 'payroll.view', 'close.export', 'audit.view'],
  },
  {
    id: 'ws_payroll', name: 'Partner payroll', audience: 'ws', scope: 'org', mfa: true,
    about: 'Payroll bureau for the accounting partner: sends approved hours to TeamPay and locks the period.',
    permissions: [...VIEW, 'payroll.view', 'payroll.send', 'time.lock'],
  },
  {
    // Every customer at once, so one named role, held by the fewest people, and only ever counted in the
    // system's own organisation (server/routes/customers.ts): granted in a client's organisation it shows nothing.
    id: 'ws_customers', name: 'Customer operations', audience: 'ws', scope: 'org', mfa: true,
    about: "The accounting partner's commercial lead: sees every self sign-up customer's trial, subscription and revenue in one place, and moves a customer onto a partner engagement when the firm takes them on. Counts and billing standing only, never a customer's staff or pay.",
    permissions: ['customers.view', 'customers.billing'],
  },
  {
    id: 'external_auditor', name: 'External auditor', audience: 'external', scope: 'org', mfa: true, requiresEnd: true,
    about: 'Reads labour, payroll and the audit trail for the length of the audit.',
    permissions: [...VIEW, 'payroll.view', 'audit.view'],
  },
  {
    id: 'investor', name: 'Investor', audience: 'external', scope: 'org', mfa: false, requiresEnd: true,
    about: 'Reads the rota and labour cost for an agreed period.',
    permissions: VIEW,
  },
];

export interface Conflict {
  a: Permission;
  b: Permission;
  effect: 'block' | 'warn';
  why: string;
}

/** Paired duties, checked across everything one person holds in the organisation. */
export const CONFLICTS: Conflict[] = [
  { a: 'pay.edit', b: 'payroll.send', effect: 'block', why: 'Could raise a pay rate and send it to payroll with nobody else seeing it.' },
  { a: 'pay.edit', b: 'pay.approve', effect: 'warn', why: 'Could propose pay rises and approve them. Approving your own proposal is refused, but a second person in both roles could approve for each other.' },
  { a: 'team.manage', b: 'payroll.send', effect: 'warn', why: 'Could add a starter who does not exist and send their pay. The ghost employee.' },
  { a: 'time.approve', b: 'pay.edit', effect: 'warn', why: 'Could approve hours and set the rate those hours are paid at.' },
  { a: 'users.manage', b: 'payroll.send', effect: 'warn', why: 'Could grant payroll rights and then use them. Access and pay should sit apart.' },
];

export const AUDIENCE_LABEL: Record<Audience, string> = { operator: 'Operator', ws: 'Accounting partner', external: 'Outside' };

export interface Membership {
  id: string;
  roleId: string;
  /** Null means the whole organisation. Site roles always name sites. */
  siteIds: string[] | null;
  starts: string;
  ends?: string;
  active: boolean;
  grantedBy: string;
  grantedAt: string;
  revokedBy?: string;
  revokedAt?: string;
  /** Accepted paired-duty warnings, kept with the grant as the reason it was allowed. */
  note?: string;
}

export type UserStatus = 'invited' | 'active' | 'suspended';

export interface User {
  id: string;
  email: string;
  name: string;
  jobTitle?: string;
  audience: Audience;
  status: UserStatus;
  mfaEnrolled: boolean;
  /** The person's record on the rota, when they also work shifts. */
  employeeId?: string;
  createdAt: string;
  invitedBy?: string;
  inviteExpiresAt?: string;
  activatedAt?: string;
  lastSeenAt?: string;
  memberships: Membership[];
}

export interface AccessReview {
  id: string;
  at: string;
  by: string;
  note?: string;
  people: number;
  attention: number;
}

/** Whoever is acting: a person, or a system key with organisation-wide authority. */
/**
 * A system actor has no person behind it: an integration key, or a sign-in from before roles with no
 * access record. `ws` marks a deployment key Williams, Stanley & Co. holds (the programme:lead scope):
 * the only system actor that may grant or change partner roles, and it never touches the operator's own.
 */
export type Actor = { kind: 'system'; name: string; ws?: boolean } | { kind: 'user'; user: User };

export const INVITE_DAYS = 7;
export const ENDING_SOON_DAYS = 30;
export const DORMANT_DAYS = 90;
export const REVIEW_DAYS = 90;

const roleById = new Map(ROLES.map((r) => [r.id, r]));
export const roleOf = (id: string) => roleById.get(id);

export function live(m: Membership, today: string): boolean {
  return m.active && m.starts <= today && (!m.ends || m.ends >= today);
}

/** Does this membership reach the given site? No site asked means "anywhere at all". */
export function covers(m: Membership, siteId?: string): boolean {
  if (!m.siteIds) return true;
  return siteId ? m.siteIds.includes(siteId) : true;
}

function usable(user: User, m: Membership, p: Permission, today: string, siteId?: string) {
  if (user.status !== 'active' || !live(m, today) || !covers(m, siteId)) return false;
  const role = roleOf(m.roleId);
  if (!role || !role.permissions.includes(p)) return false;
  return !(STRONG.includes(p) && role.mfa && !user.mfaEnrolled);
}

export function can(user: User, p: Permission, today: string, siteId?: string): boolean {
  return user.memberships.some((m) => usable(user, m, p, today, siteId));
}

/** Holds the permission for the whole organisation, not only some sites. */
export function canOrgWide(user: User, p: Permission, today: string): boolean {
  return user.memberships.some((m) => !m.siteIds && usable(user, m, p, today));
}

/** Sites where the person holds the permission, or 'all'. */
export function sitesWith(user: User, p: Permission, today: string): 'all' | string[] {
  const sites = new Set<string>();
  for (const m of user.memberships) {
    if (!usable(user, m, p, today)) continue;
    if (!m.siteIds) return 'all';
    m.siteIds.forEach((s) => sites.add(s));
  }
  return [...sites];
}

/** Everything the person's roles carry, ignoring status and authenticator: what they would hold. */
export function heldPermissions(user: Pick<User, 'memberships'>, today: string, extra?: RoleDef): Set<Permission> {
  const out = new Set<Permission>();
  for (const m of user.memberships) {
    if (!live(m, today) && !(m.active && m.starts > today)) continue;
    roleOf(m.roleId)?.permissions.forEach((p) => out.add(p));
  }
  extra?.permissions.forEach((p) => out.add(p));
  return out;
}

export function conflictsIn(perms: Set<Permission>): Conflict[] {
  return CONFLICTS.filter((c) => perms.has(c.a) && perms.has(c.b));
}

/** Does every live user with organisation-wide access management remain, if this one is changed? */
export function managersOtherThan(users: User[], exceptUserId: string, today: string, exceptMembershipId?: string): number {
  return users.filter((u) => {
    if (u.id === exceptUserId && !exceptMembershipId) return false;
    const view = u.id === exceptUserId ? { ...u, memberships: u.memberships.filter((m) => m.id !== exceptMembershipId) } : u;
    return canOrgWide(view, 'users.manage', today);
  }).length;
}

export interface GrantProposal {
  roleId: string;
  siteIds: string[] | null;
  starts: string;
  ends?: string;
}

export interface GrantCheck {
  errors: string[];
  warnings: string[];
  /** Permissions the person does not already hold. */
  gains: Permission[];
  conflicts: Conflict[];
}

/**
 * The rules for giving someone a role. The API refuses anything with errors and
 * anything with warnings unless the grantor accepts them; the browser shows the
 * same result while the grant is being put together.
 */
export function checkGrant(actor: Actor, target: Pick<User, 'id' | 'audience' | 'status' | 'memberships'>, g: GrantProposal, today: string, knownSites?: string[]): GrantCheck {
  const errors: string[] = [];
  const role = roleOf(g.roleId);
  if (!role) return { errors: [`There is no role ${g.roleId}.`], warnings: [], gains: [], conflicts: [] };

  if (target.status === 'suspended') errors.push('The account is suspended. Reactivate it first.');
  if (role.audience !== target.audience) {
    errors.push(`${role.name} is a ${AUDIENCE_LABEL[role.audience].toLowerCase()} role and this person is ${target.audience === 'operator' ? 'on the operator side' : AUDIENCE_LABEL[target.audience].toLowerCase()}.`);
  }
  if (role.scope === 'sites' && (!g.siteIds || g.siteIds.length === 0)) errors.push(`${role.name} is granted for named sites. Pick at least one.`);
  if (g.siteIds && knownSites) {
    const unknown = g.siteIds.filter((s) => !knownSites.includes(s));
    if (unknown.length) errors.push(`Unknown site ${unknown.join(', ')}.`);
  }
  if (role.requiresEnd && !g.ends) errors.push(`${role.name} needs an end date. Outside access is never open-ended.`);
  if (g.ends && g.ends < g.starts) errors.push('The end date is before the start date.');
  if (g.ends && g.ends < today) errors.push('The end date has already passed.');

  const duplicate = target.memberships.find(
    (m) => m.roleId === g.roleId && (live(m, today) || (m.active && m.starts > today)) && (!m.siteIds || !g.siteIds || g.siteIds.every((s) => m.siteIds!.includes(s))),
  );
  if (duplicate) errors.push(`They already hold ${role.name} ${duplicate.siteIds ? 'at those sites' : 'here'}.`);

  errors.push(...authorityErrors(actor, target, role, g, today));

  const before = heldPermissions(target, today);
  const after = heldPermissions(target, today, role);
  const conflicts = conflictsIn(after).filter((c) => !(before.has(c.a) && before.has(c.b)));
  const text = (c: Conflict) => `${PERMISSIONS[c.a].label} with ${PERMISSIONS[c.b].label.toLowerCase()}: ${c.why}`;
  for (const c of conflicts) if (c.effect === 'block') errors.push(`Refused. ${text(c)}`);
  const warnings = conflicts.filter((c) => c.effect === 'warn').map(text);
  const gains = role.permissions.filter((p) => !before.has(p));
  return { errors, warnings, gains, conflicts };
}

/** Whether this actor may give this role: never to themselves, and never beyond their own access. */
export function authorityErrors(actor: Actor, target: Pick<User, 'id'>, role: RoleDef, g: GrantProposal, today: string): string[] {
  if (actor.kind === 'system') {
    // partner roles carry the programme sign-off, which sets the partner fee, so the operator's own authority never grants them.
    if (role.audience === 'ws' && !actor.ws) return ['Accounting partner roles are granted by the client partner, or by the accounting partner itself.'];
    if (actor.ws && role.audience === 'operator') return ['Operator roles are granted by the operator. The accounting partner never appoints inside a client business.'];
    return [];
  }
  const a = actor.user;
  const missing = (sites: string[] | null) => {
    const gap = role.permissions.filter((p) => !(sites ? sites.every((s) => can(a, p, today, s)) : canOrgWide(a, p, today)));
    return gap.length ? [`${a.name} cannot grant what they do not hold: ${gap.map((p) => PERMISSIONS[p].label.toLowerCase()).join('; ')}.`] : [];
  };
  if (a.id === target.id) return ['Somebody else has to change your own access, so nobody can widen their own rights.'];
  if (a.status !== 'active') return [`${a.name} is not active and cannot grant access.`];
  if (role.audience === 'ws' && !(a.audience === 'ws' && canOrgWide(a, 'users.manage', today))) {
    return ['Accounting partner roles are granted by the client partner.'];
  }
  if (a.audience === 'ws' && role.audience === 'operator') {
    return ['Operator roles are granted by the operator. The accounting partner never appoints inside a client business.'];
  }
  if (canOrgWide(a, 'users.manage', today)) return appoints(a, today).has(role.audience) ? [] : missing(g.siteIds);
  const mine = sitesWith(a, 'users.sites', today);
  if (mine !== 'all' && mine.length === 0) {
    return [`${a.name} does not manage access${a.mfaEnrolled ? '' : ', or has not set up the authenticator that access management requires'}.`];
  }
  if (role.scope !== 'sites') return ['Site managers grant site roles only. Organisation roles are granted by someone who manages access.'];
  if (mine !== 'all' && (g.siteIds ?? []).some((s) => !mine.includes(s))) return ['You can only grant roles at the sites you manage.'];
  return missing(g.siteIds ?? []);
}

/** Audiences the person may appoint to without holding each duty, through a live, usable role. */
function appoints(u: User, today: string): Set<Audience> {
  const out = new Set<Audience>();
  for (const m of u.memberships) {
    const r = roleOf(m.roleId);
    if (r?.appoints && !m.siteIds && usable(u, m, 'users.manage', today)) r.appoints.forEach((x) => out.add(x));
  }
  return out;
}

/**
 * Whether the actor may act on this person's identity: reset their password or authenticator, or
 * send them a fresh invitation. Each can end with whoever holds the link holding the account, so it
 * needs the authority to give the person every role they hold, exactly as granting does. An
 * operations director can reset a GM, never the people manager or the owner; the owner, who appoints
 * operators without holding each duty, can reset any operator; WS never resets a client's people.
 */
export function identityAuthorityErrors(actor: Actor, target: User, users: User[], today: string): string[] {
  const base = checkAuthority(actor, target, users, today);
  if (base) return [base];
  for (const m of target.memberships) {
    if (!m.active || !(live(m, today) || m.starts > today)) continue;
    const role = roleOf(m.roleId);
    if (!role) continue;
    const errors = authorityErrors(actor, target, role, { roleId: m.roleId, siteIds: m.siteIds, starts: m.starts, ends: m.ends }, today);
    if (errors.length) return [`Resetting ${target.name} could hand you their account, so it needs the authority to give them every role they hold. ${errors[0]}`];
  }
  return [];
}

/**
 * The rights a person holds that move money or reach confidential records: pay, payroll, locking,
 * the journal, access management, settings, cases and staff data requests. A link that opens an
 * account holding any of them only ever goes to the person's own email, never to whoever sent it.
 * Giving site roles (users.sites) is left out: it is capped to the giver's own sites and access,
 * and a GM's link handed over in person is how a client without email sets up its sites.
 */
export function strongHeld(user: Pick<User, 'memberships'>, today: string): Permission[] {
  const held = heldPermissions(user, today);
  return STRONG.filter((p) => p !== 'users.sites' && held.has(p));
}

/** Can the actor change this person's account or this membership (revoke, suspend, reset)? */
export function checkAuthority(actor: Actor, target: User, users: User[], today: string, opts: { membershipId?: string; removesAccess?: boolean } = {}): string | null {
  if (actor.kind === 'system') {
    if (target.audience === 'ws' && !actor.ws && !opts.removesAccess) return 'Accounting partner accounts are managed by the client partner.';
    if (actor.ws && target.audience === 'operator') return "The accounting partner never changes the accounts of a client's own people. The client manages them.";
  }
  if (actor.kind === 'user') {
    const a = actor.user;
    if (a.id === target.id) return 'Somebody else has to change your own access, so the organisation is never left without an administrator by accident.';
    if (a.status !== 'active') return `${a.name} is not active.`;
    if (!canOrgWide(a, 'users.manage', today)) {
      const mine = sitesWith(a, 'users.sites', today);
      const reach = opts.membershipId ? target.memberships.filter((m) => m.id === opts.membershipId) : target.memberships.filter((m) => m.active);
      const within = (mine === 'all' || mine.length > 0) && reach.every((m) => roleOf(m.roleId)?.scope === 'sites' && m.siteIds!.every((s) => mine === 'all' || mine.includes(s)));
      if (!within) return 'Only someone who manages access for the whole organisation can change this person.';
    }
    if (target.audience === 'ws' && !(a.audience === 'ws' && canOrgWide(a, 'users.manage', today)) && !opts.removesAccess) {
      return 'Accounting partner accounts are managed by the client partner.';
    }
    if (a.audience === 'ws' && target.audience === 'operator') {
      return "The accounting partner never changes the accounts of a client's own people. The client manages them.";
    }
  }
  if (opts.removesAccess && canOrgWide(target, 'users.manage', today) && managersOtherThan(users, target.id, today, opts.membershipId) === 0) {
    return `That would leave nobody able to manage access. Give someone else access management first.`;
  }
  return null;
}

export interface SiteRef { id: string; name: string }

/** 8 Nov 2026: how dates read in messages people see. */
export function ukDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function reachText(m: Pick<Membership, 'siteIds'>, sites: SiteRef[]): string {
  if (!m.siteIds) return 'Every site';
  return m.siteIds.map((id) => sites.find((s) => s.id === id)?.name ?? id).join(', ');
}

export type AttentionKind =
  | 'must_enrol' | 'invite_expired' | 'invite_pending' | 'ending_soon' | 'ended' | 'paired_block' | 'paired_warn'
  | 'single_admin' | 'no_admin' | 'self_approval' | 'dormant' | 'no_coverage' | 'review_due'
  | 'email_bounced' | 'email_failed' | 'email_complained' | 'email_delayed';

export interface Attention {
  kind: AttentionKind;
  severity: 'block' | 'warn' | 'info';
  message: string;
  userId?: string;
  siteId?: string;
}

/** The duties every site needs someone live to hold. */
export const SITE_DUTIES: Permission[] = ['rota.publish', 'time.approve', 'team.manage', 'users.sites'];
/** The duties the organisation needs someone live to hold. */
export const ORG_DUTIES: Permission[] = ['users.manage', 'payroll.send', 'time.lock', 'close.export', 'pay.approve'];

export function holders(users: User[], p: Permission, today: string, siteId?: string): User[] {
  return users.filter((u) => can(u, p, today, siteId));
}

export interface EmployeeRef { id: string; name: string; siteId: string }

/**
 * Everything about the organisation's access that someone should look at,
 * worst first. Drives the Overview and the badges on the People list.
 */
export function accessHealth(users: User[], sites: SiteRef[], employees: EmployeeRef[], reviews: AccessReview[], today: string): Attention[] {
  const out: Attention[] = [];
  const soon = addDays(today, ENDING_SOON_DAYS);
  for (const u of users) {
    const held = heldPermissions(u, today);
    if (u.status === 'invited') {
      if (u.inviteExpiresAt && u.inviteExpiresAt < today) out.push({ kind: 'invite_expired', severity: 'warn', userId: u.id, message: `${u.name}'s invitation expired on ${ukDate(u.inviteExpiresAt)}. Resend it or revoke it.` });
      else out.push({ kind: 'invite_pending', severity: 'info', userId: u.id, message: `${u.name} has not accepted their invitation yet.` });
    }
    if (u.status === 'suspended') continue;
    const needsMfa = u.memberships.some((m) => live(m, today) && roleOf(m.roleId)?.mfa);
    if (u.status === 'active' && needsMfa && !u.mfaEnrolled) {
      out.push({ kind: 'must_enrol', severity: 'block', userId: u.id, message: `${u.name} has not set up an authenticator, so their payroll, pay and access rights are switched off until they do.` });
    }
    for (const m of u.memberships) {
      const role = roleOf(m.roleId);
      if (!m.active || !m.ends || !role) continue;
      if (m.ends < today) out.push({ kind: 'ended', severity: 'info', userId: u.id, message: `${u.name}'s ${role.name} ended on ${ukDate(m.ends)}.` });
      else if (m.ends <= soon) out.push({ kind: 'ending_soon', severity: 'warn', userId: u.id, message: `${u.name}'s ${role.name} ends on ${ukDate(m.ends)}. Extend it or let it lapse.` });
    }
    for (const c of conflictsIn(held)) {
      out.push({
        kind: c.effect === 'block' ? 'paired_block' : 'paired_warn',
        severity: c.effect === 'block' ? 'block' : 'warn',
        userId: u.id,
        message: `${u.name} holds ${PERMISSIONS[c.a].label.toLowerCase()} with ${PERMISSIONS[c.b].label.toLowerCase()}. ${c.why}`,
      });
    }
    if (u.employeeId) {
      const e = employees.find((x) => x.id === u.employeeId);
      if (e && can(u, 'time.approve', today, e.siteId)) {
        out.push({ kind: 'self_approval', severity: 'warn', userId: u.id, siteId: e.siteId, message: `${u.name} works shifts at ${sites.find((s) => s.id === e.siteId)?.name ?? e.siteId} and approves hours there. Someone else must approve their own hours.` });
      }
    }
    if (u.status === 'active') {
      const seen = u.lastSeenAt?.slice(0, 10) ?? u.activatedAt?.slice(0, 10);
      if (seen && addDays(seen, DORMANT_DAYS) < today) out.push({ kind: 'dormant', severity: 'warn', userId: u.id, message: `${u.name} has not signed in since ${ukDate(seen)}. Unused access is risk with no benefit. Suspend it.` });
    }
  }
  const admins = holders(users, 'users.manage', today).filter((u) => canOrgWide(u, 'users.manage', today));
  if (admins.length === 0) out.push({ kind: 'no_admin', severity: 'block', message: 'Nobody can manage access for the organisation.' });
  else if (admins.length === 1) out.push({ kind: 'single_admin', severity: 'warn', userId: admins[0].id, message: `Only ${admins[0].name} can manage access. A single point of failure: if they leave or lose their phone, nobody can.` });
  for (const p of ORG_DUTIES.filter((x) => x !== 'users.manage')) {
    if (holders(users, p, today).length === 0) out.push({ kind: 'no_coverage', severity: 'warn', message: `Nobody can ${PERMISSIONS[p].label.toLowerCase()}.` });
  }
  for (const s of sites) {
    for (const p of SITE_DUTIES) {
      if (holders(users, p, today, s.id).length === 0) out.push({ kind: 'no_coverage', severity: p === 'time.approve' ? 'block' : 'warn', siteId: s.id, message: `${s.name}: nobody can ${PERMISSIONS[p].label.toLowerCase()}.` });
    }
  }
  const last = [...reviews].sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!last) out.push({ kind: 'review_due', severity: 'warn', message: 'Access has never been reviewed. Review it now and every quarter.' });
  else if (addDays(last.at.slice(0, 10), REVIEW_DAYS) < today) out.push({ kind: 'review_due', severity: 'warn', message: `Access was last reviewed on ${ukDate(last.at.slice(0, 10))}. A quarterly review is due.` });
  const rank = { block: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
