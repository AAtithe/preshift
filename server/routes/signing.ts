// Signing the written statement and the handbook in the staff app. The statement of particulars is
// a day one right: a manager sends the copy on the person's file, the person opens it on their own
// phone and signs it, and the file records when, from where, and against which exact copy.

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DocumentSigning, Employee, HrRecord } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, londonParts, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { notify } from '../notify';
import { idParam } from '../schemas';
import { audit, type OrgData, type Store } from '../store';
import { cipherOf } from './documents';

export const SIGNING_LABEL: Record<DocumentSigning['kind'], string> = {
  statement: 'Written statement of particulars',
  handbook: 'Staff handbook',
};

/** A typed name matches the name on file when only case, spacing and punctuation differ. */
export const sameName = (typed: string, onFile: string) => {
  const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return plain(typed).length > 0 && plain(typed) === plain(onFile);
};

/** What the person sees of a document sent to them. */
export function signingView(r: HrRecord) {
  const s = r.signing!;
  const file = r.files?.find((f) => f.id === s.fileId);
  return {
    id: r.id,
    title: r.title,
    kind: s.kind,
    kindLabel: SIGNING_LABEL[s.kind],
    fileName: file?.fileName ?? null,
    sentAt: s.sentAt,
    openedAt: s.openedAt ?? null,
    signedAt: s.signedAt ?? null,
    signedName: s.signedName ?? null,
  };
}

/** Documents sent to this person to sign, newest first. */
export const toSignOf = (org: OrgData, employeeId: string) =>
  org.hrRecords.filter((r) => r.employeeId === employeeId && r.signing).sort((a, b) => b.signing!.sentAt.localeCompare(a.signing!.sentAt));

/**
 * Manager side: send a copy on a document record to the person to sign. Keeping the file is
 * hr.manage at their home site, never on your own file.
 */
