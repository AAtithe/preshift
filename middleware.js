// Vercel Routing Middleware: nothing under /app, and no assistant call, is served without a session.
import { requireSession } from './server/session.js';

export const config = { matcher: ['/app', '/app/:path*', '/api/anthropic/:path*'] };

export default async function middleware(request) {
  return (await requireSession(request)) ?? undefined;
}
