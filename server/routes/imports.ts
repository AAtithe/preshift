import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { addDays } from '../../src/engine/time';
import type { TimeEntry } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { idParam, isoDate } from '../schemas';
import { audit, type OrgData } from '../store';

// Moving across from another system (Set-up, Import): what each upload did, so it can be undone, and
// the two things an import needs that the rest of Preshift deliberately does not offer.
//
// - Batches. Each upload is kept as one batch: the kind, the file, who and when, and for every row
//   saved the call that puts it back. Undoing runs those calls one by one from the screen, through the
//   same routes and the same permission checks as anything else, so an undo can never do what the
//   person could not have done by hand. Only calls of the shapes an import makes are accepted.
// - Past hours. The last weeks of clocked or payroll hours from the old system, so averages that look
//   back (the 48 hour week, night work, guaranteed hours offers, accrual for irregular hours staff)
//   start from fact. They were paid by the old payroll, so they are stored as approved and already
//   passed: payroll refuses to send them, and nobody can approve or pass them again.
// - Removing someone added by mistake. Only while nothing depends on them: not yet in payroll, no
//   shifts, clocked time, HR file entries, absences, TOIL or staff login. Their pay proposal is
//   withdrawn, never deleted, and anything still queued for payroll about them is dropped.

/** Past hours marked as paid by the previous system: never sent to payroll from Preshift. */
export const PREVIOUS_SYSTEM = 'previous-system';
/** Batches kept, newest first. */
const BATCHES_KEPT = 50;

export interface ImportCallRecord {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
}

export interface ImportBatch {
  id: string;
  kind: string;
  file: string;
  at: string;
  by: string;
  /** Rows saved, each with the call that puts it back, or null where it cannot be undone. */
  items: { label: string; undo: ImportCallRecord | null }[];
  undoneAt?: string;
  undoneBy?: string;
  /** Rows the undo could not put back, with the reason. */
  undoFailed?: { label: string; reason: string }[];
}

/** The calls an undo may make: the reverse of what an import does, and nothing else. */
const UNDO_SHAPES: [ImportCallRecord['method'], RegExp][] = [
  ['DELETE', /^\/v1\/import\/people\/[\w.-]+$/],
  ['DELETE', /^\/v1\/import\/hours\/[\w.-]+$/],
  ['DELETE', /^\/v1\/shifts\/[\w.-]+$/],
  ['DELETE', /^\/v1\/hr\/records\/[\w.-]+$/],
  ['DELETE', /^\/v1\/employees\/[\w.-]+\/absences\/[\w.-]+$/],
  ['DELETE', /^\/v1\/users\/[\w.-]+\/invite$/],
  ['DELETE', /^\/v1\/sales\?siteId=[\w.%-]+&date=\d{4}-\d{2}-\d{2}$/],
  ['PATCH', /^\/v1\/employees\/[\w.-]+$/],
  ['PUT', /^\/v1\/employees\/[\w.-]+\/hr$/],
  ['PUT', /^\/v1\/sales$/],
  ['POST', /^\/v1\/employees\/[\w.-]+\/toil$/],
];
export const undoAllowed = (c: ImportCallRecord) => UNDO_SHAPES.some(([m, re]) => m === c.method && re.test(c.path));

const batchesOf = (org: OrgData) => (org.importBatches ??= []);

