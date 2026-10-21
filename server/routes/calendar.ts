import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { dueReminders, planAhead, type Reminder } from '../../src/engine/plan';
import { addDays } from '../../src/engine/time';
import type { ForecastAdjustment, LocalEvent } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, londonToday, notFound, orgOf, type AppContext } from '../context';
import { refreshOutside } from '../forecasting';
import { checkFeedUrl, FeedError, maskFeedUrl, type EventFeed } from '../integrations/feeds';
import { isoDate, rangeQuery } from '../schemas';
import { audit, type OrgData } from '../store';

const lat = { type: 'number', minimum: -90, maximum: 90 } as const;
const lng = { type: 'number', minimum: -180, maximum: 180 } as const;

function requireSite(org: OrgData, siteId: string) {
  const site = org.state.sites.find((s) => s.id === siteId);
  if (!site) throw notFound(`Site ${siteId}`);
  return site;
}

/** Reminders with what people have done about them; done and set-aside ones drop out of what is due. */
function withState(org: OrgData, reminders: Reminder[], siteId: string) {
  return reminders.map((r) => {
    const s = org.reminderStates.find((x) => x.key === r.key && x.siteId === siteId);
    return { ...r, siteId, status: s?.status ?? 'open', decidedBy: s?.by, decidedAt: s?.at, note: s?.note };
  });
}

