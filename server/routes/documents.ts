import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Employee, HrRecord, RightToWorkDocument } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { idParam } from '../schemas';
import { actorName, guard, type Guard } from '../guard';
import { forReader } from './employees';
import { employeeView, readsHr, seesCases } from './hr';
import type { DocumentCipher } from '../documentCrypto';
import { audit, type DocumentAccess, type OrgData } from '../store';

/** Under Vercel's 4.5 MB request limit. The web app shrinks large photos before sending them. */
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_DOCUMENTS = 20;

/** The request types an upload may be sent as. What is stored is decided by the bytes, not by these. */
export const UPLOAD_CONTENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'];

/** What the file actually is, from its first bytes. Anything else is refused, whatever it claims to be. */
export function sniffType(data: Buffer): RightToWorkDocument['contentType'] | null {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (starts(0x25, 0x50, 0x44, 0x46)) return 'application/pdf';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** A display name only: no path, no control characters, and short. */
function cleanFileName(name: string | undefined, contentType: RightToWorkDocument['contentType'], fallback = 'right-to-work'): string {
  const base = (name ?? '').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 120);
  return base || `${fallback}.${contentType.split('/')[1]}`;
}

function employeeIn(org: OrgData, id: string): Employee {
  const e = org.state.employees.find((x) => x.id === id);
  if (!e) throw notFound(`Employee ${id}`);
  return e;
}

function cipherOf(ctx: AppContext): DocumentCipher {
  if (!ctx.documentCipher) {
    throw new HttpError(
      503,
      'document_key_missing',
      'Right to work copies are encrypted, and no valid document key is set. Set PRESHIFT_DOCUMENT_KEY to 32 random bytes in base64.',
    );
  }
  return ctx.documentCipher;
}

function accessEntry(req: FastifyRequest, documentId: string, employeeId: string, action: DocumentAccess['action']): DocumentAccess {
  return {
    orgId: orgOf(req).orgId,
    documentId,
    employeeId,
    action,
    at: new Date().toISOString(),
    // The signed-in email or the key's name: the exact identity, not a display name.
    actor: req.principal.name,
    via: req.principal.email ? 'session' : 'api key',
    ip: req.ip,
  };
}

// Files written or removed by a request, settled once the response shows whether the record was saved.
const written = new WeakMap<FastifyRequest, string>();
const removed = new WeakMap<FastifyRequest, DroppedCopy[]>();

export interface DroppedCopy {
  employeeId: string;
  documentId: string;
}

/** Copies on personnel file records that are going, so their files go with them. */
export const recordCopies = (records: HrRecord[]): DroppedCopy[] =>
  records.flatMap((r) => (r.files ?? []).map((f) => ({ employeeId: r.employeeId, documentId: f.id })));

/** Copies the records named before a change and no longer name after it, as when retention strips a leaver. */
export function droppedCopies(before: Employee[], after: Employee[]): DroppedCopy[] {
  const still = new Set(after.flatMap((e) => (e.rightToWork?.documents ?? []).map((d) => d.id)));
  return before.flatMap((e) =>
    (e.rightToWork?.documents ?? []).filter((d) => !still.has(d.id)).map((d) => ({ employeeId: e.id, documentId: d.id })),
  );
}

/**
 * Marks files for deletion once this request's change is saved. Pair with deleteCopiesOnSave as
 * the route's onResponse, so a failed save never leaves a record naming a file that is gone.
 */
export function deleteCopiesAfterSave(req: FastifyRequest, copies: DroppedCopy[]) {
  if (copies.length) removed.set(req, [...(removed.get(req) ?? []), ...copies]);
}

export function deleteCopiesOnSave(ctx: AppContext) {
  return async (req: FastifyRequest, reply: { statusCode: number }) => {
    const copies = removed.get(req);
    if (!copies || reply.statusCode >= 400) return;
    for (const c of copies) {
      await ctx.store.deleteDocument(orgOf(req).orgId, c.documentId);
      await ctx.store.logDocumentAccess(accessEntry(req, c.documentId, c.employeeId, 'deleted'));
    }
  };
}

