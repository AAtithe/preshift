// How a message leaves Preshift: WhatsApp (Meta's Cloud API), text (Twilio), email (Resend) to a
// member of staff, and Slack or Teams to a site's managers. The organisation's keys are saved by
// an admin under Settings, in the settings store, never in organisation data, so no data endpoint
// can return them.
//
// What goes where is a data decision, not only a delivery one:
// - To a member of staff, on a channel they chose and agreed to, the message itself.
// - To Slack or Teams, a notice and a link, never what a member of staff wrote. Staff write about
//   sickness, childcare and complaints; a workspace channel is read by people who have no business
//   reading that, and is kept by a third party on its own terms.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Employee } from '../src/engine/types';
import {
  CHANNEL_NAMES, directId, emptyMessaging, inQuiet, maskEmail, maskPhone, minutesToQuietEnd, routeFor,
  type Channel, type Conversation, type Delivery, type Message, type MessagingData, type PersonChannel, type TeamChannel,
} from '../src/engine/messaging';
import { londonParts, type AppContext } from './context';
import { emailSetting, noticeEmail, parseEmailSettings, sendMail } from './mail';
import type { OrgData, Store } from './store';

export interface WhatsAppSettings {
  /** The WhatsApp Business phone number's id in Meta's Cloud API (digits). */
  phoneNumberId: string;
  /** A system user access token with whatsapp_business_messaging. */
  accessToken: string;
  /** The Meta app's secret, which signs the webhook Meta posts replies to. */
  appSecret: string;
  /** Made by Preshift: Meta sends it back once when the webhook is set up. */
  verifyToken: string;
  /**
   * An approved template with one body parameter, such as "Message from work: {{1}}". WhatsApp
   * accepts free text only within 24 hours of the person's last message; outside that window,
   * which is most of the time, it must be a template.
   */
  template: string;
  language: string;
}

export interface SmsSettings {
  accountSid: string;
  authToken: string;
  /** A Twilio number in international form, or an alphanumeric sender of up to 11 characters (texts from it cannot be replied to). */
  from: string;
}

export interface MessagingSettings {
  whatsapp?: WhatsAppSettings;
  sms?: SmsSettings;
  /** Incoming webhook addresses by site id, '*' for every site without its own. */
  slack?: Record<string, string>;
  teams?: Record<string, string>;
  /** Email staff who have not chosen a channel, once email is set up. Off unless an admin turns it on. */
  emailWhenUnset?: boolean;
}

export const messagingSetting = (orgId: string) => `messaging:${orgId}`;

export async function getMessagingSettings(store: Pick<Store, 'getSetting'>, orgId: string): Promise<MessagingSettings> {
  const raw = await store.getSetting(messagingSetting(orgId));
  if (!raw) return {};
  try {
    return JSON.parse(raw) as MessagingSettings;
  } catch {
    return {};
  }
}

export const newVerifyToken = () => randomBytes(18).toString('base64url');

/** Whether email is set up under Settings, so a person can choose it. */
export async function emailConnected(store: Pick<Store, 'getSetting'>, orgId: string): Promise<boolean> {
  return Boolean(parseEmailSettings(await store.getSetting(emailSetting(orgId))));
}

/** Where the manager app and the staff app are, for links in notices: the address saved with email, else none. */
export async function appUrlOf(store: Pick<Store, 'getSetting'>, orgId: string): Promise<string | null> {
  return parseEmailSettings(await store.getSetting(emailSetting(orgId)))?.appUrl ?? null;
}

/**
 * Slack and Teams addresses are typed in by people and then called by the server, so only the
 * providers' own webhook hosts are accepted: never an address inside our network or anyone else's.
 */
export function teamUrlProblem(channel: TeamChannel, raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Paste the whole webhook address, starting https://.';
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return 'The webhook address must be a plain https address.';
  if (channel === 'slack') {
    return url.hostname === 'hooks.slack.com' && /^\/(services|workflows|triggers)\//.test(url.pathname)
      ? null
      : 'That is not a Slack incoming webhook. It starts https://hooks.slack.com/services/.';
  }
  const host = url.hostname;
  return host.endsWith('.webhook.office.com') || host.endsWith('.logic.azure.com') || host.endsWith('.api.powerplatform.com')
    ? null
    : 'That is not a Teams webhook. Make one with the Workflows app in the channel ("Post to a channel when a webhook request is received") and paste its address.';
}

