import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { seedHrRecords, seedState } from '../src/engine/seed';
import { sessionUser } from './auth';
import { HttpError } from './context';
import { hashPassword } from './passwords';
import { isSandbox, londonDate, nextLondonMidnight, sandboxExpired, sandboxId } from './sandbox';
import { seedUsers } from './seedUsers';
import { createSession, SESSION_SECONDS, sessionCookie } from './session';
import { audit, type Store } from './store';

// The public demo, on the live system alongside customers. Anyone who presses "Start the demo" gets
// a sandbox organisation of their own, seeded with the demo group, and is signed in as its admin
// without creating an account. Every sandbox is wiped when London's date changes at midnight.
//
// Segregation, in layers:
// 1. Identity. Sandboxes and their visitors are told apart by id (server/sandbox.ts). Visitors cannot
//    sign in with a password, change one, reset one, or hold an integration key.
// 2. Routes. A visitor's session reaches only the routes in SANDBOX_ROUTES marked true; anything
//    else, including any route added later, is refused until someone decides it is safe.
// 3. Data. Every request loads one organisation, the caller's own. Deletion works on sandbox ids
//    only, enforced in the store and again in its SQL.
// 4. Payroll. Sandboxes always run on an in-process TeamPay simulator with its own random secret,
//    never the real provider, whatever the deployment is connected to.
// 5. Capacity and cost. Daily caps on sandboxes in total and per visitor address, and on the
//    rota assistant per sandbox and in total.
// 6. Kill switch. Unset PRESHIFT_DEMO and no sandbox can start, and existing visitors are refused.

/** Sandboxes that can be started in one London day, across all visitors. */
export const MAX_SANDBOXES_PER_DAY = 500;
/** Sandboxes one visitor address can start in a day. */
export const MAX_SANDBOXES_PER_ADDRESS = 10;
/** Claude calls one sandbox may make on the shared demo key. One assistant request is several calls. */
export const ASSISTANT_CALLS = 40;
/** Claude calls all sandboxes together may make in a day. */
export const ASSISTANT_CALLS_PER_DAY = 1500;
const SWEEP_EVERY_MS = 10 * 60 * 1000;

/**
 * Every route a demo visitor's session can reach, by method and route pattern: true allowed, false
 * refused. A route missing from this list is refused, and a test fails until it is added here, so
 * each new feature gets a deliberate decision about the demo.
 */
