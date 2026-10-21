import { json } from '../_lib/http.js';
import { currentUser } from '../_lib/session.js';

export async function GET(request: Request): Promise<Response> {
  const user = await currentUser(request);
  return user ? json({ user }) : json({ error: 'Not signed in.' }, 401);
}
