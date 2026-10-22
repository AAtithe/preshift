import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { HttpError } from './context';
import type { OrgData, Store } from './store';

/**
 * Outbound webhooks: a partner system (EPOS, BI, an in-house tool) registers an https address
 * and the events it wants, and Preshift posts each one there, signed, as it happens.
 *
 * Events are thin on purpose. Each carries what changed and the ids to fetch, never pay, dates of
 * birth or other personal data, so a leaked or misdirected webhook gives nothing away. The partner
 * reads the detail back through the API with a key scoped to what it is allowed to see.
 *
 * Events are queued in the same save as the change that caused them, from the audit trail, so an
 * event is never sent for a change that was rolled back and never lost for one that was saved.
 */

export interface WebhookEndpoint {
  id: string;
  url: string;
  /** Event types, or '*' for all. */
  events: string[];
  description?: string;
  /** Signing secret, shown once when the endpoint is made. */
  secret: string;
  active: boolean;
  createdAt: string;
  createdBy: string;
}

export interface WebhookEvent {
  id: string;
  type: string;
  createdAt: string;
  orgId: string;
  data: Record<string, unknown>;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  event: WebhookEvent;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  lastStatus?: number;
  deliveredAt?: number;
}

/** What each public event means. The type is the audit action that raises it. */
export const WEBHOOK_EVENTS: Record<string, string> = {
  'shift.created': 'A shift was added. data.id is the shift.',
  'shift.updated': 'A shift was changed. data.id is the shift.',
  'shift.deleted': 'A shift was removed. data.id is the shift.',
  'rota.built': 'Sites were built from the forecast. data.siteIds, data.weekStart.',
  'rota.replaced': "A site's week was replaced in one go. data.siteId, data.weekStart.",
  'rota.assistant_applied': "The rota assistant's draft was applied. data.siteId or data.siteIds, data.weekStart, data.shifts. Never the instruction typed, which can name people.",
  'rota.cleared': 'Sites were cleared for a week. data.siteIds, data.weekStart.',
  'rota.published': 'A week was published to staff. data.siteIds, data.weekStart.',
  'forecast.upserted': 'Hourly sales and covers were loaded. data.rows is the count.',
  'employee.created': 'A starter was added. data.id is the employee.',
  'employee.updated': 'An employee record changed. data.id, data.fields (names only).',
  'employee.leaver': 'Someone was made a leaver. data.id, data.leaveDate.',
  'pay.change_proposed': 'A pay change was proposed and waits for finance. data.id is the change, data.employeeId. Pay stays as it is.',
  'pay.change_approved': 'Finance approved a pay change; employee.updated follows for the new pay. data.id, data.employeeId.',
  'pay.change_rejected': 'Finance rejected a pay change. data.id, data.employeeId.',
  'pay.change_withdrawn': 'A waiting pay change was taken back. data.id, data.employeeId.',
  'tronc.scheme_saved': "A site's tronc scheme was recorded or changed. data.siteId, data.fields (names only).",
  'time.manual_entry': 'A time entry was entered by hand. data.id is the entry.',
  'time.edited': 'A time entry was changed. data.id, data.fields.',
  'time.approved': 'Clocked time was approved for payroll. data.ids.',
  'time.phone_clock_in': 'Someone clocked in on their phone. data.id is the entry.',
  'time.phone_clock_out': 'Someone clocked out on their phone. data.id is the entry.',
  'payroll.hours_submitted': 'Approved hours were sent to payroll for a company. data.id, data.entityId.',
  'payroll.run_completed': 'A pay run came back and was reconciled. data.run, data.entityId, data.variance.',
  'hr.profile.updated': "Someone's personnel details changed. data.id is the employee, data.fields (names only).",
  'hr.absence.created': 'Absence was recorded. data.id is the employee, data.absenceId. Never the type or reason.',
  'hr.absence.updated': 'An absence was changed. data.id, data.absenceId, data.fields (names only).',
  'hr.absence.deleted': 'An absence was removed. data.id, data.absenceId.',
  'hr.record.created': 'Training, a review, a document or a note was added. data.id, data.employeeId, data.kind.',
  'hr.record.updated': 'One of those was changed. data.id, data.employeeId, data.kind, data.fields (names only).',
  'hr.record.deleted': 'One of those was removed. data.id, data.employeeId, data.kind.',
  'employee.rtw_document.added': 'A right to work copy was stored. data.id is the employee, data.documentId.',
  'employee.rtw_document.deleted': 'A right to work copy was deleted. data.id, data.documentId.',
};

