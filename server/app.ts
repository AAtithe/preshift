import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import type { Command } from '../src/shared/commands';
import {
  acceptInvite,
  createInvite,
  logIn,
  logOut,
  memberships,
  MIN_PASSWORD,
  SESSION_DAYS,
  sessionUser,
  signUp,
  switchOrganisation,
  type SessionUser,
} from './auth';
import { londonNow } from './clock';
import { execute, HttpError } from './commands';
import { withOrg, type Db } from './db';
import { can, permissionsFor, visibleState, type MemberRole } from './permissions';
import { loadState } from './repo';

export interface AppOptions {
  db: Db;
  /** Lets anyone create an organisation. Off in production: WS sets clients up. */
  allowSignup?: boolean;
  /** Lets an owner load the demo over their organisation's data. Demo and test servers only. */
  allowDemoSeed?: boolean;
  /** Secure cookies need HTTPS; on everywhere but local development. */
  secureCookies?: boolean;
  /** The server's clock, replaceable in tests. */
  now?: () => Date;
  /** Log server faults. Off in tests. */
  logErrors?: boolean;
}

const COOKIE = 'ps_session';
const ROLES: MemberRole[] = ['owner', 'finance', 'gm', 'troncmaster', 'staff'];

/** Ten wrong passwords per address and email in fifteen minutes, then wait. In memory: one server for now. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPTS = 10;

export function buildApp(options: AppOptions) {
  const { db } = options;
  const now = () => londonNow(options.now?.() ?? new Date());
  const app = Fastify({ logger: options.logErrors ? { level: 'error' } : false, bodyLimit: 5 * 1024 * 1024 });
  app.register(cookie);
  const attempts = new Map<string, { count: number; until: number }>();

  const setSession = (reply: FastifyReply, token: string) =>
    reply.setCookie(COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: options.secureCookies ?? true,
      maxAge: SESSION_DAYS * 24 * 60 * 60,
    });

  async function requireUser(request: FastifyRequest): Promise<SessionUser> {
    const user = await sessionUser(db, request.cookies[COOKIE]);
    if (!user) throw new HttpError(401, 'Please sign in.');
    return user;
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) return reply.status(error.status).send({ error: error.message });
    const { statusCode: status, message } = error as { statusCode?: number; message?: string };
    if (status && status < 500) return reply.status(status).send({ error: message });
    app.log.error(error);
    return reply.status(500).send({ error: 'Something went wrong.' });
  });

  // Cross-site request forgery: a browser will not send JSON cross-site without a preflight this
  // server never answers, and the session cookie is SameSite=Lax. Every write must be JSON.
  app.addHook('preHandler', async (request) => {
    if (request.method !== 'GET' && !String(request.headers['content-type'] ?? '').startsWith('application/json')) {
      throw new HttpError(415, 'Send JSON.');
    }
  });

  app.post<{ Body: { organisationName: string; name: string; email: string; password: string } }>('/api/auth/signup', async (request, reply) => {
    if (!options.allowSignup) throw new HttpError(403, 'Sign up is closed. Ask Williams, Stanley & Co. for an invite.');
    const { organisationName, name, email, password } = request.body ?? ({} as never);
    if (!organisationName || !name || !email) throw new HttpError(400, 'Organisation, name and email are needed.');
    if (!password || password.length < MIN_PASSWORD) throw new HttpError(400, `Use a password of at least ${MIN_PASSWORD} characters.`);
    try {
      const { token } = await signUp(db, organisationName, name, email, password);
      setSession(reply, token);
      return { ok: true };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'That email already has an account. Sign in instead.');
      throw e;
    }
  });

  app.post<{ Body: { email: string; password: string } }>('/api/auth/login', async (request, reply) => {
    const { email = '', password = '' } = request.body ?? {};
    const key = `${request.ip}|${email.toLowerCase()}`;
    const seen = attempts.get(key);
    if (seen && seen.until > Date.now() && seen.count >= LOGIN_ATTEMPTS) throw new HttpError(429, 'Too many attempts. Try again in fifteen minutes.');
    const token = await logIn(db, email, password);
    if (!token) {
      const fresh = !seen || seen.until <= Date.now();
      attempts.set(key, { count: fresh ? 1 : seen.count + 1, until: fresh ? Date.now() + LOGIN_WINDOW_MS : seen.until });
      throw new HttpError(401, 'Email or password not recognised.');
    }
    attempts.delete(key);
    setSession(reply, token);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[COOKIE];
    if (token) await logOut(db, token);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post<{ Body: { token: string; name: string; password: string } }>('/api/auth/accept-invite', async (request, reply) => {
    const { token, name, password } = request.body ?? ({} as never);
    if (!password || password.length < MIN_PASSWORD) throw new HttpError(400, `Use a password of at least ${MIN_PASSWORD} characters.`);
    const session = await acceptInvite(db, token, name, password);
    if (!session) throw new HttpError(400, 'That invite has expired or been used, or the password does not match the existing account.');
    setSession(reply, session);
    return { ok: true };
  });

  app.get('/api/me', async (request) => {
    const user = await requireUser(request);
    return {
      user: { id: user.userId, name: user.name, email: user.email },
      organisation: { id: user.organisationId, name: user.organisationName },
      membership: user.membership,
      permissions: permissionsFor(user.membership),
      organisations: await memberships(db, user.userId),
    };
  });

  app.post<{ Body: { organisationId: string } }>('/api/session/organisation', async (request) => {
    const user = await requireUser(request);
    if (!(await switchOrganisation(db, request.cookies[COOKIE]!, user.userId, request.body?.organisationId))) throw new HttpError(403, 'Not a member of that organisation.');
    return { ok: true };
  });

  app.get('/api/state', async (request) => {
    const user = await requireUser(request);
    const state = await withOrg(db, user.organisationId, loadState);
    return { state: visibleState(state, user.membership), now: now() };
  });

  app.post<{ Body: Command }>('/api/commands', async (request) => {
    const user = await requireUser(request);
    const changes = await withOrg(db, user.organisationId, (tx) =>
      execute({ tx, user, now: now(), allowDemoSeed: options.allowDemoSeed ?? false }, request.body),
    );
    // A whole new state goes back through the same visibility filter as a load.
    return { changes: changes.map((c) => (c.type === 'replaceState' ? { ...c, state: visibleState(c.state, user.membership) } : c)) };
  });

  app.get('/api/members', async (request) => {
    const user = await requireUser(request);
    if (!can(user.membership, 'org.invite')) throw new HttpError(403, 'Only an owner can see who has access.');
    const { rows } = await db.query(
      `select u.name, u.email, m.role, m.site_ids, m.employee_id from memberships m join users u on u.id = m.user_id
        where m.organisation_id = $1 order by m.role, u.name`,
      [user.organisationId],
    );
    return { members: rows.map((r) => ({ name: r.name, email: r.email, role: r.role, siteIds: r.site_ids, employeeId: r.employee_id })) };
  });

  app.post<{ Body: { email: string; role: MemberRole; siteIds: string[] | null; employeeId?: string | null } }>('/api/invites', async (request) => {
    const user = await requireUser(request);
    if (!can(user.membership, 'org.invite')) throw new HttpError(403, 'Only an owner can invite people.');
    const { email, role, siteIds = null, employeeId = null } = request.body ?? ({} as never);
    if (!email || !ROLES.includes(role)) throw new HttpError(400, 'An email and a valid role are needed.');
    if ((role === 'staff' || role === 'troncmaster') && !employeeId) throw new HttpError(400, 'Link staff and troncmasters to their employee record.');
    const token = await createInvite(db, user.organisationId, user.userId, { email, role, siteIds, employeeId });
    return { token };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/audit', async (request) => {
    const user = await requireUser(request);
    if (!can(user.membership, 'view.all')) throw new HttpError(403, 'Not available for your role.');
    const limit = Math.min(500, Number(request.query.limit ?? 100));
    const events = await withOrg(db, user.organisationId, async (tx) => {
      const { rows } = await tx.query(
        `select a.id, a.at, a.action, a.site_id, a.detail, u.name as user_name from audit_events a left join users u on u.id = a.user_id
          order by a.id desc limit $1`,
        [limit],
      );
      return rows;
    });
    const scope = user.membership.siteIds;
    return { events: events.filter((e) => scope === null || e.site_id === null || scope.includes(e.site_id)) };
  });

  return app;
}