export const SANDBOX_ROUTES: Record<string, boolean> = {
  // Reading the sandbox's own data.
  'GET /v1/sites': true,
  'GET /v1/shifts': true,
  'GET /v1/entities': true,
  'GET /v1/employees': true,
  'GET /v1/employees/:id': true,
  'GET /v1/roles': true,
  'GET /v1/rota/week': true,
  'GET /v1/demand-rules': true,
  'GET /v1/forecast': true,
  'GET /v1/hr/overview': true,
  // Staff requests and open shifts work on the visitor's own sandbox, as the rota does.
  'GET /v1/requests': true,
  // The morning email: visitors may look at it; nothing is ever emailed from a sandbox.
  'GET /v1/requests/digest': true,
  'PUT /v1/requests/digest': true,
  'POST /v1/requests/:id/approve': true,
  'POST /v1/requests/:id/decline': true,
  'GET /v1/open-shifts': true,
  'POST /v1/open-shifts': true,
  'DELETE /v1/open-shifts/:id': true,
  'GET /v1/hr/records': true,
  'GET /v1/time-entries': true,
  'GET /v1/time-entries/break-check': true,
  'GET /v1/time-entries/compare': true,
  'GET /v1/integrations/payroll': true,
  'GET /v1/integrations/payroll/outbox': true,
  'GET /v1/payroll/submissions': true,
  'GET /v1/payroll/runs': true,
  'GET /v1/privacy/register': true,
  'GET /v1/privacy/retention': true,
  'GET /v1/privacy/requests': true,
  'GET /v1/journal': true,
  // Working the rota, people, time and payroll inside the sandbox.
  'POST /v1/shifts': true,
  'PATCH /v1/shifts/:id': true,
  'DELETE /v1/shifts/:id': true,
  'POST /v1/rota/build': true,
  'POST /v1/rota/clear': true,
  'POST /v1/rota/publish': true,
  'PUT /v1/rota/week': true,
  'PUT /v1/forecast': true,
  'POST /v1/forecast/from-takings': true,
  'POST /v1/employees': true,
  'PATCH /v1/employees/:id': true,
  'POST /v1/employees/:id/leaver': true,
  'POST /v1/employees/:id/absences': true,
  'PATCH /v1/employees/:id/absences/:absenceId': true,
  'DELETE /v1/employees/:id/absences/:absenceId': true,
  'PUT /v1/employees/:id/hr': true,
  'PUT /v1/employees/:id/badge': true,
  'DELETE /v1/employees/:id/badge': true,
  'PATCH /v1/entities/:id': true,
  'PUT /v1/sites/:id/geofence': true,
  'DELETE /v1/sites/:id/geofence': true,
  'POST /v1/hr/records': true,
  'PATCH /v1/hr/records/:id': true,
  'DELETE /v1/hr/records/:id': true,
  'POST /v1/time-entries': true,
  'POST /v1/time-entries/clock-in': true,
  'POST /v1/time-entries/approve': true,
  'POST /v1/time-entries/tap': true,
  // Kiosks in the sandbox can be listed and removed; pairing one is refused below.
  'GET /v1/kiosks': true,
  'DELETE /v1/kiosks/:id': true,
  'POST /v1/time-entries/:id/clock-out': true,
  'PATCH /v1/time-entries/:id': true,
  'POST /v1/integrations/payroll/sync-employees': true,
  'POST /v1/integrations/payroll/outbox/:id/retry': true,
  'POST /v1/payroll/submissions': true,
  // Pay changes waiting on finance approval, inside the sandbox.
  'GET /v1/pay-changes': true,
  'POST /v1/employees/:id/pay-changes': true,
  'POST /v1/pay-changes/:id/approve': true,
  'POST /v1/pay-changes/:id/reject': true,
  'POST /v1/pay-changes/:id/withdraw': true,
  // Whether a till is connected: never in a sandbox, so this only ever says not connected.
  'GET /v1/integrations/epos': true,
  'POST /v1/dev/simulate-clocking': true,
  'POST /v1/dev/teampay/run-payroll': true,
  'PUT /v1/privacy/policy': true,
  'POST /v1/privacy/retention/apply': true,
  'POST /v1/privacy/requests': true,
  'PATCH /v1/privacy/requests/:id': true,
  'POST /v1/privacy/subjects/:id/export': true,
  'POST /v1/privacy/subjects/:id/erase': true,
  'GET /v1/sales': true,
  'PUT /v1/sales': true,
  'DELETE /v1/sales': true,
  'PUT /v1/sites/:id/travel/:toId': true,
  'DELETE /v1/sites/:id/travel/:toId': true,
  'PUT /v1/rota/weeks': true,
  // Managers' overrides of the rest rules, kept in the sandbox's own rota.
  'GET /v1/rota/overrides': true,
  'POST /v1/rota/overrides': true,
  'DELETE /v1/rota/overrides/:id': true,
  // Business set-up works on the caller's organisation only, so a prospect can set up their own.
  'GET /v1/setup/status': true,
  'PUT /v1/setup': true,
  'POST /v1/setup/start-fresh': true,
  // The access controls, shown on the sandbox's fictional team. None of them has an account, and
  // anything that issues an invitation, a reset link or touches an authenticator is refused below.
  'GET /v1/me': true,
  'GET /v1/me/authenticator': true,
  'GET /v1/access/catalogue': true,
  'GET /v1/access/health': true,
  'GET /v1/access/emails': true,
  'GET /v1/access/reviews': true,
  'POST /v1/access/reviews': true,
  'GET /v1/access/audit': true,
  'GET /v1/users': true,
  'GET /v1/users/:id': true,
  'PATCH /v1/users/:id': true,
  // Your own name and title, on the sandbox's own record: no account, password or authenticator.
  'PATCH /v1/me': true,
  'POST /v1/users/:id/grants': true,
  'PATCH /v1/users/:id/grants/:mid': true,
  'DELETE /v1/users/:id/grants/:mid': true,
  'POST /v1/users/:id/suspend': true,
  'DELETE /v1/users/:id/invite': true,
  // Refused: each of these issues an invitation or a reset link, which could bring a real person
  // into a sandbox, or acts on an account's password or authenticator.
  'POST /v1/users': false,
  // Clients are real organisations made by a WS partner: never from a demo.
  'GET /v1/clients': false,
  'POST /v1/clients': false,
  'POST /v1/clients/:orgId/owner-invite': false,
  'DELETE /v1/clients/:orgId': false,
  'POST /v1/users/bulk': false,
  'POST /v1/users/:id/reactivate': false,
  'POST /v1/users/:id/resend-invite': false,
  'POST /v1/users/:id/reset-password': false,
  'POST /v1/users/:id/reset-authenticator': false,
  'POST /v1/me/authenticator/start': false,
  'POST /v1/me/authenticator/confirm': false,
  'POST /v1/me/authenticator/verify': false,
  'POST /v1/me/authenticator/recovery-codes': false,
  // The forecast model, the weekly moves, the scorecard and the calendar, on the sandbox's own sample data.
  'GET /v1/actuals': true,
  'PUT /v1/actuals': true,
  'GET /v1/forecast/adjustments': true,
  'POST /v1/forecast/adjustments': true,
  'DELETE /v1/forecast/adjustments/:id': true,
  'POST /v1/forecast/model': true,
  'PATCH /v1/forecast/hour': true,
  'GET /v1/forecast/accuracy': true,
  'GET /v1/forecast/accuracy/report': true,
  'POST /v1/coach/moves': true,
  'POST /v1/coach/apply': true,
  'POST /v1/coach/dismiss': true,
  'GET /v1/coach/history': true,
  'GET /v1/scorecard': true,
  'GET /v1/programmes': true,
  'GET /v1/weather': true,
  'GET /v1/event-feeds': true,
  'GET /v1/local-events': true,
  'POST /v1/local-events': true,
  'DELETE /v1/local-events/:id': true,
  'PUT /v1/sites/:id/nation': true,
  'GET /v1/school-holidays': true,
  'POST /v1/school-holidays': true,
  'DELETE /v1/school-holidays/:id': true,
  'GET /v1/calendar': true,
  'GET /v1/reminders': true,
  'POST /v1/reminders': true,
  'PUT /v1/bookings': true,
  'POST /v1/bookings/import': true,
  'GET /v1/bookings': true,
  'GET /v1/bookings/status': true,
  // Refused: the programme's baseline, sign-offs and gain share are the WS lead's, and nobody in a
  // sandbox is one.
  'PUT /v1/programmes/:siteId': false,
  'PUT /v1/programmes/:siteId/baseline': false,
  'POST /v1/programmes/:siteId/signoffs': false,
  'DELETE /v1/programmes/:siteId/signoffs/:milestoneId': false,
  'POST /v1/programmes/:siteId/verifications': false,
  // Refused: benchmarks are drawn from customers' figures, which a visitor must never see.
  'PUT /v1/settings/benchmarking': false,
  'GET /v1/benchmarks': false,
  // Refused: these have the live system fetch weather and any feed address a visitor chose.
  'POST /v1/outside/refresh': false,
  'POST /v1/event-feeds': false,
  'DELETE /v1/event-feeds/:id': false,
  // Refused: an API key would outlive the visitor's session, and a webhook would have the live
  // system call any address a visitor chose.
  'GET /v1/api-keys': false,
  'POST /v1/api-keys': false,
  'DELETE /v1/api-keys/:id': false,
  'GET /v1/api-keys/:id/calls': false,
  'GET /v1/webhooks/events': false,
  'GET /v1/webhooks': false,
  'POST /v1/webhooks': false,
  'PATCH /v1/webhooks/:id': false,
  'DELETE /v1/webhooks/:id': false,
  'POST /v1/webhooks/:id/rotate-secret': false,
  'POST /v1/webhooks/:id/test': false,
  'GET /v1/webhooks/deliveries': false,
  'POST /v1/webhooks/deliveries/:id/retry': false,
  // Refused: connecting a till hands the live system a visitor's Square token to call Square with.
  'PUT /v1/integrations/epos': false,
  'DELETE /v1/integrations/epos': false,
  'GET /v1/integrations/epos/locations': false,
  'PUT /v1/integrations/epos/mapping': false,
  'POST /v1/integrations/epos/sync': false,
  // Refused: keys and email are the live system's, not a visitor's.
  'PUT /v1/settings/claude-limits': false,
  // Refused: a sandbox is never billed, and nobody pays for the demo.
  'GET /v1/billing': false,
  'POST /v1/billing/checkout': false,
  'POST /v1/billing/portal': false,
  'POST /v1/billing/sites': false,
  'GET /v1/settings': false,
  'PUT /v1/settings/claude-api-key': false,
  'PUT /v1/settings/email': false,
  'DELETE /v1/settings/email': false,
  'POST /v1/access/emails/:id/check': false,
  // Refused: right to work copies are identity documents. A prospect must not be invited to put a
  // real passport into a public demo, and there are none in it to read.
  'POST /v1/employees/:id/right-to-work/documents': false,
  'GET /v1/employees/:id/right-to-work/documents/:docId': false,
  'GET /v1/employees/:id/absences/:absenceId/fit-notes/:docId': false,
  'GET /v1/employees/:id/right-to-work/documents/:docId/access': false,
  'DELETE /v1/employees/:id/right-to-work/documents/:docId': false,
  // Refused: these call postcode and TfL services on the live system's quota at a visitor's say.
  'PUT /v1/sites/:id/location': false,
  'POST /v1/sites/travel/refresh': false,
  // Refused: staff logins are matched by email across the whole system, so a visitor creating one
  // could learn whether an address belongs to a customer's staff.
  'GET /v1/staff-logins': false,
  'POST /v1/staff-logins/:id/invite': false,
  'DELETE /v1/staff-logins/:id': false,
  // Refused: pairing signs the visitor out of the iPad they pair, and with it their sandbox, and
  // hands the device a credential lasting a year for a sandbox that ends at midnight.
  'POST /v1/kiosks': false,
  'GET /v1/staff-logins/review': false,
  // Support is people answering people: a demo visitor is no named person, and nobody real is on the other end.
  'GET /v1/support/tickets': false,
  'POST /v1/support/tickets': false,
  'POST /v1/support/answered': false,
  'POST /v1/support/tickets/:id/vote': false,
  'POST /v1/support/tickets/:id/comments': false,
  'PATCH /v1/support/tickets/:id': false,
  'POST /v1/staff-logins/review': false,
  // Refused: for signing in as the seeded team in development only.
  'GET /v1/dev/people': false,
  // Not reached with a visitor's session: signature-checked, or the staff app's own sign-in.
  'POST /v1/integrations/teampay/webhook/:orgId': false,
  'POST /v1/integrations/resend/webhook/:orgId': false,
  'POST /v1/integrations/stripe/webhook': false,
  'POST /v1/staff/invite': false,
  'POST /v1/staff/join': false,
  'POST /v1/staff/login': false,
  'POST /v1/staff/logout': false,
  'GET /v1/staff/me': false,
  'POST /v1/staff/clock-in': false,
  'POST /v1/staff/clock-out': false,
  'POST /v1/staff/break-start': false,
  'POST /v1/staff/break-end': false,
  'GET /v1/staff/notifications': false,
  'POST /v1/staff/notifications/read': false,
  'GET /v1/staff/team': false,
  'GET /v1/staff/board': false,
  'GET /v1/staff/shifts/:id/swap-options': false,
  'POST /v1/staff/swaps': false,
  'POST /v1/staff/swaps/:id/accept': false,
  'POST /v1/staff/swaps/:id/decline': false,
  'POST /v1/staff/open-shifts/:id/claim': false,
  'POST /v1/staff/requests/holiday': false,
  'POST /v1/staff/requests/time-off': false,
  'POST /v1/staff/requests/availability': false,
  'PUT /v1/staff/unavailable': false,
  'POST /v1/staff/requests/:id/cancel': false,
  'POST /v1/staff/sick': false,
  'POST /v1/staff/sick/back': false,
  'POST /v1/staff/fit-note': false,
  'GET /v1/kiosk/board': false,
  'POST /v1/kiosk/tap': false,
  'POST /v1/kiosk/clock': false,
};

