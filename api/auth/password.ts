import { sql } from '../_lib/db.js';
import { json, readJson } from '../_lib/http.js';
import { isLockedOut, LOCKED_OUT, recordAttempt } from '../_lib/lockout.js';
import { hashPassword, newPasswordProblem, verifyPassword } from '../_lib/password.js';
import { currentUser, sessionId } from '../_lib/session.js';

export async function POST(request: Request): Promise<Response> {
  const user = await currentUser(request);
  if (!user) return json({ error: 'Not signed in.' }, 401);
  const body = await readJson<{ currentPassword?: unknown; newPassword?: unknown }>(request);
  const current = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
  const next = typeof body?.newPassword === 'string' ? body.newPassword : '';
  if (!current || !next) return json({ error: 'Enter your current and new password.' }, 400);
  if (await isLockedOut(user.email)) return json({ error: LOCKED_OUT }, 429);

  const db = sql();
  const [{ password_hash }] = (await db`select password_hash from preshift.users where id = ${user.id}`) as {
    password_hash: string;
  }[];
  if (!(await verifyPassword(current, password_hash))) {
    await recordAttempt(user.email, false);
    return json({ error: 'Current password is incorrect.' }, 403);
  }
  if (current === next) return json({ error: 'Choose a password you have not used here before.' }, 400);
  const problem = newPasswordProblem(next, user.email);
  if (problem) return json({ error: problem }, 400);

  // Sign out every other device: if the old password was known to someone else, so were its sessions.
  await db.transaction([
    db`update preshift.users set password_hash = ${await hashPassword(next)}, must_change_password = false where id = ${user.id}`,
    db`delete from preshift.sessions where user_id = ${user.id} and id <> ${sessionId(request)}`,
  ]);
  return json({ ok: true });
}