/** What the screens may see: whether each channel is set up, and nothing that would let anyone use it. */
export function settingsView(s: MessagingSettings, orgId: string, appUrl: string | null, sites: { id: string; name: string }[]) {
  const team = (map?: Record<string, string>) =>
    Object.entries(map ?? {}).map(([siteId, url]) => ({
      siteId,
      siteName: siteId === '*' ? 'Every other site' : sites.find((x) => x.id === siteId)?.name ?? siteId,
      host: new URL(url).hostname,
    }));
  return {
    whatsapp: s.whatsapp
      ? {
          set: true,
          phoneNumberId: s.whatsapp.phoneNumberId,
          tokenEndsWith: s.whatsapp.accessToken.slice(-4),
          template: s.whatsapp.template,
          language: s.whatsapp.language,
          // What to give Meta when setting up the webhook. The verify token is ours, not a key to anything.
          webhook: { url: `${appUrl ?? ''}${whatsappWebhookPath(orgId)}`, verifyToken: s.whatsapp.verifyToken },
        }
      : { set: false },
    sms: s.sms ? { set: true, accountSid: s.sms.accountSid, from: s.sms.from, tokenEndsWith: s.sms.authToken.slice(-4) } : { set: false },
    slack: team(s.slack),
    teams: team(s.teams),
    emailWhenUnset: !!s.emailWhenUnset,
    appUrl,
  };
}

export const whatsappWebhookPath = (orgId: string) => `/v1/integrations/whatsapp/webhook/${encodeURIComponent(orgId)}`;

/** The org's messaging, made on first use. */
export function messagingOf(org: OrgData): MessagingData {
  if (!org.messaging) org.messaging = emptyMessaging();
  // Organisations saved before a field existed.
  org.messaging.lastInbound ??= {};
  org.messaging.notified ??= {};
  org.messaging.reads ??= {};
  return org.messaging;
}

// ---- Sending ---------------------------------------------------------------------------------

const TIMEOUT_MS = 4000;

type Fetch = typeof fetch;

interface Sent {
  ok: boolean;
  providerId?: string;
  detail?: string;
}

async function post(fetcher: Fetch, url: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const res = await fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body, text };
}

const failure = (err: unknown) => ({ ok: false, detail: err instanceof Error && err.name === 'TimeoutError' ? 'No answer in time' : 'Could not reach the provider' });

/** Template parameters may not carry line breaks, tabs or long runs of spaces. */
const flat = (s: string) => s.replace(/\s*\n\s*/g, '; ').replace(/\s{2,}/g, ' ').trim();
const cut = (s: string, max: number, more: string) => (s.length <= max ? s : `${s.slice(0, max - more.length - 1).trimEnd()} ${more}`);

export async function sendWhatsApp(fetcher: Fetch, cfg: WhatsAppSettings, to: string, text: string, freeText: boolean): Promise<Sent> {
  const message = freeText
    ? { type: 'text', text: { body: cut(text, 4000, '(more in the Preshift app)'), preview_url: false } }
    : {
        type: 'template',
        template: {
          name: cfg.template,
          language: { code: cfg.language },
          components: [{ type: 'body', parameters: [{ type: 'text', text: cut(flat(text), 1000, '(more in the Preshift app)') }] }],
        },
      };
  try {
    const res = await post(fetcher, `https://graph.facebook.com/v21.0/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: to.replace(/^\+/, ''), ...message }),
    });
    if (!res.ok) {
      const err = (res.body as { error?: { message?: string } } | null)?.error?.message;
      return { ok: false, detail: `WhatsApp refused it (${res.status})${err ? `: ${err}` : ''}` };
    }
    const id = (res.body as { messages?: { id?: string }[] } | null)?.messages?.[0]?.id;
    return { ok: true, providerId: id };
  } catch (err) {
    return failure(err);
  }
}

export async function sendSms(fetcher: Fetch, cfg: SmsSettings, to: string, text: string): Promise<Sent> {
  try {
    const res = await post(fetcher, `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: cfg.from, Body: cut(text, 1500, '(more in the Preshift app)') }).toString(),
    });
    if (!res.ok) return { ok: false, detail: `Twilio refused it (${res.status})` };
    return { ok: true, providerId: (res.body as { sid?: string } | null)?.sid };
  } catch (err) {
    return failure(err);
  }
}

/** A notice to a team channel: a line of text and a button into Preshift. */
export async function postTeam(fetcher: Fetch, channel: TeamChannel, url: string, text: string, link: string | null): Promise<Sent> {
  const body =
    channel === 'slack'
      ? { text: link ? `${text} <${link}|Open in Preshift>` : text }
      : {
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: {
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                type: 'AdaptiveCard',
                version: '1.4',
                body: [{ type: 'TextBlock', text, wrap: true }],
                ...(link ? { actions: [{ type: 'Action.OpenUrl', title: 'Open in Preshift', url: link }] } : {}),
              },
            },
          ],
        };
  try {
    const res = await post(fetcher, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.ok ? { ok: true } : { ok: false, detail: `${CHANNEL_NAMES[channel]} refused it (${res.status})` };
  } catch (err) {
    return failure(err);
  }
}

// ---- Who gets what -----------------------------------------------------------------------------

