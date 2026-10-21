import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  accessHealth, ALL_PERMISSIONS, can, canOrgWide, checkAuthority, checkGrant, CONFLICTS, holders, INVITE_DAYS, live,
  ORG_DUTIES, PERMISSIONS, ROLES, SITE_DUTIES, sitesWith, STRONG, type Actor, type Audience, type Membership, type User,
} from '../../src/engine/access';
import { addDays } from '../../src/engine/time';
import { requireScope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { idParam, isoDate } from '../schemas';
import { audit, type OrgData } from '../store';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESENDS_PER_HOUR = 3;
const ACCESS_ACTIONS = ['user.', 'membership.', 'access.', 'invite.'];

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

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

function actorOf(req: FastifyRequest, org: OrgData): Actor {
  const uid = req.principal.userId;
  if (!uid) return { kind: 'system', name: req.principal.name };
  const user = org.users.find((u) => u.id === uid);
  if (!user) throw new HttpError(403, 'forbidden', 'This key belongs to a person who no longer has an account');
  if (user.status !== 'active') throw new HttpError(403, 'forbidden', `${user.name}'s account is ${user.status}`);
  user.lastSeenAt = new Date().toISOString();
  return { kind: 'user', user };
}

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

function issueInvite(org: OrgData, user: User, now: Date) {
  for (const [k, v] of org.inviteTokens) if (v.userId === user.id) org.inviteTokens.delete(k);
  const token = `${org.orgId}.${randomBytes(24).toString('base64url')}`;
  const expiresAt = addDays(now.toISOString().slice(0, 10), INVITE_DAYS);
  org.inviteTokens.set(hash(token), { userId: user.id, expiresAt });
  user.inviteExpiresAt = expiresAt;
  const sends = (org.inviteSends.get(user.id) ?? []).filter((t) => now.getTime() - Date.parse(t) < 3_600_000);
  org.inviteSends.set(user.id, [...sends, now.toISOString()]);
  // There is no mailer yet: the link goes back once to whoever sent the invitation, to pass on.
  return { inviteUrl: `/accept-invite?token=${encodeURIComponent(token)}`, expiresAt };
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
      for (const [k, v] of org.inviteTokens) if (v.userId === target.id) org.inviteTokens.delete(k);
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
      audit(org, nameOf(actor), 'user.authenticator_reset', { userId: target.id });
      return { user: target };
    }
    case 'resend-invite': {
      if (target.status !== 'invited') throw new HttpError(409, 'conflict', `${target.name} has already accepted`);
      refuse(checkAuthority(actor, target, org.users, today));
      const recent = (org.inviteSends.get(target.id) ?? []).filter((t) => now.getTime() - Date.parse(t) < 3_600_000);
      if (recent.length >= RESENDS_PER_HOUR) throw new HttpError(429, 'too_many', `Already sent ${RESENDS_PER_HOUR} times in the last hour. Check the email address instead.`);
      const link = issueInvite(org, target, now);
      audit(org, nameOf(actor), 'invite.resent', { userId: target.id, expiresAt: link.expiresAt });
      return { user: target, ...link };
    }
  }
}

