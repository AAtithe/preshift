import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Default deny, checked in CI. Each API route enforces access itself (server/guard.ts), so a new
// route that forgets to ask would be open to every signed-in person, a site supervisor included.
// This test fails until the route visibly checks access, or is named below with the reason it does not.

/** Calls that refuse unless the caller holds the right permission. */
const CHECKS = /\bguard\(|\bguardOf\(|\bg\.allow\(|\bmayView\(|\bmayAdd\(|\ballowPay\(|\bdataProtection\(|\bemployeeOf\(|\bsettingsPerson\(|\.\.\.admin\b|\bkeyManager\(|\bhooks\(|\ballowSetup\(/;

/** Files whose routes answer to their own authority rules rather than the guard. */
const EXEMPT_FILES: Record<string, string> = {
  'users.ts': 'The access module itself: every change is checked by checkAuthority and checkGrant in src/engine/access.ts.',
  'authenticator.ts': "A person's own authenticator, acting only on the caller's own account.",
};

/** Single routes that are deliberately open, and why. */
const EXEMPT_ROUTES: Record<string, string> = {
  'GET /v1/privacy/register': 'The record of processing names nobody and is open to anyone who reads the rota.',
  'POST /v1/integrations/teampay/webhook/:orgId': 'Called by TeamPay with a signed body, never by a person.',
  'GET /v1/webhooks/events': 'The public catalogue of event types and what each carries: no organisation data.',
  'GET /v1/dev/people': 'Development only: answers dev- keys outside production and 404s for everyone else.',
  'POST /v1/staff/invite': 'Staff app: a one-time invite token in the body, no manager session.',
  'POST /v1/staff/join': 'Staff app: a one-time invite token, no manager session.',
  'POST /v1/staff/login': 'Staff app sign-in.',
  'POST /v1/staff/logout': 'Staff app sign-out.',
  'GET /v1/staff/me': "Staff app: the caller's own shifts and hours, under the staff session.",
  'POST /v1/staff/clock-in': 'Staff app: the caller clocking themselves, under the staff session and geofence.',
  'POST /v1/staff/clock-out': 'Staff app: the caller clocking themselves, under the staff session and geofence.',
};

interface Route {
  file: string;
  key: string;
  body: string;
}

/** Each route registration in a file, with its source up to the next one. */
function routesIn(file: string): Route[] {
  const source = readFileSync(file, 'utf8');
  const starts = [...source.matchAll(/\bapp\.(get|post|put|patch|delete)\b/g)];
  return starts.flatMap((m, i) => {
    const body = source.slice(m.index!, starts[i + 1]?.index ?? source.length);
    const url = body.match(/'(\/v1\/[^']*)'/)?.[1];
    return url ? [{ file: path.basename(file), key: `${m[1].toUpperCase()} ${url}`, body }] : [];
  });
}

const dir = path.resolve(__dirname, 'routes');
const routes = readdirSync(dir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .flatMap((f) => routesIn(path.join(dir, f)));

describe('every API route checks access', () => {
  it('finds the routes', () => {
    expect(routes.length).toBeGreaterThan(80);
  });

  it('refuses by default: a route checks a permission or is named as open, with its reason', () => {
    const unchecked = routes
      .filter((r) => !EXEMPT_FILES[r.file] && !EXEMPT_ROUTES[r.key] && !CHECKS.test(r.body))
      .map((r) => `${r.key} (${r.file})`);
    expect(unchecked).toEqual([]);
  });

  it('names no exemption that no longer exists', () => {
    const keys = new Set(routes.map((r) => r.key));
    expect(Object.keys(EXEMPT_ROUTES).filter((k) => !keys.has(k))).toEqual([]);
  });
});