export function calendarRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('rota:write') };
  const today = () => londonToday(ctx);

  app.put<{ Params: { id: string }; Body: { lat: number; lng: number } }>(
    '/v1/sites/:id/location',
    {
      ...write,
      schema: {
        tags: ['Calendar'],
        description: "Where the site is, for its weather and nearby events. Without one, the clock-in geofence's centre is used.",
        body: { type: 'object', required: ['lat', 'lng'], additionalProperties: false, properties: { lat, lng } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const site = requireSite(org, req.params.id);
      site.location = { lat: req.body.lat, lng: req.body.lng };
      audit(org, req.principal.name, 'site.location', { siteId: site.id });
      return site;
    },
  );

  app.post<{ Body: { siteIds?: string[] } }>(
    '/v1/outside/refresh',
    {
      ...write,
      schema: {
        tags: ['Calendar'],
        description: 'Fetches the weather and every event feed now, then refreshes the forecast for the rest of this week and next. Runs daily on its own.',
        body: { type: 'object', properties: { siteIds: { type: 'array', items: { type: 'string' }, maxItems: 500 } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      for (const id of req.body?.siteIds ?? []) requireSite(org, id);
      return { sites: await refreshOutside(ctx, org, today(), req.principal.name, req.body?.siteIds) };
    },
  );

  app.get<{ Querystring: { siteId?: string; from?: string; to?: string } }>('/v1/weather', { ...read, schema: { tags: ['Calendar'], querystring: rangeQuery } }, async (req) => {
    const q = req.query;
    return (orgOf(req).state.weather ?? []).filter((w) => (!q.siteId || w.siteId === q.siteId) && (!q.from || w.date >= q.from) && (!q.to || w.date <= q.to));
  });

  // ----- Event feeds -----

  // Private calendar links carry secret tokens, so the address is never sent back in full.
  const view = (f: EventFeed) => ({ ...f, url: maskFeedUrl(f.url) });

  app.get('/v1/event-feeds', { ...read, schema: { tags: ['Calendar'] } }, async (req) => orgOf(req).eventFeeds.map(view));

  app.post<{ Body: Omit<EventFeed, 'id'> }>(
    '/v1/event-feeds',
    {
      ...write,
      schema: {
        tags: ['Calendar'],
        description: 'Adds a source of local events for a site: an iCal address (a stadium, venue or council calendar) or Ticketmaster within a radius.',
        body: {
          type: 'object',
          required: ['siteId', 'kind', 'label'],
          additionalProperties: false,
          properties: {
            siteId: { type: 'string' },
            kind: { type: 'string', enum: ['ics', 'ticketmaster'] },
            label: { type: 'string', minLength: 1, maxLength: 80 },
            url: { type: 'string', maxLength: 2000 },
            radiusKm: { type: 'number', minimum: 0.2, maximum: 20 },
          },
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      requireSite(org, req.body.siteId);
      if (req.body.kind === 'ics') {
        try {
          checkFeedUrl(req.body.url ?? '');
        } catch (e) {
          throw new HttpError(422, 'invalid_feed', (e as FeedError).message);
        }
      } else if (!ctx.feeds.ticketmasterKey) {
        throw new HttpError(422, 'ticketmaster_not_set_up', 'Ticketmaster is not set up for this deployment. Use an iCal feed instead.');
      }
      const feed: EventFeed = { id: `feed_${randomUUID().slice(0, 12)}`, ...req.body, url: req.body.url?.replace(/^webcal:/i, 'https:') };
      org.eventFeeds.push(feed);
      audit(org, req.principal.name, 'event_feed.added', { id: feed.id, siteId: feed.siteId, kind: feed.kind });
      return reply.code(201).send(view(feed));
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/event-feeds/:id', { ...write, schema: { tags: ['Calendar'] } }, async (req, reply) => {
    const org = orgOf(req);
    if (!org.eventFeeds.some((f) => f.id === req.params.id)) throw notFound(`Feed ${req.params.id}`);
    org.eventFeeds = org.eventFeeds.filter((f) => f.id !== req.params.id);
    // Its future events go with it; past ones stay, as history the site really traded through.
    org.state.localEvents = (org.state.localEvents ?? []).filter((e) => e.feedId !== req.params.id || e.date < today());
    audit(org, req.principal.name, 'event_feed.removed', { id: req.params.id });
    return reply.code(204).send();
  });

  // ----- Local events -----

  app.get<{ Querystring: { siteId?: string; from?: string; to?: string } }>('/v1/local-events', { ...read, schema: { tags: ['Calendar'], querystring: rangeQuery } }, async (req) => {
    const q = req.query;
    return (orgOf(req).state.localEvents ?? []).filter((e) => (!q.siteId || e.siteId === q.siteId) && (!q.from || e.date >= q.from) && (!q.to || e.date <= q.to));
  });

  app.post<{ Body: { siteId: string; date: string; name: string; startMinute?: number; venue?: string } }>(
    '/v1/local-events',
    {
      ...write,
      schema: {
        tags: ['Calendar'],
        description: 'Something on nearby that no feed lists: a street party, a conference, a road closure.',
        body: {
          type: 'object',
          required: ['siteId', 'date', 'name'],
          additionalProperties: false,
          properties: { siteId: { type: 'string' }, date: isoDate, name: { type: 'string', minLength: 1, maxLength: 120 }, startMinute: { type: 'integer', minimum: 0, maximum: 1439 }, venue: { type: 'string', maxLength: 120 } },
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      requireSite(org, req.body.siteId);
      const event: LocalEvent = { id: `ev_${randomUUID().slice(0, 12)}`, ...req.body, source: 'manual' };
      org.state.localEvents = [...(org.state.localEvents ?? []), event];
      audit(org, req.principal.name, 'local_event.added', { id: event.id, siteId: event.siteId, date: event.date });
      return reply.code(201).send(event);
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/local-events/:id', { ...write, schema: { tags: ['Calendar'] } }, async (req, reply) => {
    const org = orgOf(req);
    const event = (org.state.localEvents ?? []).find((e) => e.id === req.params.id);
    if (!event || event.source !== 'manual') throw notFound(`Event ${req.params.id} entered by hand`);
    org.state.localEvents = org.state.localEvents!.filter((e) => e.id !== req.params.id);
    audit(org, req.principal.name, 'local_event.removed', { id: req.params.id });
    return reply.code(204).send();
  });

  // ----- The calendar and reminders -----

  app.get<{ Querystring: { siteId: string; from?: string; to?: string } }>(
    '/v1/calendar',
    {
      ...read,
      schema: {
        tags: ['Calendar'],
        description: "A site's coming weeks: occasions, local events and weather by day, what the model applies by itself and why, and the reminders.",
        querystring: { type: 'object', required: ['siteId'], properties: { siteId: { type: 'string' }, from: isoDate, to: isoDate } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      requireSite(org, req.query.siteId);
      const now = today();
      const from = req.query.from ?? now;
      // Far enough ahead to catch the longest reminder lead time.
      const to = req.query.to ?? addDays(from, 83);
      if (to < from || to > addDays(from, 400)) throw new HttpError(422, 'invalid_period', 'Choose up to 400 days, ending after it starts');
      const plan = planAhead(org.state, req.query.siteId, from, to, now);
      return { ...plan, reminders: withState(org, plan.reminders, req.query.siteId) };
    },
  );

  app.get<{ Querystring: { siteIds?: string } }>(
    '/v1/reminders',
    {
      ...read,
      schema: { tags: ['Calendar'], description: "What is due now across the sites given (comma separated), or every site, not yet done or set aside.", querystring: { type: 'object', properties: { siteIds: { type: 'string' } } } },
    },
    async (req) => {
      const org = orgOf(req);
      const now = today();
      const ids = req.query.siteIds ? req.query.siteIds.split(',') : org.state.sites.map((s) => s.id);
      return ids
        .filter((id) => org.state.sites.some((s) => s.id === id))
        .flatMap((siteId) => withState(org, dueReminders(planAhead(org.state, siteId, now, addDays(now, 83), now), now), siteId))
        .filter((r) => r.status === 'open')
        .sort((a, b) => a.date.localeCompare(b.date));
    },
  );

  app.post<{ Body: { siteId: string; key: string; action: 'done' | 'dismiss' | 'expect'; factor?: number; note?: string } }>(
    '/v1/reminders',
    {
      ...write,
      schema: {
        tags: ['Calendar'],
        description:
          'Deals with a reminder: done, set aside, or expect (sets the trade you expect for its hours as a forecast adjustment, which the model then uses and learns against).',
        body: {
          type: 'object',
          required: ['siteId', 'key', 'action'],
          additionalProperties: false,
          properties: {
            siteId: { type: 'string' },
            key: { type: 'string', maxLength: 200 },
            action: { type: 'string', enum: ['done', 'dismiss', 'expect'] },
            factor: { type: 'number', exclusiveMinimum: 0, maximum: 5 },
            note: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const { siteId, key, action } = req.body;
      requireSite(org, siteId);
      const now = today();
      const reminder = planAhead(org.state, siteId, now, addDays(now, 400), now).reminders.find((r) => r.key === key);
      if (!reminder) throw notFound(`Reminder ${key}`);
      let adjustment: ForecastAdjustment | undefined;
      // One answer per reminder: a second answer replaces the first, it never stacks on it.
      const adjustmentId = `rem:${siteId}:${key}`;
      if (action === 'expect') {
        if (req.body.factor === undefined) throw new HttpError(422, 'factor_required', 'Say what you expect, as a share of normal trade');
        if (key.startsWith('occasion:bh-')) {
          throw new HttpError(422, 'bank_holiday', 'Bank holidays are already forecast from how past bank holidays traded. Override the hours on the Forecast tab if you know better.');
        }
        adjustment = {
          id: adjustmentId,
          siteId,
          date: reminder.date,
          factor: req.body.factor,
          reason: reminder.kind === 'weather' ? 'weather' : 'event',
          note: req.body.note ?? reminder.title,
          fromHour: reminder.fromHour,
          toHour: reminder.toHour,
        };
        org.state.forecastAdjustments = [...(org.state.forecastAdjustments ?? []).filter((a) => a.id !== adjustmentId), adjustment];
      }
      org.reminderStates = [
        ...org.reminderStates.filter((s) => !(s.key === key && s.siteId === siteId)),
        { key, siteId, status: action === 'dismiss' ? 'dismissed' : 'done', at: ctx.now().toISOString(), by: req.principal.name, note: req.body.note },
      ];
      audit(org, req.principal.name, 'reminder.decided', { siteId, key, action, factor: req.body.factor });
      return { key, status: action === 'dismiss' ? 'dismissed' : 'done', adjustment };
    },
  );
}
