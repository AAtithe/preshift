import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireScope } from '../auth';
import { HttpError, londonParts, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard, type Guard } from '../guard';
import {
  addMessage, deliverToStaff, directThread, getMessagingSettings, inBatches, managerLink, messagingOf, messagingSetting, newVerifyToken,
  notifyTeam, outboundFor, postTeam, reachOf, settingsView, STOP_WORDS, teamUrlProblem, verifyMetaSignature, appUrlOf, emailConnected,
  type MessagingSettings, type WhatsAppInbound,
} from '../messaging';
import { audit, type OrgData } from '../store';
import { requireStaff } from './staff';
import { acceptOffer, announceTaken, askDueRounds, coverOf, type Taken } from '../cover';
import { isYes, openOffersFor } from '../../src/engine/cover';
import {
  bodyProblem, CHANNEL_NAMES, deliverySummary, MAX_TITLE, normalisePhone, OUTSIDE_CHANNELS,
  staffReader, trimMessaging, unread, userReader,
  type Conversation, type Delivery, type Message, type PersonChannel, type StaffMessagingPrefs,
} from '../../src/engine/messaging';
import type { Employee } from '../../src/engine/types';

/** Managers who run a site's team read and write its messages: those who build its rota or manage its people. */
const MESSAGE = ['rota.edit', 'team.manage'] as const;

const preview = (s: string) => (s.length > 140 ? `${s.slice(0, 139)}…` : s);

/**
 * Messages are between people. A key with no person behind it (a till, a payroll system) has no
 * business reading what staff wrote to their managers or writing to staff as if it were one.
 */
export function messenger(ctx: AppContext, req: FastifyRequest): { g: Guard; org: OrgData; reader: string; name: string; userId?: string } {
  const org = orgOf(req);
  const g = guard(ctx, req, org);
  if (g.actor.kind !== 'user' && !req.principal.email) throw new HttpError(403, 'forbidden', 'Messages are read and sent by people, not by a system key.');
  const user = g.actor.kind === 'user' ? g.actor.user : undefined;
  return { g, org, reader: userReader(user?.id ?? req.principal.email!), name: actorName(g), userId: user?.id };
}

export const employeeName = (org: OrgData, id?: string) => org.state.employees.find((e) => e.id === id)?.name ?? 'Former member of staff';
export const siteName = (org: OrgData, id: string) => org.state.sites.find((s) => s.id === id)?.name ?? id;

/** An announcement's recipients: everyone working at the site, its own team and those who cover it. */
const teamOf = (org: OrgData, siteId: string) =>
  org.state.employees.filter((e) => e.status !== 'leaver' && (e.siteId === siteId || e.coverSiteIds.includes(siteId)));

function messageView(m: Message) {
  return { id: m.id, at: m.at, from: m.from, body: m.body, via: m.via, urgent: !!m.urgent, deliveries: m.deliveries, reached: deliverySummary(m) };
}

