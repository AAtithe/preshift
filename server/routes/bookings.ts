import type { FastifyInstance } from 'fastify';
import { importBookings } from '../../src/engine/bookingImport';
import { compactBookings, mergeBookings } from '../../src/engine/bookings';
import { addDays } from '../../src/engine/time';
import type { Booking } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, londonToday, notFound, orgOf, type AppContext } from '../context';
import { isoDate, rangeQuery } from '../schemas';
import { guard } from '../guard';
import { audit, type OrgData } from '../store';

/**
 * Only these fields are kept for a booking: anything else in a request is
 * dropped as it is read, so a connector sending whole booking records cannot
 * pass guest names, phone numbers, emails or notes through to storage.
 */
const bookingRow = {
  type: 'object',
  required: ['id', 'siteId', 'source', 'date', 'startMinute', 'covers', 'status'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 120 },
    siteId: { type: 'string' },
    source: { type: 'string', pattern: '^[a-z0-9_-]{1,30}$' },
    date: isoDate,
    startMinute: { type: 'integer', minimum: 0, maximum: 1439 },
    covers: { type: 'integer', minimum: 1, maximum: 500 },
    status: { type: 'string', enum: ['booked', 'cancelled', 'no_show', 'completed'] },
    createdAt: { type: 'string', maxLength: 40 },
    cancelledAt: { type: 'string', maxLength: 40 },
  },
} as const;

const realDay = (d: string) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const instantOrDay = (v?: string) => v === undefined || (/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) && !Number.isNaN(Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v)));

/**
 * Lays bookings in. An export (whole days in one file) is compacted into pace
 * history straight away. A push is not: a connector may send a day across
 * several pages, so pushed days wait for the daily job, which compacts days
 * two days gone. Returns how many were left out as history already held.
 */
function store(org: OrgData, rows: Booking[], today: string, wholeDays: boolean): number {
  const merged = mergeBookings(org.state.bookings ?? [], rows, org.state.bookingPace ?? [], wholeDays);
  if (!wholeDays) {
    org.state.bookings = merged.bookings;
    return merged.ignored;
  }
  const compacted = compactBookings(merged.bookings, org.state.bookingPace ?? [], today);
  org.state.bookings = compacted.bookings;
  org.state.bookingPace = compacted.pace;
  return merged.ignored;
}

