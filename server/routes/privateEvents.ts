import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { importPrivateEvents } from '../../src/engine/privateEventImport';
import { eventTeam, mergePrivateEvents } from '../../src/engine/privateEvents';
import type { PrivateEvent } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, londonToday, notFound, orgOf, type AppContext } from '../context';
import { isoDate, rangeQuery } from '../schemas';
import { guard } from '../guard';
import { audit, type OrgData } from '../store';

/**
 * Only these fields are kept for an event: anything else in a request is dropped
 * as it is read, so a connector sending whole event records from Tripleseat or
 * SevenRooms cannot pass the client's name, contacts or notes through to storage.
 */
const eventFields = {
  siteId: { type: 'string' },
  date: isoDate,
  startMinute: { type: 'integer', minimum: 0, maximum: 1439 },
  // Past midnight runs on: a wedding from 14:00 to 01:00 ends at 1500.
  endMinute: { type: 'integer', minimum: 1, maximum: 2879 },
  guests: { type: 'integer', minimum: 1, maximum: 5000 },
  kind: { type: 'string', enum: ['wedding', 'private_hire', 'party', 'corporate', 'other'] },
  style: { type: 'string', enum: ['seated', 'buffet', 'standing', 'drinks'] },
  status: { type: 'string', enum: ['enquiry', 'provisional', 'confirmed', 'cancelled'] },
  exclusive: { type: 'boolean' },
  space: { type: 'string', maxLength: 60 },
  spend: { type: 'number', minimum: 0, maximum: 10_000_000 },
} as const;

const pushedRow = {
  type: 'object',
  required: ['id', 'siteId', 'source', 'date', 'startMinute', 'endMinute', 'guests', 'status'],
  additionalProperties: false,
  properties: { id: { type: 'string', minLength: 1, maxLength: 120 }, source: { type: 'string', pattern: '^[a-z0-9_-]{1,30}$' }, ...eventFields },
} as const;

const realDay = (d: string) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

function check(e: Pick<PrivateEvent, 'id' | 'date' | 'startMinute' | 'endMinute'>) {
  if (!realDay(e.date)) throw new HttpError(422, 'invalid_date', `Event ${e.id} has no such date ${e.date}`);
  if (e.endMinute <= e.startMinute) throw new HttpError(422, 'invalid_time', `Event ${e.id} ends before it starts: an end past midnight is written as 24:00 or later`);
  if (e.endMinute - e.startMinute > 18 * 60) throw new HttpError(422, 'invalid_time', `Event ${e.id} runs over eighteen hours: enter each day of a longer event on its own`);
}

/** Fills what a connector or a person may leave out. */
const complete = (e: Omit<PrivateEvent, 'kind' | 'style' | 'exclusive'> & Partial<Pick<PrivateEvent, 'kind' | 'style' | 'exclusive'>>): PrivateEvent => ({
  ...e,
  kind: e.kind ?? 'other',
  style: e.style ?? 'seated',
  exclusive: e.exclusive ?? e.kind === 'private_hire',
});

