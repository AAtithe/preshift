import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { NOTE_KINDS, overlaps } from '../../src/engine/dayNotes';
import type { DayNote, ShiftType } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { idParam, isoDate, minute, rangeQuery } from '../schemas';
import { audit, type OrgData } from '../store';

function requireSite(org: OrgData, siteId: string) {
  if (!org.state.sites.some((s) => s.id === siteId)) throw notFound(`Site ${siteId}`);
}

/**
 * What whoever builds the rota works from besides the forecast: the site's shift types, set up once
 * and picked from a list, and a note on any day (a big booking, an event, a road closure).
 */
export function rotaPlanningRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('rota:write') };

  // ----- Shift types -----

  app.get<{ Querystring: { siteId?: string } }>(
    '/v1/shift-types',
    { ...read, schema: { tags: ['Rota'], description: "Each site's saved shift patterns: times, unpaid break and, if set, the role.", querystring: { type: 'object', properties: { siteId: { type: 'string' } } } } },
    async (req) => {
      const org = orgOf(req);
      const visible = guard(ctx, req, org).at('rota.view');
      return (org.state.shiftTypes ?? []).filter((t) => visible(t) && (!req.query.siteId || t.siteId === req.query.siteId));
    },
  );

  app.post<{ Body: Omit<ShiftType, 'id'> }>(
    '/v1/shift-types',
    {
      ...write,
      schema: {
        tags: ['Rota'],
        description: 'Saves a shift pattern at a site, to pick from a list when building the rota. A finish at or before the start runs past midnight: send it as minutes past the start day, up to 48:00.',
        body: {
          type: 'object',
          required: ['siteId', 'name', 'startMinute', 'endMinute', 'breakMinutes'],
          additionalProperties: false,
          properties: {
            siteId: { type: 'string' },
            name: { type: 'string', minLength: 1, maxLength: 40 },
            startMinute: minute,
            endMinute: minute,
            breakMinutes: { type: 'integer', minimum: 0, maximum: 240 },
            roleId: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const body = req.body;
      requireSite(org, body.siteId);
      const g = guard(ctx, req, org);
      g.allow('rota.edit', body.siteId);
      if (body.endMinute <= body.startMinute) throw new HttpError(422, 'invalid_times', 'The finish must be after the start.');
      if (body.roleId && !org.state.roles.some((r) => r.id === body.roleId)) throw notFound(`Role ${body.roleId}`);
      const name = body.name.trim();
      const types = org.state.shiftTypes ?? [];
      if (types.some((t) => t.siteId === body.siteId && t.name.toLowerCase() === name.toLowerCase())) {
        throw new HttpError(409, 'conflict', `There is already a shift type called ${name} at this site.`);
      }
      const type: ShiftType = { ...body, name, id: `st_${randomUUID().slice(0, 12)}` };
      org.state.shiftTypes = [...types, type];
      audit(org, actorName(g), 'shift_type.added', { id: type.id, siteId: type.siteId });
      return reply.code(201).send(type);
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/shift-types/:id', { ...write, schema: { tags: ['Rota'], params: idParam } }, async (req, reply) => {
    const org = orgOf(req);
    const type = (org.state.shiftTypes ?? []).find((t) => t.id === req.params.id);
    if (!type) throw notFound(`Shift type ${req.params.id}`);
    const g = guard(ctx, req, org);
    g.allow('rota.edit', type.siteId);
    // Shifts already built from it keep their times: a type is a starting point, not a link.
    org.state.shiftTypes = org.state.shiftTypes!.filter((t) => t.id !== type.id);
    audit(org, actorName(g), 'shift_type.removed', { id: type.id, siteId: type.siteId });
    return reply.code(204).send();
  });

  // ----- Day notes -----

  const noteBody = {
    type: 'object',
    required: ['siteId', 'date', 'kind', 'text'],
    additionalProperties: false,
    properties: {
      siteId: { type: 'string' },
      date: isoDate,
      kind: { type: 'string', enum: NOTE_KINDS.map((k) => k.id) },
      text: { type: 'string', minLength: 1, maxLength: 500 },
      startMinute: { type: 'integer', minimum: 0, maximum: 1439 },
      team: { type: 'boolean' },
      weekly: { type: 'boolean' },
      until: isoDate,
    },
  } as const;
  type NoteBody = Pick<DayNote, 'siteId' | 'date' | 'kind' | 'text' | 'startMinute' | 'team' | 'weekly' | 'until'>;

  /** The note as written, checked: only what was sent is kept, so a change can clear a time or a repeat. */
  function noteFrom(body: NoteBody, id: string, by: string): DayNote {
    const text = body.text.trim();
    if (!text) throw new HttpError(422, 'invalid_note', 'Write something in the note.');
    if (body.until && !body.weekly) throw new HttpError(422, 'invalid_note', 'Only a note that repeats every week can have an end date.');
    if (body.until && body.until < body.date) throw new HttpError(422, 'invalid_note', 'A repeating note cannot end before it starts.');
    return {
      id,
      siteId: body.siteId,
      date: body.date,
      kind: body.kind,
      text,
      ...(body.startMinute !== undefined ? { startMinute: body.startMinute } : {}),
      ...(body.team ? { team: true } : {}),
      ...(body.weekly ? { weekly: true, ...(body.until ? { until: body.until } : {}) } : {}),
      updatedBy: by,
      updatedAt: ctx.now().toISOString(),
    };
  }

  app.get<{ Querystring: { siteId?: string; from?: string; to?: string } }>(
    '/v1/day-notes',
    {
      ...read,
      schema: {
        tags: ['Rota'],
        description: 'Notes on days for whoever builds the rota. A weekly note is listed once, from its first day, when any week it repeats falls in the range.',
        querystring: rangeQuery,
      },
    },
    async (req) => {
      const org = orgOf(req);
      const { siteId, from = '0000-01-01', to = '9999-12-31' } = req.query;
      const visible = guard(ctx, req, org).at('rota.view');
      return (org.state.dayNotes ?? []).filter((n) => visible(n) && (!siteId || n.siteId === siteId) && overlaps(n, from, to));
    },
  );

  app.post<{ Body: NoteBody }>(
    '/v1/day-notes',
    {
      ...write,
      schema: {
        tags: ['Rota'],
        description: 'Adds a note on a day at a site: a big booking, an event, a road closure, a delivery. `team` shows it to the people working there that day; `weekly` repeats it on the same weekday, to `until` if given.',
        body: noteBody,
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      requireSite(org, req.body.siteId);
      const g = guard(ctx, req, org);
      g.allow('rota.edit', req.body.siteId);
      const note = noteFrom(req.body, `dn_${randomUUID().slice(0, 12)}`, actorName(g));
      org.state.dayNotes = [...(org.state.dayNotes ?? []), note];
      audit(org, actorName(g), 'day_note.added', { id: note.id, siteId: note.siteId, date: note.date });
      return reply.code(201).send(note);
    },
  );

  app.put<{ Params: { id: string }; Body: NoteBody }>(
    '/v1/day-notes/:id',
    { ...write, schema: { tags: ['Rota'], description: 'Rewrites a note. A weekly note changes for every week it is for.', params: idParam, body: noteBody } },
    async (req) => {
      const org = orgOf(req);
      const old = (org.state.dayNotes ?? []).find((n) => n.id === req.params.id);
      if (!old) throw notFound(`Note ${req.params.id}`);
      requireSite(org, req.body.siteId);
      const g = guard(ctx, req, org);
      // Moving a note to another site needs the right at both.
      g.allow('rota.edit', old.siteId);
      g.allow('rota.edit', req.body.siteId);
      const note = noteFrom(req.body, old.id, actorName(g));
      org.state.dayNotes = org.state.dayNotes!.map((n) => (n.id === old.id ? note : n));
      audit(org, actorName(g), 'day_note.changed', { id: note.id, siteId: note.siteId, date: note.date });
      return note;
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/day-notes/:id', { ...write, schema: { tags: ['Rota'], params: idParam } }, async (req, reply) => {
    const org = orgOf(req);
    const note = (org.state.dayNotes ?? []).find((n) => n.id === req.params.id);
    if (!note) throw notFound(`Note ${req.params.id}`);
    const g = guard(ctx, req, org);
    g.allow('rota.edit', note.siteId);
    org.state.dayNotes = org.state.dayNotes!.filter((n) => n.id !== note.id);
    audit(org, actorName(g), 'day_note.removed', { id: note.id, siteId: note.siteId });
    return reply.code(204).send();
  });
}
