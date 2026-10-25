import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { TeamPaySimulator } from './integrations/payroll/simulator';
import { MemoryStore } from './store';
import { holdClock } from './testClock';

holdClock();

const WEEK = '2026-10-19';
const KEYS = [
  { key: 'admin', orgId: 'demo', name: 'Admin', scopes: ['*' as const] },
  { key: 'reader', orgId: 'demo', name: 'Reader', scopes: ['rota:read' as const] },
  { key: 'other', orgId: 'acme', name: 'Other org', scopes: ['*' as const] },
];

async function setup() {
  const { app } = await buildApp({ apiKeys: KEYS, store: new MemoryStore(['demo'], '2026-10-21'), provider: new TeamPaySimulator(), autoDispatch: false });
  let next = 1;
  const rpc = async (method: string, params?: unknown, key = 'admin', headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
      payload: JSON.stringify({ jsonrpc: '2.0', id: next++, method, ...(params ? { params } : {}) }),
    });
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  const tool = async (name: string, args: Record<string, unknown> = {}, key = 'admin') => (await rpc('tools/call', { name, arguments: args }, key)).body.result;
  return { app, rpc, tool };
}

describe('MCP connector', () => {
  it('initialises with the version the client asks for, or the newest', async () => {
    const { rpc } = await setup();
    const asked = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(asked.body.result.protocolVersion).toBe('2025-03-26');
    expect(asked.body.result.serverInfo.name).toBe('preshift');
    expect(asked.body.result.capabilities.tools).toBeDefined();
    expect((await rpc('initialize', { protocolVersion: '1999-01-01' })).body.result.protocolVersion).toBe('2025-06-18');
  });

  it('accepts notifications with 202 and answers ping', async () => {
    const { app, rpc } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      payload: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(res.statusCode).toBe(202);
    expect((await rpc('ping')).body.result).toEqual({});
  });

  it('refuses callers without a valid key, and cross-origin browsers', async () => {
    const { rpc, app } = await setup();
    expect((await rpc('tools/list', undefined, 'nope')).status).toBe(401);
    expect((await rpc('tools/list', undefined, 'admin', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/mcp', headers: { authorization: 'Bearer admin' } })).statusCode).toBe(405);
  });

  it('lists the one organisation a key belongs to, and refuses any other', async () => {
    const { tool } = await setup();
    const listed = await tool('list_organisations');
    expect(listed.structuredContent.organisations.map((o: { id: string }) => o.id)).toEqual(['demo']);
    expect((await tool('list_sites', { organisation: 'demo' })).isError).toBe(false);
    expect((await tool('list_sites', { organisation: 'acme' })).content[0].text).toContain('does not reach');
  });

  it('lists only the tools the key may run', async () => {
    const { rpc } = await setup();
    const all = (await rpc('tools/list')).body.result.tools.map((t: { name: string }) => t.name);
    expect(all).toEqual(expect.arrayContaining(['list_sites', 'get_rota_week', 'build_rota', 'publish_rota', 'approve_time', 'get_labour_journal']));
    const reader = (await rpc('tools/list', undefined, 'reader')).body.result.tools as { name: string; annotations: { readOnlyHint: boolean } }[];
    expect(reader.map((t) => t.name)).toContain('get_rota_week');
    expect(reader.map((t) => t.name)).not.toContain('build_rota');
    expect(reader.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });

  it('will not build the rota where the organisation has switched off AI rota writing', async () => {
    const store = new MemoryStore(['demo'], '2026-10-21');
    const { app } = await buildApp({ apiKeys: KEYS, store, provider: new TeamPaySimulator(), autoDispatch: false });
    const org = await store.load('demo');
    org.settings = { ...org.settings, featuresOff: ['rotaai'] };
    const before = org.state.shifts.length;
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'build_rota', arguments: { siteId: 'mar', weekStart: WEEK } } }),
    });
    const result = res.json().result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('AI rota writing is switched off');
    expect((await store.load('demo')).state.shifts).toHaveLength(before);
  });

  it('refuses a tool beyond the key, and reports an unknown one as a protocol error', async () => {
    const { rpc, tool } = await setup();
    const refused = await tool('build_rota', { siteId: 'mar', weekStart: WEEK }, 'reader');
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('rota:write');
    expect((await rpc('tools/call', { name: 'drop_everything' })).body.error.code).toBe(-32602);
    expect((await rpc('resources/list')).body.error.code).toBe(-32601);
  });

  it('reads and builds the rota through the API, and stays inside the organisation', async () => {
    const { tool } = await setup();
    const sites = await tool('list_sites');
    expect(sites.isError).toBe(false);
    expect(JSON.parse(sites.content[0].text).map((s: { id: string }) => s.id)).toContain('mar');
    expect(JSON.parse((await tool('list_sites', {}, 'other')).content[0].text)).toEqual([]);

    const built = await tool('build_rota', { siteId: 'mar', weekStart: WEEK });
    expect(built.isError).toBe(false);
    expect(built.structuredContent.added.length).toBeGreaterThan(0);

    const week = await tool('get_rota_week', { siteId: 'mar', weekStart: WEEK });
    expect(week.structuredContent.shifts.length).toBe(built.structuredContent.added.length);
    expect(Array.isArray(week.structuredContent.issues)).toBe(true);
  });

  it('passes a refusal back as the tool result, with the reason, so the model can put it right', async () => {
    const { tool } = await setup();
    const res = await tool('add_shift', { employeeId: 'mar-2', roleId: 'chef', siteId: 'mar', date: WEEK, startMinute: 600, endMinute: 1080, breakMinutes: 0 });
    expect(res.isError).toBe(false);
    const pub = await tool('publish_rota', { siteId: 'mar', weekStart: WEEK });
    expect(pub.isError).toBe(true);
    expect(pub.content[0].text).toContain('compliance_block');
  });

  it('answers a batch in order', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      payload: JSON.stringify([
        { jsonrpc: '2.0', id: 'a', method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
      ]),
    });
    const body = res.json();
    expect(body.map((m: { id: string }) => m.id)).toEqual(['a', 'b']);
  });
});
