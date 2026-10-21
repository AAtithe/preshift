import { currentUser } from '../../server/session';

export async function GET(request) {
  const user = await currentUser(request);
  return user ? Response.json(user) : Response.json({ email: null }, { status: 401 });
}
