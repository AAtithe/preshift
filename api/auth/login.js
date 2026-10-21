import { parseUsers, verifyLogin } from '../../server/passwords';
import { createSession, safeNext, sessionCookie, sessionSecret } from '../../server/session';

const back = (next, error) =>
  new Response(null, { status: 303, headers: { location: `/login?${new URLSearchParams({ next, error })}` } });

export async function POST(request) {
  const form = await request.formData();
  const next = safeNext(form.get('next'), '/app/');
  const secret = sessionSecret();
  const users = parseUsers(process.env.APP_USERS);
  if (!secret || users.size === 0) return back(next, 'setup');

  const user = await verifyLogin(users, form.get('email'), form.get('password'));
  if (!user) {
    // Slows guessing without needing state; a database-backed lockout replaces this in Phase 2.
    await new Promise((resolve) => setTimeout(resolve, 600));
    return back(next, 'invalid');
  }
  return new Response(null, {
    status: 303,
    headers: { location: next, 'set-cookie': sessionCookie(request, await createSession(user, secret)) },
  });
}
