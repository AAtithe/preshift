import type { FastifyRequest } from 'fastify';
import { can, PERMISSIONS, roleOf, STRONG, type Actor, type Permission, type User } from '../src/engine/access';
import { HttpError, type AppContext } from './context';
import { audit, noteActing, type OrgData } from './store';

// Every rota, time and payroll route asks here, after the key's scopes have passed.
// A system key (no person) keeps organisation-wide authority. A personal key acts
// as its person, so their roles decide, site by site, as src/engine/access.ts says.

/**
 * Who is acting. A personal key names its person; a signed-in session is matched to its
 * person by email. A session with no access record keeps organisation-wide authority, as
 * every session had before roles existed, so nobody is locked out on the day roles arrive;
 * the Access overview lists them until they are given a record.
 */
export function actorOf(req: FastifyRequest, org: OrgData, today = new Date().toISOString().slice(0, 10)): Actor {
  const { userId, email } = req.principal;
  const user = userId
    ? org.users.find((u) => u.id === userId)
    : email
      ? org.users.find((u) => u.email === email.toLowerCase())
      : undefined;
  if (!user) {
    if (userId) throw new HttpError(403, 'forbidden', 'This key belongs to a person who no longer has an account');
    // Legacy full access is the home organisation's alone: an account that has joined another
    // organisation is nobody there without a record of its own.
    if (email && req.principal.homeOrgId && req.principal.homeOrgId !== org.orgId) {
      throw new HttpError(403, 'forbidden', 'You have no access to this organisation.');
    }
    // A deployment key WS holds: never implied by `*`, so the operator's own keys never carry it.
    const ws = !email && req.principal.scopes.includes('programme:lead');
    return { kind: 'system', name: req.principal.name, ...(ws ? { ws } : {}) };
  }
  noteActing(org, user.id);
  // Signing in proves the email, so it accepts a waiting invitation.
  if (user.status === 'invited' && email) {
    if (user.inviteExpiresAt && user.inviteExpiresAt < today) throw new HttpError(403, 'forbidden', 'Your invitation has expired. Ask for a new one.');
    user.status = 'active';
    user.activatedAt = new Date().toISOString();
    user.inviteExpiresAt = undefined;
    for (const [k, v] of Object.entries(org.inviteTokens)) if (v.userId === user.id) delete org.inviteTokens[k];
    audit(org, user.name, 'invite.accepted', { userId: user.id, by: 'sign-in' });
    req.orgChanged = true;
  }
  if (user.status !== 'active') throw new HttpError(403, 'forbidden', `${user.name}'s account is ${user.status}`);
  // Last seen drives the dormant-access finding, so it must persist on reads too; at most hourly, best effort.
  const now = new Date();
  if (!user.lastSeenAt || now.getTime() - Date.parse(user.lastSeenAt) > 3_600_000) {
    user.lastSeenAt = now.toISOString();
    req.orgTouched = true;
  }
  // The rules read mfaEnrolled; for this request it means enrolled and proved in this session.
  return { kind: 'user', user: { ...user, mfaEnrolled: enrolled(req, org, user) && verified(req, org, user) } };
}

/**
 * Whether this request has passed the authenticator. A session carries the enrolment id it
 * entered a code against, so a reset or re-enrolment ends it. A personal key passes only
 * when its issuer marked it so.
 */
export function verified(req: FastifyRequest, org: OrgData, user: User): boolean {
  const { userId, sessionMfa, mfa } = req.principal;
  if (userId) return mfa === true;
  const id = enrolmentId(req, org, user);
  return !!sessionMfa && !!id && sessionMfa === id;
}

/**
 * The person's authenticator enrolment: the account's own, else one kept in this organisation
 * from before authenticators moved to the account, which moves across when next used.
 */
function enrolmentId(req: FastifyRequest, org: OrgData, user: User): string | undefined {
  if (req.principal.accountMfaId) return req.principal.accountMfaId;
  const legacy = org.authenticators[user.id];
  return legacy?.secret ? legacy.id : undefined;
}

