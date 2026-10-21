import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Employee, RightToWorkDocument } from '../../src/engine/types';
import { requireAdmin, requireScope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { audit, type OrgData } from '../store';

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
function cleanFileName(name: string | undefined, contentType: RightToWorkDocument['contentType']): string {
  const base = (name ?? '').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 120);
  return base || `right-to-work.${contentType.split('/')[1]}`;
}

function employeeIn(org: OrgData, id: string): Employee {
  const e = org.state.employees.find((x) => x.id === id);
  if (!e) throw notFound(`Employee ${id}`);
  return e;
}

// Files written or removed by a request, settled once the response shows whether the record was saved.
const written = new WeakMap<FastifyRequest, string>();
const removed = new WeakMap<FastifyRequest, string>();

export function documentRoutes(app: FastifyInstance, ctx: AppContext) {
  const tags = ['Right to work'];
  const docParams = { type: 'object', required: ['id', 'docId'], properties: { id: { type: 'string' }, docId: { type: 'string' } } } as const;

  app.post<{ Params: { id: string }; Querystring: { fileName?: string }; Body: Buffer }>(
    '/v1/employees/:id/right-to-work/documents',
    {
      preHandler: requireScope('rota:write'),
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
        // The record did not save, so nothing names this file: remove it rather than leave it behind.
        const id = written.get(req);
        if (id && reply.statusCode >= 400) await ctx.store.deleteDocument(orgOf(req).orgId, id);
      },
    },
    async (req, reply) => {
      const org = orgOf(req);
      const e = employeeIn(org, req.params.id);
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
        uploadedBy: req.principal.name,
      };
      await ctx.store.putDocument(org.orgId, doc.id, { contentType, data });
      written.set(req, doc.id);
      e.rightToWork = { ...rtw, documents: [...(rtw.documents ?? []), doc] };
      audit(org, req.principal.name, 'employee.rtw_document.added', { id: e.id, documentId: doc.id, sha256: doc.sha256 });
      return reply.code(201).send(e);
    },
  );

  app.get<{ Params: { id: string; docId: string } }>(
    '/v1/employees/:id/right-to-work/documents/:docId',
    { preHandler: requireScope('rota:read'), schema: { tags, description: 'The stored copy, to view or download.', params: docParams } },
    async (req, reply) => {
      const org = orgOf(req);
      const doc = employeeIn(org, req.params.id).rightToWork?.documents?.find((d) => d.id === req.params.docId);
      if (!doc) throw notFound(`Document ${req.params.docId}`);
      const file = await ctx.store.getDocument(org.orgId, doc.id);
      if (!file) throw notFound(`Document ${req.params.docId}`);
      const ascii = doc.fileName.replace(/[^\x20-\x7e]/g, '_');
      return reply
        .header('content-type', doc.contentType)
        .header('content-disposition', `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, no-store')
        .send(file.data);
    },
  );

  app.delete<{ Params: { id: string; docId: string } }>(
    '/v1/employees/:id/right-to-work/documents/:docId',
    {
      preHandler: requireAdmin,
      schema: {
        tags,
        description:
          'Deletes a copy: one uploaded in error, or a leaver\'s once the two years after they left have passed. Admins only.',
        params: docParams,
      },
      onResponse: async (req, reply) => {
        // Only once the record no longer names it, so a failed save never leaves a link to nothing.
        const id = removed.get(req);
        if (id && reply.statusCode < 400) await ctx.store.deleteDocument(orgOf(req).orgId, id);
      },
    },
    async (req) => {
      const org = orgOf(req);
      const e = employeeIn(org, req.params.id);
      const docs = e.rightToWork?.documents ?? [];
      const doc = docs.find((d) => d.id === req.params.docId);
      if (!doc) throw notFound(`Document ${req.params.docId}`);
      e.rightToWork = { ...e.rightToWork!, documents: docs.filter((d) => d.id !== doc.id) };
      removed.set(req, doc.id);
      audit(org, req.principal.name, 'employee.rtw_document.deleted', { id: e.id, documentId: doc.id, fileName: doc.fileName, sha256: doc.sha256 });
      return e;
    },
  );
}
