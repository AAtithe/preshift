import { parseUsers, verifyLogin } from '../../server/passwords.js';
import { createSession, safeNext, sessionCookie, sessionSecret } from '../../server/session.js';

const back = (request, next, error) => {
  const url = new URL('/login', request.url);
  url.searchParams.set('next', next);
  url.searchParams.set('error', error);
  return Response.redirect(url, 303);
};

export async function POST(request) {
  const form = await request.formData();
  const next = safeNext(form.get('next'), '/app/');
  const secret = sessionSecret();
  const users = parseUsers(process.env.APP_USERS);
  if (!secret || users.size === 0) return back(request, next, 'setup');

  const email = await verifyLogin(users, form.get('email'), form.get('password'));
  if (!email) {
    // Slows guessing without needing state; a database-backed lockout replaces this in Phase 2.
    await new Promise((resolve) => setTimeout(resolve, 600));
    return back(request, next, 'invalid');
  }
  return new Response(null, {
    status: 303,
    headers: { location: next, 'set-cookie': sessionCookie(request, await createSession(email, secret)) },
  });
}
