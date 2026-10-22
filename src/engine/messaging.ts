// Messages between managers and staff, and how each one reaches people. Pure logic, shared by the
// API (which stores and sends) and the browser (which shows and explains).
//
// Preshift is the record. Every message, announcement and rota notice lives here, in one thread per
// person, with who read it and when. WhatsApp, SMS and email carry a notice to the person's phone;
// Slack and Teams carry a notice to the managers' own channel. None of them is where the
// conversation is kept, because a manager's WhatsApp group is not a record anyone can produce to
// a tribunal, answer a data request from, or close when someone leaves.

import { formatMinute } from './time';

/** Reaches one member of staff. 'app' is the inbox in the staff app, and always gets the message. */
export type PersonChannel = 'app' | 'whatsapp' | 'sms' | 'email';
/** Reaches a site's managers, in the channel their team already watches. */
export type TeamChannel = 'slack' | 'teams';
export type Channel = PersonChannel | TeamChannel;

/** The channels a person can choose beyond the app, in the order offered. */
export const OUTSIDE_CHANNELS: Exclude<PersonChannel, 'app'>[] = ['whatsapp', 'sms', 'email'];

export const CHANNEL_NAMES: Record<Channel, string> = {
  app: 'Staff app',
  whatsapp: 'WhatsApp',
  sms: 'Text message',
  email: 'Email',
  slack: 'Slack',
  teams: 'Microsoft Teams',
};

/** Default quiet hours, London time: nothing but urgent messages is pushed between 22:00 and 07:00. */
export const DEFAULT_QUIET = { start: 22 * 60, end: 7 * 60 };

/**
 * How one member of staff wants to hear from work. Set by the person, in the staff app, never by a
 * manager: consent to WhatsApp or text is theirs to give and to withdraw, and it is given with the
 * number they typed themselves.
 */
export interface StaffMessagingPrefs {
  /** Channels beyond the app, most preferred first. A notice goes by the first one that works. */
  channels: Exclude<PersonChannel, 'app'>[];
  /** Their mobile, as they entered it, in international form (+447700900123). */
  phone?: string;
  /** When they agreed to messages by WhatsApp from this number. Removed when they withdraw. */
  whatsappConsentAt?: string;
  /** When they agreed to text messages from this number. */
  smsConsentAt?: string;
  /** London minutes of the day. Null means no quiet hours. Absent means the default. */
  quiet?: { start: number; end: number } | null;
  updatedAt: string;
}

export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed' | 'held' | 'skipped';

/** One attempt to carry a message outside the app. */
export interface Delivery {
  channel: Channel;
  /** Masked: the last digits of a phone, the domain of an email, the site of a team channel. */
  to: string;
  status: DeliveryStatus;
  at: string;
  /** For a held delivery: when quiet hours end and it goes. */
  after?: string;
  /** The person the delivery is for, when the message went to several (an announcement). */
  employeeId?: string;
  /** The provider's id, to match its delivery and read reports. */
  providerId?: string;
  detail?: string;
}

export interface Conversation {
  id: string;
  /** direct: one person and the managers of their site. announcement: one way, to a site's team. */
  kind: 'direct' | 'announcement';
  siteId: string;
  /** A direct thread's member of staff. */
  employeeId?: string;
  /** An announcement's recipients, fixed when it was sent. */
  recipients?: string[];
  title?: string;
  /** Urgent messages are pushed through quiet hours. */
  urgent?: boolean;
  createdAt: string;
  createdBy: string;
  lastAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  at: string;
  from: { kind: 'manager' | 'staff' | 'system'; id?: string; name: string };
  body: string;
  /** Where it was written: in Preshift, or a reply that came back by WhatsApp or text. */
  via: 'app' | 'whatsapp' | 'sms';
  urgent?: boolean;
  deliveries: Delivery[];
}

export interface MessagingData {
  conversations: Conversation[];
  messages: Message[];
  /** By employee id. */
  prefs: Record<string, StaffMessagingPrefs>;
  /** `${conversationId}|${reader}` to when they last read it. Readers are `staff:<id>` or `user:<id>`. */
  reads: Record<string, string>;
  /** `${employeeId}|${weekStart}` to the signature of the shifts they were last told about. */
  notified: Record<string, string>;
  /** When each person last wrote in by WhatsApp: WhatsApp allows free text only within 24 hours of that. */
  lastInbound: Record<string, string>;
}

