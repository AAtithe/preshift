import { sql } from '../_lib/db.js';
import { json, readJson } from '../_lib/http.js';
import { resetEmail, sendMail } from '../_lib/mail.js';
import { createResetToken, MAX_RESETS_PER_HOUR, RESET_MINUTES } from '../_lib/reset.js';
import { appUrl } from '../_lib/urls.js';

// The answer is the same whether or not the email has an account, so this form cannot be used
// to find out who our clients are.
const SENT = { ok: true, message: 'If that email has an account, a reset link is on its way. It expires in 30 minutes.' };

export async function POST(request: Request): Promise<Response> {
  const body = await readJson<{ email?: unknown }>(request);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email.includes('@')) return json({ error: 'Enter the email you sign in with.' }, 400);

  const link = appUrl(request, '/app/reset');
  if (!link) {
    console.error('Password reset not sent: APP_URL is not set');
    return json({ error: 'Password reset is not available yet. Ask your administrator.' }, 503);
  }

  const db = sql();
  const users = (await db`
    select u.id, u.name, (
      select count(*)::int from preshift.password_resets r
      where r.user_id = u.id and r.created_at > now() - interval '1 hour'
    ) as recent
    from preshift.users u where u.email = ${email}`) as { id: string; name: string; recent: number }[];
  const user = users[0];
  if (!user || user.recent >= MAX_RESETS_PER_HOUR) return json(SENT);

  const token = await createResetToken(user.id);
  // The token goes in the fragment, which browsers never send to a server or in a Referer header.
  await sendMail(resetEmail(user.name, email, `${link}#token=${token}`, RESET_MINUTES));
  return json(SENT);
}
