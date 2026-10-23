import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canDataset, reportCsv, resolveRange, runReport, visibleFields, AREA_LABEL, RANGE_LABEL, type ReportDefinition } from '../../src/engine/reportBuilder';
import { STANDARD_REPORTS } from '../../src/engine/standardReports';
import { requireScope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard, type Guard } from '../guard';
import { datasetsFor } from '../reports/datasets';
import { audit, type OrgData, type SavedReport } from '../store';

const MAX_DAYS = 3 * 366;

const definitionSchema = {
  type: 'object',
  required: ['dataset', 'groupBy', 'measures'],
  additionalProperties: false,
  properties: {
    dataset: { type: 'string', maxLength: 40 },
    groupBy: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 40 } },
    measures: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', maxLength: 40 } },
    filters: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        required: ['field', 'op', 'values'],
        additionalProperties: false,
        properties: { field: { type: 'string', maxLength: 40 }, op: { enum: ['is', 'isNot'] }, values: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 200 } } },
      },
    },
    range: { enum: Object.keys(RANGE_LABEL) },
    from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    sort: { type: 'object', required: ['by', 'direction'], additionalProperties: false, properties: { by: { type: 'string', maxLength: 40 }, direction: { enum: ['asc', 'desc'] } } },
    limit: { type: 'integer', minimum: 1, maximum: 5000 },
  },
} as const;

const savedSchema = {
  type: 'object',
  required: ['name', 'definition'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', maxLength: 500 },
    shared: { type: 'boolean' },
    definition: definitionSchema,
  },
} as const;

/** Runs one report for the caller: only datasets, sites and fields their access allows. */
export function runFor(org: OrgData, g: Guard, today: string, def: ReportDefinition) {
  const ds = datasetsFor(org).find((d) => d.id === def.dataset);
  const can = (p: Parameters<Guard['can']>[0], site?: string) => g.can(p, site);
  if (!ds || !canDataset(ds, can)) throw notFound(`Report data ${def.dataset}`);
  // Dates: those given, else the named range, else the dataset's own default; a snapshot is as at today.
  const named = def.range ? resolveRange(def.range, today) : undefined;
  const given = def.from || def.to ? { from: def.from ?? '0000-01-01', to: def.to ?? '9999-12-31' } : named;
  const window = given ?? (ds.snapshot ? undefined : resolveRange(ds.defaultRange ?? 'last-12-months', today));
  if (window && window.from > window.to) throw new HttpError(400, 'invalid_range', 'The start date is after the end date.');
  const build = window ?? resolveRange('last-12-months', today);
  const span = (Date.parse(build.to) - Date.parse(build.from)) / 86_400_000;
  if (Number.isFinite(span) && span > MAX_DAYS && build.from !== '0000-01-01') throw new HttpError(400, 'range_too_long', 'Report on at most three years at a time.');
  const rows = ds.rows({ org, g, today, from: build.from === '0000-01-01' ? '2000-01-01' : build.from, to: build.to === '9999-12-31' ? '2100-12-31' : build.to });
  const result = runReport(ds, rows, { ...def, from: window?.from, to: window?.to }, can);
  return { dataset: ds, result, window };
}