export function bookingRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('rota:write') };
  const today = () => londonToday(ctx);
  const requireSite = (org: OrgData, siteId: string) => {
    if (!org.state.sites.some((s) => s.id === siteId)) throw notFound(`Site ${siteId}`);
  };

  app.put<{ Body: { rows: Booking[] } }>(
    '/v1/bookings',
    {
      ...write,
      bodyLimit: 10 * 1024 * 1024,
      schema: {
        tags: ['Bookings'],
        description:
          'Bookings from a booking system or a connector, by its own reference. Covers, time and when each was made or cancelled only: ' +
          'any other field is dropped as it is read, so no guest details are ever stored. Days already gone become pace history, and a ' +
          'push never rewrites a day already in history (a full export through the import does).',
        body: { type: 'object', required: ['rows'], properties: { rows: { type: 'array', maxItems: 50000, items: bookingRow } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      // Bookings move the forecast: demand data, as takings are.
      const g = guard(ctx, req, org);
      for (const siteId of new Set(req.body.rows.map((r) => r.siteId))) {
        requireSite(org, siteId);
        g.allow('demand.manage', siteId);
      }
      for (const r of req.body.rows) {
        if (!realDay(r.date)) throw new HttpError(422, 'invalid_date', `Booking ${r.id} has no such date ${r.date}`);
        if (!instantOrDay(r.createdAt) || !instantOrDay(r.cancelledAt)) throw new HttpError(422, 'invalid_date', `Booking ${r.id} has an unreadable made or cancelled date`);
      }
      const rows = req.body.rows.map((r) => ({ ...r, id: r.id.startsWith(`${r.source}:`) ? r.id : `${r.source}:${r.id}` }));
      // A push is booking by booking, so it never rewrites a day already in history; only a full export does.
      const ignored = store(org, rows, today(), false);
      // The audit records counts only; booking detail never goes into a log.
      audit(org, req.principal.name, 'bookings.received', { rows: rows.length, ignored, sites: [...new Set(rows.map((r) => r.siteId))] });
      return { received: rows.length - ignored, historyKept: ignored };
    },
  );

  app.post<{ Body: { siteId: string; source: string; csv: string; usDates?: boolean } }>(
    '/v1/bookings/import',
    {
      ...write,
      bodyLimit: 15 * 1024 * 1024,
      schema: {
        tags: ['Bookings'],
        description:
          'Imports a booking export (CSV) from ResDiary, SevenRooms, OpenTable or anything similar. Columns are found by name; ' +
          'only date, time, covers, status, reference and made and cancelled dates are read. Dates are read UK style unless usDates.',
        body: {
          type: 'object',
          required: ['siteId', 'source', 'csv'],
          additionalProperties: false,
          properties: {
            siteId: { type: 'string' },
            source: { type: 'string', enum: ['resdiary', 'sevenrooms', 'opentable', 'other'] },
            csv: { type: 'string', maxLength: 12 * 1024 * 1024 },
            usDates: { type: 'boolean' },
          },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      requireSite(org, req.body.siteId);
      guard(ctx, req, org).allow('demand.manage', req.body.siteId);
      const result = importBookings(req.body.csv, req.body.siteId, req.body.source, { usDates: req.body.usDates });
      // An export carries whole days, so it may replace days already in history.
      if (result.rows.length) store(org, result.rows, today(), true);
      const dates = result.rows.map((r) => r.date).sort();
      audit(org, req.principal.name, 'bookings.imported', { siteId: req.body.siteId, source: req.body.source, rows: result.rows.length, skipped: result.skipped.length });
      return {
        imported: result.rows.length,
        from: dates[0],
        to: dates[dates.length - 1],
        columns: result.columns,
        // Named so people can see their guests' details were left behind.
        notRead: result.ignored,
        skipped: result.skipped.length,
        problems: result.skipped.slice(0, 20),
      };
    },
  );

  app.get<{ Querystring: { siteId?: string; from?: string; to?: string } }>('/v1/bookings', { ...read, schema: { tags: ['Bookings'], querystring: rangeQuery } }, async (req) => {
    const q = req.query;
    const visible = guard(ctx, req, orgOf(req)).at('rota.view');
    return (orgOf(req).state.bookings ?? []).filter((b) => visible(b) && (!q.siteId || b.siteId === q.siteId) && (!q.from || b.date >= q.from) && (!q.to || b.date <= q.to));
  });

  app.get('/v1/bookings/status', { ...read, schema: { tags: ['Bookings'], description: 'What is loaded for each site: bookings ahead, how far ahead, and how much pace history there is to learn from.' } }, async (req) => {
    const org = orgOf(req);
    const now = today();
    const lastImport = [...org.audit].reverse().filter((a) => a.action === 'bookings.imported' || a.action === 'bookings.received');
    const visible = guard(ctx, req, org).at('rota.view');
    return org.state.sites.filter((s) => visible({ siteId: s.id })).map((s) => {
      const ahead = (org.state.bookings ?? []).filter((b) => b.siteId === s.id && b.date >= now);
      const history = new Set((org.state.bookingPace ?? []).filter((p) => p.siteId === s.id && p.date >= addDays(now, -84)).map((p) => p.date));
      const last = lastImport.find((a) => {
        const d = a.detail as { siteId?: string; sites?: string[] } | undefined;
        return d?.siteId === s.id || (d?.sites ?? []).includes(s.id);
      });
      return {
        siteId: s.id,
        bookingsAhead: ahead.length,
        coversAhead: ahead.filter((b) => b.status !== 'cancelled').reduce((t, b) => t + b.covers, 0),
        furthestAhead: ahead.map((b) => b.date).sort().at(-1) ?? null,
        historyDays: history.size,
        lastLoadedAt: last?.at ?? null,
      };
    });
  });
}
