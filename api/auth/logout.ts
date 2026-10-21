import { json } from '../_lib/http.js';
import { destroySession } from '../_lib/session.js';

export async function POST(request: Request): Promise<Response> {
  return json({ ok: true }, 200, { 'set-cookie': await destroySession(request) });
}