export const sandboxRouteAllowed = (method: string, route: string | undefined) => SANDBOX_ROUTES[`${method} ${route}`] === true;

const refused = (message: string) => new HttpError(403, 'demo', message);

/**
 * Refuses a demo visitor anything outside the allowlist, and everything once the demo is switched
 * off. Runs after authentication on the whole /v1 API; customers are untouched.
 */
export function sandboxGuard(enabled: boolean) {
  return async (req: FastifyRequest) => {
    if (!isSandbox(req.principal?.orgId)) return;
    if (!enabled) throw refused('The public demo has been switched off.');
    if (!sandboxRouteAllowed(req.method, req.routeOptions.url)) {
      throw refused('This is the public demo, so invitations, passwords, keys, webhooks, email, identity documents, staff app logins and support tickets are switched off here.');
    }
  };
}

interface DayCounters {
  sandboxes: number;
  addresses: Record<string, number>;
}

const daySetting = (date: string) => `demo_day:${date}`;
export const assistantCallsSetting = (orgId: string) => `demo_assistant_calls:${orgId}`;

async function readDay(store: Store, date: string): Promise<DayCounters> {
  try {
    const raw = await store.getSetting(daySetting(date));
    if (raw) return { sandboxes: 0, addresses: {}, ...JSON.parse(raw) };
  } catch {
    // A damaged counter starts again rather than blocking the demo.
  }
  return { sandboxes: 0, addresses: {} };
}