export const emptyMessaging = (): MessagingData => ({ conversations: [], messages: [], prefs: {}, reads: {}, notified: {}, lastInbound: {} });

export const MAX_BODY = 2000;
export const MAX_TITLE = 120;
/** Messages are kept 13 months: a year of any dispute about what someone was told, and a month to answer it. */
export const KEEP_MONTHS = 13;
/** Held to a size the organisation document can carry; the oldest go first. */
export const KEEP_MAX = 5000;

export const directId = (employeeId: string) => `dm_${employeeId}`;
export const staffReader = (employeeId: string) => `staff:${employeeId}`;
export const userReader = (userId: string) => `user:${userId}`;

/** What is wrong with a message as typed, or null. */
export function bodyProblem(body: unknown): string | null {
  if (typeof body !== 'string' || !body.trim()) return 'Write a message first.';
  if (body.length > MAX_BODY) return `Keep a message under ${MAX_BODY} characters.`;
  return null;
}

/**
 * A UK or international mobile in the form WhatsApp and Twilio take (+447700900123), or null.
 * UK numbers may be typed the usual way: 07700 900123, +44 (0)7700 900123, 0044 7700 900123.
 */
export function normalisePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (s.startsWith('+440')) s = `+44${s.slice(4)}`;
  if (/^07\d{9}$/.test(s)) s = `+44${s.slice(1)}`;
  if (!/^\+[1-9]\d{7,14}$/.test(s)) return null;
  // A UK number must be a mobile: landlines cannot take WhatsApp or texts.
  if (s.startsWith('+44') && !/^\+447\d{9}$/.test(s)) return null;
  return s;
}

/** Enough of a number to tell which it is, never enough to use it. */
export const maskPhone = (phone: string) => `ending ${phone.slice(-4)}`;
export const maskEmail = (email: string) => `@${email.split('@')[1] ?? ''}`;

/** Whether a London minute of the day falls in the person's quiet hours. */
export function inQuiet(prefs: Pick<StaffMessagingPrefs, 'quiet'> | undefined, minute: number): boolean {
  const q = prefs?.quiet === undefined ? DEFAULT_QUIET : prefs.quiet;
  if (!q || q.start === q.end) return false;
  return q.start < q.end ? minute >= q.start && minute < q.end : minute >= q.start || minute < q.end;
}

/** Minutes from a London minute of the day until quiet hours end. */
export function minutesToQuietEnd(prefs: Pick<StaffMessagingPrefs, 'quiet'> | undefined, minute: number): number {
  const q = prefs?.quiet === undefined ? DEFAULT_QUIET : prefs.quiet;
  if (!q) return 0;
  return (q.end - minute + 1440) % 1440;
}

/** What the organisation has set up, and what the person has, for deciding where a notice goes. */
export interface Reach {
  /** Channels the organisation has connected. */
  connected: Set<Exclude<PersonChannel, 'app'>>;
  /** The email on the person's staff login, else their record. */
  email?: string;
}

/**
 * The outside channels to try for this person, best first, and the reason any they chose is not
 * usable. Only the first that sends is used: one notice, one buzz. A channel needs the organisation
 * to have connected it and, for WhatsApp and text, the person's own consent with a number.
 */
export function routeFor(prefs: StaffMessagingPrefs | undefined, reach: Reach): { order: Exclude<PersonChannel, 'app'>[]; unusable: { channel: Channel; reason: string }[] } {
  const chosen = prefs?.channels?.length ? prefs.channels : reach.email ? (['email'] as const) : [];
  const order: Exclude<PersonChannel, 'app'>[] = [];
  const unusable: { channel: Channel; reason: string }[] = [];
  for (const c of chosen) {
    if (!reach.connected.has(c)) unusable.push({ channel: c, reason: `${CHANNEL_NAMES[c]} is not connected for this organisation` });
    else if (c === 'whatsapp' && !(prefs?.phone && prefs.whatsappConsentAt)) unusable.push({ channel: c, reason: 'No WhatsApp number agreed by the person' });
    else if (c === 'sms' && !(prefs?.phone && prefs.smsConsentAt)) unusable.push({ channel: c, reason: 'No mobile number agreed by the person' });
    else if (c === 'email' && !reach.email) unusable.push({ channel: c, reason: 'No email address' });
    else order.push(c);
  }
  return { order, unusable };
}

