import { createHash, randomBytes } from 'node:crypto';
import { sql } from './db.js';

export const COOKIE = 'ps_session';
const TTL_DAYS = 30;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  accountId: string;
  accountName: string;
  role: 'admin' | 'manager';
  mustChangePassword: boolean;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** The stored id of the session making this request, if it carries one. */
export function sessionId(request: Request): string | null {
  const token = readCookie(request, COOKIE);
  return token ? hashToken(token) : null;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function cookie(request: Request, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function createSession(request: Request, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await sql()`
    insert into preshift.sessions (id, user_id, expires_at)
    values (${hashToken(token)}, ${userId}, now() + make_interval(days => ${TTL_DAYS}))`;
  return cookie(request, token, TTL_DAYS * 24 * 60 * 60);
}

export async function destroySession(request: Request): Promise<string> {
  const token = readCookie(request, COOKIE);
  if (token) await sql()`delete from preshift.sessions where id = ${hashToken(token)}`;
  return cookie(request, '', 0);
}

export async function currentUser(request: Request): Promise<SessionUser | null> {
  const id = sessionId(request);
  if (!id) return null;
  const rows = (await sql()`
    select u.id, u.email, u.name, u.role, u.must_change_password, a.id as account_id, a.name as account_name
    from preshift.sessions s
    join preshift.users u on u.id = s.user_id
    join preshift.accounts a on a.id = u.account_id
    where s.id = ${id} and s.expires_at > now()`) as {
    id: string;
    email: string;
    name: string;
    role: SessionUser['role'];
    must_change_password: boolean;
    account_id: string;
    account_name: string;
  }[];
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    accountId: row.account_id,
    accountName: row.account_name,
    role: row.role,
    mustChangePassword: row.must_change_password,
  };
}
