import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { randomBytes } from 'node:crypto';
import { MemoryStore, PgStore, type Query, type Store } from './store';
import { sniffType } from './routes/documents';

const KEYS = [
  { key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*' as const] },
  { key: 'gm', orgId: 'demo', name: 'GM', scopes: ['rota:read' as const, 'rota:write' as const, 'hr:read' as const, 'hr:write' as const] },
  { key: 'rota', orgId: 'demo', name: 'Rota integration', scopes: ['rota:read' as const, 'rota:write' as const] },
  { key: 'other', orgId: 'acme', name: 'Other org', scopes: ['*' as const] },
];

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2000, 1)]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const KEY = randomBytes(32).toString('base64');

function pglite(): { db: PGlite; query: Query } {
  const db = new PGlite();
  return { db, query: async (text, params) => (await db.query(text, params)).rows as Record<string, unknown>[] };
}

async function setup(store: Store = new MemoryStore(['demo'], '2026-10-21'), env: NodeJS.ProcessEnv = { PRESHIFT_DOCUMENT_KEY: KEY }) {
  const { app } = await buildApp({ apiKeys: KEYS, store, provider: new TeamPaySimulator(), autoDispatch: false, env });
  const upload = (employeeId: string, data: Buffer, contentType = 'application/pdf', key = 'admin', fileName = 'passport.pdf') =>
    app.inject({
      method: 'POST',
      url: `/v1/employees/${employeeId}/right-to-work/documents?fileName=${encodeURIComponent(fileName)}`,
      headers: { authorization: `Bearer ${key}`, 'content-type': contentType },
      payload: data,
    });
  const call = (method: string, url: string, key = 'admin', body?: unknown) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      payload: body ? JSON.stringify(body) : undefined,
    });
  const signInAdmin = async () => {
    const password = 'correct horse battery';
    const owner = await app.inject({
      method: 'POST',
      url: '/auth/setup',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ email: 'owner@ws.example', password, confirm: password, next: '/app/' }).toString(),
    });
    return String(owner.headers['set-cookie']).split(';')[0];
  };
  return { app, store, upload, call, signInAdmin };
}

