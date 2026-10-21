import type { FastifyReply, FastifyRequest } from 'fastify';
import { DEMO_OWNER_ID, seedUsers } from './seedUsers';

export type Scope = 'rota:read' | 'rota:write' | 'time:write' | 'time:approve' | 'payroll:write' | 'users:manage' | '*';

export interface ApiKey {
  key: string;
  orgId: string;
  name: string;
  scopes: Scope[];
  /**
   * A personal key acts as that person: user management then follows their roles,
   * not the key's scopes alone. Keys without a user are system keys with
   * organisation-wide authority.
   */
  userId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: ApiKey;
  }
}

/**
 * Keys come from PRESHIFT_API_KEYS as JSON: [{"key":"...","orgId":"...","name":"...","scopes":["*"],"userId":"optional"}].
 * Outside production a development key is available so the demo runs with no setup.
 */
export function loadApiKeys(env = process.env): ApiKey[] {
  if (env.PRESHIFT_API_KEYS) return JSON.parse(env.PRESHIFT_API_KEYS) as ApiKey[];
  if (env.NODE_ENV === 'production') return [];
  // The demo signs in as the seeded owner, so access rules apply to the web app as they would to a person.
  // Each seeded person also has a key (dev-<userId>), so the demo can sign in as anyone and show the controls.
  const people = seedUsers(new Date().toISOString().slice(0, 10)).users;
  return [
    { key: 'dev-key', orgId: 'demo', name: 'Development', scopes: ['*'], userId: DEMO_OWNER_ID },
    ...people.map((u) => ({ key: `dev-${u.id}`, orgId: 'demo', name: `${u.name} (demo)`, scopes: ['*' as const], userId: u.id })),
  ];
}

export function authenticate(keys: ApiKey[]) {
  const byKey = new Map(keys.map((k) => [k.key, k]));
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const principal = byKey.get(token);
    if (!principal) return reply.code(401).send({ error: 'unauthorised', message: 'Missing or invalid API key' });
    req.principal = principal;
  };
}

export function requireScope(scope: Scope) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const scopes = req.principal?.scopes ?? [];
    if (!scopes.includes('*') && !scopes.includes(scope)) {
      return reply.code(403).send({ error: 'forbidden', message: `This key lacks the ${scope} scope` });
    }
  };
}