/**
 * Copies of identity documents are the most sensitive files Preshift holds. Adding one is
 * hr.manage at the person's home site, never on your own file; viewing one is reading their
 * personnel file there (hr.view, or an HR scope for a key). Deleting one, and reading who has
 * viewed it, are data protection acts: privacy.manage, by a person, never an integration key.
 */
function mayAdd(g: Guard, e: Employee) {
  g.allow('hr.manage', e.siteId);
  if (g.behind?.employeeId === e.id) throw new HttpError(403, 'forbidden', 'Somebody else files your own right to work documents.');
}

function mayView(req: FastifyRequest, g: Guard, e: Employee) {
  if (!readsHr(req, g, e)) throw new HttpError(403, 'forbidden', `Viewing ${e.name}'s documents needs their personnel file`);
}

function dataProtection(req: FastifyRequest, g: Guard) {
  if (!req.principal.userId && !req.principal.email) throw new HttpError(403, 'forbidden', 'Copies are deleted, and their views read, by a person, not an API key.');
  g.allow('privacy.manage');
}

/** An answer carries the person as the caller may see them: their file and their pay as allowed. */
const shown = (req: FastifyRequest, g: Guard, e: Employee) => forReader(g, employeeView(req, e, g));

export function documentRoutes(app: FastifyInstance, ctx: AppContext) {
  const tags = ['Right to work'];
  const docParams = { type: 'object', required: ['id', 'docId'], properties: { id: { type: 'string' }, docId: { type: 'string' } } } as const;

  app.post<{ Params: { id: string }; Querystring: { fileName?: string }; Body: Buffer }>(
    '/v1/employees/:id/right-to-work/documents',
    {
      preHandler: requireScope('hr:write'),
      bodyLimit: MAX_DOCUMENT_BYTES,
      schema: {
        tags,
        description:
          'Stores a copy of a right to work document: the file itself as the request body (PDF, JPEG, PNG or WebP, up to 4 MB), ' +
          'its name in `fileName`. Returns the employee with the copy listed.',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        querystring: { type: 'object', properties: { fileName: { type: 'string', maxLength: 255 } } },
      },
      onResponse: async (req, reply) => {
        const id = written.get(req);
        if (!id) return;
        // The record did not save, so nothing names this file: remove it rather than leave it behind.
        if (reply.statusCode >= 400) await ctx.store.deleteDocument(orgOf(req).orgId, id);
        else await ctx.store.logDocumentAccess(accessEntry(req, id, req.params.id, 'added'));
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const e = employeeIn(org, req.params.id);
      mayAdd(g, e);
      const cipher = cipherOf(ctx);
      const data = Buffer.isBuffer(req.body) ? req.body : null;
      if (!data?.length) throw new HttpError(400, 'invalid_request', 'Send the file as the request body.');
      const contentType = sniffType(data);
      if (!contentType) throw new HttpError(415, 'unsupported_file', 'Upload a PDF, JPEG, PNG or WebP copy of the document.');
      const rtw = e.rightToWork ?? { checked: false };
      if ((rtw.documents?.length ?? 0) >= MAX_DOCUMENTS) {
        throw new HttpError(409, 'too_many_documents', `${e.name} already has ${MAX_DOCUMENTS} copies on file. Delete any that are not needed first.`);
      }
      const doc: RightToWorkDocument = {
        id: `rtw_${randomUUID()}`,
        fileName: cleanFileName(req.query.fileName, contentType),
        contentType,
        bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
        uploadedAt: new Date().toISOString(),
        uploadedBy: actorName(g),
      };
      await ctx.store.putDocument(org.orgId, doc.id, { contentType, data: cipher.seal(org.orgId, doc.id, data) });
      written.set(req, doc.id);
      e.rightToWork = { ...rtw, documents: [...(rtw.documents ?? []), doc] };
      audit(org, actorName(g), 'employee.rtw_document.added', { id: e.id, documentId: doc.id, sha256: doc.sha256 });
      return reply.code(201).send(shown(req, g, e));
    },
  );

  app.get<{ Params: { id: string; docId: string } }>(
    '/v1/employees/:id/right-to-work/documents/:docId',
    {
      preHandler: requireScope('hr:read'),
      schema: { tags, description: 'The stored copy, to view or download. Every view is logged, with who and from where.', params: docParams },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const e = employeeIn(org, req.params.id);
      mayView(req, guard(ctx, req, org), e);
      const cipher = cipherOf(ctx);
      const doc = e.rightToWork?.documents?.find((d) => d.id === req.params.docId);
      if (!doc) throw notFound(`Document ${req.params.docId}`);
      const file = await ctx.store.getDocument(org.orgId, doc.id);
      if (!file) throw notFound(`Document ${req.params.docId}`);
      const data = cipher.open(org.orgId, doc.id, file.data);
      // Logged before a single byte is sent: a view that cannot be recorded does not happen.
      await ctx.store.logDocumentAccess(accessEntry(req, doc.id, req.params.id, 'viewed'));
      const ascii = doc.fileName.replace(/[^\x20-\x7e]/g, '_');
      return reply
        .header('content-type', doc.contentType)
        .header('content-disposition', `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
        .send(data);
    },
  );

  app.get<{ Params: { id: string; docId: string } }>(
    '/v1/employees/:id/right-to-work/documents/:docId/access',
    {
      schema: {
        tags,
        description: 'Who added, viewed and deleted a copy, oldest first. Kept after the copy itself is deleted. Needs privacy.manage.',
        params: docParams,
      },
    },
    async (req) => {
      const org = orgOf(req);
      dataProtection(req, guard(ctx, req, org));
      employeeIn(org, req.params.id);
      const log = (await ctx.store.listDocumentAccess(org.orgId, req.params.docId)).filter((a) => a.employeeId === req.params.id);
      if (log.length === 0) throw notFound(`Document ${req.params.docId}`);
      return log;
    },
  );

  app.delete<{ Params: { id: string; docId: string } }>(
    '/v1/employees/:id/right-to-work/documents/:docId',
    {
      schema: {
        tags,
        description:
          'Deletes a copy uploaded in error. Leavers\' copies go through the retention schedule (POST /v1/privacy/retention/apply). Needs privacy.manage.',
        params: docParams,
      },
      onResponse: deleteCopiesOnSave(ctx),
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      dataProtection(req, g);
      const e = employeeIn(org, req.params.id);
      const docs = e.rightToWork?.documents ?? [];
      const doc = docs.find((d) => d.id === req.params.docId);
      if (!doc) throw notFound(`Document ${req.params.docId}`);
      e.rightToWork = { ...e.rightToWork!, documents: docs.filter((d) => d.id !== doc.id) };
      deleteCopiesAfterSave(req, [{ employeeId: e.id, documentId: doc.id }]);
      audit(org, actorName(g), 'employee.rtw_document.deleted', { id: e.id, documentId: doc.id, fileName: doc.fileName, sha256: doc.sha256 });
      return shown(req, g, e);
    },
  );
}

/**
 * Copies on personnel file records: a signed contract, a warning letter, a fit note, a certificate.
 * The same encryption, size and type rules, and the same access log, as right to work copies. Adding
 * one is keeping the file (hr.manage at the person's home site, never your own); viewing one is
 * reading it; a copy on a case is for those who handle cases, never the person it is about.
 */
export function hrFileRoutes(app: FastifyInstance, ctx: AppContext) {
  const tags = ['HR'];
  const fileParams = { type: 'object', required: ['id', 'fileId'], properties: { id: { type: 'string' }, fileId: { type: 'string' } } } as const;

  /** The record and its person, as long as the caller may see the record at all. */
  function recordFor(req: FastifyRequest, g: Guard, org: OrgData, id: string) {
    const record = org.hrRecords.find((r) => r.id === id);
    if (!record || (record.kind === 'case' && !seesCases(req, g, record.employeeId))) throw notFound(`Record ${id}`);
    return { record, employee: employeeIn(org, record.employeeId) };
  }

  app.post<{ Params: { id: string }; Querystring: { fileName?: string }; Body: Buffer }>(
    '/v1/hr/records/:id/files',
    {
      preHandler: requireScope('hr:write'),
      bodyLimit: MAX_DOCUMENT_BYTES,
      schema: {
        tags,
        description: 'Stores a copy on a personnel file record: the file itself as the request body (PDF, JPEG, PNG or WebP, up to 4 MB), its name in `fileName`. Returns the record.',
        params: idParam,
        querystring: { type: 'object', properties: { fileName: { type: 'string', maxLength: 255 } } },
      },
      onResponse: async (req, reply) => {
        const id = written.get(req);
        if (!id) return;
        if (reply.statusCode >= 400) await ctx.store.deleteDocument(orgOf(req).orgId, id);
        else {
          const record = orgOf(req).hrRecords.find((r) => r.id === req.params.id);
          await ctx.store.logDocumentAccess(accessEntry(req, id, record?.employeeId ?? '', 'added'));
        }
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const { record, employee } = recordFor(req, g, org, req.params.id);
      g.allow('hr.manage', employee.siteId);
      if (g.behind?.employeeId === employee.id) throw new HttpError(403, 'forbidden', 'Somebody else keeps your own personnel file.');
      const cipher = cipherOf(ctx);
      const data = Buffer.isBuffer(req.body) ? req.body : null;
      if (!data?.length) throw new HttpError(400, 'invalid_request', 'Send the file as the request body.');
      const contentType = sniffType(data);
      if (!contentType) throw new HttpError(415, 'unsupported_file', 'Upload a PDF, JPEG, PNG or WebP copy.');
      if ((record.files?.length ?? 0) >= MAX_DOCUMENTS) throw new HttpError(409, 'too_many_documents', `This record already has ${MAX_DOCUMENTS} copies.`);
      const doc: RightToWorkDocument = {
        id: `hrf_${randomUUID()}`,
        fileName: cleanFileName(req.query.fileName, contentType, record.kind),
        contentType,
        bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
        uploadedAt: new Date().toISOString(),
        uploadedBy: actorName(g),
      };
      await ctx.store.putDocument(org.orgId, doc.id, { contentType, data: cipher.seal(org.orgId, doc.id, data) });
      written.set(req, doc.id);
      record.files = [...(record.files ?? []), doc];
      audit(org, actorName(g), 'hr.record.file_added', { id: record.id, employeeId: employee.id, documentId: doc.id, sha256: doc.sha256 });
      return reply.code(201).send(record);
    },
  );

  app.get<{ Params: { id: string; fileId: string } }>(
    '/v1/hr/records/:id/files/:fileId',
    {
      preHandler: requireScope('hr:read'),
      schema: { tags, description: 'The stored copy, to view or download. Every view is logged, with who and from where.', params: fileParams },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const { record, employee } = recordFor(req, g, org, req.params.id);
      mayView(req, g, employee);
      const doc = record.files?.find((d) => d.id === req.params.fileId);
      if (!doc) throw notFound(`File ${req.params.fileId}`);
      const cipher = cipherOf(ctx);
      const file = await ctx.store.getDocument(org.orgId, doc.id);
      if (!file) throw notFound(`File ${req.params.fileId}`);
      const data = cipher.open(org.orgId, doc.id, file.data);
      await ctx.store.logDocumentAccess(accessEntry(req, doc.id, employee.id, 'viewed'));
      const ascii = doc.fileName.replace(/[^\x20-\x7e]/g, '_');
      return reply
        .header('content-type', doc.contentType)
        .header('content-disposition', `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
        .send(data);
    },
  );

  app.delete<{ Params: { id: string; fileId: string } }>(
    '/v1/hr/records/:id/files/:fileId',
    {
      schema: { tags, description: 'Deletes a copy added in error. Needs privacy.manage, by a person.', params: fileParams },
      onResponse: deleteCopiesOnSave(ctx),
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      dataProtection(req, g);
      const { record, employee } = recordFor(req, g, org, req.params.id);
      const doc = record.files?.find((d) => d.id === req.params.fileId);
      if (!doc) throw notFound(`File ${req.params.fileId}`);
      record.files = record.files!.filter((d) => d.id !== doc.id);
      deleteCopiesAfterSave(req, [{ employeeId: employee.id, documentId: doc.id }]);
      audit(org, actorName(g), 'hr.record.file_deleted', { id: record.id, employeeId: employee.id, documentId: doc.id, sha256: doc.sha256 });
      return record;
    },
  );
}
