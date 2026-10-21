import { sessionCookie } from '../../server/session.js';

export function GET(request) {
  return new Response(null, { status: 303, headers: { location: '/login?signedout=1', 'set-cookie': sessionCookie(request, '', 0) } });
}
