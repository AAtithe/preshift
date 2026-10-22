// What became of each email Preshift sent: Resend's reports, by webhook or by asking, kept against
// the person. A link that never arrived must not look the same as one that did.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MailStatus, MailView } from '../src/engine/mail';
import type { EmailSettings } from './mail';
import type { MailEventType, MailKind, MailRecord, OrgData } from './store';

/** Signed reports older or newer than this are refused, so a captured one cannot be replayed later. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
/** How long the log keeps an email, and at most how many, so the organisation's record stays small. */
const KEEP_DAYS = 180;
const KEEP_MAX = 2000;

/** Resend's webhook event types, and what Preshift calls them. Opens and clicks are not tracked. */
const WEBHOOK_TYPES: Record<string, MailEventType> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
};

/** Resend's `last_event` on an email it is asked about. */
const LAST_EVENTS: Record<string, MailEventType> = {
  sent: 'sent',
  delivered: 'delivered',
  delivery_delayed: 'delayed',
  bounced: 'bounced',
  complained: 'complained',
  failed: 'failed',
};


/**
 * Where an email stands. A bounce or a failure is final whatever came before it; a complaint
 * follows a delivery; otherwise the furthest it got.
 */
export function statusOf(record: MailRecord): MailStatus {
  const has = (t: MailEventType) => record.events.some((e) => e.type === t);
  for (const t of ['bounced', 'failed', 'complained', 'delivered', 'delayed'] as const) if (has(t)) return t;
  return 'sent';
}

/** The detail of the event that set the status, such as the receiving server's reason for a bounce. */
const detailOf = (record: MailRecord, status: MailStatus) => [...record.events].reverse().find((e) => e.type === status)?.detail;


export function view(id: string, record: MailRecord): MailView {
  const status = statusOf(record);
  const event = [...record.events].reverse().find((e) => e.type === status);
  return { id, to: record.to, kind: record.kind, userId: record.userId, employeeId: record.employeeId, sentAt: record.sentAt, by: record.by, status, at: event?.at ?? record.sentAt, detail: detailOf(record, status) };
}

/** Records an email Resend accepted. Resend's id is the key every later report names. */
export function recordSent(org: OrgData, id: string, mail: { to: string; kind: MailKind; userId?: string; employeeId?: string; by: string }, now = new Date()) {
  org.mail[id] = { ...mail, sentAt: now.toISOString(), events: [{ id: 'accepted', type: 'sent', at: now.toISOString() }] };
  prune(org, now);
}

function prune(org: OrgData, now: Date) {
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString();
  const kept = Object.entries(org.mail)
    .filter(([, r]) => r.sentAt >= cutoff)
    .sort(([, a], [, b]) => b.sentAt.localeCompare(a.sentAt))
    .slice(0, KEEP_MAX);
  org.mail = Object.fromEntries(kept);
}

/**
 * Adds a report to its email, once: the event id is how a retried webhook is recognised. Returns
 * the email when the report was new and about an email Preshift sent, else null.
 */
export function addEvent(org: OrgData, mailId: string, event: MailRecord['events'][number]): MailRecord | null {
  const record = org.mail[mailId];
  if (!record || record.events.some((e) => e.id === event.id)) return null;
  record.events.push(event);
  return record;
}

/** The newest email to each person, by user id. */
export function latestByUser(org: OrgData): Map<string, MailView> {
  const out = new Map<string, MailView>();
  for (const [id, r] of Object.entries(org.mail)) {
    if (!r.userId) continue;
    const current = out.get(r.userId);
    if (!current || r.sentAt > current.sentAt) out.set(r.userId, view(id, r));
  }
  return out;
}

/** The newest staff app invitation to each employee, by employee id. */
export function latestByEmployee(org: OrgData): Map<string, MailView> {
  const out = new Map<string, MailView>();
  for (const [id, r] of Object.entries(org.mail)) {
    if (!r.employeeId) continue;
    const current = out.get(r.employeeId);
    if (!current || r.sentAt > current.sentAt) out.set(r.employeeId, view(id, r));
  }
  return out;
}

/** The webhook's address, for the person setting it up in Resend. */
export const webhookPath = (orgId: string) => `/v1/integrations/resend/webhook/${encodeURIComponent(orgId)}`;

/**
 * Checks a Resend webhook. Resend signs through Svix: HMAC-SHA256 under the base64 secret after
 * `whsec_`, over `id.timestamp.body` exactly as sent, in a header listing `v1,<signature>` pairs.
 */
export function verifyWebhook(secret: string, headers: Record<string, unknown>, rawBody: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signatures = headers['svix-signature'];
  if (typeof id !== 'string' || typeof timestamp !== 'string' || typeof signatures !== 'string') return false;
  const at = Number(timestamp);
  if (!/^\d+$/.test(timestamp) || Math.abs(nowSeconds - at) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest();
  return signatures.split(' ').some((pair) => {
    const [version, signature] = pair.split(',');
    if (version !== 'v1' || !signature) return false;
    const given = Buffer.from(signature, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** The report a webhook body carries, or null for an event Preshift does not track. */
export function fromWebhook(eventId: string, body: unknown): { mailId: string; event: MailRecord['events'][number] } | null {
  const b = body as { type?: unknown; created_at?: unknown; data?: Record<string, unknown> } | null;
  const type = typeof b?.type === 'string' ? WEBHOOK_TYPES[b.type] : undefined;
  const mailId = b?.data?.email_id;
  if (!type || typeof mailId !== 'string') return null;
  const at = typeof b?.created_at === 'string' && !Number.isNaN(Date.parse(b.created_at)) ? new Date(b.created_at).toISOString() : new Date().toISOString();
  return { mailId, event: { id: eventId, type, at, detail: reasonOf(type, b?.data ?? {}) } };
}

/** The receiving server's words, kept short: they are shown to whoever manages access. */
function reasonOf(type: MailEventType, data: Record<string, unknown>): string | undefined {
  const pick = (o: unknown, k: string) => (o && typeof o === 'object' && typeof (o as Record<string, unknown>)[k] === 'string' ? ((o as Record<string, unknown>)[k] as string) : undefined);
  let reason: string | undefined;
  if (type === 'bounced') {
    const kind = pick(data.bounce, 'type');
    const message = pick(data.bounce, 'message');
    reason = [kind === 'Transient' ? 'temporary' : kind === 'Permanent' ? 'permanent' : undefined, message].filter(Boolean).join(': ') || undefined;
  } else if (type === 'failed') reason = pick(data.failed, 'reason');
  return reason ? reason.replace(/[\r\n]+/g, ' ').trim().slice(0, 300) : undefined;
}

/**
 * Asks Resend where an email stands, for organisations without the webhook. Returns the event
 * type, or null if Resend could not say.
 */
export async function askResend(settings: EmailSettings, mailId: string): Promise<MailEventType | null> {
  try {
    const res = await fetch(`https://api.resend.com/emails/${encodeURIComponent(mailId)}`, { headers: { authorization: `Bearer ${settings.resendApiKey}` } });
    if (!res.ok) return null;
    const body = (await res.json()) as { last_event?: unknown };
    return typeof body.last_event === 'string' ? (LAST_EVENTS[body.last_event] ?? null) : null;
  } catch {
    return null;
  }
}
