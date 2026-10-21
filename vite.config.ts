import { existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Serves api/*.ts in `npm run dev` the way Vercel serves them in production, so the login and
// the live rota can be worked on locally against Neon without the Vercel CLI.
function devApi(): Plugin {
  return {
    name: 'preshift-dev-api',
    configureServer(server) {
      Object.assign(process.env, loadEnv('development', process.cwd(), ''));
      server.middlewares.use('/api', async (req, res, next) => {
        const path = (req.url ?? '/').split('?')[0];
        const file = resolve('api', `.${path}.ts`);
        if (path.includes('_lib') || !existsSync(file)) return next();
        try {
          const mod = await server.ssrLoadModule(file);
          const handler = mod[req.method ?? 'GET'];
          if (typeof handler !== 'function') {
            res.statusCode = 405;
            return res.end();
          }
          const response: Response = await handler(await toRequest(req));
          res.statusCode = response.status;
          response.headers.forEach((value, key) => key !== 'set-cookie' && res.setHeader(key, value));
          const cookies = response.headers.getSetCookie();
          if (cookies.length) res.setHeader('set-cookie', cookies);
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (err) {
          next(err);
        }
      });
    },
  };
}

async function toRequest(req: IncomingMessage & { originalUrl?: string }): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const body = chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined;
  return new Request(`http://${req.headers.host}${req.originalUrl ?? req.url}`, { method: req.method, headers, body });
}

export default defineConfig({
  plugins: [react(), devApi()],
  test: { globals: true, environment: 'node', include: ['src/**/*.test.ts', 'api/**/*.test.ts'] },
});