export function importRoutes(app: FastifyInstance, ctx: AppContext) {
  const write = { preHandler: requireScope('rota:write') };
  const read = { preHandler: requireScope('rota:read') };
  const tags = ['Import'];
  const today = () => ctx.store.todayISO();

  // Imports are done from Set-up, by whoever manages the organisation's settings, signed in as a person.
  const importer = (req: Parameters<typeof guard>[1], org: OrgData) => {
    const g = guard(ctx, req, org);
    if (!req.principal.email && !req.principal.userId) throw new HttpError(403, 'forbidden', 'Imports are made by a signed-in person, not an integration key');
    g.allow('settings.manage');
    return g;
  };

  app.get('/v1/import/batches', { ...read, schema: { tags, description: 'The last uploads made from Set-up, Import, newest first, with what each saved.' } }, async (req) => {
    const org = orgOf(req);
    importer(req, org);
    return batchesOf(org).slice(0, BATCHES_KEPT);
  });

  app.post<{ Body: { kind: string; file: string; items: { label: string; undo: ImportCallRecord | null }[] } }>(
    '/v1/import/batches',
    {
      ...write,
      schema: {
        tags,
        description: 'Records an upload once its rows are saved, with the call that puts back each one. Only the reverse of what an import does is accepted.',
        body: {
          type: 'object',
          required: ['kind', 'file', 'items'],
          additionalProperties: false,
          properties: {
            kind: { type: 'string', maxLength: 40 },
            file: { type: 'string', maxLength: 200 },
            items: {
              type: 'array',
              maxItems: 10000,
              items: {
                type: 'object',
                required: ['label', 'undo'],
                additionalProperties: false,
                properties: {
                  label: { type: 'string', maxLength: 200 },
                  undo: {
                    anyOf: [
                      { type: 'null' },
                      { type: 'object', required: ['method', 'path'], additionalProperties: false, properties: { method: { type: 'string', enum: ['POST', 'PATCH', 'PUT', 'DELETE'] }, path: { type: 'string', maxLength: 300 }, body: {} } },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const g = importer(req, org);
      const bad = req.body.items.filter((i) => i.undo && !undoAllowed(i.undo));
      if (bad.length) throw new HttpError(422, 'invalid_undo', 'An undo may only reverse what an import does', bad.map((i) => i.label));
      const batch: ImportBatch = { id: `imp_${randomUUID().slice(0, 12)}`, kind: req.body.kind, file: req.body.file, at: new Date().toISOString(), by: actorName(g), items: req.body.items };
      org.importBatches = [batch, ...batchesOf(org)].slice(0, BATCHES_KEPT);
      audit(org, actorName(g), 'import.saved', { id: batch.id, kind: batch.kind, rows: batch.items.length });
      return reply.code(201).send(batch);
    },
  );

  app.post<{ Params: { id: string }; Body: { failed?: { label: string; reason: string }[] } }>(
    '/v1/import/batches/:id/undone',
    {
      ...write,
      schema: {
        tags,
        description: 'Marks an upload as undone, once the screen has run its undo calls, with any rows that could not be put back.',
        params: idParam,
        body: { type: 'object', additionalProperties: false, properties: { failed: { type: 'array', maxItems: 10000, items: { type: 'object', required: ['label', 'reason'], properties: { label: { type: 'string' }, reason: { type: 'string' } } } } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = importer(req, org);
      const batch = batchesOf(org).find((b) => b.id === req.params.id);
      if (!batch) throw notFound(`Import ${req.params.id}`);
      if (batch.undoneAt) throw new HttpError(409, 'already_undone', `This upload was undone on ${batch.undoneAt.slice(0, 10)} by ${batch.undoneBy}.`);
      Object.assign(batch, { undoneAt: new Date().toISOString(), undoneBy: actorName(g), ...(req.body?.failed?.length ? { undoFailed: req.body.failed } : {}) });
      audit(org, actorName(g), 'import.undone', { id: batch.id, kind: batch.kind, failed: req.body?.failed?.length ?? 0 });
      return batch;
    },
  );

  app.post<{ Body: { entries: Omit<TimeEntry, 'id' | 'status' | 'source'>[] } }>(
    '/v1/import/hours',
    {
      ...write,
      schema: {
        tags,
        description:
          'Adds hours worked before go-live, from the previous system. They are stored approved and already paid, so payroll never sends them, ' +
          'and nobody approves them again: they are history for the averages that look back. Needs settings.manage. The same person, day and start already held is skipped.',
        body: {
          type: 'object',
          required: ['entries'],
          additionalProperties: false,
          properties: {
            entries: {
              type: 'array',
              maxItems: 20000,
              items: {
                type: 'object',
                required: ['employeeId', 'siteId', 'roleId', 'date', 'clockIn', 'clockOut'],
                additionalProperties: false,
                properties: {
                  employeeId: { type: 'string' }, siteId: { type: 'string' }, roleId: { type: 'string' }, date: isoDate,
                  clockIn: { type: 'integer', minimum: 0, maximum: 2879 }, clockOut: { type: 'integer', minimum: 1, maximum: 2880 }, breakMinutes: { type: 'integer', minimum: 0, default: 0 },
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = importer(req, org);
      const now = today();
      const at = new Date().toISOString();
      const held = new Set(org.timeEntries.map((t) => `${t.employeeId}|${t.date}|${t.clockIn}`));
      const added: string[] = [];
      const refused: { index: number; reason: string }[] = [];
      let skipped = 0;
      req.body.entries.forEach((body, index) => {
        const no = (reason: string) => void refused.push({ index, reason });
        const e = org.state.employees.find((x) => x.id === body.employeeId);
        if (!e) return no(`No one with id ${body.employeeId}`);
        if (!org.state.sites.some((s) => s.id === body.siteId)) return no(`No site ${body.siteId}`);
        if (!org.state.roles.some((r) => r.id === body.roleId)) return no(`No role ${body.roleId}`);
        // History only: hours from today on are clocked on Preshift, and paid from it.
        if (body.date >= now) return no('Hours from today on are clocked on Preshift, not imported.');
        if (body.date < addDays(now, -400)) return no('More than a year back is not needed for any average Preshift works out.');
        if ((body.clockOut ?? 0) <= body.clockIn) return no('Clock out must be after clock in.');
        const key = `${body.employeeId}|${body.date}|${body.clockIn}`;
        if (held.has(key)) return void skipped++;
        held.add(key);
        const entry: TimeEntry = {
          ...body,
          breakMinutes: body.breakMinutes ?? 0,
          id: `te_imp_${randomUUID().slice(0, 12)}`,
          status: 'approved',
          source: 'import',
          approvedBy: `${actorName(g)} (imported)`,
          approvedAt: at,
          passedIn: PREVIOUS_SYSTEM,
        };
        org.timeEntries.push(entry);
        added.push(entry.id);
      });
      if (added.length) audit(org, actorName(g), 'time.imported', { entries: added.length, refused: refused.length, skipped });
      return { added, skipped, refused };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/import/hours/:id',
    { ...write, schema: { tags, description: 'Removes hours brought in from the previous system. Hours clocked on Preshift are never removed this way.', params: idParam } },
    async (req, reply) => {
      const org = orgOf(req);
      const g = importer(req, org);
      const entry = org.timeEntries.find((t) => t.id === req.params.id);
      if (!entry || entry.source !== 'import') throw notFound(`Imported hours ${req.params.id}`);
      org.timeEntries = org.timeEntries.filter((t) => t.id !== entry.id);
      audit(org, actorName(g), 'time.import_removed', { id: entry.id });
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/import/people/:id',
    {
      ...write,
      schema: {
        tags,
        description:
          'Removes someone added by an import, only while nothing depends on them: not in payroll, no shifts, clocked time, HR file entries, ' +
          'absences, TOIL or staff login. Their pay proposal is withdrawn and anything still queued for payroll about them is dropped.',
        params: idParam,
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const g = importer(req, org);
      const e = org.state.employees.find((x) => x.id === req.params.id);
      if (!e) throw notFound(`Employee ${req.params.id}`);
      g.allow('team.manage', e.siteId);
      const why: string[] = [];
      if (e.payrollId) why.push('already set up in payroll, so mark them as a leaver instead');
      if (org.outbox.some((o) => o.type === 'employee.upsert' && o.payload.employeeId === e.id && o.status === 'delivered')) why.push('already sent to payroll');
      if (org.state.shifts.some((s) => s.employeeId === e.id)) why.push('on the rota');
      if (org.timeEntries.some((t) => t.employeeId === e.id)) why.push('has clocked or imported hours');
      if (org.hrRecords.some((r) => r.employeeId === e.id)) why.push('has entries on their HR file');
      if (e.absences?.length) why.push('has absences recorded');
      if (e.toil?.length) why.push('has TOIL recorded');
      if ((await ctx.store.listStaffLogins(org.orgId)).some((l) => l.employeeId === e.id)) why.push('has a staff app login');
      if (org.users.some((u) => u.employeeId === e.id)) why.push('is linked to a manager sign-in');
      if (why.length) throw new HttpError(409, 'in_use', `${e.name} cannot be removed: ${why.join('; ')}.`, why);
      org.state.employees = org.state.employees.filter((x) => x.id !== e.id);
      org.outbox = org.outbox.filter((o) => !(o.status !== 'delivered' && 'employeeId' in o.payload && o.payload.employeeId === e.id));
      for (const p of org.payChanges.filter((c) => c.employeeId === e.id && c.status === 'pending')) {
        Object.assign(p, { status: 'withdrawn', decidedBy: actorName(g), decidedAt: new Date().toISOString(), note: 'Added by an import in error and removed.' });
      }
      audit(org, actorName(g), 'employee.removed', { id: e.id, name: e.name, reason: 'import undone' });
      return reply.code(204).send();
    },
  );
}