export function reportRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };
  const today = () => ctx.store.todayISO();

  /** Saving is a person's act: a key can run reports but not keep them. */
  function reportPerson(req: FastifyRequest) {
    if (!req.principal.email) throw new HttpError(403, 'forbidden', 'Reports are saved by a person signed in, not an API key.');
    const g = guard(ctx, req, orgOf(req));
    return { g, name: actorName(g), email: req.principal.email.toLowerCase() };
  }

  const mayEdit = (g: Guard, email: string, r: SavedReport) => r.createdByEmail === email || g.can('settings.manage');

  app.get('/v1/reports/catalogue', { ...read, schema: { tags: ['Reports'], description: 'The data the caller may report on: each dataset with the fields and figures they may see.' } }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    const can = (p: Parameters<Guard['can']>[0], site?: string) => g.can(p, site);
    const datasets = datasetsFor(org)
      .filter((ds) => canDataset(ds, can))
      .map((ds) => {
        const fields = visibleFields(ds, can);
        return {
          id: ds.id,
          label: ds.label,
          area: ds.area,
          areaLabel: AREA_LABEL[ds.area],
          description: ds.description,
          dateLabel: ds.dateLabel,
          snapshot: !!ds.snapshot,
          defaultRange: ds.snapshot ? null : ds.defaultRange ?? 'last-12-months',
          dimensions: fields.dimensions.map((d) => ({ id: d.id, label: d.label, type: d.type ?? 'text' })),
          measures: fields.measures.map((m) => ({ id: m.id, label: m.label, format: m.format, help: m.help ?? null })),
        };
      });
    const available = new Set(datasets.map((d) => d.id));
    return {
      areas: AREA_LABEL,
      ranges: RANGE_LABEL,
      datasets,
      // Ready-made reports on data the caller may read.
      standard: STANDARD_REPORTS.filter((r) => available.has(r.definition.dataset)),
    };
  });

  app.post<{ Body: ReportDefinition; Querystring: { format?: string } }>(
    '/v1/reports/run',
    { ...read, schema: { tags: ['Reports'], description: 'Runs a report definition. Rows stay within the sites the caller may see; fields they may not see are left out and named in withheld. Add ?format=csv for CSV.', body: definitionSchema } },
    async (req, reply) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const { dataset, result, window } = runFor(org, g, today(), req.body);
      if (req.query.format === 'csv') return reply.header('content-type', 'text/csv; charset=utf-8').send(reportCsv(result));
      return { ...result, dataset: { id: dataset.id, label: dataset.label }, from: window?.from ?? null, to: window?.to ?? null };
    },
  );

  app.get('/v1/reports/saved', { ...read, schema: { tags: ['Reports'], description: 'Reports the caller saved, and reports others shared, on data the caller may read.' } }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    const can = (p: Parameters<Guard['can']>[0], site?: string) => g.can(p, site);
    const email = req.principal.email?.toLowerCase();
    const readable = new Set(datasetsFor(org).filter((ds) => canDataset(ds, can)).map((ds) => ds.id));
    return (org.savedReports ?? [])
      .filter((r) => (r.shared || r.createdByEmail === email) && readable.has(r.definition.dataset))
      .map((r) => ({ ...r, mine: r.createdByEmail === email, canEdit: !!email && mayEdit(g, email, r) }));
  });

  app.post<{ Body: { name: string; description?: string; shared?: boolean; definition: ReportDefinition } }>('/v1/reports/saved', { ...read, schema: { tags: ['Reports'], body: savedSchema } }, async (req, reply) => {
    const { g, name, email } = reportPerson(req);
    const org = orgOf(req);
    // Proves the definition runs for its author before anyone else can open it.
    runFor(org, g, today(), req.body.definition);
    const now = new Date().toISOString();
    const saved: SavedReport = {
      id: `rpt_${randomUUID().slice(0, 12)}`,
      name: req.body.name.trim(),
      description: req.body.description?.trim() || undefined,
      definition: req.body.definition,
      shared: !!req.body.shared,
      createdBy: name,
      createdByEmail: email,
      createdAt: now,
      updatedAt: now,
    };
    org.savedReports = [...(org.savedReports ?? []), saved];
    audit(org, name, 'report.saved', { id: saved.id, dataset: saved.definition.dataset, shared: saved.shared });
    return reply.code(201).send(saved);
  });

  app.put<{ Params: { id: string }; Body: { name: string; description?: string; shared?: boolean; definition: ReportDefinition } }>(
    '/v1/reports/saved/:id',
    { ...read, schema: { tags: ['Reports'], body: savedSchema } },
    async (req) => {
      const { g, name, email } = reportPerson(req);
      const org = orgOf(req);
      const r = (org.savedReports ?? []).find((x) => x.id === req.params.id);
      if (!r || (!r.shared && r.createdByEmail !== email)) throw notFound(`Report ${req.params.id}`);
      if (!mayEdit(g, email, r)) throw new HttpError(403, 'forbidden', `Only ${r.createdBy}, or someone who manages settings, can change this report.`);
      runFor(org, g, today(), req.body.definition);
      Object.assign(r, { name: req.body.name.trim(), description: req.body.description?.trim() || undefined, definition: req.body.definition, shared: !!req.body.shared, updatedAt: new Date().toISOString() });
      audit(org, name, 'report.updated', { id: r.id });
      return r;
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/reports/saved/:id', { ...read, schema: { tags: ['Reports'] } }, async (req, reply) => {
    const { g, name, email } = reportPerson(req);
    const org = orgOf(req);
    const r = (org.savedReports ?? []).find((x) => x.id === req.params.id);
    if (!r || (!r.shared && r.createdByEmail !== email)) throw notFound(`Report ${req.params.id}`);
    if (!mayEdit(g, email, r)) throw new HttpError(403, 'forbidden', `Only ${r.createdBy}, or someone who manages settings, can delete this report.`);
    org.savedReports = (org.savedReports ?? []).filter((x) => x.id !== r.id);
    audit(org, name, 'report.deleted', { id: r.id });
    return reply.code(204).send();
  });
}
