import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DayNote, ShiftType } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { idParam, isoDate, minute, rangeQuery } from '../schemas';
import { audit, type OrgData } from '../store';
import { inRange } from './rota';

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

  app.get<{ Querystring: { siteId?: string; from?: string; to?: string } }>(
    '/v1/day-notes',
    { ...read, schema: { tags: ['Rota'], description: 'Notes on days for whoever builds the rota.', querystring: rangeQuery } },
    async (req) => {
      const org = orgOf(req);
      return (org.state.dayNotes ?? []).filter(inRange(req.query)).filter(guard(ctx, req, org).at('rota.view'));
    },
  );

  app.put<{ Body: Pick<DayNote, 'siteId' | 'date' | 'text'> }>(
    '/v1/day-notes',
    {
      ...write,
      schema: {
        tags: ['Rota'],
        description: "Writes a site's note for a day, replacing the one there. Empty text removes it.",
        body: {
          type: 'object',
          required: ['siteId', 'date', 'text'],
          additionalProperties: false,
          properties: { siteId: { type: 'string' }, date: isoDate, text: { type: 'string', maxLength: 500 } },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const { siteId, date } = req.body;
      requireSite(org, siteId);
      const g = guard(ctx, req, org);
      g.allow('rota.edit', siteId);
      const text = req.body.text.trim();
      const others = (org.state.dayNotes ?? []).filter((n) => n.siteId !== siteId || n.date !== date);
      if (!text) {
        org.state.dayNotes = others;
        audit(org, actorName(g), 'day_note.removed', { siteId, date });
        return { siteId, date, text: '' };
      }
      const note: DayNote = { siteId, date, text, updatedBy: actorName(g), updatedAt: ctx.now().toISOString() };
      org.state.dayNotes = [...others, note];
      audit(org, actorName(g), 'day_note.saved', { siteId, date });
      return note;
    },
  );
}