export function userRoutes(app: FastifyInstance, ctx: AppContext) {
  const manage = { preHandler: requireScope('users:manage') };
  const tags = ['Users and access'];
  const today = () => ctx.store.todayISO();

  app.get('/v1/me', { schema: { tags, description: 'The key in use, the person it acts as, and what they can do.' } }, async (req) => {
    const org = orgOf(ctx, req);
    const actor = actorOf(req, org);
    const user = actor.kind === 'user' ? actor.user : undefined;
    return {
      key: req.principal.name,
      scopes: req.principal.scopes,
      user,
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
    const org = orgOf(ctx, req);
    return readable(actorOf(req, org), org, today());
  });

  app.get<{ Params: { id: string } }>('/v1/users/:id', { ...manage, schema: { tags, params: idParam } }, async (req) => {
    const org = orgOf(ctx, req);
    const u = readable(actorOf(req, org), org, today()).find((x) => x.id === req.params.id);
    if (!u) throw notFound(`User ${req.params.id}`);
    return u;
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
      const org = orgOf(ctx, req);
      const actor = actorOf(req, org);
      const email = req.body.email.trim().toLowerCase();
      if (!EMAIL.test(email)) throw new HttpError(400, 'invalid_request', 'That is not an email address');
      const existing = org.users.find((u) => u.email === email);
      if (existing) throw new HttpError(409, 'exists', `There is already an account for ${email}. Grant ${existing.name} a role instead.`, { userId: existing.id });
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
      const org = orgOf(ctx, req);
      const actor = actorOf(req, org);
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
      const org = orgOf(ctx, req);
      const m = grant(org, actorOf(req, org), findUser(org, req.params.id), req.body, today());
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
      const org = orgOf(ctx, req);
      const actor = actorOf(req, org);
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
      const org = orgOf(ctx, req);
      const actor = actorOf(req, org);
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
      const org = orgOf(ctx, req);
      return accountAction(org, actorOf(req, org), findUser(org, req.params.id), action, today());
    });
  }

  app.delete<{ Params: { id: string } }>(
    '/v1/users/:id/invite',
    { ...manage, schema: { tags, description: 'Withdraws an invitation that has not been accepted. The account is removed; the audit trail keeps it.', params: idParam } },
    async (req) => {
      const org = orgOf(ctx, req);
      const actor = actorOf(req, org);
      const target = findUser(org, req.params.id);
      if (target.status !== 'invited') throw new HttpError(409, 'conflict', `${target.name} has accepted. Suspend the account instead.`);
      refuse(checkAuthority(actor, target, org.users, today()));
      for (const [k, v] of org.inviteTokens) if (v.userId === target.id) org.inviteTokens.delete(k);
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
      const org = orgOf(ctx, req);
      const actor = actorOf(req, org);
      const results = req.body.userIds.map((id) => {
        try {
          const out = accountAction(org, actor, findUser(org, id), req.body.action, today());
          return { userId: id, ok: true, inviteUrl: (out as { inviteUrl?: string }).inviteUrl };
        } catch (e) {
          return { userId: id, ok: false, error: (e as Error).message };
        }
      });
      return { done: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
    },
  );

  app.get('/v1/access/health', { ...manage, schema: { tags, description: 'What needs attention, and who covers each duty at each site.' } }, async (req) => {
    const org = orgOf(ctx, req);
    const users = readable(actorOf(req, org), org, today());
    const t = today();
    const ids = (us: User[]) => us.map((u) => u.id);
    return {
      attention: accessHealth(users, org.state.sites, org.state.employees, org.accessReviews, t),
      coverage: {
        organisation: Object.fromEntries(ORG_DUTIES.map((p) => [p, ids(holders(users, p, t))])),
        sites: Object.fromEntries(org.state.sites.map((s) => [s.id, Object.fromEntries(SITE_DUTIES.map((p) => [p, ids(holders(users, p, t, s.id))]))])),
      },
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
    const org = orgOf(ctx, req);
    mustAudit(actorOf(req, org), today());
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
      const org = orgOf(ctx, req);
      const actor = actorOf(req, org);
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
      const org = orgOf(ctx, req);
      mustAudit(actorOf(req, org), today());
      return org.audit
        .filter((e) => ACCESS_ACTIONS.some((p) => e.action.startsWith(p)))
        .filter((e) => !req.query.userId || e.detail?.userId === req.query.userId)
        .slice()
        .reverse();
    },
  );

  // Public: the person accepting has no key yet. The token is the proof.
  app.post<{ Body: { token: string } }>(
    '/v1/invites/accept',
    {
      schema: {
        tags,
        security: [],
        description: 'Accepts an invitation. The token is single use and lasts seven days.',
        body: { type: 'object', required: ['token'], additionalProperties: false, properties: { token: { type: 'string', minLength: 10 } } },
      },
    },
    async (req) => {
      const orgId = req.body.token.split('.')[0];
      const org = ctx.store.all().find((o) => o.orgId === orgId);
      const entry = org?.inviteTokens.get(hash(req.body.token));
      if (!org || !entry) throw new HttpError(404, 'not_found', 'This invitation is not valid. Ask for a new one.');
      const user = org.users.find((u) => u.id === entry.userId);
      org.inviteTokens.delete(hash(req.body.token));
      if (!user || user.status !== 'invited') throw new HttpError(404, 'not_found', 'This invitation is not valid. Ask for a new one.');
      if (entry.expiresAt < ctx.store.todayISO()) throw new HttpError(410, 'expired', 'This invitation has expired. Ask for a new one.');
      user.status = 'active';
      user.activatedAt = new Date().toISOString();
      user.inviteExpiresAt = undefined;
      audit(org, user.name, 'invite.accepted', { userId: user.id });
      return { name: user.name, email: user.email, needsAuthenticator: user.memberships.some((m) => ROLES.find((r) => r.id === m.roleId)?.mfa) };
    },
  );
}
