import { currentUser } from '../../server/session.js';

export async function GET(request) {
  const email = await currentUser(request);
  return email ? Response.json({ email }) : Response.json({ email: null }, { status: 401 });
}