export function privateEventRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('rota:write') };
  const today = () => londonToday(ctx);
  const requireSite = (org: OrgData, siteId: string) => {
    if (!org.state.sites.some((s) => s.id === siteId)) throw notFound(`Site ${siteId}`);
  };
  const held = (org: OrgData, id: string) => {
    const e = (org.state.privateEvents ?? []).find((x) => x.id === id);
    if (!e) throw notFound(`Event ${id}`);
    return e;
  };
  // What the rota will ask for, so whoever books the event sees the team it needs.
  const view = (org: OrgData, e: PrivateEvent) => ({ ...e, team: eventTeam(org.state, e) });

  app.get<{ Querystring: { siteId?: string; from?: string; to?: string } }>(
    '/v1/private-events',
    { ...read, schema: { tags: ['Private events'], querystring: rangeQuery, description: 'Weddings, buyouts and functions, with the team each needs by role.' } },
    async (req) => {
      const q = req.query;
      const org = orgOf(req);
      const visible = guard(ctx, req, org).at('rota.view');
      return (org.state.privateEvents ?? [])
        .filter((e) => visible(e) && (!q.siteId || e.siteId === q.siteId) && (!q.from || e.date >= q.from) && (!q.to || e.date <= q.to))
        .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute)
        .map((e) => view(org, e));
    },
  );

  app.put<{ Body: { rows: (Omit<PrivateEvent, 'kind' | 'style' | 'exclusive'> & Partial<PrivateEvent>)[] } }>(
    '/v1/private-events',
    {
      ...write,
      bodyLimit: 5 * 1024 * 1024,
      schema: {
        tags: ['Private events'],
        description:
          'Events from Tripleseat, SevenRooms or any events system, by its own reference: when, how many, how served, the status and what it is worth. ' +
          'Any other field is dropped as it is read, so no client details are ever stored. Send an event again to change it, or with status cancelled to stand it down.',
        body: { type: 'object', required: ['rows'], properties: { rows: { type: 'array', maxItems: 5000, items: pushedRow } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      for (const siteId of new Set(req.body.rows.map((r) => r.siteId))) {
        requireSite(org, siteId);
        g.allow('demand.manage', siteId);
      }
      const rows = req.body.rows.map((r) => complete({ ...r, id: r.id.startsWith(`${r.source}:`) ? r.id : `${r.source}:${r.id}` }));
      rows.forEach(check);
      org.state.privateEvents = mergePrivateEvents(org.state.privateEvents ?? [], rows);
      audit(org, req.principal.name, 'private_events.received', { rows: rows.length, sites: [...new Set(rows.map((r) => r.siteId))] });
      return { received: rows.length };
    },
  );

  app.post<{ Body: { siteId: string; source: string; csv: string; usDates?: boolean; spendIncludesVat?: boolean } }>(
    '/v1/private-events/import',
    {
      ...write,
      bodyLimit: 15 * 1024 * 1024,
      schema: {
        tags: ['Private events'],
        description:
          'Imports an events export (CSV) from Tripleseat, SevenRooms or anything similar. Columns are found by name; only date, times, guest count, ' +
          'status, type, style, room and total are read. Totals are taken as including VAT unless spendIncludesVat is false.',
        body: {
          type: 'object',
          required: ['siteId', 'source', 'csv'],
          additionalProperties: false,
          properties: {
            siteId: { type: 'string' },
            source: { type: 'string', enum: ['tripleseat', 'sevenrooms', 'other'] },
            csv: { type: 'string', maxLength: 12 * 1024 * 1024 },
            usDates: { type: 'boolean' },
            spendIncludesVat: { type: 'boolean' },
          },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      requireSite(org, req.body.siteId);
      guard(ctx, req, org).allow('demand.manage', req.body.siteId);
      const result = importPrivateEvents(req.body.csv, req.body.siteId, req.body.source, { usDates: req.body.usDates, spendIncludesVat: req.body.spendIncludesVat });
      org.state.privateEvents = mergePrivateEvents(org.state.privateEvents ?? [], result.rows);
      const ahead = result.rows.filter((e) => e.date >= today());
      audit(org, req.principal.name, 'private_events.imported', { siteId: req.body.siteId, source: req.body.source, rows: result.rows.length, skipped: result.skipped.length });
      return {
        imported: result.rows.length,
        ahead: ahead.length,
        confirmed: ahead.filter((e) => e.status === 'confirmed').length,
        columns: result.columns,
        notRead: result.ignored,
        skipped: result.skipped.length,
        problems: result.skipped.slice(0, 20),
      };
    },
  );

  app.post<{ Body: Omit<PrivateEvent, 'id' | 'source'> }>(
    '/v1/private-events',
    {
      ...write,
      schema: {
        tags: ['Private events'],
        description: 'An event entered by hand: one the events system does not hold, or a site with no events system.',
        body: { type: 'object', required: ['siteId', 'date', 'startMinute', 'endMinute', 'guests', 'kind', 'style', 'status'], additionalProperties: false, properties: eventFields },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      requireSite(org, req.body.siteId);
      guard(ctx, req, org).allow('demand.manage', req.body.siteId);
      const event = complete({ ...req.body, id: `manual:${randomUUID().slice(0, 12)}`, source: 'manual' });
      check(event);
      org.state.privateEvents = [...(org.state.privateEvents ?? []), event];
      audit(org, req.principal.name, 'private_event.added', { id: event.id, siteId: event.siteId, date: event.date, status: event.status });
      return reply.code(201).send(view(org, event));
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<Omit<PrivateEvent, 'id' | 'source' | 'siteId'>> }>(
    '/v1/private-events/:id',
    {
      ...write,
      schema: {
        tags: ['Private events'],
        description: 'Changes an event: confirmed, final numbers, a new time. An event from an events system is changed there too, or its next export puts it back.',
        body: { type: 'object', additionalProperties: false, properties: (({ siteId: _s, ...rest }) => rest)(eventFields) },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const event = held(org, req.params.id);
      guard(ctx, req, org).allow('demand.manage', event.siteId);
      const next = { ...event, ...req.body };
      check(next);
      org.state.privateEvents = org.state.privateEvents!.map((e) => (e.id === event.id ? next : e));
      audit(org, req.principal.name, 'private_event.changed', { id: event.id, fields: Object.keys(req.body), status: next.status });
      return view(org, next);
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/private-events/:id', { ...write, schema: { tags: ['Private events'] } }, async (req, reply) => {
    const org = orgOf(req);
    const event = held(org, req.params.id);
    // One from an events system is cancelled, not deleted: its next export would only bring it back.
    if (event.source !== 'manual') throw new HttpError(409, 'from_events_system', 'This event came from an events system: cancel it there, or mark it cancelled here');
    guard(ctx, req, org).allow('demand.manage', event.siteId);
    org.state.privateEvents = org.state.privateEvents!.filter((e) => e.id !== event.id);
    audit(org, req.principal.name, 'private_event.removed', { id: event.id });
    return reply.code(204).send();
  });
}
