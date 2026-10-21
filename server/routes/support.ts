import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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
  type BugImpact,
  type SupportTicket,
  type TicketContext,
  type TicketKind,
  type TicketStatus,
} from '../../src/engine/support';
import { requireScope } from '../auth';
import { HttpError, notFound, orgOf } from '../context';
import type { Mail } from '../mail';
import { idParam } from '../schemas';
import { audit, type OrgData } from '../store';

/**
 * The Preshift support desk: where new tickets are sent, and how. Unset, tickets stay in the
 * organisation's own log and the desk reads them through the API.
 */
export interface SupportDesk {
  to: string;
  send: (mail: Mail) => Promise<boolean>;
}

const actor = (req: FastifyRequest) => req.principal.user?.email ?? req.principal.name;

/**
 * The support desk works through an integration key granted support:write by name, never a signed-in
 * customer and never a key that merely holds every scope: a customer's own integration is not the desk.
 */
const isDesk = (req: FastifyRequest) => !req.principal.user && req.principal.scopes.includes('support:write');

function supportOf(org: OrgData) {
  org.support ??= { tickets: [], answeredByHelp: 0 };
  return org.support;
}

const ticketView = (t: SupportTicket) => ({ ...t, responseDueAt: responseDueAt(t), responseTarget: targetFor(t).label });

/** Raising, voting and commenting are for people signed in, so every ticket has someone to answer. */
async function requirePerson(req: FastifyRequest, reply: FastifyReply) {
  if (!req.principal?.user) return reply.code(403).send({ error: 'forbidden', message: 'Sign in to raise or comment on a ticket' });
}