describe('right to work documents', () => {
  it('stores a copy, lists it on the record and serves back the same bytes', async () => {
    const { upload, call } = await setup();
    const res = await upload('mar-2', PDF, 'application/pdf', 'gm', '../../Passport scan.pdf');
    expect(res.statusCode).toBe(201);
    const doc = res.json().rightToWork.documents[0];
    expect(doc).toMatchObject({ fileName: 'Passport scan.pdf', contentType: 'application/pdf', bytes: PDF.length, uploadedBy: 'GM' });
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);

    const file = await call('GET', `/v1/employees/mar-2/right-to-work/documents/${doc.id}`, 'gm');
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.rawPayload.equals(PDF)).toBe(true);
  });

  it('decides the type from the bytes and refuses anything that is not a document copy', async () => {
    const { upload } = await setup();
    const png = await upload('mar-2', PNG, 'application/octet-stream', 'admin', 'card');
    expect(png.json().rightToWork.documents[0]).toMatchObject({ contentType: 'image/png', fileName: 'card' });
    const html = await upload('mar-2', Buffer.from('<html><script>alert(1)</script></html>'), 'image/jpeg');
    expect(html.statusCode).toBe(415);
    expect((await upload('mar-2', Buffer.alloc(0))).statusCode).toBe(400);
    expect((await upload('mar-2', Buffer.concat([PDF, Buffer.alloc(4 * 1024 * 1024)]))).statusCode).toBe(413);
    expect(sniffType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
  });

  it('keeps the copies when the check itself is edited', async () => {
    const { upload, call } = await setup();
    await upload('mar-2', PDF);
    const res = await call('PATCH', '/v1/employees/mar-2', 'admin', {
      rightToWork: { checked: true, checkedOn: '2026-10-20', evidence: 'Share code', documents: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rightToWork).toMatchObject({ evidence: 'Share code' });
    expect(res.json().rightToWork.documents).toHaveLength(1);
  });

  it('lets only a signed-in admin delete a copy, and then the file is gone', async () => {
    const { app, upload, call, store, signInAdmin } = await setup();
    const doc = (await upload('mar-2', PDF)).json().rightToWork.documents[0];
    const url = `/v1/employees/mar-2/right-to-work/documents/${doc.id}`;
    expect((await call('DELETE', url, 'gm')).statusCode).toBe(403);
    // Integration keys never reach admin actions, even with every scope.
    expect((await call('DELETE', url, 'admin')).statusCode).toBe(403);
    expect(await store.getDocument('demo', doc.id)).not.toBeNull();

    const cookie = await signInAdmin();
    const res = await app.inject({ method: 'DELETE', url, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().rightToWork.documents).toEqual([]);
    expect(await store.getDocument('demo', doc.id)).toBeNull();
    expect((await call('GET', url)).statusCode).toBe(404);
  });

  it('keeps each organisation\'s copies to itself', async () => {
    const { upload, call } = await setup();
    const doc = (await upload('mar-2', PDF)).json().rightToWork.documents[0];
    expect((await call('GET', `/v1/employees/mar-2/right-to-work/documents/${doc.id}`, 'other')).statusCode).toBe(404);
    expect((await upload('mar-2', PDF, 'application/pdf', 'other')).statusCode).toBe(404);
  });

  it('keeps copies in Postgres, outside the organisation document', async () => {
    const { db, query } = pglite();
    const first = await setup(new PgStore(query, ['demo'], '2026-10-21'));
    const doc = (await first.upload('mar-2', PDF)).json().rightToWork.documents[0];

    const second = await setup(new PgStore(query, ['demo'], '2026-10-21'));
    const file = await second.call('GET', `/v1/employees/mar-2/right-to-work/documents/${doc.id}`);
    expect(file.rawPayload.equals(PDF)).toBe(true);
    const org = await db.query<{ data: string }>(`select data::text as data from preshift.orgs where org_id = 'demo'`);
    expect(org.rows[0].data).not.toContain(PDF.toString('base64').slice(0, 40));
    const stored = await db.query<{ data: string }>('select data from preshift.documents');
    expect(Buffer.from(stored.rows[0].data, 'base64').includes(Buffer.from('%PDF'))).toBe(false);
    await second.store.deleteDocument('demo', doc.id);
    expect((await second.call('GET', `/v1/employees/mar-2/right-to-work/documents/${doc.id}`)).statusCode).toBe(404);
  });

  it('stores only ciphertext, bound to its own record, and refuses a file that has been altered or moved', async () => {
    const { upload, call, store } = await setup();
    const a = (await upload('mar-2', PDF)).json().rightToWork.documents[0];
    const b = (await upload('mar-2', PNG, 'image/png')).json().rightToWork.documents.at(-1);
    const sealed = (await store.getDocument('demo', a.id))!;
    expect(sealed.data.subarray(0, 4).toString()).toBe('PSD1');
    expect(sealed.data.includes(Buffer.from('%PDF'))).toBe(false);

    // Another record's ciphertext put in this file's place does not decrypt.
    await store.putDocument('demo', b.id, sealed);
    expect((await call('GET', `/v1/employees/mar-2/right-to-work/documents/${b.id}`)).json().error).toBe('document_tampered');
    const flipped = Buffer.from(sealed.data);
    flipped[flipped.length - 1] ^= 1;
    await store.putDocument('demo', a.id, { ...sealed, data: flipped });
    const res = await call('GET', `/v1/employees/mar-2/right-to-work/documents/${a.id}`);
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('document_tampered');
  });

  it('refuses files on a database until a valid key is set, and says so on the health check', async () => {
    const none = await setup(new PgStore(pglite().query, ['demo'], '2026-10-21'), {});
    expect((await none.upload('mar-2', PDF)).json().error).toBe('document_key_missing');
    expect((await none.call('GET', '/health')).json().documents).toBe('no key');
    const bad = await setup(new PgStore(pglite().query, ['demo'], '2026-10-21'), { PRESHIFT_DOCUMENT_KEY: 'too-short' });
    expect((await bad.upload('mar-2', PDF)).statusCode).toBe(503);
    expect((await bad.call('GET', '/health')).json().documents).toBe('invalid key');

    const { query } = pglite();
    const first = await setup(new PgStore(query, ['demo'], '2026-10-21'));
    expect((await first.call('GET', '/health')).json().documents).toBe('encrypted');
    const doc = (await first.upload('mar-2', PDF)).json().rightToWork.documents[0];
    const other = await setup(new PgStore(query, ['demo'], '2026-10-21'), { PRESHIFT_DOCUMENT_KEY: randomBytes(32).toString('base64') });
    expect((await other.call('GET', `/v1/employees/mar-2/right-to-work/documents/${doc.id}`)).json().error).toBe('document_key_mismatch');
  });

  it('logs every view, addition and deletion, shows the log to admins only, and keeps it after the copy is gone', async () => {
    const { upload, call, app, signInAdmin } = await setup();
    const doc = (await upload('mar-2', PDF, 'application/pdf', 'gm')).json().rightToWork.documents[0];
    const url = `/v1/employees/mar-2/right-to-work/documents/${doc.id}`;
    await call('GET', url, 'gm');
    await call('GET', url, 'gm');

    expect((await call('GET', `${url}/access`, 'gm')).statusCode).toBe(403);
    const cookie = await signInAdmin();
    const viewAsAdmin = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(viewAsAdmin.statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url, headers: { cookie } });

    const log = (await app.inject({ method: 'GET', url: `${url}/access`, headers: { cookie } })).json();
    expect(log.map((a: { action: string; actor: string; via: string }) => [a.action, a.actor, a.via])).toEqual([
      ['added', 'GM', 'api key'],
      ['viewed', 'GM', 'api key'],
      ['viewed', 'GM', 'api key'],
      ['viewed', 'owner@ws.example', 'session'],
      ['deleted', 'owner@ws.example', 'session'],
    ]);
    expect(log[1].ip).toBeTruthy();
  });

  it('does not show a copy when the view cannot be logged', async () => {
    const store = new MemoryStore(['demo'], '2026-10-21');
    const { upload, call } = await setup(store);
    const doc = (await upload('mar-2', PDF)).json().rightToWork.documents[0];
    store.logDocumentAccess = async () => {
      throw new Error('log unavailable');
    };
    const res = await call('GET', `/v1/employees/mar-2/right-to-work/documents/${doc.id}`);
    expect(res.statusCode).toBe(500);
    expect(res.rawPayload.includes(Buffer.from('%PDF'))).toBe(false);
  });

  it('keeps copies from keys without an HR scope', async () => {
    const { upload, call } = await setup();
    const doc = (await upload('mar-2', PDF)).json().rightToWork.documents[0];
    expect((await upload('mar-2', PDF, 'application/pdf', 'rota')).statusCode).toBe(403);
    expect((await call('GET', `/v1/employees/mar-2/right-to-work/documents/${doc.id}`, 'rota')).statusCode).toBe(403);
  });

  it('destroys a leaver\'s stored copies when retention removes their right to work record, and logs it', async () => {
    const { upload, call, app, store, signInAdmin } = await setup();
    const doc = (await upload('mar-2', PDF)).json().rightToWork.documents[0];
    expect((await call('POST', '/v1/employees/mar-2/leaver', 'admin', { leaveDate: '2023-06-30' })).statusCode).toBe(200);
    const cookie = await signInAdmin();
    const schedule = (await app.inject({ method: 'GET', url: '/v1/privacy/retention', headers: { cookie } })).json();
    const item = (schedule.items ?? schedule).find((i: { code: string; employeeId: string }) => i.code === 'right-to-work' && i.employeeId === 'mar-2');
    expect(item).toMatchObject({ due: true });
    expect(item.removes).toContain('copies');

    const applied = await app.inject({ method: 'POST', url: '/v1/privacy/retention/apply', headers: { cookie } });
    expect(applied.statusCode).toBe(200);
    expect(await store.getDocument('demo', doc.id)).toBeNull();
    const person = (await call('GET', '/v1/employees/mar-2')).json();
    expect(person.rightToWork.documents ?? []).toEqual([]);
    const log = (await store.listDocumentAccess('demo', doc.id)).map((a) => [a.action, a.actor]);
    expect(log.at(-1)).toEqual(['deleted', 'owner@ws.example']);
  });
});