const writeDay = (store: Store, date: string, day: DayCounters) => store.setSetting(daySetting(date), JSON.stringify(day));

const assistantDaySetting = (date: string) => `demo_assistant_day:${date}`;

/**
 * Takes one Claude call from a sandbox's allowance and the day's, or says why not. Both are counted
 * atomically, so calls arriving together cannot slip past either cap between them.
 */
export async function takeAssistantCall(store: Store, orgId: string, now = Date.now()): Promise<string | null> {
  if ((await store.addToSetting(assistantCallsSetting(orgId), 1)) > ASSISTANT_CALLS) {
    return 'This demo has used its share of the rota assistant. Book a demo to see more of it.';
  }
  if ((await store.addToSetting(assistantDaySetting(londonDate(now)), 1)) > ASSISTANT_CALLS_PER_DAY) {
    return 'The rota assistant has reached its limit for the demo today. Try again tomorrow.';
  }
  return null;
}

/**
 * The midnight reset: deletes every sandbox made before today's London date, with its visitor,
 * staff logins and counters. Runs from the scheduled job either side of midnight and as visitors
 * arrive; visitors' sessions stop working at midnight whether or not it has run yet.
 */
export async function sweepSandboxes(store: Store, now = Date.now()): Promise<number> {
  let removed = 0;
  for (const orgId of await store.sandboxIds()) {
    if (!sandboxExpired(orgId, now)) continue;
    await store.setSetting(assistantCallsSetting(orgId), null);
    await store.deleteSandbox(orgId);
    removed++;
  }
  // Counters for the past week; older ones went with earlier resets.
  for (let d = 1; d <= 7; d++) {
    const date = londonDate(now - d * 86_400_000);
    await store.setSetting(daySetting(date), null);
    await store.setSetting(assistantDaySetting(date), null);
  }
  return removed;
}