export interface Outbound {
  ctx: Pick<AppContext, 'store' | 'fetch' | 'now'>;
  org: OrgData;
  settings: MessagingSettings;
  appUrl: string | null;
}

export async function outboundFor(ctx: Outbound['ctx'], org: OrgData): Promise<Outbound> {
  return { ctx, org, settings: await getMessagingSettings(ctx.store, org.orgId), appUrl: await appUrlOf(ctx.store, org.orgId) };
}

/**
 * Carries a message to one member of staff beyond the app, by the first channel that works of
 * those they chose. Outside quiet hours, or when urgent, it goes now; otherwise it is held and the
 * scheduled run sends it when their quiet hours end. Never to a leaver.
 */
export async function deliverToStaff(out: Outbound, employee: Employee, text: string, opts: { urgent?: boolean; subject: string; force?: boolean }): Promise<Delivery[]> {
  const { ctx, org, settings } = out;
  if (employee.status === 'leaver') return [];
  const data = messagingOf(org);
  const prefs = data.prefs[employee.id];
  const login = await ctx.store.getStaffLogin(org.orgId, employee.id);
  const emailSettings = parseEmailSettings(await ctx.store.getSetting(emailSetting(org.orgId)));
  const email = login?.email ?? employee.email;
  const connected = new Set<Exclude<PersonChannel, 'app'>>();
  if (settings.whatsapp) connected.add('whatsapp');
  if (settings.sms) connected.add('sms');
  if (emailSettings) connected.add('email');
  // Nobody chose: the app only, unless the organisation emails people who have not.
  const effective = prefs?.channels?.length ? prefs : settings.emailWhenUnset && email ? { channels: ['email' as const], updatedAt: '' } : undefined;
  if (!effective) return [];
  const { order, unusable } = routeFor({ ...prefs, ...effective }, { connected, email });
  const at = ctx.now();
  const iso = at.toISOString();
  const skipped: Delivery[] = unusable.map((u) => ({ channel: u.channel, to: '', status: 'skipped', at: iso, employeeId: employee.id, detail: u.reason }));
  if (order.length === 0) return skipped;
  const minute = londonParts(at).minute;
  if (!opts.urgent && !opts.force && inQuiet(prefs, minute)) {
    const after = new Date(at.getTime() + minutesToQuietEnd(prefs, minute) * 60_000).toISOString();
    return [...skipped, { channel: order[0], to: '', status: 'held', at: iso, after, employeeId: employee.id, detail: 'Quiet hours' }];
  }
  const results: Delivery[] = [...skipped];
  for (const channel of order) {
    let sent: Sent;
    let to: string;
    if (channel === 'whatsapp') {
      to = maskPhone(prefs!.phone!);
      const last = data.lastInbound[employee.id];
      const open = !!last && at.getTime() - Date.parse(last) < 24 * 3_600_000;
      sent = await sendWhatsApp(ctx.fetch, settings.whatsapp!, prefs!.phone!, text, open);
    } else if (channel === 'sms') {
      to = maskPhone(prefs!.phone!);
      sent = await sendSms(ctx.fetch, settings.sms!, prefs!.phone!, text);
    } else {
      to = maskEmail(email!);
      const link = out.appUrl ? `${out.appUrl}/staff/` : null;
      const id = await sendMail(emailSettings!, noticeEmail(email!, opts.subject, text, link)).catch(() => null);
      sent = id === null ? { ok: false, detail: 'Email not accepted' } : { ok: true, providerId: id || undefined };
    }
    results.push({ channel, to, status: sent.ok ? 'sent' : 'failed', at: iso, employeeId: employee.id, ...(sent.providerId ? { providerId: sent.providerId } : {}), ...(sent.detail ? { detail: sent.detail } : {}) });
    if (sent.ok) break;
  }
  return results;
}

/** The webhook for a site's team channel: its own, else the organisation's '*'. */
const teamUrl = (map: Record<string, string> | undefined, siteId: string) => map?.[siteId] ?? map?.['*'];

/** Posts a notice to the site's Slack and Teams channels, whichever are set up. */
export async function notifyTeam(out: Outbound, siteId: string, text: string, link: string | null): Promise<Delivery[]> {
  const site = out.org.state.sites.find((s) => s.id === siteId);
  const iso = out.ctx.now().toISOString();
  const results: Delivery[] = [];
  for (const channel of ['slack', 'teams'] as const) {
    const url = teamUrl(out.settings[channel], siteId);
    if (!url) continue;
    const sent = await postTeam(out.ctx.fetch, channel, url, text, link);
    results.push({ channel, to: site?.name ?? siteId, status: sent.ok ? 'sent' : 'failed', at: iso, ...(sent.detail ? { detail: sent.detail } : {}) });
  }
  return results;
}