export function signingRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post<{ Params: { id: string }; Body: { kind: DocumentSigning['kind']; fileId: string } }>(
    '/v1/hr/records/:id/send-to-sign',
    {
      preHandler: requireScope('hr:write'),
      schema: {
        tags: ['HR'],
        description:
          'Sends a copy on a document record to the person to read and sign in the staff app. Sending the written statement records it as issued that day. ' +
          'Once signed it cannot be sent again; send a new record for a new version.',
        params: idParam,
        body: {
          type: 'object',
          required: ['kind', 'fileId'],
          properties: { kind: { type: 'string', enum: ['statement', 'handbook'] }, fileId: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      const record = org.hrRecords.find((r) => r.id === req.params.id);
      if (!record || record.kind === 'case') throw notFound(`Record ${req.params.id}`);
      const e = org.state.employees.find((x) => x.id === record.employeeId);
      if (!e) throw notFound(`Employee ${record.employeeId}`);
      g.allow('hr.manage', e.siteId);
      if (g.behind?.employeeId === e.id) throw new HttpError(403, 'forbidden', 'Somebody else keeps your own personnel file.');
      if (record.kind !== 'document') throw new HttpError(422, 'not_a_document', 'Only a document record can be sent to sign.');
      if (record.signing?.signedAt) throw new HttpError(409, 'already_signed', `${e.name} signed this on ${record.signing.signedAt.slice(0, 10)}. Add a new document record for a new version.`);
      const file = record.files?.find((f) => f.id === req.body.fileId);
      if (!file) throw notFound(`File ${req.body.fileId}`);
      const now = ctx.now();
      const today = londonParts(now).date;
      record.signing = { kind: req.body.kind, fileId: file.id, sha256: file.sha256, sentAt: now.toISOString(), sentBy: actorName(g) };
      // Giving the written statement is what the law asks for on day one; signing it is the evidence it was given.
      if (req.body.kind === 'statement' && !e.hr?.contractIssuedOn) e.hr = { ...e.hr, contractIssuedOn: today };
      notify(org, e.id, 'document_to_sign', `Please read and sign: ${record.title}`, `Your ${SIGNING_LABEL[req.body.kind].toLowerCase()} is ready in the app. Open it, read it, then sign.`, now);
      audit(org, actorName(g), 'hr.document.sent_to_sign', { id: record.id, employeeId: e.id, kind: req.body.kind, documentId: file.id, sha256: file.sha256 });
      return record;
    },
  );
}

/** Staff side: their own documents to sign, the copy itself, and signing it. */
export function staffSigningRoutes(app: FastifyInstance, ctx: AppContext, store: Store, signedIn: (req: FastifyRequest) => Promise<{ org: OrgData; employee: Employee; login: { email?: string } }>) {
  const hidden = { hide: true };
  const mine = (org: OrgData, employee: Employee, id: string) => {
    const record = toSignOf(org, employee.id).find((r) => r.id === id);
    if (!record) throw notFound('Document');
    return record;
  };

  app.get('/v1/staff/documents', { schema: hidden }, async (req) => {
    const { org, employee } = await signedIn(req);
    return toSignOf(org, employee.id).map(signingView);
  });

  app.get<{ Params: { id: string } }>('/v1/staff/documents/:id/file', { schema: { ...hidden, params: idParam } }, async (req, reply) => {
    const { org, employee, login } = await signedIn(req);
    const record = mine(org, employee, req.params.id);
    const s = record.signing!;
    const doc = record.files?.find((f) => f.id === s.fileId);
    if (!doc) throw notFound('Document');
    const stored = await store.getDocument(org.orgId, doc.id);
    if (!stored) throw notFound('Document');
    const data = cipherOf(ctx).open(org.orgId, doc.id, stored.data);
    const at = new Date().toISOString();
    await store.logDocumentAccess({ orgId: org.orgId, documentId: doc.id, employeeId: employee.id, action: 'viewed', at, actor: login.email ?? `staff:${employee.id}`, via: 'staff app', ip: req.ip });
    if (!s.openedAt) {
      s.openedAt = at;
      audit(org, `staff:${employee.id}`, 'hr.document.opened', { id: record.id, employeeId: employee.id });
      await store.save(org);
    }
    const ascii = doc.fileName.replace(/[^\x20-\x7e]/g, '_');
    return reply
      .header('content-type', doc.contentType)
      .header('content-disposition', `inline; filename="${ascii}"`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .send(data);
  });

  app.post<{ Params: { id: string }; Body: { name: string; read: boolean } }>(
    '/v1/staff/documents/:id/sign',
    {
      schema: {
        ...hidden,
        params: idParam,
        body: { type: 'object', required: ['name', 'read'], properties: { name: { type: 'string', maxLength: 120 }, read: { type: 'boolean' } }, additionalProperties: false },
      },
    },
    async (req) => {
      const { org, employee } = await signedIn(req);
      const record = mine(org, employee, req.params.id);
      const s = record.signing!;
      if (s.signedAt) throw new HttpError(409, 'already_signed', 'You have signed this already.');
      if (!s.openedAt) throw new HttpError(409, 'not_opened', 'Open the document and read it before you sign.');
      if (req.body.read !== true) throw new HttpError(422, 'not_confirmed', 'Confirm you have read it.');
      if (!sameName(req.body.name, employee.name)) throw new HttpError(422, 'name_mismatch', `Type your name as your employer has it: ${employee.name}.`);
      // The copy signed must be the copy sent: checked against the fingerprint taken when it was sent.
      const doc = record.files?.find((f) => f.id === s.fileId);
      const stored = doc ? await store.getDocument(org.orgId, doc.id) : null;
      if (!doc || !stored) throw notFound('Document');
      const data = cipherOf(ctx).open(org.orgId, doc.id, stored.data);
      if (createHash('sha256').update(data).digest('hex') !== s.sha256) throw new HttpError(409, 'document_changed', 'This copy has changed since it was sent. Ask your manager to send it again.');
      const now = new Date();
      const today = londonParts(now).date;
      Object.assign(s, { signedAt: now.toISOString(), signedName: req.body.name.trim(), ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) });
      employee.hr = { ...employee.hr, ...(s.kind === 'statement' ? { contractSignedOn: today } : { handbookAcknowledgedOn: today }) };
      audit(org, `staff:${employee.id}`, 'hr.document.signed', { id: record.id, employeeId: employee.id, kind: s.kind, sha256: s.sha256, ip: req.ip });
      await store.save(org);
      return signingView(record);
    },
  );
}