/** Admins of the organisation, or the support desk's key, may move a ticket on. */
async function requireTriage(req: FastifyRequest, reply: FastifyReply) {
  if (req.principal?.user?.role === 'admin' || isDesk(req)) return;
  return reply.code(403).send({ error: 'forbidden', message: 'Only an admin or the support desk can change a ticket’s status' });
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function deskEmail(to: string, orgId: string, t: SupportTicket, demo: boolean): Mail {
  const lines = [
    `${KIND_LABEL[t.kind]} from ${t.raisedBy} (organisation ${orgId}${demo ? ', public demo sandbox' : ''})`,
    t.severity ? `Severity: ${t.severity}. Stops them: ${IMPACTS[t.impact!].label}.` : '',
    `First response due: ${responseDueAt(t)} (${targetFor(t).label})`,
    '',
    t.title,
    '',
    t.detail,
    t.steps ? `\nSteps to reproduce:\n${t.steps}` : '',
    t.hoursSavedPerWeek ? `\nWorth, by their estimate: ${t.hoursSavedPerWeek} hours a week` : '',
    t.context ? `\nContext: ${JSON.stringify(t.context)}` : '',
    '',
    `Reply through the API: POST /v1/support/tickets/${t.id}/comments with a support:write key for ${orgId}.`,
  ].filter((l, i, all) => l !== '' || all[i - 1] !== '');
  const text = lines.join('\n');
  const tag = t.severity === 'blocking' ? '[BLOCKING] ' : '';
  return {
    to,
    subject: `${tag}${demo ? '[demo] ' : ''}${KIND_LABEL[t.kind]}: ${t.title} (${t.id})`,
    text,
    html: `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;line-height:1.5"><pre style="white-space:pre-wrap;font:inherit">${escape(text)}</pre></body></html>`,
  };
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
 * Front line support: questions, bug reports and feature ideas, each with a first response target,
 * and a count of questions the help library answered before anyone had to raise one. Everyone in the
 * organisation sees its tickets, so a known problem is reported once and an idea collects votes
 * instead of duplicates. Status is moved on by the organisation's admins or the support desk's key.
 */
export function supportRoutes(app: FastifyInstance, options: { desk?: SupportDesk; demo: boolean }) {
  const read = { preHandler: requireScope('rota:read') };
  const person = { preHandler: requirePerson };

  app.get('/v1/support/tickets', { ...read, schema: { tags: ['Support'], description: 'Every ticket the organisation has raised, open and blocking first.' } }, async (req) => {
    const support = orgOf(req).support;
    return {
      tickets: [...(support?.tickets ?? [])].sort(ticketOrder).map(ticketView),
      answeredByHelp: support?.answeredByHelp ?? 0,
      deskConnected: Boolean(options.desk),
    };
  });

  app.post<{ Body: RaiseBody }>(
    '/v1/support/tickets',
    {
      ...person,
      schema: {
        tags: ['Support'],
        description: 'Raises a question, a bug report or a feature idea. A bug says what it stops the operator doing, which sets its severity.',
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
      const b = req.body;
      const problem = ticketProblem(b);
      if (problem) throw new HttpError(400, 'incomplete', problem);
      const org = orgOf(req);
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
        raisedBy: actor(req),
        comments: [],
        ...(b.kind === 'bug' && b.impact ? { impact: b.impact, severity: IMPACTS[b.impact].severity } : {}),
        ...(b.kind === 'bug' && b.steps?.trim() ? { steps: b.steps.trim() } : {}),
        ...(b.kind === 'feature' ? { votes: [actor(req)], ...(b.hoursSavedPerWeek ? { hoursSavedPerWeek: b.hoursSavedPerWeek } : {}) } : {}),
        ...(b.context ? { context: b.context } : {}),
      };
      support.tickets.push(ticket);
      audit(org, actor(req), 'support.ticket_raised', { id: ticket.id, kind: ticket.kind, severity: ticket.severity });
      // A failed email never loses the ticket: it is saved either way and the desk can read it through the API.
      const emailed = options.desk ? await options.desk.send(deskEmail(options.desk.to, org.orgId, ticket, options.demo)) : false;
      return reply.code(201).send({ ...ticketView(ticket), emailed });
    },
  );

  app.post(
    '/v1/support/answered',
    { ...person, schema: { tags: ['Support'], description: 'Counts a question the help library answered, so no ticket was needed.' } },
    async (req) => {
      const support = supportOf(orgOf(req));
      support.answeredByHelp += 1;
      return { answeredByHelp: support.answeredByHelp };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/support/tickets/:id/vote',
    { ...person, schema: { tags: ['Support'], description: 'Adds or removes your vote on a feature idea.', params: idParam } },
    async (req) => {
      const org = orgOf(req);
      const t = supportOf(org).tickets.find((x) => x.id === req.params.id);
      if (!t) throw notFound(`Ticket ${req.params.id}`);
      if (t.kind !== 'feature') throw new HttpError(409, 'not_a_feature', 'Only feature ideas take votes.');
      const me = actor(req);
      const votes = t.votes ?? [];
      t.votes = votes.includes(me) ? votes.filter((v) => v !== me) : [...votes, me];
      return ticketView(t);
    },
  );

  app.post<{ Params: { id: string }; Body: { body: string } }>(
    '/v1/support/tickets/:id/comments',
    {
      preHandler: async (req, reply) => {
        if (!req.principal?.user && !isDesk(req)) return requirePerson(req, reply);
      },
      schema: {
        tags: ['Support'],
        description: 'Adds to a ticket. From the support desk’s key it is a reply, and the first one stops the response clock.',
        params: idParam,
        body: { type: 'object', additionalProperties: false, required: ['body'], properties: { body: { type: 'string', minLength: 1, maxLength: 5000 } } },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const t = supportOf(org).tickets.find((x) => x.id === req.params.id);
      if (!t) throw notFound(`Ticket ${req.params.id}`);
      const body = req.body.body.trim();
      if (!body) throw new HttpError(400, 'empty', 'Write something first.');
      const fromSupport = isDesk(req);
      const at = new Date().toISOString();
      t.comments.push({ at, author: actor(req), fromSupport, body });
      if (fromSupport) {
        t.firstResponseAt ??= at;
        if (t.status === 'new') t.status = 'acknowledged';
      }
      return reply.code(201).send(ticketView(t));
    },
  );

  app.patch<{ Params: { id: string }; Body: { status: TicketStatus } }>(
    '/v1/support/tickets/:id',
    {
      preHandler: requireTriage,
      schema: {
        tags: ['Support'],
        params: idParam,
        body: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string', enum: Object.keys(STATUS_LABEL) } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const t = supportOf(org).tickets.find((x) => x.id === req.params.id);
      if (!t) throw notFound(`Ticket ${req.params.id}`);
      const now = new Date().toISOString();
      t.status = req.body.status;
      t.resolvedAt = isOpen(t) ? undefined : (t.resolvedAt ?? now);
      if (isDesk(req)) t.firstResponseAt ??= now;
      audit(org, actor(req), 'support.ticket_updated', { id: t.id, status: t.status });
      return ticketView(t);
    },
  );
}
