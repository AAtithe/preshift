import { describe, expect, it } from 'vitest';
import { readHire } from '../src/engine/hires';
import { signHire } from './routes/hires';
import { MemoryStore } from './store';
import { enrol, kit, TODAY } from './testkit';

const OWNER = { email: 'owner@ws.example', password: 'correct horse battery' };

async function boot() {
  const k = await kit({ store: new MemoryStore(['demo'], TODAY), accounts: false, env: { PRESHIFT_APP_URL: 'https://app.preshift.example' } });
  const setup = await k.form('/auth/setup', { email: OWNER.email, password: OWNER.password, confirm: OWNER.password, next: '/app/' });
  const cookie = (await enrol(k, setup.cookie!)).cookie;
  const call = (method: string, url: string, body?: unknown) => k.call(method, url, cookie, body);
  const hook = (secret: string, body: unknown, signature?: string) => {
    const raw = JSON.stringify(body);
    return k.app.inject({ method: 'POST', url: '/v1/integrations/ats/webhook/demo', headers: { 'content-type': 'application/json', 'x-preshift-signature': signature ?? signHire(secret, raw) }, payload: raw });
  };
  return { k, call, hook };
}

const hired = (over: Record<string, unknown> = {}) => ({
  event: 'candidate.hired',
  candidate: { id: 'tf-881', first_name: 'Priya', last_name: 'Shah', email: 'priya@example.com', phone: '07700 900123', date_of_birth: '22/03/2001', location: 'Marylebone', job_title: 'Bartender', start_date: '2026-11-02', pay_rate: 13.5, ...over },
});

describe('new hires from recruitment', () => {
  it('reads a hire in either naming style, matching the site and role by name where it can', () => {
    const sites = [{ id: 'mar', name: 'Marylebone', trackingCode: 'MARY' }];
    const roles = [{ id: 'bar', name: 'Bartender' }];
    expect(readHire(hired(), sites, roles).hire).toEqual({
      externalId: 'tf-881', name: 'Priya Shah', email: 'priya@example.com', phone: '07700 900123', dateOfBirth: '2001-03-22',
      siteId: 'mar', siteGiven: 'Marylebone', roleId: 'bar', roleGiven: 'Bartender', startDate: '2026-11-02', hourlyRate: 13.5,
    });
    expect(readHire({ id: 'x', fullName: 'A B', siteId: 'MARY', role: 'Head Bartender' }, sites, roles).hire).toMatchObject({ siteId: 'mar', roleId: 'bar' });
    const unknown = readHire({ id: 'y', name: 'C D', site: 'Leeds', role: 'Sommelier' }, sites, roles).hire!;
    expect(unknown.siteId).toBeUndefined();
    expect(unknown.siteGiven).toBe('Leeds');
    expect(readHire({ name: 'No Id' }, sites, roles).problem).toMatch(/no id/);
  });

  it('takes hires only when signed with the secret, and a resent hire updates rather than doubles', async () => {
    const { call, hook } = await boot();
    expect((await hook('anything', hired())).statusCode).toBe(401);
    const connected = await call('PUT', '/v1/integrations/ats', { source: 'talent_funnel' });
    expect(connected.status).toBe(200);
    const secret: string = connected.body.secret;
    expect(connected.body.webhookUrl).toBe('https://app.preshift.example/v1/integrations/ats/webhook/demo');
    expect(JSON.stringify((await call('GET', '/v1/integrations/ats')).body)).not.toContain(secret);

    expect((await hook(secret, hired(), 'sha256=forged')).statusCode).toBe(401);
    const first = await hook(secret, hired());
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: 'waiting', matched: { site: true, role: true } });
    expect((await hook(secret, hired({ phone: '07700 900999' }))).json().id).toBe(first.json().id);
    // Applied or interviewed is not a hire.
    expect((await hook(secret, { ...hired(), event: 'candidate.applied' })).json()).toMatchObject({ ignored: 'candidate.applied' });

    const waiting = (await call('GET', '/v1/hires')).body;
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ name: 'Priya Shah', phone: '07700 900999', siteId: 'mar', roleId: 'bar' });
  });

  it('adds a checked hire as a starter with the details the applicant gave, once', async () => {
    const { call, hook } = await boot();
    const secret: string = (await call('PUT', '/v1/integrations/ats', { source: 'talent_funnel' })).body.secret;
    const id = (await hook(secret, hired())).json().id;
    const added = await call('POST', `/v1/hires/${id}/add`, { contractedHours: 16 });
    expect(added.status).toBe(201);
    const person = (await call('GET', `/v1/employees/${added.body.employeeId}`)).body;
    expect(person).toMatchObject({ name: 'Priya Shah', siteId: 'mar', roleIds: ['bar'], dateOfBirth: '2001-03-22', contractedHours: 16, startDate: '2026-11-02' });
    expect((await call('POST', `/v1/hires/${id}/add`, {})).status).toBe(409);
    expect((await call('GET', '/v1/hires')).body).toEqual([]);
    // Sent again after being added, the hire is not reopened.
    expect((await hook(secret, hired())).json()).toMatchObject({ status: 'added' });
  });

  it('asks the manager for what the recruitment system did not send, and can dismiss a hire', async () => {
    const { call, hook } = await boot();
    const secret: string = (await call('PUT', '/v1/integrations/ats', { source: 'other' })).body.secret;
    const id = (await hook(secret, hired({ id: 'tf-2', location: 'Leeds', date_of_birth: undefined }))).json().id;
    const refused = await call('POST', `/v1/hires/${id}/add`, {});
    expect(refused.status).toBe(422);
    expect(refused.body.message).toMatch(/site, date of birth/);
    expect((await call('POST', `/v1/hires/${id}/add`, { siteId: 'fitz', dateOfBirth: '2000-01-01' })).status).toBe(201);
    const other = (await hook(secret, hired({ id: 'tf-3' }))).json().id;
    expect((await call('POST', `/v1/hires/${other}/dismiss`)).body.status).toBe('dismissed');
  });
});
