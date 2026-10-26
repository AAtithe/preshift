// The Preshift MCP connector: lets Claude, or any Model Context Protocol client, read and run
// the rota through the same public API a partner uses. Served at POST /mcp as stateless
// Streamable HTTP (JSON responses, no event stream), so it runs unchanged on Vercel.
//
// Every tool is a call to an existing /v1 route made with the caller's own credentials, so the
// key's scopes, the person's site access, the compliance checks, the audit trail and webhooks
// all apply exactly as they do for the web app. The connector adds no authority of its own.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { featureOn } from '../src/engine/features';
import { hasScope, type Scope } from './auth';
import { ORG_HEADER, resourceMetadataUrl } from './oauth';
import { isoDate, minute } from './schemas';
import type { Store } from './store';

/** Newest first. A client asking for one of these gets it; anything else gets the newest. */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const SERVER_INFO = { name: 'preshift', title: 'Preshift Rota', version: '1.0.0' };

const INSTRUCTIONS =
  'Preshift is the rota, time and payroll system for UK hospitality run with Williams, Stanley & Co. ' +
  'One connection can reach several organisations (a person at Williams, Stanley & Co. works across many clients): ' +
  'call list_organisations first, and pass organisation on every other tool whenever it lists more than one. ' +
  'Then use list_sites and list_roles to learn the ids. Weeks start on Monday: pass weekStart as that Monday (YYYY-MM-DD). ' +
  'Money is in pounds, sales are net of VAT, and minutes count from midnight (600 is 10:00). ' +
  'get_rota_week gives cost against forecast and every compliance issue; publish_rota refuses a week with a blocking issue, so fix those first. ' +
  'Only approved time reaches payroll, and nobody approves their own hours.';