export function messageRoutes(app: FastifyInstance, ctx: AppContext) {
  const { store } = ctx;
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('rota:write') };
  const hidden = { schema: { hide: true } };

  /** The conversation, if the caller manages its site. */
  function conversationOf(req: FastifyRequest<{ Params: { id: string } }>) {
    const p = messenger(ctx, req);
    const c = messagingOf(p.org).conversations.find((x) => x.id === req.params.id);
    if (!c || !MESSAGE.some((perm) => p.g.can(perm, c.siteId))) throw notFound('Conversation');
    return { ...p, c };
  }

  app.get<{ Querystring: { siteId?: string } }>('/v1/messages', { ...read, ...hidden }, async (req) => {
    const { g, org, reader } = messenger(ctx, req);
    const data = messagingOf(org);
    const reach = g.at(...MESSAGE);
    const site = req.query.siteId;
    return data.conversations
      .filter((c) => reach(c) && (!site || c.siteId === site))
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
      .map((c) => {
        const last = data.messages.filter((m) => m.conversationId === c.id).at(-1);
        return {
          id: c.id,
          kind: c.kind,
          siteId: c.siteId,
          siteName: siteName(org, c.siteId),
          employeeId: c.employeeId ?? null,
          name: c.kind === 'direct' ? employeeName(org, c.employeeId) : c.title ?? 'Announcement',
          urgent: !!c.urgent,
          lastAt: c.lastAt,
          last: last ? { from: last.from.name, body: preview(last.body), at: last.at } : null,
          unread: unread(data, c, reader),
          ...(c.kind === 'announcement'
            ? { recipients: c.recipients?.length ?? 0, read: (c.recipients ?? []).filter((id) => data.reads[`${c.id}|${staffReader(id)}`]).length }
            : {}),
        };
      });
  });

  app.get<{ Params: { id: string } }>('/v1/messages/:id', { ...read, ...hidden }, async (req) => {
    const { org, c } = conversationOf(req);
    const data = messagingOf(org);
    const readAt = (id: string) => data.reads[`${c.id}|${staffReader(id)}`] ?? null;
    return {
      id: c.id,
      kind: c.kind,
      siteId: c.siteId,
      siteName: siteName(org, c.siteId),
      employeeId: c.employeeId ?? null,
      name: c.kind === 'direct' ? employeeName(org, c.employeeId) : c.title ?? 'Announcement',
      urgent: !!c.urgent,
      createdBy: c.createdBy,
      messages: data.messages.filter((m) => m.conversationId === c.id).map(messageView),
      // Read receipts: proof of what each person was told, and when they opened it.
      readers:
        c.kind === 'announcement'
          ? (c.recipients ?? []).map((id) => ({ employeeId: id, name: employeeName(org, id), readAt: readAt(id) }))
          : c.employeeId
            ? [{ employeeId: c.employeeId, name: employeeName(org, c.employeeId), readAt: readAt(c.employeeId) }]
            : [],
    };
  });

  app.post<{ Params: { id: string } }>('/v1/messages/:id/read', { ...read, ...hidden }, async (req) => {
    const { org, c, reader } = conversationOf(req);
    messagingOf(org).reads[`${c.id}|${reader}`] = ctx.now().toISOString();
    req.orgChanged = true;
    return { ok: true };
  });

  // A message to one member of staff, in their thread. Their own words come back the same way.
  app.post<{ Body: { employeeId?: string; body?: string; urgent?: boolean } }>('/v1/messages/direct', { ...write, ...hidden }, async (req, reply) => {
    const { g, org, name, userId, reader } = messenger(ctx, req);
    const employee = org.state.employees.find((e) => e.id === req.body?.employeeId);
    if (!employee) throw notFound('Employee');
    if (!MESSAGE.some((perm) => g.can(perm, employee.siteId))) g.allow('team.manage', employee.siteId);
    if (employee.status === 'leaver') throw new HttpError(409, 'leaver', `${employee.name} has left. Messages to a leaver are not sent.`);
    const problem = bodyProblem(req.body?.body);
    if (problem) throw new HttpError(400, 'invalid_message', problem);
    const at = ctx.now().toISOString();
    const thread = directThread(org, employee, name, at);
    const urgent = req.body?.urgent === true;
    const message = addMessage(org, thread, { at, from: { kind: 'manager', id: userId, name }, body: req.body!.body!.trim(), via: 'app', urgent });
    const out = await outboundFor(ctx, org);
    message.deliveries = await deliverToStaff(out, employee, `${name}: ${message.body}`, { urgent, subject: `Message from ${name}` });
    // Writing is reading: the sender has seen everything up to their own message.
    messagingOf(org).reads[`${thread.id}|${reader}`] = at;
    trimMessaging(messagingOf(org), ctx.now());
    audit(org, name, 'messaging.sent', { conversationId: thread.id, employeeId: employee.id, urgent });
    return reply.code(201).send({ conversationId: thread.id, message: messageView(message) });
  });

  // One message to a site's whole team, with read receipts. Not a group chat: replies go to each person's own thread.
  app.post<{ Body: { siteId?: string; title?: string; body?: string; urgent?: boolean } }>('/v1/messages/announcements', { ...write, ...hidden }, async (req, reply) => {
    const { g, org, name, userId, reader } = messenger(ctx, req);
    const siteId = req.body?.siteId ?? '';
    if (!org.state.sites.some((s) => s.id === siteId)) throw notFound('Site');
    g.allow('rota.publish', siteId);
    const problem = bodyProblem(req.body?.body);
    if (problem) throw new HttpError(400, 'invalid_message', problem);
    const title = (req.body?.title ?? '').trim().slice(0, MAX_TITLE) || `${siteName(org, siteId)} team`;
    const recipients = teamOf(org, siteId);
    if (recipients.length === 0) throw new HttpError(409, 'no_team', 'Nobody works at this site yet.');
    const at = ctx.now().toISOString();
    const urgent = req.body?.urgent === true;
    const c: Conversation = {
      id: `ann_${randomUUID()}`,
      kind: 'announcement',
      siteId,
      recipients: recipients.map((e) => e.id),
      title,
      urgent,
      createdAt: at,
      createdBy: name,
      lastAt: at,
    };
    const data = messagingOf(org);
    data.conversations.push(c);
    const message = addMessage(org, c, { at, from: { kind: 'manager', id: userId, name }, body: req.body!.body!.trim(), via: 'app', urgent });
    data.reads[`${c.id}|${reader}`] = at;
    const out = await outboundFor(ctx, org);
    const text = `${title}, from ${name}: ${message.body}`;
    const results = await inBatches(recipients, 10, (e) => deliverToStaff(out, e, text, { urgent, subject: title }));
    message.deliveries = results.flat();
    message.deliveries.push(...(await notifyTeam(out, siteId, `${name} sent "${title}" to ${recipients.length} people at ${siteName(org, siteId)}.`, managerLink(out, siteId, c.id))));
    trimMessaging(data, ctx.now());
    audit(org, name, 'messaging.announcement', { conversationId: c.id, siteId, recipients: recipients.length, urgent });
    return reply.code(201).send({ conversationId: c.id, message: messageView(message) });
  });

  // Who at a site can be reached, and how: the number to grow, since a message nobody sees changes nothing.
  app.get<{ Querystring: { siteId?: string } }>('/v1/messages/reach', { ...read, ...hidden }, async (req) => {
    const { g, org } = messenger(ctx, req);
    const siteId = req.query.siteId ?? '';
    if (!org.state.sites.some((s) => s.id === siteId)) throw notFound('Site');
    if (!MESSAGE.some((perm) => g.can(perm, siteId))) g.allow('team.manage', siteId);
    const reach = await reachOf(store, org);
    return org.state.employees
      .filter((e) => e.status !== 'leaver' && e.siteId === siteId)
      .map((e) => ({ employeeId: e.id, name: e.name, ...reach.get(e.id)! }));
  });

  // ---- Settings: the organisation's channels ----

  function settingsPerson(req: FastifyRequest) {
    if (!req.principal.email) throw new HttpError(403, 'forbidden', 'Settings are changed by a person signed in, not an API key.');
    const g = guard(ctx, req, orgOf(req));
    g.allow('settings.manage');
    return actorName(g);
  }

  const view = async (orgId: string, org: OrgData) =>
    settingsView(await getMessagingSettings(store, orgId), orgId, await appUrlOf(store, orgId), org.state.sites);

  const save = (orgId: string, s: MessagingSettings) => store.setSetting(messagingSetting(orgId), JSON.stringify(s));

  app.get('/v1/settings/messaging', hidden, async (req) => {
    settingsPerson(req);
    return view(req.principal.orgId, orgOf(req));
  });

  // Saving without a token keeps the one saved, so the template can change without re-entering it.
  app.put<{ Body: { phoneNumberId?: string; accessToken?: string; appSecret?: string; template?: string; language?: string } }>('/v1/settings/messaging/whatsapp', hidden, async (req) => {
    const who = settingsPerson(req);
    const orgId = req.principal.orgId;
    const current = await getMessagingSettings(store, orgId);
    const b = req.body ?? {};
    const phoneNumberId = b.phoneNumberId?.trim() ?? '';
    if (!/^\d{6,20}$/.test(phoneNumberId)) throw new HttpError(400, 'invalid_phone_number_id', "Enter the phone number ID from Meta's WhatsApp set-up page: digits only.");
    const accessToken = b.accessToken?.trim() || current.whatsapp?.accessToken;
    if (!accessToken || !/^[A-Za-z0-9_-]{30,}$/.test(accessToken)) throw new HttpError(400, 'invalid_token', 'Enter a permanent access token for a system user with whatsapp_business_messaging.');
    const appSecret = b.appSecret?.trim() || current.whatsapp?.appSecret;
    if (!appSecret || !/^[0-9a-f]{32}$/.test(appSecret)) throw new HttpError(400, 'invalid_app_secret', "Enter the Meta app's secret (32 characters, from App settings, Basic). It proves replies came from Meta.");
    const template = b.template?.trim() ?? '';
    if (!/^[a-z0-9_]{1,512}$/.test(template)) throw new HttpError(400, 'invalid_template', 'Enter the name of an approved template with one body variable, in lower case with underscores.');
    const language = b.language?.trim() || 'en_GB';
    if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language)) throw new HttpError(400, 'invalid_language', 'Enter the template language code, such as en_GB.');
    await save(orgId, { ...current, whatsapp: { phoneNumberId, accessToken, appSecret, template, language, verifyToken: current.whatsapp?.verifyToken ?? newVerifyToken() } });
    audit(orgOf(req), who, 'settings.whatsapp_set', { phoneNumberId, template });
    return view(orgId, orgOf(req));
  });

  app.put<{ Body: { accountSid?: string; authToken?: string; from?: string } }>('/v1/settings/messaging/sms', hidden, async (req) => {
    const who = settingsPerson(req);
    const orgId = req.principal.orgId;
    const current = await getMessagingSettings(store, orgId);
    const b = req.body ?? {};
    const accountSid = b.accountSid?.trim() ?? '';
    if (!/^AC[0-9a-f]{32}$/.test(accountSid)) throw new HttpError(400, 'invalid_sid', 'Enter the Twilio account SID. It starts AC.');
    const authToken = b.authToken?.trim() || current.sms?.authToken;
    if (!authToken || !/^[0-9a-f]{32}$/.test(authToken)) throw new HttpError(400, 'invalid_token', 'Enter the Twilio auth token (32 characters).');
    const raw = b.from?.trim() ?? '';
    const from = normalisePhone(raw) ?? (/^(?=.*[A-Za-z])[A-Za-z0-9 ]{1,11}$/.test(raw) ? raw : null);
    if (!from) throw new HttpError(400, 'invalid_from', 'Enter the Twilio number texts come from, or a sender name of up to 11 letters and numbers.');
    await save(orgId, { ...current, sms: { accountSid, authToken, from } });
    audit(orgOf(req), who, 'settings.sms_set', { from });
    return view(orgId, orgOf(req));
  });

  app.delete<{ Params: { channel: string } }>('/v1/settings/messaging/:channel', hidden, async (req) => {
    const who = settingsPerson(req);
    const channel = req.params.channel;
    if (channel !== 'whatsapp' && channel !== 'sms') throw notFound('Channel');
    const orgId = req.principal.orgId;
    const { [channel]: _gone, ...rest } = await getMessagingSettings(store, orgId);
    await save(orgId, rest);
    audit(orgOf(req), who, `settings.${channel}_removed`);
    return view(orgId, orgOf(req));
  });

  // A team channel for one site, or '*' for every site without its own. A null url removes it.
  app.put<{ Body: { channel?: string; siteId?: string; url?: string | null } }>('/v1/settings/messaging/team', hidden, async (req) => {
    const who = settingsPerson(req);
    const orgId = req.principal.orgId;
    const org = orgOf(req);
    const channel = req.body?.channel;
    if (channel !== 'slack' && channel !== 'teams') throw new HttpError(400, 'invalid_channel', 'Choose Slack or Teams.');
    const siteId = req.body?.siteId ?? '';
    if (siteId !== '*' && !org.state.sites.some((s) => s.id === siteId)) throw notFound('Site');
    const current = await getMessagingSettings(store, orgId);
    const map = { ...(current[channel] ?? {}) };
    const url = req.body?.url?.trim();
    if (url) {
      const problem = teamUrlProblem(channel, url);
      if (problem) throw new HttpError(400, 'invalid_url', problem);
      map[siteId] = url;
    } else delete map[siteId];
    await save(orgId, { ...current, [channel]: map });
    audit(org, who, url ? `settings.${channel}_set` : `settings.${channel}_removed`, { siteId });
    return view(orgId, org);
  });

  app.put<{ Body: { emailWhenUnset?: boolean } }>('/v1/settings/messaging/defaults', hidden, async (req) => {
    const who = settingsPerson(req);
    const orgId = req.principal.orgId;
    const current = await getMessagingSettings(store, orgId);
    const emailWhenUnset = req.body?.emailWhenUnset === true;
    await save(orgId, { ...current, emailWhenUnset });
    audit(orgOf(req), who, 'settings.messaging_defaults_set', { emailWhenUnset });
    return view(orgId, orgOf(req));
  });

  app.post<{ Body: { channel?: string; siteId?: string } }>('/v1/settings/messaging/test', hidden, async (req) => {
    const who = settingsPerson(req);
    const org = orgOf(req);
    const channel = req.body?.channel;
    if (channel !== 'slack' && channel !== 'teams') throw new HttpError(400, 'invalid_channel', 'Choose Slack or Teams.');
    const map = (await getMessagingSettings(store, org.orgId))[channel] ?? {};
    const url = map[req.body?.siteId ?? '*'];
    if (!url) throw notFound(`${CHANNEL_NAMES[channel]} channel`);
    const sent = await postTeam(ctx.fetch, channel, url, `Preshift is connected. ${who} sent this test from Settings.`, null);
    if (!sent.ok) throw new HttpError(502, 'not_delivered', sent.detail ?? 'Not delivered');
    return { ok: true };
  });
}