/** A shift as a notice needs it. */
export interface NoticeShift {
  date: string;
  startMinute: number;
  endMinute: number;
  siteName: string;
  roleName: string;
}

/** What a person's week looks like, so a notice goes only when it changed. Empty for no shifts. */
export const weekSignature = (shifts: NoticeShift[]) =>
  [...shifts]
    .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute)
    .map((s) => `${s.date} ${s.startMinute}-${s.endMinute} ${s.siteName} ${s.roleName}`)
    .join('; ');

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const shortDate = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${DAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
};

/**
 * The rota notice for one person's week. `before` is what they were last told: empty for a first
 * publish. Plain text, so it reads the same in the app, a WhatsApp message and a text.
 */
export function weekNotice(name: string, weekStart: string, shifts: NoticeShift[], before: string): string {
  const first = name.split(' ')[0] || name;
  const week = `the week of ${shortDate(weekStart)}`;
  if (shifts.length === 0) return `Hi ${first}, your shifts for ${week} have been taken off the rota. You are not rostered that week. Message your manager in the Preshift app if that is wrong.`;
  const lines = [...shifts]
    .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute)
    .map((s) => `${shortDate(s.date)}: ${formatMinute(s.startMinute)} to ${formatMinute(s.endMinute)}, ${s.roleName}, ${s.siteName}`);
  const opening = before ? `Hi ${first}, your shifts for ${week} have changed. Your rota is now:` : `Hi ${first}, your rota for ${week} is out:`;
  return [opening, ...lines, 'Reply here or in the Preshift app if anything is wrong.'].join('\n');
}

/**
 * How many messages in the conversation the reader has not read. Staff count everything from work;
 * managers count what staff wrote, not rota notices or each other.
 */
export function unread(data: MessagingData, c: Conversation, reader: string): number {
  const since = data.reads[`${c.id}|${reader}`] ?? '';
  const counts = reader.startsWith('staff:') ? (m: Message) => m.from.kind !== 'staff' : (m: Message) => m.from.kind === 'staff';
  return data.messages.filter((m) => m.conversationId === c.id && m.at > since && counts(m)).length;
}

/**
 * Drops messages past the retention period, and the oldest beyond the cap, then conversations left
 * with none. Returns how many messages went.
 */
export function trimMessaging(data: MessagingData, now: Date): number {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - KEEP_MONTHS);
  const before = data.messages.length;
  data.messages = data.messages.filter((m) => m.at >= cutoff.toISOString());
  if (data.messages.length > KEEP_MAX) data.messages = [...data.messages].sort((a, b) => a.at.localeCompare(b.at)).slice(-KEEP_MAX);
  const live = new Set(data.messages.map((m) => m.conversationId));
  data.conversations = data.conversations.filter((c) => live.has(c.id));
  for (const k of Object.keys(data.reads)) if (!live.has(k.split('|')[0])) delete data.reads[k];
  return before - data.messages.length;
}

/** How a message reached its person, for a manager reading the thread: the best outcome per person. */
export function deliverySummary(m: Message): string {
  if (m.deliveries.length === 0) return 'In the app';
  const rank: Record<DeliveryStatus, number> = { read: 6, delivered: 5, sent: 4, held: 3, failed: 2, skipped: 1 };
  const best = [...m.deliveries].sort((a, b) => rank[b.status] - rank[a.status])[0];
  const word: Record<DeliveryStatus, string> = {
    read: 'read', delivered: 'delivered', sent: 'sent', held: 'held for quiet hours', failed: 'not delivered', skipped: 'not sent',
  };
  return `${CHANNEL_NAMES[best.channel]}: ${word[best.status]}`;
}
