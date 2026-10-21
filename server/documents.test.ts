import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore, PgStore, type Query, type Store } from './store';
import { sniffType } from './routes/documents';

const KEYS = [
  { key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*' as const] },
  { key: 'gm', orgId: 'demo', name: 'GM', scopes: ['rota:read' as const, 'rota:write' as const] },
  { key: 'other', orgId: 'acme', name: 'Other org', scopes: ['*' as const] },
];

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2000, 1)]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function setup(store: Store = new MemoryStore(['demo'], '2026-10-21')) {
  const { app } = await buildApp({ apiKeys: KEYS, store, provider: new TeamPaySimulator(), autoDispatch: false });
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
  return { app, store, upload, call };
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
    const { app, upload, call, store } = await setup();
    const doc = (await upload('mar-2', PDF)).json().rightToWork.documents[0];
    const url = `/v1/employees/mar-2/right-to-work/documents/${doc.id}`;
    expect((await call('DELETE', url, 'gm')).statusCode).toBe(403);
    // Integration keys never reach admin actions, even with every scope.
    expect((await call('DELETE', url, 'admin')).statusCode).toBe(403);
    expect(await store.getDocument('demo', doc.id)).not.toBeNull();

    const password = 'correct horse battery';
    const owner = await app.inject({
      method: 'POST',
      url: '/auth/setup',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ email: 'owner@ws.example', password, confirm: password, next: '/app/' }).toString(),
    });
    const cookie = String(owner.headers['set-cookie']).split(';')[0];
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
    const db = new PGlite();
    const query: Query = async (text, params) => (await db.query(text, params)).rows as Record<string, unknown>[];
    const first = await setup(new PgStore(query, ['demo'], '2026-10-21'));
    const doc = (await first.upload('mar-2', PDF)).json().rightToWork.documents[0];

    const second = await setup(new PgStore(query, ['demo'], '2026-10-21'));
    const file = await second.call('GET', `/v1/employees/mar-2/right-to-work/documents/${doc.id}`);
    expect(file.rawPayload.equals(PDF)).toBe(true);
    const org = await db.query<{ data: string }>(`select data::text as data from preshift.orgs where org_id = 'demo'`);
    expect(org.rows[0].data).not.toContain(PDF.toString('base64').slice(0, 40));
    await second.store.deleteDocument('demo', doc.id);
    expect((await second.call('GET', `/v1/employees/mar-2/right-to-work/documents/${doc.id}`)).statusCode).toBe(404);
  });
});
