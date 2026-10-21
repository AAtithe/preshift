import { sql } from '../_lib/db.js';
import { json, readJson } from '../_lib/http.js';
import { DUMMY_HASH, verifyPassword } from '../_lib/password.js';
import { createSession } from '../_lib/session.js';

const MAX_FAILURES = 5;
const WINDOW_MINUTES = 15;

export async function POST(request: Request): Promise<Response> {
  const body = await readJson<{ email?: unknown; password?: unknown }>(request);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email || !password) return json({ error: 'Enter your email and password.' }, 400);

  const db = sql();
  const [{ failures }] = (await db`
    select count(*)::int as failures from preshift.login_attempts
    where email = ${email} and not ok and at > now() - make_interval(mins => ${WINDOW_MINUTES})`) as { failures: number }[];
  if (failures >= MAX_FAILURES) {
    return json({ error: `Too many attempts. Try again in ${WINDOW_MINUTES} minutes.` }, 429);
  }

  const users = (await db`select id, password_hash from preshift.users where email = ${email}`) as {
    id: string;
    password_hash: string;
  }[];
  const user = users[0];
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  await db`insert into preshift.login_attempts (email, ok) values (${email}, ${ok && !!user})`;
  if (!ok || !user) return json({ error: 'Email or password is incorrect.' }, 401);

  const setCookie = await createSession(request, user.id);
  await db`update preshift.users set last_login_at = now() where id = ${user.id}`;
  return json({ ok: true }, 200, { 'set-cookie': setCookie });
}
