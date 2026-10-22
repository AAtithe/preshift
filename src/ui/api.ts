import type { Change, Command } from '../shared/commands';
import type { RotaState } from '../engine/types';

export type Role = 'owner' | 'finance' | 'gm' | 'troncmaster' | 'staff';

export interface Me {
  user: { id: string; name: string; email: string };
  organisation: { id: string; name: string };
  membership: { role: Role; siteIds: string[] | null; employeeId: string | null };
  permissions: string[];
  organisations: { organisationId: string; name: string; role: Role }[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok || json === null) throw new ApiError(res.status, json?.error ?? 'The server is not available.');
  return json as T;
}

export type Boot = { mode: 'demo' } | { mode: 'signin' } | { mode: 'server'; me: Me };

/**
 * Finds out how the app is running. A server that answers means sign in or
 * carry on; no server at all means the offline demo, exactly as before.
 */
export async function boot(): Promise<Boot> {
  try {
    return { mode: 'server', me: await call<Me>('GET', '/api/me') };
  } catch (e) {
    return e instanceof ApiError && e.status === 401 ? { mode: 'signin' } : { mode: 'demo' };
  }
}

export const api = {
  me: () => call<Me>('GET', '/api/me'),
  state: () => call<{ state: RotaState }>('GET', '/api/state'),
  command: (cmd: Command) => call<{ changes: Change[] }>('POST', '/api/commands', cmd),
  login: (email: string, password: string) => call('POST', '/api/auth/login', { email, password }),
  signup: (organisationName: string, name: string, email: string, password: string) =>
    call('POST', '/api/auth/signup', { organisationName, name, email, password }),
  acceptInvite: (token: string, name: string, password: string) => call('POST', '/api/auth/accept-invite', { token, name, password }),
  logout: () => call('POST', '/api/auth/logout', {}),
  switchOrganisation: (organisationId: string) => call('POST', '/api/session/organisation', { organisationId }),
  members: () => call<{ members: { name: string; email: string; role: Role; siteIds: string[] | null; employeeId: string | null }[] }>('GET', '/api/members'),
  invite: (email: string, role: Role, siteIds: string[] | null, employeeId: string | null) =>
    call<{ token: string }>('POST', '/api/invites', { email, role, siteIds, employeeId }),
};