const secure = (req: FastifyRequest) => req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';

/** The visitor's address, as the platform reports it. Only ever kept as a keyed hash, per day. */
function address(req: FastifyRequest): string {
  const forwarded = req.headers['x-real-ip'] ?? String(req.headers['x-forwarded-for'] ?? '').split(',')[0];
  return (typeof forwarded === 'string' && forwarded.trim()) || req.ip;
}

/** A form on another site must not be able to start sandboxes in a visitor's browser. */
function sameOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] === undefined || req.headers['sec-fetch-site'] === 'same-origin';
  try {
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '');
    // Compare as URLs on the origin's own scheme, so a default port written out still matches.
    const url = new URL(origin);
    return url.host === new URL(`${url.protocol}//${host}`).host;
  } catch {
    return false;
  }
}

export function demoRoutes(app: FastifyInstance, store: Store, options: { enabled: boolean; appPath: string; demoPage: string }) {
  const hidden = { schema: { hide: true } };
  let lastSweep = 0;

  const toApp = (reply: FastifyReply) => reply.code(303).header('location', options.appPath).send();

  async function currentSandbox(req: FastifyRequest) {
    const user = await sessionUser(req.headers.cookie, store);
    return user && isSandbox(user.orgId) ? user : null;
  }

  // The start page. Opening it never creates anything, so link previews and crawlers cost nothing.
  app.get('/demo', hidden, async (req, reply) => {
    if (!options.enabled) return reply.code(302).header('location', '/login').send();
    if (await currentSandbox(req)) return toApp(reply);
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(await readFile(options.demoPage));
  });

  // Start a sandbox. A visitor already in one goes back to it; fresh=1 replaces it with a new one.
  app.post<{ Body: Record<string, string> }>('/demo/start', hidden, async (req, reply) => {
    if (!options.enabled) return reply.code(404).send({ error: 'not_found', message: 'Not found' });
    const back = (error: string) => reply.code(303).header('location', `/demo?error=${error}`).send();
    if (!sameOrigin(req)) return back('origin');
    const current = await currentSandbox(req);
    if (current && req.body?.fresh !== '1') return toApp(reply);

    const now = Date.now();
    if (now - lastSweep > SWEEP_EVERY_MS) {
      lastSweep = now;
      void sweepSandboxes(store, now).catch((err) => app.log.error(err));
    }

    const date = londonDate(now);
    const day = await readDay(store, date);
    const who = createHmac('sha256', await store.sessionSecret()).update(`${date}:${address(req)}`).digest('hex').slice(0, 16);
    if (day.sandboxes >= MAX_SANDBOXES_PER_DAY || (day.addresses[who] ?? 0) >= MAX_SANDBOXES_PER_ADDRESS) {
      return back('busy');
    }
    await writeDay(store, date, { ...day, sandboxes: day.sandboxes + 1, addresses: { ...day.addresses, [who]: (day.addresses[who] ?? 0) + 1 } });

    const orgId = sandboxId(now, randomBytes(6).toString('hex'));
    if (await store.has(orgId)) throw new HttpError(409, 'conflict', 'Try again.');
    const org = await store.load(orgId);
    org.state = seedState();
    org.hrRecords = seedHrRecords();
    // The demo's fictional team, so the Access tab has people to show. None of them can sign in:
    // they have no accounts. The visitor has no record, so they hold the sandbox's full access.
    const people = seedUsers(londonDate(now));
    org.users = people.users;
    org.accessReviews = people.reviews;
    // An address no one can receive mail at, on no real domain. Nobody ever types the password:
    // the visitor is signed in by the cookie below, and password sign-in refuses sandbox accounts.
    const user = {
      email: `visitor@${orgId}.invalid`,
      orgId,
      role: 'admin' as const,
      ...(await hashPassword(randomBytes(24).toString('hex'))),
      createdAt: new Date(now).toISOString(),
      sessionsValidFrom: 0,
      failedAttempts: 0,
      lockedUntil: 0,
    };
    if (!(await store.createUser(user))) throw new HttpError(409, 'conflict', 'Try again.');
    audit(org, user.email, 'demo.sandbox_created');
    await store.save(org);
    // Starting again clears the old copy straight away rather than leaving it until midnight.
    if (current) await store.deleteSandbox(current.orgId).catch((err) => app.log.error(err));

    const token = await createSession(user, await store.sessionSecret(), now);
    const untilMidnight = Math.max(60, Math.floor((nextLondonMidnight(now) - now) / 1000));
    return reply
      .code(303)
      .header('set-cookie', sessionCookie(token, secure(req), Math.min(SESSION_SECONDS, untilMidnight)))
      .header('location', options.appPath)
      .send();
  });
}
