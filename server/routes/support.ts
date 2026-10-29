import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { live, type User } from '../../src/engine/access';
import {
  DAILY_TICKET_LIMIT,
  IMPACTS,
  isOpen,
  KIND_LABEL,
  responseDueAt,
  STATUS_LABEL,
  targetFor,
  ticketOrder,
  ticketProblem,
  withinRetention,
  type BugImpact,
  type SupportTicket,
  type TicketContext,
  type TicketKind,
  type TicketStatus,
} from '../../src/engine/support';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { actorOf } from '../guard';
import { emailSetting, linkFor, parseEmailSettings, sendMail, type Mail } from '../mail';
import { isSandbox } from '../sandbox';
import { idParam } from '../schemas';
import { audit, type OrgData } from '../store';

/**
 * The client's support desk is its client partner: a Williams, Stanley & Co. person holding the
 * client partner role across this organisation. Never an API key, so no client can make itself
 * the desk and mark its own tickets answered.
 */
function deskOf(org: OrgData, today: string): User[] {
  return org.users.filter(
    (u) => u.audience === 'ws' && u.status === 'active' && u.memberships.some((m) => m.roleId === 'ws_partner' && !m.siteIds && live(m, today)),
  );
}

/**
 * Support is for people signed in, so every ticket has someone to answer and every reply someone
 * who wrote it. A system key is nobody; a personal key acts as its person.
 */
function supportPerson(ctx: AppContext, req: FastifyRequest): { user: User; desk: boolean; org: OrgData } {
  const org = orgOf(req);
  const today = ctx.store.todayISO();
  const actor = actorOf(req, org, today);
  if (actor.kind !== 'user') throw new HttpError(403, 'forbidden', 'Support tickets are raised and answered by people signed in, never by an integration key.');
  return { user: actor.user, desk: deskOf(org, today).some((u) => u.id === actor.user.id), org };
}

/** The organisation's tickets, closed ones past retention dropped as they are read. */
function supportOf(org: OrgData) {
  org.support ??= { tickets: [], answeredByHelp: 0 };
  org.support.tickets = withinRetention(org.support.tickets, new Date());
  return org.support;
}

const ticketView = (t: SupportTicket) => ({ ...t, responseDueAt: responseDueAt(t), responseTarget: targetFor(t).label });

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** What the client partner receives: enough to act on without opening the app, and a link to the ticket. */
export function deskEmail(to: string, client: string, t: SupportTicket, link: string): Mail {
  const lines = [
    `${KIND_LABEL[t.kind]} from ${t.raisedBy} at ${client}`,
    t.severity ? `Severity: ${t.severity}. Stops them: ${IMPACTS[t.impact!].label}.` : '',
    `First response due: ${new Date(responseDueAt(t)).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' })} London (${targetFor(t).label})`,
    '',
    t.title,
    '',
    t.detail,
    t.steps ? `\nSteps to reproduce:\n${t.steps}` : '',
    t.hoursSavedPerWeek ? `\nWorth, by their estimate: ${t.hoursSavedPerWeek} hours a week` : '',
    '',
    `Reply in Preshift, under Help > Support for ${client}: ${link}`,
  ].filter((l, i, all) => l !== '' || all[i - 1] !== '');
  const text = lines.join('\n');
  return {
    to,
    subject: `${t.severity === 'blocking' ? '[BLOCKING] ' : ''}${client}: ${KIND_LABEL[t.kind]}: ${t.title.replace(/[\r\n]+/g, ' ')}`,
    text,
    html: `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;line-height:1.5"><pre style="white-space:pre-wrap;font:inherit">${escape(text)}</pre></body></html>`,
  };
}

/**
 * Tells each of the client's partners, through their own WS organisation's email, as a client
 * owner's invitation goes. A failed or impossible send never loses the ticket: it is saved either
 * way and says so, and the partner sees it in the app.
 */
