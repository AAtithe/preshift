import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Db, Tx } from './db';
import { withTx } from './db';
import type { MemberRole, Membership } from './permissions';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;
export const SESSION_DAYS = 14;
export const INVITE_DAYS = 7;
export const MIN_PASSWORD = 12;

/** scrypt with a random salt, stored with its parameters so they can be raised later without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return timingSafeEqual(key, expected);
}

/** Tokens go to the browser; only their hash is stored, so a database leak gives no working sessions. */
export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface SessionUser {
  userId: string;
  name: string;
  email: string;
  organisationId: string;
  organisationName: string;
  membership: Membership;
}

export async function createSession(tx: Tx, userId: string, organisationId: string): Promise<string> {
  const token = newToken();
  await tx.query(`insert into sessions (token_hash, user_id, organisation_id, expires_at) values ($1, $2, $3, now() + interval '${SESSION_DAYS} days')`, [
    hashToken(token),
    userId,
    organisationId,
  ]);
  return token;
}

export async function sessionUser(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const { rows } = await db.query(
    `select u.id, u.name, u.email, o.id as org_id, o.name as org_name, m.role, m.site_ids, m.employee_id
       from sessions s
       join users u on u.id = s.user_id
       join organisations o on o.id = s.organisation_id
       join memberships m on m.user_id = s.user_id and m.organisation_id = s.organisation_id
      where s.token_hash = $1 and s.expires_at > now()`,
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    userId: r.id,
    name: r.name,
    email: r.email,
    organisationId: r.org_id,
    organisationName: r.org_name,
    membership: { role: r.role as MemberRole, siteIds: r.site_ids, employeeId: r.employee_id },
  };
}

export async function memberships(db: Db, userId: string) {
  const { rows } = await db.query<{ organisation_id: string; name: string; role: MemberRole }>(
    `select m.organisation_id, o.name, m.role from memberships m join organisations o on o.id = m.organisation_id where m.user_id = $1 order by o.name`,
    [userId],
  );
  return rows.map((r) => ({ organisationId: r.organisation_id, name: r.name, role: r.role }));
}

/** A new organisation with its first owner. */
export async function signUp(db: Db, organisationName: string, name: string, email: string, password: string) {
  const passwordHash = await hashPassword(password);
  return withTx(db, async (tx) => {
    const org = await tx.query<{ id: string }>('insert into organisations (name) values ($1) returning id', [organisationName]);
    const user = await tx.query<{ id: string }>('insert into users (email, name, password_hash) values (lower($1), $2, $3) returning id', [email, name, passwordHash]);
    await tx.query("insert into memberships (user_id, organisation_id, role) values ($1, $2, 'owner')", [user.rows[0].id, org.rows[0].id]);
    return { token: await createSession(tx, user.rows[0].id, org.rows[0].id), organisationId: org.rows[0].id };
  });
}

// Verified against when the email is unknown, so a wrong email takes as long as a wrong password.
const DUMMY_HASH = hashPassword('not-a-real-password-used-for-timing');

/** Checks the password; the same answer and similar time whether the email exists or not. */
export async function logIn(db: Db, email: string, password: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string; password_hash: string }>('select id, password_hash from users where email = lower($1)', [email]);
  const user = rows[0];
  const ok = await verifyPassword(password, user?.password_hash ?? (await DUMMY_HASH));
  if (!user || !ok) return null;
  const orgs = await memberships(db, user.id);
  if (orgs.length === 0) return null;
  return withTx(db, (tx) => createSession(tx, user.id, orgs[0].organisationId));
}

export async function logOut(db: Db, token: string): Promise<void> {
  await db.query('delete from sessions where token_hash = $1', [hashToken(token)]);
}

/** Moves the session to another organisation the user belongs to: one login for an accountant with many clients. */
export async function switchOrganisation(db: Db, token: string, userId: string, organisationId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    'update sessions set organisation_id = $3 where token_hash = $1 and user_id = $2 and exists (select 1 from memberships where user_id = $2 and organisation_id = $3)',
    [hashToken(token), userId, organisationId],
  );
  return rowCount === 1;
}

export interface InviteInput {
  email: string;
  role: MemberRole;
  siteIds: string[] | null;
  employeeId: string | null;
}

export async function createInvite(db: Db, organisationId: string, invitedBy: string, input: InviteInput): Promise<string> {
  const token = newToken();
  await db.query(
    `insert into invites (token_hash, organisation_id, email, role, site_ids, employee_id, invited_by, expires_at)
     values ($1, $2, lower($3), $4, $5, $6, $7, now() + interval '${INVITE_DAYS} days')`,
    [hashToken(token), organisationId, input.email, input.role, input.siteIds, input.employeeId, invitedBy],
  );
  return token;
}

/** Accepts an invite: a new user sets a password; an existing one confirms theirs. Either way they join the organisation. */
export async function acceptInvite(db: Db, token: string, name: string, password: string): Promise<string | null> {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query(
      'select organisation_id, email, role, site_ids, employee_id from invites where token_hash = $1 and accepted_at is null and expires_at > now() for update',
      [hashToken(token)],
    );
    const invite = rows[0];
    if (!invite) return null;
    const existing = await tx.query<{ id: string; password_hash: string }>('select id, password_hash from users where email = $1', [invite.email]);
    let userId: string;
    if (existing.rows[0]) {
      if (!(await verifyPassword(password, existing.rows[0].password_hash))) return null;
      userId = existing.rows[0].id;
    } else {
      const created = await tx.query<{ id: string }>('insert into users (email, name, password_hash) values ($1, $2, $3) returning id', [
        invite.email,
        name,
        await hashPassword(password),
      ]);
      userId = created.rows[0].id;
    }
    await tx.query(
      `insert into memberships (user_id, organisation_id, role, site_ids, employee_id) values ($1, $2, $3, $4, $5)
       on conflict (user_id, organisation_id) do update set role = excluded.role, site_ids = excluded.site_ids, employee_id = excluded.employee_id`,
      [userId, invite.organisation_id, invite.role, invite.site_ids, invite.employee_id],
    );
    await tx.query('update invites set accepted_at = now() where token_hash = $1', [hashToken(token)]);
    return createSession(tx, userId, invite.organisation_id);
  });
}