/** Whether the person has an authenticator, wherever they set it up. */
export function enrolled(req: FastifyRequest, org: OrgData, user: User): boolean {
  if (req.principal.userId) return user.mfaEnrolled;
  return !!enrolmentId(req, org, user);
}

/** A signed-in person with no access record: still organisation-wide, and a finding until they have one. */
export function withoutRecord(req: FastifyRequest, org: OrgData): boolean {
  const { userId, email, homeOrgId } = req.principal;
  return !userId && !!email && (!homeOrgId || homeOrgId === org.orgId) && !org.users.some((u) => u.email === email.toLowerCase());
}

export interface Guard {
  actor: Actor;
  /** Today in the organisation's calendar, as the checks were made. */
  today: string;
  /** The person, for a personal key. */
  user?: User;
  /**
   * The person behind the request: the caller, or whoever made the API key it came with. The rules
   * on your own record, pay and cases hold for them however they ask, so a key is no way round them.
   */
  behind?: User;
  /** A key someone made in the app, rather than a deployment's own key set in its environment. */
  appKey: boolean;
  can: (p: Permission, siteId?: string) => boolean;
  /** Refuses with the reason a person would need to put it right. */
  allow: (p: Permission, siteId?: string) => void;
  /** Sites where any of the permissions is held; 'all' for a system key or an organisation-wide role. */
  sites: (...ps: Permission[]) => 'all' | Set<string>;
  /** Filter for lists: keeps rows at a site where any of the permissions is held. */
  at: (...ps: Permission[]) => (row: { siteId: string }) => boolean;
}

export function guard(ctx: AppContext, req: FastifyRequest, org: OrgData): Guard {
  const today = ctx.store.todayISO();
  const actor = actorOf(req, org, today);
  const user = actor.kind === 'user' ? actor.user : undefined;
  const maker = req.principal.madeBy;
  // Keys made before makers were recorded by id are matched by name: stricter, never looser.
  const behind = user ?? (maker && org.users.find((u) => (maker.id ? u.id === maker.id : u.name === maker.name)));
  const siteName = (id?: string) => (id ? org.state.sites.find((s) => s.id === id)?.name ?? id : undefined);

  const check = (p: Permission, siteId?: string) => !user || can(user, p, today, siteId);

  const allow = (p: Permission, siteId?: string) => {
    if (check(p, siteId)) return;
    const where = siteId ? ` at ${siteName(siteId)}` : '';
    // Held but switched off for want of an authenticator: say so, rather than a bare refusal.
    const heldWithoutMfa = STRONG.includes(p) && !user!.mfaEnrolled &&
      user!.memberships.some((m) => m.active && roleOf(m.roleId)?.mfa && roleOf(m.roleId)?.permissions.includes(p) && (!m.siteIds || !siteId || m.siteIds.includes(siteId)));
    throw new HttpError(
      403,
      'forbidden',
      heldWithoutMfa
        ? `${user!.name} needs to set up an authenticator to ${PERMISSIONS[p].label.toLowerCase()}`
        : `${user!.name} cannot ${PERMISSIONS[p].label.toLowerCase()}${where}`,
      { permission: p, siteId },
    );
  };

  const sites = (...ps: Permission[]): 'all' | Set<string> => {
    if (!user) return 'all';
    const out = new Set<string>();
    for (const s of org.state.sites) if (ps.some((p) => can(user, p, today, s.id))) out.add(s.id);
    return out.size > 0 && out.size === org.state.sites.length ? 'all' : out;
  };

  const at = (...ps: Permission[]) => {
    const reach = sites(...ps);
    return (row: { siteId: string }) => reach === 'all' || reach.has(row.siteId);
  };

  return { actor, user, behind, appKey: Boolean(req.principal.keyId), today, can: check, allow, sites, at };
}

export const actorName = (g: Guard) => (g.actor.kind === 'system' ? g.actor.name : g.actor.user.name);
