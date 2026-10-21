// Runs the Vercel sign-in functions and middleware inside the Vite dev and preview servers,
// so local behaviour matches production. The app is served at / locally rather than /app.

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { POST as login } from '../api/auth/login.js';
import { GET as logout } from '../api/auth/logout.js';
import { GET as me } from '../api/auth/me.js';
import { requireSession } from './session.js';

const ROUTES = { 'POST /api/auth/login': login, 'GET /api/auth/logout': logout, 'GET /api/auth/me': me };

async function toRequest(req, { withBody = true } = {}) {
  const chunks = [];
  // The guard only needs the cookie; leaving the body unread lets the proxy forward it.
  if (withBody) for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v ? [[k, v]] : [])),
    body: !withBody || req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
}

async function send(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** Every page and the assistant need a session; Vite's own module requests are left alone. */
function guarded(req) {
  const path = req.url.split('?')[0];
  if (path.startsWith('/api/anthropic/')) return true;
  return req.method === 'GET' && (req.headers.accept ?? '').includes('text/html');
}

export function devAuth(env) {
  const enabled = Boolean(env.APP_USERS);
  if (enabled) {
    process.env.APP_USERS = env.APP_USERS;
    // A fresh secret per run is fine locally; it only means signing in again after a restart.
    process.env.SESSION_SECRET = env.SESSION_SECRET || randomBytes(32).toString('hex');
  }

  const middleware = async (req, res, next) => {
    try {
      const path = req.url.split('?')[0];
      if (req.method === 'GET' && path === '/login') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        return res.end(readFileSync(new URL('../site/login.html', import.meta.url)));
      }
      const handler = ROUTES[`${req.method} ${path}`];
      if (handler) return send(res, await handler(await toRequest(req)));
      if (guarded(req)) {
        const denied = await requireSession(await toRequest(req, { withBody: false }));
        if (denied) return send(res, denied);
      }
      next();
    } catch (err) {
      next(err);
    }
  };

  return {
    name: 'preshift-dev-auth',
    configureServer(server) {
      if (!enabled) {
        server.config.logger.info('  Sign-in is off locally: set APP_USERS in .env.local to turn it on.');
        return;
      }
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      if (enabled) server.middlewares.use(middleware);
    },
  };
}
