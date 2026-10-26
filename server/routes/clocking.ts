import type { FastifyInstance } from 'fastify';
import { normaliseBadge } from '../../src/engine/clocking';
import type { Employee, GeoFence, GeoFix, Site, TimeEntry } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, londonParts, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { forReader } from './employees';
import { geofenceBody, geoFixBody, idParam } from '../schemas';
import { audit, type OrgData } from '../store';
import { employeeView } from './hr';
import { clockIn, clockOut, clockTime, endBreak, isFixedReader, onBreak } from './time';

const REPEAT_TAP_MINUTES = 2;

/** Minutes from a fixed epoch, so clocks on different dates compare. */
const minutesSince = (date: string, minute: number) => Date.parse(date) / 60_000 + minute;
const latest = (t: TimeEntry) =>
  minutesSince(t.date, Math.max(t.clockIn, t.clockOut ?? 0, ...(t.breaks ?? []).flatMap((b) => [b.start, b.end ?? 0])));

/** Sites are replaced, not edited in place: the demo seed shares its site records between organisations. */
export function replaceSite(org: OrgData, id: string, change: (site: Site) => Site): Site {
  const i = org.state.sites.findIndex((s) => s.id === id);
  if (i < 0) throw notFound(`Site ${id}`);
  org.state.sites = org.state.sites.map((s, j) => (j === i ? change(s) : s));
  return org.state.sites[i];
}

export type TapAction = 'clock_in' | 'clock_out' | 'break_end' | 'already_clocked_in' | 'already_clocked_out';

/**
 * One card tap at a site: clocks the holder in, out, or back from a break. Shared by readers under
 * their own key and by paired kiosks, so a card behaves the same wherever it is tapped.
 */
export function tapCard(
  org: OrgData,
  siteId: string,
  rawBadge: string,
  { at, location, fixedReader }: { at?: string; location?: GeoFix; fixedReader: boolean },
): TapResult {
  const badgeId = normaliseBadge(rawBadge);
  const employee = badgeId ? org.state.employees.find((e) => e.badgeId === badgeId) : undefined;
  if (!employee) throw new HttpError(404, 'unknown_card', 'This card is not enrolled. Ask a manager to add it to your profile.');
  return tapPerson(org, employee, siteId, { method: 'card', at, location, fixedReader });
}

export type TapResult = { action: TapAction; employee: { id: string; name: string }; entry: TimeEntry };

/**
 * One tap by a known person at a site, by card or by their phone on the site's tag: in, out, or
 * back from a break, whichever they need next.
 */
export function tapPerson(
  org: OrgData,
  employee: Employee,
  siteId: string,
  opts: { method: 'card' | 'tag'; at?: string; location?: GeoFix; fixedReader?: boolean },
): TapResult {
  const { at } = opts;
  const open = org.timeEntries.find((t) => t.employeeId === employee.id && t.status === 'open');
  const person = { id: employee.id, name: employee.name };
  // Readers often send one tap twice. A second tap within two minutes is the same tap, not a clock-out.
  const { date, minute } = londonParts(at ? new Date(at) : new Date());
  const now = minutesSince(date, minute);
  const last = org.timeEntries
    .filter((t) => t.employeeId === employee.id && t.source === 'clock')
    .reduce<TimeEntry | undefined>((a, t) => (!a || latest(t) > latest(a) ? t : a), undefined);
  if (last && now - latest(last) < REPEAT_TAP_MINUTES) {
    return { action: last.status === 'open' ? 'already_clocked_in' : 'already_clocked_out', employee: person, entry: last };
  }
  // Someone tapping while on a break is coming back from it, not leaving for the day.
  if (open && onBreak(open)) return { action: 'break_end', employee: person, entry: endBreak(open, at) };
  // A tap at another site closes the shift where it was opened, so hours are never left running.
  if (open) return { action: 'clock_out', employee: person, entry: clockOut(org, open, opts) };
  return { action: 'clock_in', employee: person, entry: clockIn(org, employee, siteId, opts) };
}

/** Site geofences, RFID card enrolment, and the card tap that clocks people in and out. */
export function clockingRoutes(app: FastifyInstance, ctx: AppContext) {
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
      // A wider fence lets people clock in from somewhere else: a site setting, behind the authenticator.
      const g = guard(ctx, req, org);
      g.allow('settings.manage');
      const geofence = { lat: req.body.lat, lng: req.body.lng, radiusMetres: req.body.radiusMetres };
      const site = replaceSite(org, req.params.id, (s) => ({ ...s, geofence }));
      audit(org, actorName(g), 'site.geofence_set', { siteId: site.id, ...geofence });
      return site;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/sites/:id/geofence',
    { ...setup, schema: { tags: ['Clocking'], description: 'Turns the location check off for a site.', params: idParam } },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      g.allow('settings.manage');
      const site = replaceSite(org, req.params.id, ({ geofence: _g, ...s }) => s);
      audit(org, actorName(g), 'site.geofence_removed', { siteId: site.id });
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
      // A card clocks its holder in: issuing one is the team's to manage, at the person's own site.
      const g = guard(ctx, req, org);
      g.allow('team.manage', employee.siteId);
      const badgeId = normaliseBadge(req.body.badgeId);
      if (badgeId.length < 4) throw new HttpError(422, 'invalid_badge', 'That card reading is too short. Tap the card again.');
      const holder = org.state.employees.find((e) => e.badgeId === badgeId && e.id !== employee.id);
      if (holder) throw new HttpError(409, 'badge_in_use', `That card is already enrolled for ${holder.name}. Remove it from them first.`);
      employee.badgeId = badgeId;
      audit(org, actorName(g), 'employee.badge_enrolled', { id: employee.id });
      return forReader(g, employeeView(req, employee, g));
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/employees/:id/badge',
    { ...setup, schema: { tags: ['Clocking'], description: 'Removes a lost or returned card.', params: idParam } },
    async (req) => {
      const org = orgOf(req);
      const employee = org.state.employees.find((e) => e.id === req.params.id);
      if (!employee) throw notFound(`Employee ${req.params.id}`);
      const g = guard(ctx, req, org);
      g.allow('team.manage', employee.siteId);
      delete employee.badgeId;
      audit(org, actorName(g), 'employee.badge_removed', { id: employee.id });
      return forReader(g, employeeView(req, employee, g));
    },
  );

  app.post<{ Body: { badgeId: string; siteId: string; at?: string; location?: GeoFix } }>(
    '/v1/time-entries/tap',
    {
      ...write,
      schema: {
        tags: ['Clocking'],
        description:
          'A card tapped on a site reader. Clocks the card holder in, or out if they are already in. A reader fixed at the ' +
          'site under its own API key needs no location, and may send the time of a tap it held while offline. A card read ' +
          "on a signed-in person's phone or tablet needs the device inside the site's geofence, and is timed by the server.",
        body: {
          type: 'object',
          required: ['badgeId', 'siteId'],
          properties: { badgeId: { type: 'string', minLength: 1 }, siteId: { type: 'string' }, at: { type: 'string', format: 'date-time' }, location: geoFixBody },
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      guard(ctx, req, org).allow('time.record', req.body.siteId);
      const at = clockTime(req, req.body.at);
      const result = tapCard(org, req.body.siteId, req.body.badgeId, { at, location: req.body.location, fixedReader: isFixedReader(req) });
      return result.action === 'clock_in' ? reply.code(201).send(result) : result;
    },
  );
}