export const managerLink = (out: Outbound, siteId: string, conversationId?: string) =>
  out.appUrl ? `${out.appUrl}/app/?view=messages&site=${encodeURIComponent(siteId)}${conversationId ? `&thread=${encodeURIComponent(conversationId)}` : ''}` : null;

/** Runs the work a few at a time, so a big team does not open a hundred connections at once. */
export async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) results.push(...(await Promise.all(items.slice(i, i + size).map(run))));
  return results;
}

// ---- Threads ---------------------------------------------------------------------------------

/** The person's one thread with the managers of their site, made on first use. */
export function directThread(org: OrgData, employee: Employee, by: string, at: string): Conversation {
  const data = messagingOf(org);
  const id = directId(employee.id);
  let c = data.conversations.find((x) => x.id === id);
  if (!c) {
    c = { id, kind: 'direct', siteId: employee.siteId, employeeId: employee.id, createdAt: at, createdBy: by, lastAt: at };
    data.conversations.push(c);
  }
  // A person who moves site takes their thread with them, to their new managers.
  c.siteId = employee.siteId;
  return c;
}

export function addMessage(org: OrgData, c: Conversation, m: Omit<Message, 'id' | 'conversationId' | 'deliveries'> & { deliveries?: Delivery[] }): Message {
  const data = messagingOf(org);
  const message: Message = { id: `msg_${randomUUID()}`, conversationId: c.id, deliveries: [], ...m };
  data.messages.push(message);
  c.lastAt = m.at;
  return message;
}

/**
 * Sends what quiet hours held back, now they are over: run by the scheduled dispatch. Each held
 * delivery is replaced by what happened when it went.
 */
export async function releaseHeld(ctx: Outbound['ctx'], org: OrgData): Promise<number> {
  const data = org.messaging;
  if (!data) return 0;
  const nowIso = ctx.now().toISOString();
  const due = data.messages.filter((m) => m.deliveries.some((d) => d.status === 'held' && (d.after ?? '') <= nowIso));
  if (due.length === 0) return 0;
  const out = await outboundFor(ctx, org);
  let released = 0;
  for (const m of due) {
    const c = data.conversations.find((x) => x.id === m.conversationId);
    const next: Delivery[] = [];
    for (const d of m.deliveries) {
      if (d.status !== 'held' || (d.after ?? '') > nowIso) {
        next.push(d);
        continue;
      }
      const employee = org.state.employees.find((e) => e.id === d.employeeId);
      if (!employee) continue;
      next.push(...(await deliverToStaff(out, employee, m.body, { subject: c?.title ?? 'A message from work', force: true })));
      released++;
    }
    m.deliveries = next;
  }
  return released;
}

// ---- Replies by WhatsApp -----------------------------------------------------------------------

/** Meta signs each webhook with the app secret: `x-hub-signature-256: sha256=<hex>` over the raw body. */
export function verifyMetaSignature(appSecret: string, header: string | undefined, raw: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(raw, 'utf8').digest('hex');
  const given = header.slice(7);
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export interface WhatsAppInbound {
  entry?: {
    changes?: {
      value?: {
        messages?: { from?: string; id?: string; timestamp?: string; type?: string; text?: { body?: string } }[];
        statuses?: { id?: string; status?: string; recipient_id?: string; errors?: { title?: string }[] }[];
      };
    }[];
  }[];
}

/** Words that withdraw consent, as WhatsApp users expect them to. */
export const STOP_WORDS = ['stop', 'unsubscribe', 'stop all', 'opt out'];

export type { Channel };

/**
 * For each member of staff: whether they have a staff app login, the channel a notice would reach
 * them by, and why any channel they chose cannot be used. A notice to someone with neither reaches nobody.
 */
export async function reachOf(store: Store, org: OrgData) {
  const settings = await getMessagingSettings(store, org.orgId);
  const logins = new Map((await store.listStaffLogins(org.orgId)).map((l) => [l.employeeId, l]));
  const email = await emailConnected(store, org.orgId);
  const connected = new Set<Exclude<PersonChannel, 'app'>>([...(settings.whatsapp ? ['whatsapp' as const] : []), ...(settings.sms ? ['sms' as const] : []), ...(email ? ['email' as const] : [])]);
  const data = messagingOf(org);
  return new Map(
    org.state.employees.map((e) => {
      const login = logins.get(e.id);
      const prefs = data.prefs[e.id];
      const chosen = prefs?.channels?.length ? prefs : settings.emailWhenUnset && (login?.email ?? e.email) ? { ...prefs, channels: ['email' as const], updatedAt: '' } : prefs;
      const { order, unusable } = routeFor(chosen, { connected, email: login?.email ?? e.email });
      return [e.id, { app: Boolean(login?.hash), channel: order[0] ?? null, problems: unusable.map((u) => u.reason) }];
    }),
  );
}
