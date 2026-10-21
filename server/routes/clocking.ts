import type { FastifyInstance } from 'fastify';
import { normaliseBadge } from '../../src/engine/clocking';
import type { GeoFence, GeoFix, Site, TimeEntry } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, londonParts, notFound, orgOf, type AppContext } from '../context';
import { geofenceBody, geoFixBody, idParam } from '../schemas';
import { audit, type OrgData } from '../store';
import { employeeView } from './hr';
import { clockIn, clockOut, endBreak, onBreak } from './time';

const REPEAT_TAP_MINUTES = 2;

/** Minutes from a fixed epoch, so clocks on different dates compare. */
const minutesSince = (date: string, minute: number) => Date.parse(date) / 60_000 + minute;
const latest = (t: TimeEntry) =>
  minutesSince(t.date, Math.max(t.clockIn, t.clockOut ?? 0, ...(t.breaks ?? []).flatMap((b) => [b.start, b.end ?? 0])));

/** Sites are replaced, not edited in place: the demo seed shares its site records between organisations. */
function replaceSite(org: OrgData, id: string, change: (site: Site) => Site): Site {
  const i = org.state.sites.findIndex((s) => s.id === id);
  if (i < 0) throw notFound(`Site ${id}`);
  org.state.sites = org.state.sites.map((s, j) => (j === i ? change(s) : s));
  return org.state.sites[i];
}

/** Site geofences, RFID card enrolment, and the card tap that clocks people in and out. */
export function clockingRoutes(app: FastifyInstance, _ctx: AppContext) {
  const setup = { preHandler: requireScope('rota:write') };
  const write = { preHandler: requireScope('time:write') };

  app.put<{ Params: { id: string }; Body: GeoFence }>(
    '/v1/sites/:id/geofence',
    {
      ...setup,
      schema: {
        tags: ['Clocking'],
        description: 'Sets the area staff must be inside to clock in on a phone or tablet: a centre and a radius in metres.',
        params: idParam,
        body: geofenceBody,
      },
    },
    async (req) => {
      const org = orgOf(req);
      const geofence = { lat: req.body.lat, lng: req.body.lng, radiusMetres: req.body.radiusMetres };
      const site = replaceSite(org, req.params.id, (s) => ({ ...s, geofence }));
      audit(org, req.principal.name, 'site.geofence_set', { siteId: site.id, ...geofence });
      return site;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/sites/:id/geofence',
    { ...setup, schema: { tags: ['Clocking'], description: 'Turns the location check off for a site.', params: idParam } },
    async (req) => {
      const org = orgOf(req);
      const site = replaceSite(org, req.params.id, ({ geofence: _g, ...s }) => s);
      audit(org, req.principal.name, 'site.geofence_removed', { siteId: site.id });
      return site;
    },
  );

  app.put<{ Params: { id: string }; Body: { badgeId: string } }>(
    '/v1/employees/:id/badge',
    {
      ...setup,
      schema: {
        tags: ['Clocking'],
        description: 'Enrols an RFID card for a person, replacing any card they had. A card belongs to one person at a time.',
        params: idParam,
        body: { type: 'object', required: ['badgeId'], additionalProperties: false, properties: { badgeId: { type: 'string', minLength: 1 } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const employee = org.state.employees.find((e) => e.id === req.params.id);
      if (!employee) throw notFound(`Employee ${req.params.id}`);
      const badgeId = normaliseBadge(req.body.badgeId);
      if (badgeId.length < 4) throw new HttpError(422, 'invalid_badge', 'That card reading is too short. Tap the card again.');
      const holder = org.state.employees.find((e) => e.badgeId === badgeId && e.id !== employee.id);
      if (holder) throw new HttpError(409, 'badge_in_use', `That card is already enrolled for ${holder.name}. Remove it from them first.`);
      employee.badgeId = badgeId;
      audit(org, req.principal.name, 'employee.badge_enrolled', { id: employee.id });
      return employeeView(req, employee);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/employees/:id/badge',
    { ...setup, schema: { tags: ['Clocking'], description: 'Removes a lost or returned card.', params: idParam } },
    async (req) => {
      const org = orgOf(req);
      const employee = org.state.employees.find((e) => e.id === req.params.id);
      if (!employee) throw notFound(`Employee ${req.params.id}`);
      delete employee.badgeId;
      audit(org, req.principal.name, 'employee.badge_removed', { id: employee.id });
      return employeeView(req, employee);
    },
  );

  app.post<{ Body: { badgeId: string; siteId: string; at?: string; location?: GeoFix } }>(
    '/v1/time-entries/tap',
    {
      ...write,
      schema: {
        tags: ['Clocking'],
        description:
          'A card tapped on a site reader. Clocks the card holder in, or out if they are already in. The reader is fixed at ' +
          'the site, so no device location is required; one sent is recorded with the entry.',
        body: {
          type: 'object',
          required: ['badgeId', 'siteId'],
          properties: { badgeId: { type: 'string', minLength: 1 }, siteId: { type: 'string' }, at: { type: 'string', format: 'date-time' }, location: geoFixBody },
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const badgeId = normaliseBadge(req.body.badgeId);
      const employee = badgeId ? org.state.employees.find((e) => e.badgeId === badgeId) : undefined;
      if (!employee) throw new HttpError(404, 'unknown_card', 'This card is not enrolled. Ask a manager to add it to your profile.');
      const open = org.timeEntries.find((t) => t.employeeId === employee.id && t.status === 'open');
      const opts = { method: 'card' as const, at: req.body.at, location: req.body.location };
      const person = { id: employee.id, name: employee.name };
      // Readers often send one tap twice. A second tap within two minutes is the same tap, not a clock-out.
      const { date, minute } = londonParts(req.body.at ? new Date(req.body.at) : new Date());
      const now = minutesSince(date, minute);
      const last = org.timeEntries
        .filter((t) => t.employeeId === employee.id && t.source === 'clock')
        .reduce<TimeEntry | undefined>((a, t) => (!a || latest(t) > latest(a) ? t : a), undefined);
      if (last && now - latest(last) < REPEAT_TAP_MINUTES) {
        return { action: last.status === 'open' ? 'already_clocked_in' : 'already_clocked_out', employee: person, entry: last };
      }
      // Someone tapping while on a break is coming back from it, not leaving for the day.
      if (open && onBreak(open)) {
        return { action: 'break_end', employee: person, entry: endBreak(open, req.body.at) };
      }
      if (open) {
        // A tap at another site closes the shift where it was opened, so hours are never left running.
        return { action: 'clock_out', employee: person, entry: clockOut(org, open, opts) };
      }
      const entry = clockIn(org, employee, req.body.siteId, opts);
      return reply.code(201).send({ action: 'clock_in', employee: person, entry });
    },
  );
}
