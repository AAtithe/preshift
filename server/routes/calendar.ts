import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { dueReminders, planAhead, type Reminder } from '../../src/engine/plan';
import { addDays } from '../../src/engine/time';
import { kindOf, schoolHolidays } from '../../src/engine/school';
import type { ForecastAdjustment, LocalEvent, Site } from '../../src/engine/types';

import { requireScope } from '../auth';
import { HttpError, londonToday, notFound, orgOf, type AppContext } from '../context';
import { refreshOutside } from '../forecasting';
import { checkFeedUrl, FeedError, maskFeedUrl, type EventFeed } from '../integrations/feeds';
import { isoDate, rangeQuery } from '../schemas';
import { guard } from '../guard';
import { audit, type OrgData } from '../store';

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
      const g = guard(ctx, req, org);
      for (const id of req.body?.siteIds ?? []) {
        requireSite(org, id);
        g.allow('demand.manage', id);
      }
      // Without a list, every site whose forecast this person runs.
      const siteIds = req.body?.siteIds ?? org.state.sites.filter((s) => g.can('demand.manage', s.id)).map((s) => s.id);
      if (siteIds.length === 0) g.allow('demand.manage');
      return { sites: await refreshOutside(ctx, org, today(), req.principal.name, siteIds) };
    },
  );

  app.get<{ Querystring: { siteId?: string; from?: string; to?: string } }>('/v1/weather', { ...read, schema: { tags: ['Calendar'], querystring: rangeQuery } }, async (req) => {
    const q = req.query;
    const visible = guard(ctx, req, orgOf(req)).at('rota.view');
    return (orgOf(req).state.weather ?? []).filter((w) => visible(w) && (!q.siteId || w.siteId === q.siteId) && (!q.from || w.date >= q.from) && (!q.to || w.date <= q.to));
  });

  // ----- Event feeds -----

  // Private calendar links carry secret tokens, so the address is never sent back in full.
  const view = (f: EventFeed) => ({ ...f, url: maskFeedUrl(f.url) });

  app.get('/v1/event-feeds', { ...read, schema: { tags: ['Calendar'] } }, async (req) => orgOf(req).eventFeeds.filter(guard(ctx, req, orgOf(req)).at('rota.view')).map(view));

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
            kind: { type: 'string', enum: ['ics', 'ticketmaster', 'school'] },
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
      guard(ctx, req, org).allow('demand.manage', req.body.siteId);
      if (req.body.kind === 'ics' || req.body.kind === 'school') {
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
    const feed = org.eventFeeds.find((f) => f.id === req.params.id);
    if (!feed) throw notFound(`Feed ${req.params.id}`);
    guard(ctx, req, org).allow('demand.manage', feed.siteId);
    org.eventFeeds = org.eventFeeds.filter((f) => f.id !== req.params.id);
    // Its future events go with it; past ones stay, as history the site really traded through.
    org.state.localEvents = (org.state.localEvents ?? []).filter((e) => e.feedId !== req.params.id || e.date < today());
    // A council feed's holidays go too, past ones included: without the feed they are not confirmed any more.
    org.state.schoolHolidays = (org.state.schoolHolidays ?? []).filter((p) => p.feedId !== req.params.id);
    audit(org, req.principal.name, 'event_feed.removed', { id: req.params.id });
    return reply.code(204).send();
  });

  // ----- Local events -----

  app.get<{ Querystring: { siteId?: string; from?: string; to?: string } }>('/v1/local-events', { ...read, schema: { tags: ['Calendar'], querystring: rangeQuery } }, async (req) => {
    const q = req.query;
    const visible = guard(ctx, req, orgOf(req)).at('rota.view');
    return (orgOf(req).state.localEvents ?? []).filter((e) => visible(e) && (!q.siteId || e.siteId === q.siteId) && (!q.from || e.date >= q.from) && (!q.to || e.date <= q.to));
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
      guard(ctx, req, org).allow('demand.manage', req.body.siteId);
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
    guard(ctx, req, org).allow('demand.manage', event.siteId);
    org.state.localEvents = org.state.localEvents!.filter((e) => e.id !== req.params.id);
    audit(org, req.principal.name, 'local_event.removed', { id: req.params.id });
    return reply.code(204).send();
  });

  // ----- School holidays -----

  app.put<{ Params: { id: string }; Body: { nation: NonNullable<Site['nation']> } }>(
    '/v1/sites/:id/nation',
    {
      ...write,
      schema: {
        tags: ['Calendar'],
        description: "Which nation's school calendar and school-leaving rules apply at the site. England when not set.",
        body: { type: 'object', required: ['nation'], additionalProperties: false, properties: { nation: { type: 'string', enum: ['england', 'wales', 'scotland', 'northern_ireland'] } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const site = requireSite(org, req.params.id);
      // It decides which child employment rules apply: site set-up, as its location is.
      guard(ctx, req, org).allow('settings.manage');
      site.nation = req.body.nation;
      audit(org, req.principal.name, 'site.nation', { siteId: site.id, nation: site.nation });
      return site;
    },
  );

  app.get<{ Querystring: { siteId: string; from?: string; to?: string } }>(
    '/v1/school-holidays',
    {
      ...read,
      schema: {
        tags: ['Calendar'],
        description: "The school holidays that apply to a site: the council's own where given, otherwise the usual England and Wales pattern, marked as an estimate.",
        querystring: { type: 'object', required: ['siteId'], properties: { siteId: { type: 'string' }, from: isoDate, to: isoDate } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const site = requireSite(org, req.query.siteId);
      guard(ctx, req, org).allow('rota.view', site.id);
      const from = req.query.from ?? today();
      const to = req.query.to ?? addDays(from, 400);
      const confirmed = (org.state.schoolHolidays ?? []).filter((p) => p.siteId === site.id);
      return schoolHolidays(confirmed, from, to, !site.nation || site.nation === 'england' || site.nation === 'wales');
    },
  );

  app.post<{ Body: { siteId: string; start: string; end: string; name: string } }>(
    '/v1/school-holidays',
    {
      ...write,
      schema: {
        tags: ['Calendar'],
        description: "A school holiday from the council's published dates, entered by hand. It replaces the estimate for the same holiday; the others stay estimated.",
        body: {
          type: 'object',
          required: ['siteId', 'start', 'end', 'name'],
          additionalProperties: false,
          properties: { siteId: { type: 'string' }, start: isoDate, end: isoDate, name: { type: 'string', minLength: 1, maxLength: 80 } },
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      requireSite(org, req.body.siteId);
      guard(ctx, req, org).allow('demand.manage', req.body.siteId);
      if (req.body.end < req.body.start) throw new HttpError(422, 'invalid_period', 'The holiday ends before it starts');
      const period = { id: `sh_${randomUUID().slice(0, 12)}`, siteId: req.body.siteId, start: req.body.start, end: req.body.end, name: req.body.name, kind: kindOf(req.body.name), source: 'manual' as const };
      org.state.schoolHolidays = [...(org.state.schoolHolidays ?? []), period];
      audit(org, req.principal.name, 'school_holiday.added', { siteId: period.siteId, start: period.start, end: period.end });
      return reply.code(201).send(period);
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/school-holidays/:id', { ...write, schema: { tags: ['Calendar'] } }, async (req, reply) => {
    const org = orgOf(req);
    const held = (org.state.schoolHolidays ?? []).find((p) => p.id === req.params.id);
    if (!held || held.source !== 'manual') throw notFound(`School holiday ${req.params.id} entered by hand`);
    guard(ctx, req, org).allow('demand.manage', held.siteId);
    org.state.schoolHolidays = org.state.schoolHolidays!.filter((p) => p.id !== req.params.id);
    audit(org, req.principal.name, 'school_holiday.removed', { id: req.params.id });
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
      guard(ctx, req, org).allow('rota.view', req.query.siteId);
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
      const visible = guard(ctx, req, org).at('rota.view');
      const ids = req.query.siteIds ? req.query.siteIds.split(',') : org.state.sites.map((s) => s.id);
      return ids
        .filter((id) => org.state.sites.some((s) => s.id === id) && visible({ siteId: id }))
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
      guard(ctx, req, org).allow('demand.manage', siteId);
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
