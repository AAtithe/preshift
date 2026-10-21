import { sql } from '../_lib/db.js';
import { json, readJson } from '../_lib/http.js';
import { hashPassword, newPasswordProblem } from '../_lib/password.js';
import { findValidReset } from '../_lib/reset.js';
import { createSession } from '../_lib/session.js';

const EXPIRED = 'This reset link has expired or has already been used. Ask for a new one.';

// With only a token, checks the link is still good so the page can say so before any typing.
// With a new password as well, sets it, signs out every device and signs this one in.
export async function POST(request: Request): Promise<Response> {
  const body = await readJson<{ token?: unknown; newPassword?: unknown }>(request);
  const token = typeof body?.token === 'string' ? body.token : '';
  if (!token) return json({ error: EXPIRED }, 400);
  const reset = await findValidReset(token);
  if (!reset) return json({ error: EXPIRED }, 410);
  if (body?.newPassword === undefined) return json({ ok: true, email: reset.email });

  const next = typeof body.newPassword === 'string' ? body.newPassword : '';
  const problem = newPasswordProblem(next, reset.email);
  if (problem) return json({ error: problem }, 400);

  const db = sql();
  const hash = await hashPassword(next);
  // One statement claims the token and sets the password, so if the link is used twice at once
  // only one request can match the unused token and the other changes nothing.
  const claimed = (await db`
    with used as (
      update preshift.password_resets set used_at = now()
      where id = ${reset.id} and used_at is null and expires_at > now()
      returning user_id
    )
    update preshift.users set password_hash = ${hash}, must_change_password = false
    where id in (select user_id from used)
    returning id`) as { id: string }[];
  if (claimed.length === 0) return json({ error: EXPIRED }, 410);

  await db.transaction([
    db`delete from preshift.password_resets where user_id = ${reset.user_id} and id <> ${reset.id}`,
    db`delete from preshift.sessions where user_id = ${reset.user_id}`,
    // Proving control of the inbox clears any lockout from earlier wrong guesses.
    db`delete from preshift.login_attempts where email = ${reset.email} and not ok`,
  ]);

  const setCookie = await createSession(request, reset.user_id);
  return json({ ok: true }, 200, { 'set-cookie': setCookie });
}