async function notifyDesk(ctx: AppContext, org: OrgData, t: SupportTicket): Promise<SupportTicket['notified']> {
  if (isSandbox(org.orgId)) return 'demo';
  const desk = deskOf(org, ctx.store.todayISO());
  if (desk.length === 0) return 'no_desk';
  let sent = 0;
  let ready = 0;
  const client = org.state.entities[0]?.name ?? org.orgId;
  for (const partner of desk) {
    const home = (await ctx.store.getUser(partner.email))?.orgId;
    const settings = home ? parseEmailSettings(await ctx.store.getSetting(emailSetting(home))) : null;
    if (!settings) continue;
    ready++;
    if ((await sendMail(settings, deskEmail(partner.email, client, t, linkFor(settings, '/?view=support')))) !== null) sent++;
  }
  return sent > 0 ? 'emailed' : ready > 0 ? 'failed' : 'not_set_up';
}

const contextSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tab: { type: 'string', maxLength: 40 },
    siteId: { type: 'string', maxLength: 60 },
    week: { type: 'string', maxLength: 10 },
    userAgent: { type: 'string', maxLength: 300 },
  },
} as const;

type RaiseBody = {
  kind: TicketKind;
  title: string;
  detail: string;
  impact?: BugImpact;
  steps?: string;
  hoursSavedPerWeek?: number;
  context?: TicketContext;
};

/**
 * Support: questions, bug reports and feature ideas, each with a first response target counted in
 * working hours, answered by the client's client partner. Everyone in the organisation sees its
 * tickets, so a known problem is reported once and an idea collects votes rather than duplicates.
 * Only the desk moves a ticket on, and only its reply stops the response clock.
 */
