import { sql } from '../_lib/db.js';
import { json, readJson } from '../_lib/http.js';
import { isLockedOut, LOCKED_OUT, recordAttempt } from '../_lib/lockout.js';
import { DUMMY_HASH, verifyPassword } from '../_lib/password.js';
import { createSession } from '../_lib/session.js';

export async function POST(request: Request): Promise<Response> {
  const body = await readJson<{ email?: unknown; password?: unknown }>(request);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email || !password) return json({ error: 'Enter your email and password.' }, 400);
  if (await isLockedOut(email)) return json({ error: LOCKED_OUT }, 429);

  const db = sql();
  const users = (await db`select id, password_hash from preshift.users where email = ${email}`) as {
    id: string;
    password_hash: string;
  }[];
  const user = users[0];
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  await recordAttempt(email, ok && !!user);
  if (!ok || !user) return json({ error: 'Email or password is incorrect.' }, 401);

  const setCookie = await createSession(request, user.id);
  await db`update preshift.users set last_login_at = now() where id = ${user.id}`;
  return json({ ok: true }, 200, { 'set-cookie': setCookie });
}