interface Tool {
  name: string;
  title: string;
  description: string;
  /** The key must hold this scope (or one that implies it) for the tool to be listed or run. */
  scope: Scope;
  readOnly: boolean;
  /** Removes or overwrites work that cannot be got back. */
  destructive?: boolean;
  /** Writes a whole rota, so it is refused where the organisation has switched off AI rota writing. */
  writesRota?: boolean;
  inputSchema: Record<string, unknown>;
  /** The API call this tool makes. */
  request: (args: Record<string, unknown>) => { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; body?: unknown };
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const siteId = { type: 'string', description: 'Site id, from list_sites' };
const weekStart = { ...isoDate, description: 'The Monday the week starts, YYYY-MM-DD' };
const from = { ...isoDate, description: 'First day, YYYY-MM-DD' };
const to = { ...isoDate, description: 'Last day, YYYY-MM-DD' };

/** A query string from the arguments given, leaving out any not set. */
function query(path: string, args: Record<string, unknown>, names: string[]) {
  const q = new URLSearchParams();
  for (const n of names) if (args[n] !== undefined && args[n] !== null && args[n] !== '') q.set(n, String(args[n]));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** One site or several, as the build and publish routes take them. */
const sitesWeek = (args: Record<string, unknown>) => ({
  weekStart: args.weekStart,
  ...(Array.isArray(args.siteIds) && args.siteIds.length ? { siteIds: args.siteIds } : { siteId: args.siteId }),
});
const sitesWeekInput = obj(
  { siteId, siteIds: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Several sites at once, all or nothing. Use instead of siteId.' }, weekStart },
  ['weekStart'],
);

export const MCP_TOOLS: Tool[] = [
  {
    name: 'list_sites',
    title: 'Sites',
    description: 'Every site you can see: id, name, company, labour target %, opening hours and tracking code.',
    scope: 'rota:read',
    readOnly: true,
    inputSchema: obj({}),
    request: () => ({ method: 'GET', url: '/v1/sites' }),
  },
  {
    name: 'list_roles',
    title: 'Roles',
    description: 'Job roles (chef, bartender, floor and so on) with their nominal codes. Shifts name a role by id.',
    scope: 'rota:read',
    readOnly: true,
    inputSchema: obj({}),
    request: () => ({ method: 'GET', url: '/v1/roles' }),
  },
  {
    name: 'list_employees',
    title: 'Staff',
    description: 'Staff you can see, with home site, roles, pay basis and rate, contracted hours and availability. Personal data: use only for the task in hand.',
    scope: 'employees:read',
    readOnly: true,
    inputSchema: obj({}),
    request: () => ({ method: 'GET', url: '/v1/employees' }),
  },
  {
    name: 'get_rota_week',
    title: 'Rota week',
    description:
      "One site's week: every shift, labour cost against forecast sales and the labour target (when you may see costs), " +
      'and every compliance issue (rest, breaks, young workers, 48 hours, availability). Issues with severity "block" stop publication.',
    scope: 'rota:read',
    readOnly: true,
    inputSchema: obj({ siteId, weekStart }, ['siteId', 'weekStart']),
    request: (a) => ({ method: 'GET', url: query('/v1/rota/week', a, ['siteId', 'weekStart']) }),
  },
  {
    name: 'list_shifts',
    title: 'Shifts',
    description: 'Shifts in a date range, optionally for one site.',
    scope: 'rota:read',
    readOnly: true,
    inputSchema: obj({ siteId, from, to }),
    request: (a) => ({ method: 'GET', url: query('/v1/shifts', a, ['siteId', 'from', 'to']) }),
  },
  {
    name: 'get_forecast',
    title: 'Forecast',
    description: 'Forecast sales (net of VAT) and covers by site, day and hour.',
    scope: 'rota:read',
    readOnly: true,
    inputSchema: obj({ siteId, from, to }),
    request: (a) => ({ method: 'GET', url: query('/v1/forecast', a, ['siteId', 'from', 'to']) }),
  },
  {
    name: 'get_sales',
    title: 'Actual takings',
    description: 'Actual takings by site and day, net of VAT, from the till or entered by hand.',
    scope: 'rota:read',
    readOnly: true,
    inputSchema: obj({ siteId, from, to }),
    request: (a) => ({ method: 'GET', url: query('/v1/sales', a, ['siteId', 'from', 'to']) }),
  },
  {
    name: 'list_time_entries',
    title: 'Clocked time',
    description: 'Clocked and entered time in a date range, with status (open, submitted, approved, sent to payroll).',
    scope: 'rota:read',
    readOnly: true,
    inputSchema: obj({ siteId, from, to }),
    request: (a) => ({ method: 'GET', url: query('/v1/time-entries', a, ['siteId', 'from', 'to']) }),
  },
  {
    name: 'compare_rota_to_clocked',
    title: 'Rostered against clocked',
    description: 'Rostered hours against clocked hours per person for a site and week: where the week drifted from plan.',
    scope: 'rota:read',
    readOnly: true,
    inputSchema: obj({ siteId, weekStart }, ['siteId', 'weekStart']),
    request: (a) => ({ method: 'GET', url: query('/v1/time-entries/compare', a, ['siteId', 'weekStart']) }),
  },
  {
    name: 'get_labour_journal',
    title: 'Labour accrual journal',
    description:
      'The ready-to-post labour accrual for a week: by role nominal and site, one journal per company, with employer NI, pension, ' +
      'holiday accrual, intercompany recharges and Employment Allowance. Basis "auto" uses approved actuals once there are any, otherwise the rota.',
    scope: 'rota:read',
    readOnly: true,
    inputSchema: obj({ weekStart, basis: { type: 'string', enum: ['rota', 'actual', 'auto'], default: 'auto' }, entityId: { type: 'string', description: 'One company only' } }, ['weekStart']),
    request: (a) => ({ method: 'GET', url: query('/v1/journal', { ...a, format: 'json' }, ['weekStart', 'basis', 'entityId', 'format']) }),
  },
  {
    name: 'list_payroll_runs',
    title: 'Payroll runs',
    description: 'Completed payroll runs from TeamPay with the variance between rota cost and what was paid.',
    scope: 'employees:read',
    readOnly: true,
    inputSchema: obj({}),
    request: () => ({ method: 'GET', url: '/v1/payroll/runs' }),
  },
  {
    name: 'build_rota',
    title: 'Build rota from forecast',
    description:
      "Builds a week for one site or several from the forecast: each site's own team first, then agreed cover. " +
      'Adds shifts to unpublished gaps and reports any hours it could not fill. Review with get_rota_week before publishing.',
    scope: 'rota:write',
    readOnly: false,
    writesRota: true,
    inputSchema: sitesWeekInput,
    request: (a) => ({ method: 'POST', url: '/v1/rota/build', body: sitesWeek(a) }),
  },
  {
    name: 'add_shift',
    title: 'Add a shift',
    description: 'Adds one shift and returns any compliance issues it raises. Minutes count from midnight; a shift may run past midnight up to 2880.',
    scope: 'rota:write',
    readOnly: false,
    inputSchema: obj(
      {
        employeeId: { type: 'string' },
        roleId: { type: 'string' },
        siteId,
        date: { ...isoDate, description: 'The day the shift starts' },
        startMinute: { ...minute, description: 'Start, minutes from midnight' },
        endMinute: { ...minute, description: 'End, minutes from midnight' },
        breakMinutes: { type: 'integer', minimum: 0, default: 0 },
      },
      ['employeeId', 'roleId', 'siteId', 'date', 'startMinute', 'endMinute'],
    ),
    request: (a) => ({ method: 'POST', url: '/v1/shifts', body: a }),
  },
  {
    name: 'remove_shift',
    title: 'Remove a shift',
    description: 'Removes a shift. A shift that has started or been clocked against cannot be removed.',
    scope: 'rota:write',
    readOnly: false,
    destructive: true,
    inputSchema: obj({ id: { type: 'string', description: 'Shift id' } }, ['id']),
    request: (a) => ({ method: 'DELETE', url: `/v1/shifts/${encodeURIComponent(String(a.id ?? ''))}` }),
  },
  {
    name: 'publish_rota',
    title: 'Publish rota',
    description: 'Publishes the week so staff see their shifts. Refused, all or nothing, if any site in it has a blocking compliance issue.',
    scope: 'rota:write',
    readOnly: false,
    inputSchema: sitesWeekInput,
    request: (a) => ({ method: 'POST', url: '/v1/rota/publish', body: sitesWeek(a) }),
  },
  {
    name: 'approve_time',
    title: 'Approve clocked time',
    description:
      'Approves submitted time so it can go to payroll: by ids, or everything submitted for a site and date range. ' +
      "Nobody approves their own hours: by range they are skipped and counted, by id they are refused.",
    scope: 'time:approve',
    readOnly: false,
    inputSchema: obj({ ids: { type: 'array', items: { type: 'string' } }, siteId, from, to }),
    request: (a) => ({ method: 'POST', url: '/v1/time-entries/approve', body: a }),
  },
];

const JSONRPC = '2.0';
type Id = string | number | null;
interface RpcMessage {
  jsonrpc?: string;
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
}

const rpcError = (id: Id, code: number, message: string) => ({ jsonrpc: JSONRPC, id, error: { code, message } });
const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: JSONRPC, id, result });

const allowed = (req: FastifyRequest, tool: Tool) => hasScope(req, tool.scope);

/** Every organisation this caller reaches: a connection's list, or a key's one organisation. */
const reachOf = (req: FastifyRequest) => req.principal.orgs ?? [req.principal.orgId];

const organisationArg = { type: 'string', description: 'Organisation id, from list_organisations. Needed when the connection reaches more than one.' };

/** Lists what the connection reaches. Answered here: each organisation's own routes cannot see the others. */
const LIST_ORGANISATIONS = {
  name: 'list_organisations',
  title: 'Organisations',
  description: 'The organisations (client businesses) this connection reaches, with their ids and companies. Pass one as organisation to every other tool.',
  inputSchema: obj({}),
  annotations: { title: 'Organisations', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

async function listOrganisations(store: Store, req: FastifyRequest) {
  const out = [];
  for (const id of reachOf(req)) {
    if (!(await store.has(id))) continue;
    const org = await store.load(id);
    out.push({ id, name: org.state.entities.map((e) => e.name).join(', ') || id, companies: org.state.entities.map((e) => e.name), sites: org.state.sites.length });
  }
  return { organisations: out };
}

function describe(tool: Tool) {
  const schema = tool.inputSchema as { properties: Record<string, unknown> };
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: { ...schema, properties: { ...schema.properties, organisation: organisationArg } },
    annotations: { title: tool.title, readOnlyHint: tool.readOnly, destructiveHint: !!tool.destructive, idempotentHint: tool.readOnly, openWorldHint: false },
  };
}

/** The caller's own credentials, passed to the API on every tool call so it decides exactly as it would for them. */
function credentials(req: FastifyRequest) {
  const h: Record<string, string> = {};
  if (req.headers.authorization) h.authorization = req.headers.authorization;
  if (req.headers.cookie) h.cookie = req.headers.cookie;
  return h;
}

const toolError = (text: string) => ({ result: { isError: true, content: [{ type: 'text', text }] } });

async function callTool(app: FastifyInstance, store: Store, req: FastifyRequest, params: Record<string, unknown> | undefined) {
  const name = String(params?.name ?? '');
  if (name === LIST_ORGANISATIONS.name) {
    const data = await listOrganisations(store, req);
    return { result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: false } };
  }
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) return { unknown: true as const };
  if (!allowed(req, tool)) return toolError(`This key lacks the ${tool.scope} scope, so it cannot use ${tool.name}.`);
  const { organisation, ...args } = (params?.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
  // Which organisation the call acts in: named, or the only one there is. Never guessed among several.
  const reach = reachOf(req);
  const orgId = typeof organisation === 'string' && organisation ? organisation : reach.length === 1 ? reach[0] : undefined;
  if (!orgId) return toolError(`This connection reaches ${reach.length} organisations. Call list_organisations and pass one as organisation.`);
  if (!reach.includes(orgId)) return toolError(`This connection does not reach organisation ${orgId}. Call list_organisations for the ones it does.`);
  if (tool.writesRota && (await store.has(orgId)) && !featureOn((await store.load(orgId)).settings.featuresOff, 'rotaai')) {
    return toolError('AI rota writing is switched off for this organisation, so Claude cannot build its rota. Single shifts can still be added and removed.');
  }
  const call = tool.request(args);
  const res = await app.inject({
    method: call.method,
    url: call.url,
    headers: {
      ...credentials(req),
      // A connection names the organisation on each call; a key only ever has its own.
      ...(req.principal.orgs ? { [ORG_HEADER]: orgId } : {}),
      ...(call.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: call.body !== undefined ? JSON.stringify(call.body) : undefined,
  });
  let data: unknown = res.body || null;
  try {
    data = res.body ? JSON.parse(res.body) : { ok: true };
  } catch {
    // Not JSON: hand back the text as it came.
  }
  // A refusal is the tool's answer, not a protocol failure: the model reads why and can put it right.
  const isError = res.statusCode >= 400;
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return {
    result: {
      content: [{ type: 'text', text: isError ? `Preshift refused (${res.statusCode}): ${text}` : text }],
      ...(data && typeof data === 'object' && !Array.isArray(data) && !isError ? { structuredContent: data } : {}),
      isError,
    },
  };
}

async function handle(app: FastifyInstance, store: Store, req: FastifyRequest, msg: RpcMessage): Promise<unknown | undefined> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;
  if (msg.jsonrpc !== JSONRPC || typeof msg.method !== 'string') {
    return isNotification ? undefined : rpcError(id, -32600, 'Invalid request');
  }
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '');
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      // Only what this key may run: a read-only key never sees the tools that change the rota.
      return rpcResult(id, { tools: [LIST_ORGANISATIONS, ...MCP_TOOLS.filter((t) => allowed(req, t)).map(describe)] });
    case 'tools/call': {
      const out = await callTool(app, store, req, msg.params);
      if ('unknown' in out) return rpcError(id, -32602, `Unknown tool: ${String(msg.params?.name ?? '')}`);
      return rpcResult(id, out.result);
    }
    default:
      if (isNotification) return undefined;
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

/**
 * A browser page on another site must not be able to drive the connector with a signed-in
 * person's cookie (DNS rebinding and the like), so a request carrying an Origin must come from here.
 */
function sameOrigin(req: FastifyRequest) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function mcpRoutes(app: FastifyInstance, store: Store, auth: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
  const hidden = { schema: { hide: true } };
  const guardOrigin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!sameOrigin(req)) return reply.code(403).send({ error: 'forbidden', message: 'Cross-origin requests to the connector are refused' });
  };