/**
 * HR events say something about a named person's health, conduct or immigration status, even as
 * bare ids. They are never part of '*': an endpoint names each one it wants, and only someone who
 * can read personnel files may subscribe to them (server/routes/developers.ts).
 */
export const isHrEvent = (type: string) => type.startsWith('hr.') || type.startsWith('employee.rtw_document.');

export const MAX_ENDPOINTS = 10;
const MAX_ATTEMPTS = 8;
/** Recent deliveries kept for the delivery log; pending ones are never trimmed. */
const KEEP_DONE = 200;
/** A partner endpoint gets this long to answer; a slow one must never hold up the GM's request. */
const TIMEOUT_MS = 3000;
const backoffMs = (attempt: number) => Math.min(30_000 * 2 ** (attempt - 1), 3_600_000);

/** Detail fields that may go into an event. Anything else in the audit detail stays inside Preshift. */
// Never an absence's type (sickness is health data), its dates, a file name or a document's hash.
const SAFE_FIELDS = [
  'id', 'ids', 'siteId', 'siteIds', 'weekStart', 'entityId', 'fields', 'leaveDate', 'rows', 'run', 'variance', 'count', 'added', 'unfilled',
  'published', 'removed', 'shifts', 'hours', 'employeeId', 'absenceId', 'documentId', 'kind',
];

const subscribes = (e: WebhookEndpoint, type: string) =>
  e.active && (e.events.includes(type) || (e.events.includes('*') && !isHrEvent(type)));

/** Called from audit(): queues the event for every endpoint that wants it. */
export function queueEvent(org: OrgData, type: string, detail: Record<string, unknown> | undefined) {
  if (!WEBHOOK_EVENTS[type]) return;
  // Disciplinary, grievance and capability cases are seen only by people with hr.cases: never a system.
  if (isHrEvent(type) && detail?.kind === 'case') return;
  const targets = (org.webhooks ?? []).filter((e) => subscribes(e, type));
  if (targets.length === 0) return;
  const data = Object.fromEntries(Object.entries(detail ?? {}).filter(([k]) => SAFE_FIELDS.includes(k)));
  const event: WebhookEvent = { id: `evt_${randomUUID()}`, type, createdAt: new Date().toISOString(), orgId: org.orgId, data };
  org.webhookDeliveries ??= [];
  for (const endpoint of targets) {
    org.webhookDeliveries.push({ id: randomUUID(), endpointId: endpoint.id, event, status: 'pending', attempts: 0, nextAttemptAt: Date.now() });
  }
}

/**
 * The signature header. HMAC-SHA256 over `${timestamp}.${body}` with the endpoint's secret, so a
 * receiver can check both who sent it and that it is fresh (reject anything older than five minutes).
 */
export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

export const newWebhookSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

/**
 * Only https to a public address. A webhook is the one place a customer can make Preshift's servers
 * call out, so it must not be pointed at our own network or a cloud metadata address. Plain http is
 * allowed to localhost outside production, for building an integration on a laptop.
 */
