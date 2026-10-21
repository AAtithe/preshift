// Links in emails must never be built from the request's Host header: an attacker could send a
// reset request with a forged host and the real user would get a working token on the attacker's
// domain. Production uses APP_URL; only a local dev server may fall back to the request.
export function appUrl(request: Request, path: string): string | null {
  const configured = process.env.APP_URL?.replace(/\/+$/, '');
  if (configured) return `${configured}${path}`;
  const { protocol, hostname, host } = new URL(request.url);
  if (hostname === 'localhost' || hostname === '127.0.0.1') return `${protocol}//${host}${path}`;
  return null;
}
