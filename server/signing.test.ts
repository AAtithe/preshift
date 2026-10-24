import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';
import { sameName } from './routes/signing';

const PASSWORD = 'pint of best bitter';
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2000, 7)]);

async function boot() {
  const store = new MemoryStore(['demo'], '2026-10-21');
  const { app } = await buildApp({
    apiKeys: [
      { key: 'manager', orgId: 'demo', name: 'GM', scopes: ['*'] },
      { key: 'rota', orgId: 'demo', name: 'Rota tool', scopes: ['rota:read', 'rota:write'] as never },
    ],
    store, provider: new TeamPaySimulator(), autoDispatch: false, env: { PRESHIFT_DOCUMENT_KEY: randomBytes(32).toString('base64') },
  });
  const call = async (method: string, url: string, body?: unknown, who: string = 'manager') => {
    const cookie = who.includes('=') ? who : undefined;
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { ...(cookie ? { cookie, 'user-agent': 'Test phone' } : { authorization: `Bearer ${who}` }), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = String(res.headers['set-cookie'] ?? '').split(';')[0];
    return { status: res.statusCode, body: (res.headers['content-type'] ?? '').includes('json') ? res.json() : res.rawPayload, cookie: set };
  };
  const join = async (person: string) => {
    const inv = await call('POST', `/v1/staff-logins/${person}/invite`);
    const link = Object.fromEntries(new URLSearchParams(new URL(inv.body.path, 'https://x').hash.slice(1)));
    return (await call('POST', '/v1/staff/join', { ...link, email: `${person}@example.com`, password: PASSWORD })).cookie;
  };
  const document = async (employeeId: string, title: string) => {
    const record = (await call('POST', '/v1/hr/records', { employeeId, kind: 'document', date: '2026-10-21', title })).body;
    const up = await app.inject({ method: 'POST', url: `/v1/hr/records/${record.id}/files?fileName=statement.pdf`, headers: { authorization: 'Bearer manager', 'content-type': 'application/pdf' }, payload: PDF });
    return { record, file: up.json().files[0] };
  };
  return { store, call, join, document };
}

describe('signing the written statement and handbook in the staff app', () => {
  it('sends the copy, which the person opens, reads and signs, with the time, place and fingerprint on file', async () => {
    const { store, call, join, document } = await boot();
    const grace = await join('mar-7');
    const org = await store.load('demo');
    const me = org.state.employees.find((e) => e.id === 'mar-7')!;
    me.hr = { ...me.hr, contractIssuedOn: undefined, contractSignedOn: undefined };
    const { record, file } = await document('mar-7', 'Statement of particulars');

    // A rota key cannot send personnel documents.
    expect((await call('POST', `/v1/hr/records/${record.id}/send-to-sign`, { kind: 'statement', fileId: file.id }, 'rota')).status).toBe(403);
    const sent = await call('POST', `/v1/hr/records/${record.id}/send-to-sign`, { kind: 'statement', fileId: file.id });
    expect(sent.status).toBe(200);
    expect(sent.body.signing).toMatchObject({ kind: 'statement', fileId: file.id, sha256: file.sha256, sentBy: 'GM' });
    // Giving it is issuing it: the day one right is met the day it is sent.
    expect(me.hr?.contractIssuedOn).toEqual(expect.any(String));

    const overview = (await call('GET', '/v1/staff/me', undefined, grace)).body;
    expect(overview.toSign).toBe(1);
    expect((await call('GET', '/v1/staff/notifications', undefined, grace)).body[0]).toMatchObject({ kind: 'document_to_sign', title: 'Please read and sign: Statement of particulars' });
    const list = (await call('GET', '/v1/staff/documents', undefined, grace)).body;
    expect(list).toEqual([expect.objectContaining({ id: record.id, kind: 'statement', kindLabel: 'Written statement of particulars', openedAt: null, signedAt: null })]);

    // Not before it has been opened, and only in their own name.
    expect((await call('POST', `/v1/staff/documents/${record.id}/sign`, { name: me.name, read: true }, grace)).body.error).toBe('not_opened');
    const opened = await call('GET', `/v1/staff/documents/${record.id}/file`, undefined, grace);
    expect(opened.status).toBe(200);
    expect(Buffer.from(opened.body as Buffer).equals(PDF)).toBe(true);
    expect((await call('POST', `/v1/staff/documents/${record.id}/sign`, { name: 'Someone Else', read: true }, grace)).body.error).toBe('name_mismatch');
    expect((await call('POST', `/v1/staff/documents/${record.id}/sign`, { name: me.name, read: false }, grace)).body.error).toBe('not_confirmed');

    const signed = await call('POST', `/v1/staff/documents/${record.id}/sign`, { name: `  ${me.name.toUpperCase()} `, read: true }, grace);
    expect(signed.status).toBe(200);
    expect(signed.body).toMatchObject({ signedName: me.name.toUpperCase(), signedAt: expect.any(String) });
    const kept = org.hrRecords.find((r) => r.id === record.id)!.signing!;
    expect(kept).toMatchObject({ ip: expect.any(String), userAgent: 'Test phone', sha256: file.sha256 });
    expect(me.hr?.contractSignedOn).toEqual(kept.signedAt!.slice(0, 10));
    expect(org.audit.some((a) => a.action === 'hr.document.signed')).toBe(true);
    expect((await call('GET', '/v1/staff/me', undefined, grace)).body.toSign).toBe(0);

    // Signed is final: not signed twice, not sent again, the record and its copy are kept.
    expect((await call('POST', `/v1/staff/documents/${record.id}/sign`, { name: me.name, read: true }, grace)).body.error).toBe('already_signed');
    expect((await call('POST', `/v1/hr/records/${record.id}/send-to-sign`, { kind: 'statement', fileId: file.id })).body.error).toBe('already_signed');
    expect((await call('DELETE', `/v1/hr/records/${record.id}`)).body.error).toBe('signed_kept');
  });

  it('records the handbook, and never shows anyone else\'s documents', async () => {
    const { store, call, join, document } = await boot();
    const grace = await join('mar-7');
    const ben = await join('mar-12');
    const { record, file } = await document('mar-7', 'Staff handbook 2026');
    expect((await call('POST', `/v1/hr/records/${record.id}/send-to-sign`, { kind: 'handbook', fileId: file.id })).status).toBe(200);
    expect((await call('GET', '/v1/staff/documents', undefined, ben)).body).toEqual([]);
    expect((await call('GET', `/v1/staff/documents/${record.id}/file`, undefined, ben)).status).toBe(404);
    expect((await call('POST', `/v1/staff/documents/${record.id}/sign`, { name: 'Ben Ford', read: true }, ben)).status).toBe(404);
    await call('GET', `/v1/staff/documents/${record.id}/file`, undefined, grace);
    const org = await store.load('demo');
    const me = org.state.employees.find((e) => e.id === 'mar-7')!;
    expect((await call('POST', `/v1/staff/documents/${record.id}/sign`, { name: me.name, read: true }, grace)).status).toBe(200);
    expect(me.hr?.handbookAcknowledgedOn).toEqual(expect.any(String));
    // A training record is not something to sign.
    const training = (await call('POST', '/v1/hr/records', { employeeId: 'mar-7', kind: 'training', date: '2026-10-21', title: 'Allergen awareness' })).body;
    expect((await call('POST', `/v1/hr/records/${training.id}/send-to-sign`, { kind: 'handbook', fileId: 'x' })).body.error).toBe('not_a_document');
  });

  it('matches a typed name whatever its case, spacing or punctuation', () => {
    expect(sameName(' grace  o\'neill ', "Grace O'Neill")).toBe(true);
    expect(sameName('Grace', "Grace O'Neill")).toBe(false);
    expect(sameName('', '')).toBe(false);
  });
});