export function supportRoutes(app: FastifyInstance, ctx: AppContext) {
  const tags = ['Support'];
  const find = (org: OrgData, id: string) => {
    const t = supportOf(org).tickets.find((x) => x.id === id);
    if (!t) throw notFound(`Ticket ${id}`);
    return t;
  };

  app.get('/v1/support/tickets', { schema: { tags, description: 'Every ticket the organisation has raised, open and blocking first, with who answers them.' } }, async (req) => {
    const { desk, org } = supportPerson(ctx, req);
    const support = supportOf(org);
    return {
      tickets: [...support.tickets].sort(ticketOrder).map(ticketView),
      answeredByHelp: support.answeredByHelp,
      desk: deskOf(org, ctx.store.todayISO()).map((u) => u.name),
      youAreDesk: desk,
    };
  });

  app.post<{ Body: RaiseBody }>(
    '/v1/support/tickets',
    {
      schema: {
        tags,
        description: "Raises a question, a bug report or a feature idea, and tells the client's client partner. A bug says what it stops, which sets its severity.",
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'title', 'detail'],
          properties: {
            kind: { type: 'string', enum: Object.keys(KIND_LABEL) },
            title: { type: 'string', maxLength: 140 },
            detail: { type: 'string', maxLength: 5000 },
            impact: { type: 'string', enum: Object.keys(IMPACTS) },
            steps: { type: 'string', maxLength: 3000 },
            hoursSavedPerWeek: { type: 'number', minimum: 0, maximum: 1000 },
            context: contextSchema,
          },
        },
      },
    },
    async (req, reply) => {
      const { user, org } = supportPerson(ctx, req);
      const b = req.body;
      const problem = ticketProblem(b);
      if (problem) throw new HttpError(400, 'incomplete', problem);
      const support = supportOf(org);
      const now = new Date();
      const dayAgo = now.getTime() - 86_400_000;
      if (support.tickets.filter((t) => new Date(t.raisedAt).getTime() > dayAgo).length >= DAILY_TICKET_LIMIT) {
        throw new HttpError(429, 'too_many', 'That is a lot of tickets for one day. Add to an open one, or try again tomorrow.');
      }
      const ticket: SupportTicket = {
        id: `tkt_${randomUUID().slice(0, 12)}`,
        kind: b.kind,
        title: b.title.trim(),
        detail: b.detail.trim(),
        status: 'new',
        raisedAt: now.toISOString(),
        raisedBy: user.name,
        comments: [],
        ...(b.kind === 'bug' && b.impact ? { impact: b.impact, severity: IMPACTS[b.impact].severity } : {}),
        ...(b.kind === 'bug' && b.steps?.trim() ? { steps: b.steps.trim() } : {}),
        ...(b.kind === 'feature' ? { votes: [user.name], ...(b.hoursSavedPerWeek ? { hoursSavedPerWeek: b.hoursSavedPerWeek } : {}) } : {}),
        ...(b.context ? { context: b.context } : {}),
      };
      ticket.notified = await notifyDesk(ctx, org, ticket);
      support.tickets.push(ticket);
      audit(org, user.name, 'support.ticket_raised', { id: ticket.id, kind: ticket.kind, severity: ticket.severity, notified: ticket.notified });
      return reply.code(201).send(ticketView(ticket));
    },
  );

  app.post('/v1/support/answered', { schema: { tags, description: 'Counts a question a help answer closed, so no ticket was needed.' } }, async (req) => {
    const { org } = supportPerson(ctx, req);
    const support = supportOf(org);
    support.answeredByHelp += 1;
    return { answeredByHelp: support.answeredByHelp };
  });

  app.post<{ Params: { id: string } }>(
    '/v1/support/tickets/:id/vote',
    { schema: { tags, description: 'Adds or removes your vote on a feature idea.', params: idParam } },
    async (req) => {
      const { user, org } = supportPerson(ctx, req);
      const t = find(org, req.params.id);
      if (t.kind !== 'feature') throw new HttpError(409, 'not_a_feature', 'Only feature ideas take votes.');
      const votes = t.votes ?? [];
      t.votes = votes.includes(user.name) ? votes.filter((v) => v !== user.name) : [...votes, user.name];
      return ticketView(t);
    },
  );

  app.post<{ Params: { id: string }; Body: { body: string } }>(
    '/v1/support/tickets/:id/comments',
    {
      schema: {
        tags,
        description: "Adds to a ticket. From the client's client partner it is the desk's reply, and the first one stops the response clock.",
        params: idParam,
        body: { type: 'object', additionalProperties: false, required: ['body'], properties: { body: { type: 'string', minLength: 1, maxLength: 5000 } } },
      },
    },
    async (req, reply) => {
      const { user, desk, org } = supportPerson(ctx, req);
      const t = find(org, req.params.id);
      const body = req.body.body.trim();
      if (!body) throw new HttpError(400, 'empty', 'Write something first.');
      const at = new Date().toISOString();
      t.comments.push({ at, author: user.name, fromSupport: desk, body });
      if (desk) {
        t.firstResponseAt ??= at;
        if (t.status === 'new') t.status = 'acknowledged';
      }
      audit(org, user.name, 'support.ticket_commented', { id: t.id, fromSupport: desk });
      return reply.code(201).send(ticketView(t));
    },
  );

  app.patch<{ Params: { id: string }; Body: { status: TicketStatus } }>(
    '/v1/support/tickets/:id',
    {
      schema: {
        tags,
        description: "Moves a ticket on. Only the client's client partner, the desk, may.",
        params: idParam,
        body: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string', enum: Object.keys(STATUS_LABEL) } } },
      },
    },
    async (req) => {
      const { user, desk, org } = supportPerson(ctx, req);
      if (!desk) throw new HttpError(403, 'forbidden', "Only the client partner answering this organisation's support moves a ticket on.");
      const t = find(org, req.params.id);
      const now = new Date().toISOString();
      t.status = req.body.status;
      t.resolvedAt = isOpen(t) ? undefined : (t.resolvedAt ?? now);
      t.firstResponseAt ??= now;
      audit(org, user.name, 'support.ticket_updated', { id: t.id, status: t.status });
      return ticketView(t);
    },
  );
}
