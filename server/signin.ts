// Sign-in, sign-out and "who am I" as Web handlers. On Vercel all three run in one function
// (auth.func) reached by an explicit route; locally the Vite dev server runs them (devAuth.js).

import { parseUsers, verifyLogin } from './passwords';
import { createSession, currentUser, safeNext, sessionCookie, sessionSecret } from './session';

const back = (next: string, error: string) =>
  new Response(null, { status: 303, headers: { location: `/login?${new URLSearchParams({ next, error })}` } });

export async function login(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back('/app/', 'invalid');
  }
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

export function logout(request: Request): Response {
  return new Response(null, { status: 303, headers: { location: '/login?signedout=1', 'set-cookie': sessionCookie(request, '', 0) } });
}

export async function me(request: Request): Promise<Response> {
  const user = await currentUser(request);
  return user ? Response.json(user) : Response.json({ email: null }, { status: 401 });
}

const ROUTES: Record<string, (request: Request) => Response | Promise<Response>> = {
  'POST /api/auth/login': login,
  'GET /api/auth/logout': logout,
  'GET /api/auth/me': me,
};

/** One entry point for all three, so they deploy as a single function. */
export async function handleAuth(request: Request): Promise<Response> {
  const handler = ROUTES[`${request.method} ${new URL(request.url).pathname}`];
  return handler ? handler(request) : new Response('Not found', { status: 404 });
}
