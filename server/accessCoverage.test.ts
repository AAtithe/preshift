import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Default deny, checked in CI. Each API route enforces access itself (server/guard.ts), so a new
// route that forgets to ask would be open to every signed-in person, a site supervisor included.
// This test fails until the route visibly checks access, or is named below with the reason it does not.

/** Calls that refuse unless the caller holds the right permission. */
const CHECKS = /\bguard\(|\bguardOf\(|\bg\.allow\(|\bmayView\(|\bmayAdd\(|\ballowPay\(|\bdataProtection\(|\bemployeeOf\(|\bsettingsPerson\(|\.\.\.admin\b|\.\.\.lead\b|\bkeyManager\(|\bhooks\(|\ballowSetup\(|\bclientPartner\(|\bbillingPerson\(|\bloginReviewer\(|\bsupportPerson\(/;

/** Files whose routes answer to their own authority rules rather than the guard. */
const EXEMPT_FILES: Record<string, string> = {
  'users.ts': 'The access module itself: every change is checked by checkAuthority and checkGrant in src/engine/access.ts.',
  'authenticator.ts': "A person's own authenticator, acting only on the caller's own account.",
};

/** Single routes that are deliberately open, and why. */
const EXEMPT_ROUTES: Record<string, string> = {
  'GET /v1/privacy/register': 'The record of processing names nobody and is open to anyone who reads the rota.',
  'GET /v1/privacy/policy-documents': 'Whether each company has a signed appropriate policy document: names no member of staff, read with the register.',
  'POST /v1/integrations/teampay/webhook/:orgId': 'Called by TeamPay with a signed body, never by a person.',
  'POST /v1/integrations/stripe/webhook': "Called by Stripe with a signed body, never by a person; applied only to the organisation that owns the Stripe customer.",
  'GET /v1/webhooks/events': 'The public catalogue of event types and what each carries: no organisation data.',
  'GET /v1/clients': "The caller's own client list: only organisations their own account holds a WS role in, as counts.",
  'GET /v1/dev/people': 'Development only: answers dev- keys outside production and 404s for everyone else.',
  'POST /v1/staff/invite': 'Staff app: a one-time invite token in the body, no manager session.',
  'POST /v1/staff/join': 'Staff app: a one-time invite token, no manager session.',
  'POST /v1/staff/login': 'Staff app sign-in.',
  'POST /v1/staff/logout': 'Staff app sign-out.',
  'GET /v1/staff/me': "Staff app: the caller's own shifts and hours, under the staff session.",
  'POST /v1/staff/clock-in': 'Staff app: the caller clocking themselves, under the staff session and geofence.',
  'POST /v1/staff/clock-out': 'Staff app: the caller clocking themselves, under the staff session and geofence.',
  'POST /v1/staff/pulse': "Staff app: the caller's own answer to the weekly pulse, under the staff session.",
  'POST /v1/staff/chat': 'Staff app: the caller asking for a chat for themselves, under the staff session.',
  'POST /v1/staff/rewards': 'Staff app: the caller opting themselves in or out of Hospitality Rewards, under the staff session.',
  'GET /v1/staff/notifications': "Staff app: the caller's own notifications, under the staff session.",
  'POST /v1/staff/notifications/read': "Staff app: marks the caller's own notifications read, under the staff session.",
  'GET /v1/staff/team': "Staff app: names and times of who shares the caller's own published shifts, under the staff session.",
  'GET /v1/staff/board': 'Staff app: open shifts and swaps the caller is eligible for, under the staff session.',
  'GET /v1/staff/shifts/:id/swap-options': "Staff app: colleagues who could take one of the caller's own shifts, under the staff session.",
  'POST /v1/staff/open-shifts/:id/claim': 'Staff app: the caller asks for an open shift; a manager with rota.publish decides.',
  'POST /v1/staff/requests/holiday': 'Staff app: the caller asks for holiday; a manager with team.manage decides.',
  'POST /v1/staff/requests/time-off': 'Staff app: the caller asks for time off; a manager with hr.manage decides.',
  'POST /v1/staff/requests/availability': 'Staff app: the caller proposes their availability; a manager with team.manage decides.',
  'PUT /v1/staff/unavailable': "Staff app: the caller's own one-off unavailable days, under the staff session.",
  'POST /v1/staff/requests/:id/cancel': 'Staff app: the caller withdraws their own request, under the staff session.',
  'POST /v1/staff/sick': 'Staff app: the caller reports their own sickness, under the staff session.',
  'POST /v1/staff/sick/back': 'Staff app: the caller ends their own sickness absence, under the staff session.',
  'POST /v1/staff/fit-note': 'Staff app: the caller files their own fit note, under the staff session.',
  'GET /v1/staff/push': "Staff app: the server's public push key and the caller's own phones, under the staff session.",
  'POST /v1/staff/push/subscribe': "Staff app: the caller turns on notifications for their own phone, under the staff session.",
  'POST /v1/staff/push/unsubscribe': "Staff app: the caller turns off notifications for their own phone, under the staff session.",
  'POST /v1/staff/push/test': "Staff app: a test notification to the caller's own phones, under the staff session.",
  'GET /v1/kiosk/board': "Kiosk: today's rota at the paired site only, under the kiosk's own credential, no manager session.",
  'POST /v1/kiosk/tap': "Kiosk: a card tap at the paired site, under the kiosk's own credential.",
  'POST /v1/kiosk/clock': "Kiosk: clocking by name, limited to today's rota at the paired site, under the kiosk's own credential.",
  'PUT /v1/staff/kiosk-pin': "Staff app: the caller setting their own kiosk PIN, under the staff session.",
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
