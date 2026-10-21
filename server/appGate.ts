// Serves the built web app (/app/*) only to people who are signed in. On Vercel the app's
// files live inside this function rather than in public static output, so there is no way
// round the check: no session, no HTML, scripts or styles.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { requireSession } from './session';

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

export function createAppGate(root: string) {
  const base = path.resolve(root);
  return async function GET(request: Request): Promise<Response> {
    const denied = await requireSession(request);
    if (denied) return denied;

    const { pathname } = new URL(request.url);
    if (pathname === '/app') return new Response(null, { status: 308, headers: { location: '/app/' } });
    let relative: string;
    try {
      relative = decodeURIComponent(pathname.replace(/^\/app\/?/, '')) || 'index.html';
    } catch {
      return new Response('Not found', { status: 404 });
    }
    const file = path.resolve(base, relative);
    if (file !== base && !file.startsWith(base + path.sep)) return new Response('Not found', { status: 404 });

    try {
      const body = await readFile(file);
      const ext = path.extname(file);
      // Built assets carry a content hash in their names; the HTML that points at them must not be cached.
      const cache = relative.startsWith('assets/') ? 'private, max-age=31536000, immutable' : 'private, no-store';
      return new Response(body, { headers: { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': cache } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  };
}