/** The staff app's side: the person's own thread, announcements to them, and how they want to hear. */
export function staffMessageRoutes(app: FastifyInstance, ctx: AppContext) {
  const { store } = ctx;
  const hidden = { schema: { hide: true } };

  function threadsFor(org: OrgData, employee: Employee) {
    const data = messagingOf(org);
    const reader = staffReader(employee.id);
    const mine = data.conversations.filter((c) => (c.kind === 'direct' && c.employeeId === employee.id) || (c.kind === 'announcement' && c.recipients?.includes(employee.id)));
    return mine
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
      .map((c) => ({
        id: c.id,
        kind: c.kind,
        title: c.kind === 'direct' ? `Your managers at ${siteName(org, c.siteId)}` : c.title ?? 'Announcement',
        urgent: !!c.urgent,
        lastAt: c.lastAt,
        unread: unread(data, c, reader),
        // Their own view: who wrote and what, never how it was carried to anyone else.
        messages: data.messages
          .filter((m) => m.conversationId === c.id)
          .slice(-200)
          .map((m) => ({ id: m.id, at: m.at, from: m.from.kind === 'staff' ? 'You' : m.from.name, mine: m.from.kind === 'staff', body: m.body, urgent: !!m.urgent })),
      }));
  }

  /** What the person may choose from: only channels the organisation has connected. */
  async function offered(orgId: string) {
    const s = await getMessagingSettings(store, orgId);
    const email = await emailConnected(store, orgId);
    return OUTSIDE_CHANNELS.filter((c) => (c === 'whatsapp' ? !!s.whatsapp : c === 'sms' ? !!s.sms : email));
  }

  const prefsView = (prefs: StaffMessagingPrefs | undefined, offer: string[], email?: string) => ({
    offered: offer,
    channels: prefs?.channels ?? [],
    phone: prefs?.phone ?? null,
    whatsapp: !!prefs?.whatsappConsentAt,
    sms: !!prefs?.smsConsentAt,
    quiet: prefs?.quiet === undefined ? { start: 22 * 60, end: 7 * 60 } : prefs.quiet,
    email: email ?? null,
  });

  app.get('/v1/staff/messages', hidden, async (req) => {
    const { org, employee } = await requireStaff(req, store);
    return { threads: threadsFor(org, employee) };
  });

  app.post<{ Body: { body?: string } }>('/v1/staff/messages', hidden, async (req, reply) => {
    const { org, employee } = await requireStaff(req, store);
    const problem = bodyProblem(req.body?.body);
    if (problem) throw new HttpError(400, 'invalid_message', problem);
    const at = ctx.now().toISOString();
    const thread = directThread(org, employee, employee.name, at);
    const message = addMessage(org, thread, { at, from: { kind: 'staff', id: employee.id, name: employee.name }, body: req.body!.body!.trim(), via: 'app' });
    messagingOf(org).reads[`${thread.id}|${staffReader(employee.id)}`] = at;
    const out = await outboundFor(ctx, org);
    // The team channel hears that there is a message, never what it says.
    message.deliveries = await notifyTeam(out, thread.siteId, `New message from ${employee.name} at ${siteName(org, thread.siteId)}.`, managerLink(out, thread.siteId, thread.id));
    trimMessaging(messagingOf(org), ctx.now());
    audit(org, `staff:${employee.id}`, 'messaging.staff_sent', { conversationId: thread.id });
    await store.save(org);
    return reply.code(201).send({ threads: threadsFor(org, employee) });
  });

  app.post<{ Body: { conversationId?: string } }>('/v1/staff/messages/read', hidden, async (req) => {
    const { org, employee } = await requireStaff(req, store);
    const id = req.body?.conversationId ?? '';
    const c = messagingOf(org).conversations.find((x) => x.id === id);
    const theirs = c && ((c.kind === 'direct' && c.employeeId === employee.id) || c.recipients?.includes(employee.id));
    if (!theirs) throw notFound('Conversation');
    messagingOf(org).reads[`${id}|${staffReader(employee.id)}`] = ctx.now().toISOString();
    await store.save(org);
    return { ok: true };
  });

  app.get('/v1/staff/channels', hidden, async (req) => {
    const { org, employee, login } = await requireStaff(req, store);
    return prefsView(messagingOf(org).prefs[employee.id], await offered(org.orgId), login.email ?? employee.email);
  });

  // Consent is given here, by the person, with the number they typed: never by a manager for them.
  app.put<{ Body: { channels?: string[]; phone?: string | null; whatsapp?: boolean; sms?: boolean; quiet?: { start: number; end: number } | null } }>(
    '/v1/staff/channels',
    hidden,
    async (req) => {
      const { org, employee, login } = await requireStaff(req, store);
      const offer = await offered(org.orgId);
      const b = req.body ?? {};
      const data = messagingOf(org);
      const before = data.prefs[employee.id];
      const channels = [...new Set(b.channels ?? [])].filter((c): c is Exclude<PersonChannel, 'app'> => (OUTSIDE_CHANNELS as string[]).includes(c));
      const refused = channels.filter((c) => !offer.includes(c));
      if (refused.length) throw new HttpError(400, 'not_offered', `${refused.map((c) => CHANNEL_NAMES[c]).join(' and ')} is not set up at your work yet.`);
      const phone = b.phone ? normalisePhone(b.phone) : null;
      if (b.phone && !phone) throw new HttpError(400, 'invalid_phone', 'Enter your mobile number, such as 07700 900123.');
      const wantsPhone = channels.some((c) => c === 'whatsapp' || c === 'sms');
      if (wantsPhone && !phone) throw new HttpError(400, 'phone_required', 'Enter your mobile number for WhatsApp or text messages.');
      if (channels.includes('whatsapp') && b.whatsapp !== true) throw new HttpError(400, 'consent_required', 'Tick the box to agree to messages from work on WhatsApp.');
      if (channels.includes('sms') && b.sms !== true) throw new HttpError(400, 'consent_required', 'Tick the box to agree to text messages from work.');
      const quiet = b.quiet === null ? null : b.quiet ?? before?.quiet;
      if (quiet && ![quiet.start, quiet.end].every((m) => Number.isInteger(m) && m >= 0 && m < 1440)) throw new HttpError(400, 'invalid_quiet', 'Quiet hours are a start and end time.');
      const at = ctx.now().toISOString();
      // Consent is to this number: a new number needs it given again.
      const sameNumber = !!phone && phone === before?.phone;
      const whatsappConsentAt = channels.includes('whatsapp') ? (sameNumber && before?.whatsappConsentAt) || at : undefined;
      const smsConsentAt = channels.includes('sms') ? (sameNumber && before?.smsConsentAt) || at : undefined;
      const next: StaffMessagingPrefs = {
        channels,
        ...(phone ? { phone } : {}),
        ...(whatsappConsentAt ? { whatsappConsentAt } : {}),
        ...(smsConsentAt ? { smsConsentAt } : {}),
        ...(quiet !== undefined ? { quiet } : {}),
        updatedAt: at,
      };
      data.prefs[employee.id] = next;
      // Recorded without the number: when consent was given and withdrawn, and for what.
      const was = { whatsapp: !!before?.whatsappConsentAt, sms: !!before?.smsConsentAt };
      for (const c of ['whatsapp', 'sms'] as const) {
        const now = c === 'whatsapp' ? !!whatsappConsentAt : !!smsConsentAt;
        if (now !== was[c]) audit(org, `staff:${employee.id}`, now ? 'messaging.consent_given' : 'messaging.consent_withdrawn', { employeeId: employee.id, channel: c });
      }
      audit(org, `staff:${employee.id}`, 'messaging.preferences_set', { employeeId: employee.id, channels });
      await store.save(org);
      return prefsView(next, offer, login.email ?? employee.email);
    },
  );
}

