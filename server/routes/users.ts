import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  accessHealth, ALL_PERMISSIONS, can, canOrgWide, checkAuthority, checkGrant, CONFLICTS, holders, INVITE_DAYS, live,
  ORG_DUTIES, PERMISSIONS, ROLES, SITE_DUTIES, sitesWith, STRONG, type Actor, type Audience, type Membership, type User,
} from '../../src/engine/access';
import { addDays } from '../../src/engine/time';
import { requireScope } from '../auth';
import { actorOf, withoutRecord } from '../guard';
import { authenticatorState } from './authenticator';
import { hashPassword } from '../passwords';
import type { Store } from '../store';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { idParam, isoDate } from '../schemas';
import { audit, type OrgData } from '../store';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESENDS_PER_HOUR = 3;
const ACCESS_ACTIONS = ['user.', 'membership.', 'access.', 'invite.', 'authenticator.'];

const grantFields = {
  roleId: { type: 'string' },
  // A type list, not anyOf: with anyOf, coercion turns null into [''] before the null branch is tried.
  siteIds: { type: ['array', 'null'], items: { type: 'string' } },
  starts: isoDate,
  ends: isoDate,
  acceptWarnings: { type: 'boolean', description: 'Accept paired-duty warnings. The warnings are kept on the grant as its reason.' },
} as const;

const userAndMembership = {
  type: 'object',
  required: ['id', 'mid'],
  properties: { id: { type: 'string' }, mid: { type: 'string' } },
} as const;

interface GrantBody { roleId: string; siteIds?: string[] | null; starts?: string; ends?: string; acceptWarnings?: boolean }
interface InviteBody extends GrantBody { email: string; name: string; jobTitle?: string; audience: Audience; employeeId?: string }

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const hash = hashToken;
const RESET_DAYS = 1;

const nameOf = (a: Actor) => (a.kind === 'system' ? a.name : a.user.name);

/** Who may read the directory, and how much of it. */
function readable(actor: Actor, org: OrgData, today: string): User[] {
  if (actor.kind === 'system') return org.users;
  const a = actor.user;
  if (canOrgWide(a, 'users.manage', today) || canOrgWide(a, 'audit.view', today)) return org.users;
  const mine = sitesWith(a, 'users.sites', today);
  if (mine === 'all') return org.users;
  if (mine.length === 0) throw new HttpError(403, 'forbidden', 'This is for those who manage or audit access.');
  // Site managers see the people who work at their sites, and nobody else.
  return org.users.filter((u) => u.id === a.id || u.memberships.some((m) => m.active && m.siteIds?.some((s) => mine.includes(s))));
}

function mustAudit(actor: Actor, today: string) {
  if (actor.kind === 'user' && !can(actor.user, 'audit.view', today) && !canOrgWide(actor.user, 'users.manage', today)) {
    throw new HttpError(403, 'forbidden', 'Reading the access trail needs audit or access management rights.');
  }
}

function findUser(org: OrgData, id: string): User {
  const u = org.users.find((x) => x.id === id);
  if (!u) throw notFound(`User ${id}`);
  return u;
}

function refuse(message: string | null) {
  if (message) throw new HttpError(403, 'forbidden', message);
}

/**
 * A single-use link for the person to set their own password: an invitation lasts seven days,
 * a reset one. Only its hash is kept, and a new link replaces any earlier one.
 */
function issueLink(org: OrgData, user: User, now: Date, kind: 'invite' | 'reset' = 'invite') {
  for (const [k, v] of Object.entries(org.inviteTokens)) if (v.userId === user.id) delete org.inviteTokens[k];
  const token = `${org.orgId}.${randomBytes(24).toString('base64url')}`;
  const expiresAt = addDays(now.toISOString().slice(0, 10), kind === 'invite' ? INVITE_DAYS : RESET_DAYS);
  org.inviteTokens[hash(token)] = { userId: user.id, expiresAt, kind };
  if (kind === 'invite') user.inviteExpiresAt = expiresAt;
  const sends = (org.inviteSends[user.id] ?? []).filter((t) => now.getTime() - Date.parse(t) < 3_600_000);
  org.inviteSends[user.id] = [...sends, now.toISOString()];
  // There is no mailer yet: the link goes back once to whoever made it, to pass on.
  return { inviteUrl: `/login?link=${encodeURIComponent(token)}`, expiresAt };
}
const issueInvite = (org: OrgData, user: User, now: Date) => issueLink(org, user, now, 'invite');