  // A 401 names the discovery document, so claude.ai can find Sign in with Preshift on its own.
  const challenge = async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    if (reply.statusCode === 401) reply.header('www-authenticate', `Bearer resource_metadata="${resourceMetadataUrl(req)}"`);
    return payload;
  };

  app.post('/mcp', { ...hidden, onRequest: [guardOrigin, auth], onSend: challenge }, async (req, reply) => {
    const body = req.body as RpcMessage | RpcMessage[] | undefined;
    if (!body || typeof body !== 'object') return reply.code(400).send(rpcError(null, -32700, 'Parse error'));
    const batch = Array.isArray(body);
    const messages = batch ? body : [body];
    if (messages.length === 0) return reply.code(400).send(rpcError(null, -32600, 'Invalid request'));
    const answers = [];
    for (const m of messages) {
      const a = await handle(app, store, req, m ?? {});
      if (a !== undefined) answers.push(a);
    }
    // Notifications and responses only: accepted, nothing to say.
    if (answers.length === 0) return reply.code(202).send();
    return reply.header('content-type', 'application/json').send(batch ? answers : answers[0]);
  });

  // Stateless: no server-sent event stream and no session to end.
  const notHere = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header('allow', 'POST').send({ error: 'method_not_allowed', message: 'The Preshift connector answers POST only' });
  app.get('/mcp', hidden, notHere);
  app.delete('/mcp', hidden, notHere);
}
