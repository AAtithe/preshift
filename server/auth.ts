import type { FastifyReply, FastifyRequest } from 'fastify';

export type Scope = 'rota:read' | 'rota:write' | 'time:write' | 'time:approve' | 'payroll:write' | '*';

export interface ApiKey {
  key: string;
  orgId: string;
  name: string;
  scopes: Scope[];
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: ApiKey;
  }
}

/**
 * Keys come from PRESHIFT_API_KEYS as JSON: [{"key":"...","orgId":"...","name":"...","scopes":["*"]}].
 * Outside production a development key is available so the demo runs with no setup.
 */
export function loadApiKeys(env = process.env): ApiKey[] {
  if (env.PRESHIFT_API_KEYS) return JSON.parse(env.PRESHIFT_API_KEYS) as ApiKey[];
  if (env.NODE_ENV === 'production') return [];
  return [{ key: 'dev-key', orgId: 'demo', name: 'Development', scopes: ['*'] }];
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
