import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { sessionUser } from '../auth';
import type { Store } from '../store';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const notFound = (reply: FastifyReply) => reply.code(404).type('text/plain').send('Not found');

/**
 * The sign-in page and, when appDir is given (the hosted build), the web app itself. The app's
 * files are served only to signed-in people: no session, no HTML, scripts or styles.
 */
export function webRoutes(app: FastifyInstance, store: Store, options: { loginPage: string; appDir?: string }) {
  app.get('/login', { schema: { hide: true } }, async (_req, reply) =>
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(await readFile(options.loginPage)),
  );

  if (!options.appDir) return;
  const base = path.resolve(options.appDir);

  const serve = async (url: string, cookie: string | undefined, reply: FastifyReply) => {
    const pathname = url.split('?')[0];
    if (!(await sessionUser(cookie, store))) {
      return reply.code(303).header('location', `/login?${new URLSearchParams({ next: url })}`).send();
    }
    if (pathname === '/app') return reply.code(308).header('location', '/app/').send();
    let relative: string;
    try {
      relative = decodeURIComponent(pathname.replace(/^\/app\/?/, '')) || 'index.html';
    } catch {
      return notFound(reply);
    }
    const file = path.resolve(base, relative);
    if (file !== base && !file.startsWith(base + path.sep)) return notFound(reply);
    try {
      const body = await readFile(file);
      // Built assets carry a content hash in their names; the HTML that points at them must not be cached.
      const cache = relative.startsWith('assets/') ? 'private, max-age=31536000, immutable' : 'private, no-store';
      return reply.type(TYPES[path.extname(file)] ?? 'application/octet-stream').header('cache-control', cache).send(body);
    } catch {
      return notFound(reply);
    }
  };

  app.get('/app', { schema: { hide: true } }, (req, reply) => serve(req.url, req.headers.cookie, reply));
  app.get('/app/*', { schema: { hide: true } }, (req, reply) => serve(req.url, req.headers.cookie, reply));
}