export function checkWebhookUrl(raw: unknown, production: boolean): string {
  let url: URL;
  try {
    url = new URL(typeof raw === 'string' ? raw.trim() : '');
  } catch {
    throw new HttpError(400, 'invalid_url', 'Enter the full address to send events to, starting https://.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (local && !production && (url.protocol === 'http:' || url.protocol === 'https:')) return url.toString();
  if (url.protocol !== 'https:') throw new HttpError(400, 'invalid_url', 'Webhook addresses must start https://.');
  if (url.username || url.password) throw new HttpError(400, 'invalid_url', 'Put no username or password in the address; check the signature instead.');
  if (local || host.endsWith('.local') || host.endsWith('.internal') || privateAddress(host)) {
    throw new HttpError(400, 'invalid_url', 'Webhook addresses must be on the public internet.');
  }
  return url.toString();
}

function privateAddress(host: string): boolean {
  const kind = isIP(host);
  if (kind === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (kind === 6) return host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80') || host.startsWith('::ffff:');
  return false;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number }>;

/**
 * Sends due events, each endpoint's in the order they happened, retrying with backoff up to eight
 * times. An endpoint that is down holds back only its own events. Runs inside the request that
 * raised the events (in parallel, each with a short timeout) and again on the daily cron.
 */
export async function deliverWebhooks(org: OrgData, fetcher: Fetch = fetch as unknown as Fetch, now = Date.now()) {
  const deliveries = org.webhookDeliveries ?? [];
  const due = deliveries.filter((d) => d.status === 'pending' && d.nextAttemptAt <= now);
  if (due.length === 0) return;
  const byEndpoint = new Map<string, WebhookDelivery[]>();
  for (const d of due) byEndpoint.set(d.endpointId, [...(byEndpoint.get(d.endpointId) ?? []), d]);

  await Promise.all(
    [...byEndpoint].map(async ([endpointId, items]) => {
      const endpoint = (org.webhooks ?? []).find((e) => e.id === endpointId);
      for (const d of items) {
        if (!endpoint || !endpoint.active) {
          d.status = 'failed';
          d.lastError = endpoint ? 'Endpoint turned off' : 'Endpoint removed';
          continue;
        }
        const ok = await send(endpoint, d, fetcher);
        // Keep this endpoint's events in order: once one fails, the rest wait for its retry.
        if (!ok) {
          for (const later of items.slice(items.indexOf(d) + 1)) later.nextAttemptAt = d.nextAttemptAt;
          break;
        }
      }
    }),
  );
  trim(org);
}

async function send(endpoint: WebhookEndpoint, d: WebhookDelivery, fetcher: Fetch): Promise<boolean> {
  const body = JSON.stringify(d.event);
  try {
    const res = await fetcher(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Preshift-Webhooks/1',
        'preshift-event-id': d.event.id,
        'preshift-event-type': d.event.type,
        'preshift-signature': signWebhook(endpoint.secret, body),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    d.lastStatus = res.status;
    if (res.status >= 200 && res.status < 300) {
      d.status = 'delivered';
      d.deliveredAt = Date.now();
      d.lastError = undefined;
      return true;
    }
    return retryLater(d, `Answered ${res.status}`);
  } catch (err) {
    return retryLater(d, (err as Error).name === 'TimeoutError' ? `No answer within ${TIMEOUT_MS / 1000} seconds` : (err as Error).message);
  }
}

function retryLater(d: WebhookDelivery, error: string): false {
  d.attempts++;
  d.lastError = error;
  if (d.attempts >= MAX_ATTEMPTS) d.status = 'failed';
  else d.nextAttemptAt = Date.now() + backoffMs(d.attempts);
  return false;
}

function trim(org: OrgData) {
  const deliveries = org.webhookDeliveries ?? [];
  const done = deliveries.filter((d) => d.status !== 'pending');
  if (done.length <= KEEP_DONE) return;
  const drop = new Set(done.slice(0, done.length - KEEP_DONE));
  org.webhookDeliveries = deliveries.filter((d) => !drop.has(d));
}

/** The daily sweep: retries every organisation's due events. */
export async function deliverAllWebhooks(store: Store, fetcher?: Fetch) {
  for (const orgId of await store.orgIds()) {
    const org = await store.load(orgId);
    if (!(org.webhookDeliveries ?? []).some((d) => d.status === 'pending' && d.nextAttemptAt <= Date.now())) continue;
    await deliverWebhooks(org, fetcher);
    try {
      await store.save(org);
    } catch {
      // A request changed this organisation meanwhile; it delivers its own events.
    }
  }
}