/** Replies by WhatsApp, and Meta's reports of what was delivered and read. */
export function whatsappWebhookRoutes(app: FastifyInstance, ctx: AppContext) {
  const { store } = ctx;
  const hidden = { schema: { hide: true } };

  // Meta checks the address once, when the webhook is set up, with the verify token shown in Settings.
  app.get<{ Params: { orgId: string }; Querystring: Record<string, string> }>('/v1/integrations/whatsapp/webhook/:orgId', hidden, async (req, reply) => {
    const settings = (await store.has(req.params.orgId)) ? await getMessagingSettings(store, req.params.orgId) : {};
    const q = req.query;
    if (q['hub.mode'] !== 'subscribe' || !settings.whatsapp || q['hub.verify_token'] !== settings.whatsapp.verifyToken) return reply.code(403).send();
    return reply.type('text/plain').send(q['hub.challenge'] ?? '');
  });

  app.post<{ Params: { orgId: string } }>('/v1/integrations/whatsapp/webhook/:orgId', hidden, async (req, reply) => {
    const orgId = req.params.orgId;
    // The signature is checked before anything is said about the organisation, so the reply cannot be used to find one.
    const settings = (await store.has(orgId)) ? await getMessagingSettings(store, orgId) : {};
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
    if (!settings.whatsapp || !verifyMetaSignature(settings.whatsapp.appSecret, req.headers['x-hub-signature-256'] as string | undefined, raw)) {
      return reply.code(401).send({ error: 'unauthorised', message: 'Signature not valid' });
    }
    const payload = (req.body ?? {}) as WhatsAppInbound;
    let org = await store.load(orgId);
    const apply = (o: OrgData) => takeInbound(ctx, o, payload);
    let result = apply(org);
    // A yes to cover is answered at once: whether it is theirs, and to everyone it affects.
    for (const t of result.taken) await announceTaken(ctx, org, t);
    if (result.taken.some((t) => t.kind === 'refused')) await askDueRounds(ctx, org);
    if (result.ambiguous.length) {
      const out = await outboundFor(ctx, org);
      const at = ctx.now().toISOString();
      for (const { employee, count } of result.ambiguous) {
        const text = `You have ${count} cover offers open, so YES could mean any of them. Accept the one you want in the Preshift app.`;
        const m = addMessage(org, directThread(org, employee, 'Cover', at), { at, from: { kind: 'system', name: 'Cover' }, body: text, via: 'app' });
        m.deliveries = await deliverToStaff(out, employee, text, { subject: 'Cover' });
      }
    }
    try {
      await store.save(org);
    } catch (err) {
      if (!(err instanceof HttpError && err.statusCode === 409)) throw err;
      org = await store.load(orgId);
      result = apply(org);
      await store.save(org);
    }
    // Managers hear of a new message in their team channel once it is safely stored.
    if (result.received.length) {
      const out = await outboundFor(ctx, org);
      for (const r of result.received) await notifyTeam(out, r.siteId, `New WhatsApp reply from ${r.name}.`, managerLink(out, r.siteId, r.conversationId));
    }
    return { ok: true };
  });
}

