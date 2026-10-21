import { sql } from './_lib/db.js';
import { json, readJson } from './_lib/http.js';
import { currentUser, type SessionUser } from './_lib/session.js';

// The rota for the signed-in user's account. The engine still runs in the browser; this
// endpoint is the system of record and the only way to read or write live data.

// A user still on an admin-issued password gets no rota data until they replace it.
function refuse(user: SessionUser | null): Response | null {
  if (!user) return json({ error: 'Not signed in.' }, 401);
  if (user.mustChangePassword) return json({ error: 'Change your password to continue.' }, 403);
  return null;
}

export async function GET(request: Request): Promise<Response> {
  const user = await currentUser(request);
  const refused = refuse(user);
  if (refused || !user) return refused!;
  const rows = (await sql()`select state, version from preshift.rota_state where account_id = ${user.accountId}`) as {
    state: unknown;
    version: number;
  }[];
  return json(rows[0] ?? { state: null, version: 0 });
}

const REQUIRED = ['sites', 'roles', 'employees', 'shifts', 'forecast', 'demandRules'];

export async function PUT(request: Request): Promise<Response> {
  const user = await currentUser(request);
  const refused = refuse(user);
  if (refused || !user) return refused!;
  const body = await readJson<{ state?: Record<string, unknown>; version?: unknown }>(request);
  const state = body?.state;
  const version = body?.version;
  if (!state || typeof version !== 'number' || !REQUIRED.every((k) => Array.isArray(state[k]))) {
    return json({ error: 'Invalid rota payload.' }, 400);
  }

  const db = sql();
  const stateJson = JSON.stringify(state);
  // Version 0 means "first save"; otherwise the write only lands if nobody saved in between.
  const rows = (version === 0
    ? await db`
        insert into preshift.rota_state (account_id, state, version, updated_by)
        values (${user.accountId}, ${stateJson}::jsonb, 1, ${user.id})
        on conflict (account_id) do nothing
        returning version`
    : await db`
        update preshift.rota_state
        set state = ${stateJson}::jsonb, version = version + 1, updated_at = now(), updated_by = ${user.id}
        where account_id = ${user.accountId} and version = ${version}
        returning version`) as { version: number }[];

  if (!rows[0]) return json({ error: 'This rota was changed by someone else. Reload to see their changes.' }, 409);
  return json({ version: rows[0].version });
}