/** Ends every session the person has, on the next request each makes. */
async function signOutEverywhere(store: Store, email: string) {
  if (await store.getUser(email)) await store.updateUser(email, { sessionsValidFrom: Date.now() });
}

/** What the Access screen needs to know about each person's sign-in. Never the hash. */
async function withAccounts(store: Store, orgId: string, users: User[]) {
  const accounts = new Map((await store.listUsers(orgId)).map((a) => [a.email, a]));
  const nowSecs = Math.floor(Date.now() / 1000);
  return users.map((u) => {
    const a = accounts.get(u.email);
    return { ...u, account: a ? { exists: true, locked: a.lockedUntil > nowSecs, since: a.createdAt } : { exists: false, locked: false } };
  });
}

/** Run the grant rules and turn the outcome into a refusal, a request to confirm, or a membership. */
function grant(org: OrgData, actor: Actor, target: User, body: GrantBody, today: string): Membership {
  const proposal = { roleId: body.roleId, siteIds: body.siteIds ?? null, starts: body.starts ?? today, ends: body.ends };
  const check = checkGrant(actor, target, proposal, today, org.state.sites.map((s) => s.id));
  if (check.errors.length) throw new HttpError(422, 'grant_refused', check.errors[0], { errors: check.errors, warnings: check.warnings });
  if (check.warnings.length && !body.acceptWarnings) {
    throw new HttpError(409, 'needs_confirmation', 'This grant pairs duties that should sit apart. Accept the warnings to go ahead.', { warnings: check.warnings });
  }
  const m: Membership = {
    id: `mem_${randomUUID().slice(0, 12)}`,
    ...proposal,
    active: true,
    grantedBy: nameOf(actor),
    grantedAt: new Date().toISOString(),
    note: check.warnings.length ? `Accepted: ${check.warnings.join(' ')}` : undefined,
  };
  target.memberships.push(m);
  audit(org, nameOf(actor), 'membership.granted', { userId: target.id, membershipId: m.id, roleId: m.roleId, siteIds: m.siteIds, starts: m.starts, ends: m.ends, warnings: check.warnings });
  return m;
}

type AccountAction = 'suspend' | 'reactivate' | 'reset-authenticator' | 'resend-invite';

/** The account actions, shared by the single routes and the bulk route so both apply the same rules. */
function accountAction(org: OrgData, actor: Actor, target: User, action: AccountAction, today: string) {
  const now = new Date();
  switch (action) {
    case 'suspend': {
      if (target.status === 'suspended') throw new HttpError(409, 'conflict', `${target.name} is already suspended`);
      refuse(checkAuthority(actor, target, org.users, today, { removesAccess: true }));
      target.status = 'suspended';
      for (const [k, v] of Object.entries(org.inviteTokens)) if (v.userId === target.id) delete org.inviteTokens[k];
      audit(org, nameOf(actor), 'user.suspended', { userId: target.id });
      return { user: target };
    }
    case 'reactivate': {
      if (target.status !== 'suspended') throw new HttpError(409, 'conflict', `${target.name} is not suspended`);
      refuse(checkAuthority(actor, target, org.users, today));
      // Someone who never accepted goes back to invited and needs a fresh link.
      target.status = target.activatedAt ? 'active' : 'invited';
      audit(org, nameOf(actor), 'user.reactivated', { userId: target.id });
      return target.status === 'invited' ? { user: target, ...issueInvite(org, target, now) } : { user: target };
    }
    case 'reset-authenticator': {
      if (!target.mfaEnrolled) throw new HttpError(409, 'conflict', `${target.name} has no authenticator set up`);
      refuse(checkAuthority(actor, target, org.users, today, { removesAccess: true }));
      target.mfaEnrolled = false;
      // The record goes with it: its id is what verified sessions name, so every one of them ends here.
      delete org.authenticators[target.id];
      audit(org, nameOf(actor), 'user.authenticator_reset', { userId: target.id });
      return { user: target };
    }
    case 'resend-invite': {
      if (target.status !== 'invited') throw new HttpError(409, 'conflict', `${target.name} has already accepted`);
      refuse(checkAuthority(actor, target, org.users, today));
      const recent = (org.inviteSends[target.id] ?? []).filter((t) => now.getTime() - Date.parse(t) < 3_600_000);
      if (recent.length >= RESENDS_PER_HOUR) throw new HttpError(429, 'too_many', `Already sent ${RESENDS_PER_HOUR} times in the last hour. Check the email address instead.`);
      const link = issueInvite(org, target, now);
      audit(org, nameOf(actor), 'invite.resent', { userId: target.id, expiresAt: link.expiresAt });
      return { user: target, ...link };
    }
  }
}