const digits = (s: string) => s.replace(/\D/g, '');

/** Lays a webhook's messages and status reports onto the organisation. Each message id is taken once. */
export function takeInbound(ctx: Pick<AppContext, 'now'>, org: OrgData, payload: WhatsAppInbound) {
  const data = messagingOf(org);
  const received: { siteId: string; name: string; conversationId: string }[] = [];
  const taken: Taken[] = [];
  const ambiguous: { employee: Employee; count: number }[] = [];
  const rank: Record<string, number> = { failed: 1, sent: 2, delivered: 3, read: 4 };
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      for (const s of value.statuses ?? []) {
        if (!s.id || !s.status || !rank[s.status]) continue;
        for (const m of data.messages) {
          for (const d of m.deliveries) {
            if (d.channel !== 'whatsapp' || d.providerId !== s.id) continue;
            if (rank[s.status] > (rank[d.status] ?? 0)) {
              d.status = s.status as Delivery['status'];
              d.at = ctx.now().toISOString();
              if (s.status === 'failed') d.detail = s.errors?.[0]?.title ?? 'WhatsApp could not deliver it';
            }
          }
        }
      }
      for (const m of value.messages ?? []) {
        if (!m.id || !m.from || org.processedWebhookIds.has(`wa:${m.id}`)) continue;
        org.processedWebhookIds.add(`wa:${m.id}`);
        // Only a number someone agreed to WhatsApp from, and only while they are on the team.
        const employeeId = Object.entries(data.prefs).find(([, p]) => p.phone && p.whatsappConsentAt && digits(p.phone) === digits(m.from!))?.[0];
        const employee = org.state.employees.find((e) => e.id === employeeId && e.status !== 'leaver');
        if (!employee) continue;
        const at = m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : ctx.now().toISOString();
        data.lastInbound[employee.id] = at;
        const text = m.type === 'text' ? (m.text?.body ?? '').trim() : '';
        const thread = directThread(org, employee, employee.name, at);
        if (text && STOP_WORDS.includes(text.toLowerCase())) {
          const prefs = data.prefs[employee.id];
          data.prefs[employee.id] = { ...prefs, channels: prefs.channels.filter((c) => c !== 'whatsapp'), whatsappConsentAt: undefined, updatedAt: at };
          addMessage(org, thread, { at, from: { kind: 'system', name: 'Preshift' }, body: `${employee.name} stopped messages by WhatsApp. They still get them in the staff app.`, via: 'whatsapp' });
          audit(org, `staff:${employee.id}`, 'messaging.consent_withdrawn', { employeeId: employee.id, channel: 'whatsapp', by: 'reply' });
          continue;
        }
        // Text only: photos, voice notes and documents stay in WhatsApp, never pulled into staff records unseen.
        const body = text ? text.slice(0, 2000) : `(${employee.name.split(' ')[0]} sent a ${m.type ?? 'message'} on WhatsApp. Preshift keeps text only; ask them to type it or show you.)`;
        addMessage(org, thread, { at, from: { kind: 'staff', id: employee.id, name: employee.name }, body, via: 'whatsapp' });
        // YES to a cover offer accepts it, when there is only one it can mean.
        const offers = text && isYes(text) ? openOffersFor(coverOf(org), employee.id, londonParts(ctx.now())) : [];
        if (offers.length === 1) {
          taken.push(acceptOffer(org, offers[0], employee, 'whatsapp', ctx.now()));
          continue;
        }
        if (offers.length > 1) ambiguous.push({ employee, count: offers.length });
        received.push({ siteId: thread.siteId, name: employee.name, conversationId: thread.id });
      }
    }
  }
  if (received.length) audit(org, 'WhatsApp', 'messaging.whatsapp_received', { count: received.length });
  trimMessaging(data, ctx.now());
  return { received, taken, ambiguous };
}

