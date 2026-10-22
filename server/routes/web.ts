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
  '.webmanifest': 'application/manifest+json',
};

const notFound = (reply: FastifyReply) => reply.code(404).type('text/plain').send('Not found');

/**
 * The sign-in page and, when appDir is given (the hosted build), the web app itself. The app's
 * files are served only to signed-in people: no session, no HTML, scripts or styles.
 */
export function webRoutes(app: FastifyInstance, store: Store, options: { loginPage: string; appDir?: string; staffDir?: string; kioskDir?: string }) {
  app.get('/login', { schema: { hide: true } }, async (_req, reply) =>
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(await readFile(options.loginPage)),
  );

  if (options.staffDir) {
    // The staff app is public: it holds nothing until someone signs in, and its API checks every call.
    const staffDir = options.staffDir;
    const serveStaff = (url: string, reply: FastifyReply) => serveFile(staffDir, '/staff', url, reply);
    app.get('/staff', { schema: { hide: true } }, (req, reply) => serveStaff(req.url, reply));
    app.get('/staff/*', { schema: { hide: true } }, (req, reply) => serveStaff(req.url, reply));
  }

  if (options.kioskDir) {
    // The kiosk page is public too: until the iPad is paired its API answers nothing but "not paired".
    const kioskDir = options.kioskDir;
    const serveKiosk = (url: string, reply: FastifyReply) => serveFile(kioskDir, '/kiosk', url, reply);
    app.get('/kiosk', { schema: { hide: true } }, (req, reply) => serveKiosk(req.url, reply));
    app.get('/kiosk/*', { schema: { hide: true } }, (req, reply) => serveKiosk(req.url, reply));
  }

  if (!options.appDir) return;
  const appDir = options.appDir;

  const serve = async (url: string, cookie: string | undefined, reply: FastifyReply) => {
    if (!(await sessionUser(cookie, store))) {
      return reply.code(303).header('location', `/login?${new URLSearchParams({ next: url })}`).send();
    }
    return serveFile(appDir, '/app', url, reply);
  };

  app.get('/app', { schema: { hide: true } }, (req, reply) => serve(req.url, req.headers.cookie, reply));
  app.get('/app/*', { schema: { hide: true } }, (req, reply) => serve(req.url, req.headers.cookie, reply));
}

/** One file of a built Vite app mounted at prefix, never from outside its folder. */
async function serveFile(dir: string, prefix: string, url: string, reply: FastifyReply) {
  const base = path.resolve(dir);
  const pathname = url.split('?')[0];
  if (pathname === prefix) return reply.code(308).header('location', `${prefix}/${url.slice(prefix.length)}`).send();
  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice(prefix.length + 1)) || 'index.html';
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
}