export function userRoutes(app: FastifyInstance, ctx: AppContext) {
  // People are managed by people: a signed-in session or a personal key, never an integration
  // key, which could otherwise grant itself anything if it leaked.
  const byPerson = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.principal.userId && !req.principal.email) {
      return reply.code(403).send({ error: 'forbidden', message: 'Access is managed by people signed in, never by an integration key.' });
    }
  };
  const manage = { preHandler: [requireScope('users:manage'), byPerson] };
  const tags = ['Users and access'];
  const today = () => ctx.store.todayISO();

  app.get('/v1/me', { schema: { tags, description: 'The key in use, the person it acts as, and what they can do.' } }, async (req) => {
    const org = orgOf(req);
    const actor = actorOf(req, org, today());
    const user = actor.kind === 'user' ? actor.user : undefined;
    return {
      key: req.principal.name,
      scopes: req.principal.scopes,
      withoutRecord: withoutRecord(req, org),
      // Payroll runs against the TeamPay simulator: the screens offer its demo controls.
      simulator: !!ctx.simulator,
      user,
      authenticator: user ? authenticatorState(req, org, org.users.find((u) => u.id === user.id)!, today()) : undefined,
      permissions: user ? ALL_PERMISSIONS.filter((p) => can(user, p, today())) : ALL_PERMISSIONS,
    };
  });

  app.get('/v1/access/catalogue', { schema: { tags, description: 'Every role, permission and paired-duty rule.' } }, async () => ({
    roles: ROLES,
    permissions: PERMISSIONS,
    conflicts: CONFLICTS,
    strong: STRONG,
    siteDuties: SITE_DUTIES,
    orgDuties: ORG_DUTIES,
  }));

  app.get('/v1/users', { ...manage, schema: { tags } }, async (req) => {
    const org = orgOf(req);
    return withAccounts(ctx.store, org.orgId, readable(actorOf(req, org, today()), org, today()));
  });

  app.get<{ Params: { id: string } }>('/v1/users/:id', { ...manage, schema: { tags, params: idParam } }, async (req) => {
    const org = orgOf(req);
    const u = readable(actorOf(req, org, today()), org, today()).find((x) => x.id === req.params.id);
    if (!u) throw notFound(`User ${req.params.id}`);
    return (await withAccounts(ctx.store, org.orgId, [u]))[0];
  });

  app.post<{ Body: InviteBody }>(
    '/v1/users',
    {
      ...manage,
      schema: {
        tags,
        description: 'Invites a person with their first role. Returns the invitation link once; it lasts seven days.',
        body: {
          type: 'object',
          required: ['email', 'name', 'audience', 'roleId'],
          additionalProperties: false,
          properties: {
            email: { type: 'string' },
            name: { type: 'string', minLength: 1 },
            jobTitle: { type: 'string' },
            audience: { type: 'string', enum: ['operator', 'ws', 'external'] },
            employeeId: { type: 'string' },
            ...grantFields,
          },
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const actor = actorOf(req, org, today());
      // Nobody without access management anywhere gets as far as the grant rules.
      readable(actor, org, today());
      const email = req.body.email.trim().toLowerCase();
      if (!EMAIL.test(email)) throw new HttpError(400, 'invalid_request', 'That is not an email address');
      const existing = org.users.find((u) => u.email === email);
      if (existing) throw new HttpError(409, 'exists', `There is already an account for ${email}. Grant ${existing.name} a role instead.`, { userId: existing.id });
      const account = await ctx.store.getUser(email);
      if (account && account.orgId !== org.orgId) {
        throw new HttpError(409, 'elsewhere', `${email} already signs in to another organisation. One email signs in to one organisation for now.`);
      }
      if (req.body.employeeId && !org.state.employees.some((e) => e.id === req.body.employeeId)) throw notFound(`Employee ${req.body.employeeId}`);
      const now = new Date();
      const user: User = {
        id: `usr_${randomUUID().slice(0, 12)}`,
        email,
        name: req.body.name.trim(),
        jobTitle: req.body.jobTitle?.trim() || undefined,
        audience: req.body.audience,
        status: 'invited',
        mfaEnrolled: false,
        employeeId: req.body.employeeId,
        createdAt: now.toISOString(),
        invitedBy: nameOf(actor),
        memberships: [],
      };
      // Checked before anything is written, so a refused grant leaves no half-made account.
      grant(org, actor, user, req.body, today());
      org.users.push(user);
      const link = issueInvite(org, user, now);
      audit(org, nameOf(actor), 'user.invited', { userId: user.id, email, audience: user.audience });
      return reply.code(201).send({ user, ...link });
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; jobTitle?: string; employeeId?: string | null } }>(
    '/v1/users/:id',
    {
      ...manage,
      schema: {
        tags,
        description: 'Changes the name, job title or the rota record the person is linked to. Email is the identity and does not change.',
        params: idParam,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { name: { type: 'string', minLength: 1 }, jobTitle: { type: 'string' }, employeeId: { type: ['string', 'null'] } },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const actor = actorOf(req, org, today());
      const target = findUser(org, req.params.id);
      const self = actor.kind === 'user' && actor.user.id === target.id;
      // You may correct your own name and title; the rota link drives the self-approval control, so someone else sets it.
      if (!(self && req.body.employeeId === undefined)) refuse(checkAuthority(actor, target, org.users, today()));
      if (req.body.employeeId && !org.state.employees.some((e) => e.id === req.body.employeeId)) throw notFound(`Employee ${req.body.employeeId}`);
      if (req.body.name !== undefined) target.name = req.body.name.trim();
      if (req.body.jobTitle !== undefined) target.jobTitle = req.body.jobTitle.trim() || undefined;
      if (req.body.employeeId !== undefined) target.employeeId = req.body.employeeId ?? undefined;
      audit(org, nameOf(actor), 'user.updated', { userId: target.id, fields: Object.keys(req.body) });
      return target;
    },
  );

  app.post<{ Params: { id: string }; Body: GrantBody }>(
    '/v1/users/:id/grants',
    {
      ...manage,
      schema: {
        tags,
        description: 'Grants a role. Refused (422) if it breaks a rule; 409 needs_confirmation if it pairs duties, until acceptWarnings is sent.',
        params: idParam,
        body: { type: 'object', required: ['roleId'], additionalProperties: false, properties: grantFields },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const actor = actorOf(req, org, today());
      readable(actor, org, today());
      const m = grant(org, actor, findUser(org, req.params.id), req.body, today());
      return reply.code(201).send(m);
    },
  );

  app.patch<{ Params: { id: string; mid: string }; Body: { ends: string } }>(
    '/v1/users/:id/grants/:mid',
    {
      ...manage,
      schema: {
        tags,
        description: 'Moves the end date of a role, to extend an audit or bring an end forward.',
        params: userAndMembership,
        body: { type: 'object', required: ['ends'], additionalProperties: false, properties: { ends: isoDate } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const actor = actorOf(req, org, today());
      const target = findUser(org, req.params.id);
      const m = target.memberships.find((x) => x.id === req.params.mid && x.active);
      if (!m) throw notFound(`Role ${req.params.mid}`);
      refuse(checkAuthority(actor, target, org.users, today(), { membershipId: m.id }));
      if (req.body.ends < today() || req.body.ends < m.starts) throw new HttpError(400, 'invalid_request', 'The end date must be today or later, and after the start');
      const before = m.ends;
      m.ends = req.body.ends;
      audit(org, nameOf(actor), 'membership.end_changed', { userId: target.id, membershipId: m.id, from: before ?? null, to: m.ends });
      return m;
    },
  );

  app.delete<{ Params: { id: string; mid: string } }>(
    '/v1/users/:id/grants/:mid',
    { ...manage, schema: { tags, description: 'Removes a role. The record stays, marked revoked, for the audit trail.', params: userAndMembership } },
    async (req) => {
      const org = orgOf(req);
      const actor = actorOf(req, org, today());
      const target = findUser(org, req.params.id);
      const m = target.memberships.find((x) => x.id === req.params.mid && x.active);
      if (!m) throw notFound(`Role ${req.params.mid}`);
      refuse(checkAuthority(actor, target, org.users, today(), { membershipId: m.id, removesAccess: true }));
      m.active = false;
      m.revokedBy = nameOf(actor);
      m.revokedAt = new Date().toISOString();
      audit(org, nameOf(actor), 'membership.revoked', { userId: target.id, membershipId: m.id, roleId: m.roleId, siteIds: m.siteIds });
      return m;
    },
  );

  for (const action of ['suspend', 'reactivate', 'reset-authenticator', 'resend-invite'] as const) {
    app.post<{ Params: { id: string } }>(`/v1/users/:id/${action}`, { ...manage, schema: { tags, params: idParam } }, async (req) => {
      const org = orgOf(req);
      const target = findUser(org, req.params.id);
      const out = accountAction(org, actorOf(req, org, today()), target, action, today());
      // A suspended person's sessions end now, not when they next try something.
      if (action === 'suspend') await signOutEverywhere(ctx.store, target.email);
      return out;
    });
  }

  app.post<{ Params: { id: string } }>(
    '/v1/users/:id/reset-password',
    {
      ...manage,
      schema: {
        tags,
        description:
          'Ends the password and every session, and returns a single-use link (valid a day) for the person to set a new one. ' +
          'Nobody else learns the new password. Confirm who they are by phone or in person before passing the link on.',
        params: idParam,
      },
    },
    async (req) => {
      const org = orgOf(req);
      const actor = actorOf(req, org, today());
      const target = findUser(org, req.params.id);
      if (target.status !== 'active') throw new HttpError(409, 'conflict', `${target.name} is ${target.status}. ${target.status === 'invited' ? 'Resend their invitation instead.' : 'Reactivate them first.'}`);
      refuse(checkAuthority(actor, target, org.users, today()));
      if (await ctx.store.getUser(target.email)) {
        // The old password stops working at once: it may be what was compromised.
        await ctx.store.updateUser(target.email, { ...(await hashPassword(randomBytes(32).toString('hex'))), sessionsValidFrom: Date.now(), failedAttempts: 0, lockedUntil: 0 });
      }
      const link = issueLink(org, target, new Date(), 'reset');
      audit(org, nameOf(actor), 'user.password_reset', { userId: target.id });
      return { user: target, ...link };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/users/:id/invite',
    { ...manage, schema: { tags, description: 'Withdraws an invitation that has not been accepted. The account is removed; the audit trail keeps it.', params: idParam } },
    async (req) => {
      const org = orgOf(req);
      const actor = actorOf(req, org, today());
      const target = findUser(org, req.params.id);
      if (target.status !== 'invited') throw new HttpError(409, 'conflict', `${target.name} has accepted. Suspend the account instead.`);
      refuse(checkAuthority(actor, target, org.users, today()));
      for (const [k, v] of Object.entries(org.inviteTokens)) if (v.userId === target.id) delete org.inviteTokens[k];
      org.users = org.users.filter((u) => u.id !== target.id);
      audit(org, nameOf(actor), 'invite.revoked', { userId: target.id, email: target.email });
      return { removed: target.id };
    },
  );

  app.post<{ Body: { action: AccountAction; userIds: string[] } }>(
    '/v1/users/bulk',
    {
      ...manage,
      schema: {
        tags,
        description: 'Applies one account action to many people. Each is checked on its own, in order, so the last administrator is still protected.',
        body: {
          type: 'object',
          required: ['action', 'userIds'],
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['suspend', 'reactivate', 'reset-authenticator', 'resend-invite'] },
            userIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 200 },
          },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const actor = actorOf(req, org, today());
      const results: { userId: string; ok: boolean; inviteUrl?: string; error?: string }[] = [];
      for (const id of req.body.userIds) {
        try {
          const target = findUser(org, id);
          const out = accountAction(org, actor, target, req.body.action, today());
          if (req.body.action === 'suspend') await signOutEverywhere(ctx.store, target.email);
          results.push({ userId: id, ok: true, inviteUrl: (out as { inviteUrl?: string }).inviteUrl });
        } catch (e) {
          results.push({ userId: id, ok: false, error: (e as Error).message });
        }
      }
      return { done: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
    },
  );

  app.get('/v1/access/health', { ...manage, schema: { tags, description: 'What needs attention, and who covers each duty at each site.' } }, async (req) => {
    const org = orgOf(req);
    const users = readable(actorOf(req, org, today()), org, today());
    const t = today();
    const ids = (us: User[]) => us.map((u) => u.id);
    return {
      attention: accessHealth(users, org.state.sites, org.state.employees, org.accessReviews, t),
      coverage: {
        organisation: Object.fromEntries(ORG_DUTIES.map((p) => [p, ids(holders(users, p, t))])),
        sites: Object.fromEntries(org.state.sites.map((s) => [s.id, Object.fromEntries(SITE_DUTIES.map((p) => [p, ids(holders(users, p, t, s.id))]))])),
      },
      // Accounts that can sign in to this organisation but have no access record: full access, no roles.
      signInsWithoutRecord: (await ctx.store.listUsers(org.orgId))
        .filter((a) => !org.users.some((x) => x.email === a.email))
        .map((a) => a.email),
      counts: {
        people: users.length,
        active: users.filter((u) => u.status === 'active').length,
        invited: users.filter((u) => u.status === 'invited').length,
        suspended: users.filter((u) => u.status === 'suspended').length,
        liveRoles: users.reduce((n, u) => n + u.memberships.filter((m) => live(m, t)).length, 0),
      },
    };
  });

  app.get('/v1/access/reviews', { ...manage, schema: { tags } }, async (req) => {
    const org = orgOf(req);
    mustAudit(actorOf(req, org, today()), today());
    return [...org.accessReviews].sort((a, b) => b.at.localeCompare(a.at));
  });

  app.post<{ Body: { note?: string } }>(
    '/v1/access/reviews',
    {
      ...manage,
      schema: {
        tags,
        description: 'Records that someone has reviewed who has access, with what still needed attention at the time.',
        body: { type: 'object', additionalProperties: false, properties: { note: { type: 'string', maxLength: 2000 } } },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const actor = actorOf(req, org, today());
      mustAudit(actor, today());
      const attention = accessHealth(org.users, org.state.sites, org.state.employees, org.accessReviews, today()).filter((a) => a.severity !== 'info' && a.kind !== 'review_due');
      const review = {
        id: `rev_${randomUUID().slice(0, 12)}`,
        at: new Date().toISOString(),
        by: nameOf(actor),
        note: req.body.note?.trim() || undefined,
        people: org.users.filter((u) => u.status !== 'suspended').length,
        attention: attention.length,
      };
      org.accessReviews.push(review);
      audit(org, nameOf(actor), 'access.reviewed', { reviewId: review.id, people: review.people, attention: review.attention });
      return reply.code(201).send(review);
    },
  );

  app.get<{ Querystring: { userId?: string } }>(
    '/v1/access/audit',
    { ...manage, schema: { tags, description: 'Every invitation, grant, removal and account change, newest first.', querystring: { type: 'object', properties: { userId: { type: 'string' } } } } },
    async (req) => {
      const org = orgOf(req);
      mustAudit(actorOf(req, org, today()), today());
      return org.audit
        .filter((e) => ACCESS_ACTIONS.some((p) => e.action.startsWith(p)))
        .filter((e) => !req.query.userId || e.detail?.userId === req.query.userId)
        .slice()
        .reverse();
    },
  );
}
