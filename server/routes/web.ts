import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';
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

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.webmanifest']);
const toBrotli = promisify(brotliCompress);
const toGzip = promisify(gzip);
// Built assets never change under their hashed names, so each is compressed once per process and kept.
// Brotli at 9 is within a few per cent of its best and a tenth of the time.
const packed = new Map<string, Promise<Buffer>>();

/** The file in the best encoding the browser takes, or as it is when it takes none or gains nothing. */
async function encoded(file: string, body: Buffer, accept: string | undefined): Promise<{ body: Buffer; encoding?: 'br' | 'gzip' }> {
  if (!COMPRESSIBLE.has(path.extname(file)) || body.length < 1024) return { body };
  const encoding = /\bbr\b/.test(accept ?? '') ? 'br' : /\bgzip\b/.test(accept ?? '') ? 'gzip' : undefined;
  if (!encoding) return { body };
  const key = `${encoding}:${file}`;
  let pending = packed.get(key);
  if (!pending) {
    pending = encoding === 'br' ? toBrotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }) : toGzip(body, { level: 9 });
    // The HTML is small and unhashed, so it is compressed afresh each time rather than kept.
    if (path.extname(file) !== '.html') packed.set(key, pending);
    pending.catch(() => packed.delete(key));
  }
  return { body: await pending, encoding };
}

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
    const serveStaff = (url: string, reply: FastifyReply, accept?: string) => serveFile(staffDir, '/staff', url, reply, accept);
    app.get('/staff', { schema: { hide: true } }, (req, reply) => serveStaff(req.url, reply, req.headers['accept-encoding']));
    app.get('/staff/*', { schema: { hide: true } }, (req, reply) => serveStaff(req.url, reply, req.headers['accept-encoding']));
  }

  if (options.kioskDir) {
    // The kiosk page is public too: until the iPad is paired its API answers nothing but "not paired".
    const kioskDir = options.kioskDir;
    const serveKiosk = (url: string, reply: FastifyReply, accept?: string) => serveFile(kioskDir, '/kiosk', url, reply, accept);
    app.get('/kiosk', { schema: { hide: true } }, (req, reply) => serveKiosk(req.url, reply, req.headers['accept-encoding']));
    app.get('/kiosk/*', { schema: { hide: true } }, (req, reply) => serveKiosk(req.url, reply, req.headers['accept-encoding']));
  }

  if (!options.appDir) return;
  const appDir = options.appDir;

  const serve = async (url: string, cookie: string | undefined, reply: FastifyReply, accept?: string) => {
    if (!(await sessionUser(cookie, store))) {
      return reply.code(303).header('location', `/login?${new URLSearchParams({ next: url })}`).send();
    }
    return serveFile(appDir, '/app', url, reply, accept);
  };

  app.get('/app', { schema: { hide: true } }, (req, reply) => serve(req.url, req.headers.cookie, reply, req.headers['accept-encoding']));
  app.get('/app/*', { schema: { hide: true } }, (req, reply) => serve(req.url, req.headers.cookie, reply, req.headers['accept-encoding']));
}

/** One file of a built Vite app mounted at prefix, never from outside its folder. */
async function serveFile(dir: string, prefix: string, url: string, reply: FastifyReply, accept?: string) {
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
    const out = await encoded(file, await readFile(file), accept);
    // Built assets carry a content hash in their names; the HTML that points at them must not be cached.
    const cache = relative.startsWith('assets/') ? 'private, max-age=31536000, immutable' : 'private, no-store';
    reply.type(TYPES[path.extname(file)] ?? 'application/octet-stream').header('cache-control', cache).header('vary', 'accept-encoding');
    if (out.encoding) reply.header('content-encoding', out.encoding);
    return reply.send(out.body);
  } catch {
    return notFound(reply);
  }
}
