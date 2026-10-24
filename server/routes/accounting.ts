import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { intercompanyBalances, rotaJournal } from '../../src/engine/journal';
import { journalDebits, journalFingerprint, ledgerProblems, manualJournal, reversal, type LedgerProblem } from '../../src/engine/ledger';
import { weekday } from '../../src/engine/time';
import { requireScope } from '../auth';
import { HttpError, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard } from '../guard';
import { AccountingError, type AccountingProvider, type JournalPosting, type LedgerSettings, type XeroTenant } from '../integrations/accounting/provider';
import { AccountingSimulator } from '../integrations/accounting/simulator';
import { XERO_SCOPES, XeroAuth, XeroProvider, type XeroAppConfig, type XeroTokens } from '../integrations/accounting/xero';
import { isSandbox } from '../sandbox';
import { isoDate } from '../schemas';
import { accountingOf, audit, type OrgData } from '../store';
import { labourBasis } from './payroll';

/** Xero's tokens for the organisation, kept with the other secrets and never returned. */
export const xeroTokensSetting = (orgId: string) => `xero_tokens:${orgId}`;
/** A sign-in to Xero under way: who started it, for which organisation, until when. */
const xeroStateSetting = (state: string) => `xero_state:${state}`;
const STATE_MINUTES = 15;

interface Options {
  /** Xero's app credentials, when this server has them. Without them only the simulator is offered. */
  xero?: XeroAppConfig;
  /** The simulated ledger is offered in the demo and in development, never against live books. */
  simulatorAllowed: boolean;
}

/** Xero's app credentials from the environment, or undefined when Xero is not set up on this server. */
export function xeroFromEnv(env: NodeJS.ProcessEnv): XeroAppConfig | undefined {
  if (!env.XERO_CLIENT_ID || !env.XERO_CLIENT_SECRET) return undefined;
  const appUrl = env.PRESHIFT_APP_URL?.replace(/\/+$/, '');
  const redirectUri = env.XERO_REDIRECT_URI ?? (appUrl ? `${appUrl}/v1/integrations/xero/callback` : undefined);
  if (!redirectUri) return undefined;
  return { clientId: env.XERO_CLIENT_ID, clientSecret: env.XERO_CLIENT_SECRET, redirectUri, scopes: env.XERO_SCOPES ?? XERO_SCOPES };
}

function accountingProblem(err: unknown): never {
  if (err instanceof AccountingError) throw new HttpError(err.retryable ? 502 : 422, 'ledger_error', err.message);
  throw err;
}

/**
 * Posting the labour accrual straight into each company's Xero, instead of downloading a file and
 * importing it by hand. Connecting Xero is a settings decision; posting is part of the close, for
 * whoever exports it. Every journal is checked against the company's own chart of accounts and
 * tracking first, posted once per week unless someone chooses to replace it, and reversed on the
 * first day of the next week so payroll's journal carries the real cost.
 */
export function accountingRoutes(app: FastifyInstance, ctx: AppContext, opts: Options) {
  const read = { preHandler: requireScope('rota:read') };
  const write = { preHandler: requireScope('rota:write') };
  const auth = opts.xero ? new XeroAuth(opts.xero, ctx.fetch, ctx.now) : null;
  const simulatorAllowed = (org: OrgData) => opts.simulatorAllowed || isSandbox(org.orgId);

  function settingsPerson(req: FastifyRequest) {
    if (!req.principal.email) throw new HttpError(403, 'forbidden', 'Xero is connected by a person signed in, not an API key.');
    const g = guard(ctx, req, orgOf(req));
    g.allow('settings.manage');
    return actorName(g);
  }

  /** Refreshes under way, by organisation: calls made together share one. */
  const refreshing = new Map<string, Promise<string>>();

  /**
   * A live access token, refreshed when it has run out. Xero rotates the refresh token on every use,
   * so the new one is saved at once, and two calls arriving together never both spend the old one.
   */
  async function accessToken(orgId: string): Promise<string> {
    const pending = refreshing.get(orgId);
    if (pending) return pending;
    const raw = await ctx.store.getSetting(xeroTokensSetting(orgId));
    if (!raw || !auth) throw new HttpError(409, 'not_connected', 'Xero is not connected. Connect it from Integrations.');
    const tokens = JSON.parse(raw) as XeroTokens;
    if (tokens.expiresAt - 60_000 > ctx.now().getTime()) return tokens.accessToken;
    if (refreshing.has(orgId)) return refreshing.get(orgId)!;
    const next = (async () => {
      const fresh = await auth.refresh(tokens.refreshToken).catch(accountingProblem);
      await ctx.store.setSetting(xeroTokensSetting(orgId), JSON.stringify(fresh));
      return fresh.accessToken;
    })().finally(() => refreshing.delete(orgId));
    refreshing.set(orgId, next);
    return next;
  }

  function providerFor(org: OrgData): AccountingProvider {
    const conn = org.accounting?.xero;
    if (!conn) throw new HttpError(409, 'not_connected', 'Xero is not connected. Connect it from Integrations.');
    if (conn.environment === 'simulator') {
      if (!simulatorAllowed(org)) throw new HttpError(409, 'simulator_off', 'The simulated ledger is only available in the demo. Connect Xero from Integrations.');
      return new AccountingSimulator(org.orgId, org.state);
    }
    return new XeroProvider({ accessToken: () => accessToken(org.orgId), fetch: ctx.fetch });
  }

  /** Each company posts to the Xero organisation of the same name, where there is exactly one. */
  function matchLedgers(org: OrgData, tenants: XeroTenant[]) {
    const acc = accountingOf(org);
    const taken = new Set(Object.values(acc.ledgers).map((l) => l.tenantId));
    for (const e of org.state.entities) {
      const current = acc.ledgers[e.id];
      if (current && tenants.some((t) => t.tenantId === current.tenantId)) continue;
      delete acc.ledgers[e.id];
      const same = tenants.filter((t) => t.name.trim().toLowerCase() === e.name.trim().toLowerCase() && !taken.has(t.tenantId));
      if (same.length === 1) {
        acc.ledgers[e.id] = { tenantId: same[0].tenantId, status: 'DRAFT', reverse: true };
        taken.add(same[0].tenantId);
      }
    }
  }

  function status(org: OrgData) {
    const acc = accountingOf(org);
    const tenants = acc.xero?.tenants ?? [];
    return {
      configured: !!auth,
      simulatorAllowed: simulatorAllowed(org),
      connection: acc.xero ? { environment: acc.xero.environment, connectedAt: acc.xero.connectedAt, connectedBy: acc.xero.connectedBy } : null,
      tenants: tenants.map(({ tenantId, name }) => ({ tenantId, name })),
      ledgers: org.state.entities.map((e) => {
        const l = acc.ledgers[e.id];
        return { entityId: e.id, name: e.name, ...(l ? { ...l, tenantName: tenants.find((t) => t.tenantId === l.tenantId)?.name ?? null } : { tenantId: null }) };
      }),
    };
  }

  // Connecting

  app.get('/v1/integrations/xero', { ...read, schema: { tags: ['Finance'], description: 'Whether Xero is connected, the organisations it reaches and which company posts to which.' } }, async (req) => {
    const org = orgOf(req);
    const g = guard(ctx, req, org);
    if (!g.can('close.export')) g.allow('settings.manage');
    return status(org);
  });

  app.post<{ Body: { environment?: 'production' | 'simulator' } }>(
    '/v1/integrations/xero/connect',
    { schema: { hide: true, body: { type: 'object', additionalProperties: false, properties: { environment: { type: 'string', enum: ['production', 'simulator'] } } } } },
    async (req) => {
      const by = settingsPerson(req);
      const org = orgOf(req);
      const acc = accountingOf(org);
      if (req.body?.environment === 'simulator') {
        if (!simulatorAllowed(org)) throw new HttpError(400, 'simulator_off', 'The simulated ledger is only available in the demo.');
        acc.xero = { environment: 'simulator', connectedAt: ctx.now().toISOString(), connectedBy: by, tenants: AccountingSimulator.tenants(org.state) };
        matchLedgers(org, acc.xero.tenants);
        audit(org, by, 'xero.connected', { environment: 'simulator', tenants: acc.xero.tenants.length });
        return status(org);
      }
      // A demo visitor's books are fictional and must never reach a real ledger.
      if (isSandbox(org.orgId)) throw new HttpError(403, 'demo', 'The demo connects to the simulated ledger only.');
      if (!auth) throw new HttpError(409, 'xero_not_configured', 'Xero is not set up on this server. Its app credentials are added by whoever runs Preshift.');
      const state = randomBytes(24).toString('base64url');
      const expires = ctx.now().getTime() + STATE_MINUTES * 60_000;
      await ctx.store.setSetting(xeroStateSetting(state), JSON.stringify({ orgId: org.orgId, email: req.principal.email, expires }));
      return { authorizeUrl: auth.authorizeUrl(state) };
    },
  );

  // Xero sends the person back here, signed in to Preshift in the same browser that left.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/v1/integrations/xero/callback',
    { schema: { hide: true, querystring: { type: 'object', properties: { code: { type: 'string' }, state: { type: 'string' }, error: { type: 'string' } } } } },
    async (req, reply) => {
      const by = settingsPerson(req);
      const org = orgOf(req);
      const back = (outcome: string) => reply.redirect(`/app/?view=close&xero=${outcome}`);
      const { code, state, error } = req.query;
      if (!state) return back('error');
      const raw = await ctx.store.getSetting(xeroStateSetting(state));
      await ctx.store.setSetting(xeroStateSetting(state), null);
      const started = raw ? (JSON.parse(raw) as { orgId: string; email: string; expires: number }) : null;
      // Only the person who started it, in the organisation they started it from, and not after it has run out.
      if (!started || started.orgId !== org.orgId || started.email !== req.principal.email || started.expires < ctx.now().getTime()) return back('expired');
      if (error || !code || !auth) return back('cancelled');
      try {
        const tokens = await auth.exchange(code);
        const tenants = await auth.tenants(tokens.accessToken);
        await ctx.store.setSetting(xeroTokensSetting(org.orgId), JSON.stringify(tokens));
        const acc = accountingOf(org);
        acc.xero = { environment: 'production', connectedAt: ctx.now().toISOString(), connectedBy: by, tenants };
        matchLedgers(org, tenants);
        audit(org, by, 'xero.connected', { environment: 'production', tenants: tenants.length });
        req.orgChanged = true;
        return back('connected');
      } catch (err) {
        if (err instanceof AccountingError) return back('error');
        throw err;
      }
    },
  );

  app.delete('/v1/integrations/xero', { schema: { hide: true } }, async (req) => {
    const by = settingsPerson(req);
    const org = orgOf(req);
    const acc = accountingOf(org);
    if (acc.xero?.environment === 'production' && auth) {
      // Best effort: take the app out of each organisation's connected apps. The tokens go either way.
      const token = await accessToken(org.orgId).catch(() => null);
      if (token) for (const t of acc.xero.tenants) if (t.connectionId) await auth.disconnect(token, t.connectionId).catch(() => undefined);
    }
    await ctx.store.setSetting(xeroTokensSetting(org.orgId), null);
    delete acc.xero;
    acc.ledgers = {};
    audit(org, by, 'xero.disconnected');
    // What was posted stays on record: the journals are still in Xero.
    return status(org);
  });

  app.put<{ Params: { id: string }; Body: Partial<LedgerSettings> & { tenantId: string | null } }>(
    '/v1/integrations/xero/ledgers/:id',
    {
      schema: {
        hide: true,
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['tenantId'],
          properties: { tenantId: { type: ['string', 'null'] }, status: { type: 'string', enum: ['DRAFT', 'POSTED'] }, reverse: { type: 'boolean' } },
        },
      },
    },
    async (req) => {
      const by = settingsPerson(req);
      const org = orgOf(req);
      const acc = accountingOf(org);
      const entity = org.state.entities.find((e) => e.id === req.params.id);
      if (!entity) throw notFound(`Company ${req.params.id}`);
      if (!acc.xero) throw new HttpError(409, 'not_connected', 'Connect Xero first.');
      const { tenantId } = req.body;
      if (tenantId === null) {
        delete acc.ledgers[entity.id];
      } else {
        if (!acc.xero.tenants.some((t) => t.tenantId === tenantId)) throw new HttpError(422, 'unknown_tenant', 'That Xero organisation is not one this connection reaches.');
        // One set of books per company: two companies posting into one ledger would merge their accounts.
        const other = Object.entries(acc.ledgers).find(([id, l]) => id !== entity.id && l.tenantId === tenantId);
        if (other) throw new HttpError(409, 'tenant_taken', `${org.state.entities.find((e) => e.id === other[0])?.name ?? 'Another company'} already posts to that Xero organisation. Each company needs its own.`);
        const before = acc.ledgers[entity.id];
        acc.ledgers[entity.id] = { tenantId, status: req.body.status ?? before?.status ?? 'DRAFT', reverse: req.body.reverse ?? before?.reverse ?? true };
      }
      audit(org, by, 'xero.ledger_set', { entityId: entity.id, tenantId, status: acc.ledgers[entity.id]?.status, reverse: acc.ledgers[entity.id]?.reverse });
      return status(org);
    },
  );

  // Posting

  interface WeekQuery {
    weekStart: string;
    entityId: string;
    basis?: 'rota' | 'actual' | 'auto';
  }

  const weekQuery = {
    type: 'object',
    required: ['weekStart', 'entityId'],
    properties: { weekStart: isoDate, entityId: { type: 'string' }, basis: { type: 'string', enum: ['rota', 'actual', 'auto'], default: 'auto' } },
  } as const;

  /** The week's journal for one company, checked against its ledger. */
  async function prepare(org: OrgData, q: WeekQuery) {
    const entity = org.state.entities.find((e) => e.id === q.entityId);
    if (!entity) throw notFound(`Company ${q.entityId}`);
    if (weekday(q.weekStart) !== 0) throw new HttpError(400, 'not_a_monday', 'A week starts on a Monday.');
    const { basis, state } = labourBasis(org, q.weekStart, q.basis ?? 'auto');
    const all = rotaJournal(state, q.weekStart);
    const lines = all.filter((l) => l.entityId === entity.id);
    const acc = accountingOf(org);
    const ledger = acc.ledgers[entity.id] ?? null;
    const problems: LedgerProblem[] = [];
    if (!acc.xero) problems.push({ severity: 'block', message: 'Xero is not connected. Connect it from Integrations.' });
    else if (!ledger) problems.push({ severity: 'block', message: `Choose which Xero organisation ${entity.name} posts to, under Integrations.` });
    for (const b of intercompanyBalances(state, all)) {
      if ((b.entityId === entity.id || b.counterpartyId === entity.id) && Math.abs(b.inOwnBooks - b.inCounterpartyBooks) >= 0.005) {
        problems.push({ severity: 'block', message: 'The intercompany recharge does not agree on both sides. Check it on the Close screen before posting.' });
      }
    }
    let provider: AccountingProvider | null = null;
    if (ledger && acc.xero) {
      provider = providerFor(org);
      const [accounts, tracking] = await Promise.all([provider.accounts(ledger.tenantId), provider.tracking(ledger.tenantId)]).catch(accountingProblem);
      problems.push(...ledgerProblems(lines, accounts, tracking));
    } else if (lines.length === 0) {
      problems.push({ severity: 'block', message: 'There is no labour in this week for this company, so there is nothing to post.' });
    }
    const active = acc.postings.find((p) => p.entityId === entity.id && p.weekStart === q.weekStart && !p.removedAt) ?? null;
    const fingerprint = journalFingerprint(lines);
    return { entity, basis, lines, ledger, provider, problems, active, fingerprint, changed: !!active && active.fingerprint !== fingerprint };
  }

  const tenantName = (org: OrgData, tenantId: string) => org.accounting?.xero?.tenants.find((t) => t.tenantId === tenantId)?.name ?? tenantId;

  app.get<{ Querystring: WeekQuery }>(
    '/v1/journal/xero/check',
    { ...read, schema: { tags: ['Finance'], description: "One company's labour accrual for the week, checked against its Xero chart of accounts and tracking, with what has been posted already.", querystring: weekQuery } },
    async (req) => {
      const org = orgOf(req);
      guard(ctx, req, org).allow('close.export');
      const p = await prepare(org, req.query);
      return {
        entityId: p.entity.id,
        weekStart: req.query.weekStart,
        basis: p.basis,
        ledger: p.ledger ? { ...p.ledger, tenantName: tenantName(org, p.ledger.tenantId) } : null,
        debits: journalDebits(p.lines),
        lineCount: p.lines.length,
        problems: p.problems,
        posting: p.active,
        changed: p.changed,
      };
    },
  );

  async function takeOut(provider: AccountingProvider, posting: JournalPosting) {
    await provider.removeJournal(posting.tenantId, posting.journalId, posting.status).catch(accountingProblem);
    if (posting.reversalId) await provider.removeJournal(posting.tenantId, posting.reversalId, posting.status).catch(accountingProblem);
  }

  app.post<{ Body: WeekQuery & { replace?: boolean } }>(
    '/v1/journal/xero',
    {
      ...write,
      schema: {
        tags: ['Finance'],
        description:
          "Posts one company's labour accrual for the week to its Xero organisation, as a draft or posted journal by the company's setting, with its reversal " +
          'on the Monday after. Refused when the journal does not check out, or when the week is already posted; pass replace to void the earlier one and post this.',
        body: { ...weekQuery, additionalProperties: false, properties: { ...weekQuery.properties, replace: { type: 'boolean' } } },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      g.allow('close.export');
      const by = actorName(g);
      const p = await prepare(org, req.body);
      const blocks = p.problems.filter((x) => x.severity === 'block');
      if (blocks.length) throw new HttpError(422, 'journal_problems', 'The journal cannot be posted as it stands', blocks.map((b) => b.message));
      const ledger = p.ledger!;
      const provider = p.provider!;
      if (p.active && !p.changed) {
        throw new HttpError(409, 'already_posted', `Already posted to Xero on ${p.active.postedAt.slice(0, 10)} by ${p.active.postedBy}, and nothing has changed since.`);
      }
      if (p.active && !req.body.replace) {
        throw new HttpError(409, 'posted_before', `Posted to Xero on ${p.active.postedAt.slice(0, 10)} by ${p.active.postedBy}, and the journal has changed since. Post again with replace to void that one and post this.`);
      }

      const acc = accountingOf(org);
      // The id is the same on a retry of the same journal, so Xero's idempotency key stops a second copy.
      const n = acc.postings.filter((x) => x.entityId === p.entity.id && x.weekStart === req.body.weekStart).length;
      const id = `jp_${p.entity.id}_${req.body.weekStart}_${n}_${p.fingerprint}`;
      if (p.active) {
        await takeOut(provider, p.active);
        Object.assign(p.active, { removedAt: ctx.now().toISOString(), removedBy: by, replacedBy: id });
      }
      const journal = manualJournal(p.lines);
      const { journalId } = await provider.postJournal(ledger.tenantId, journal, ledger.status, `${id}:accrual`).catch(accountingProblem);
      let reversalId: string | undefined;
      const back = ledger.reverse ? reversal(journal) : null;
      if (back) {
        try {
          ({ journalId: reversalId } = await provider.postJournal(ledger.tenantId, back, ledger.status, `${id}:reversal`));
        } catch (err) {
          // Never leave an accrual in the books without the reversal that clears it.
          await provider.removeJournal(ledger.tenantId, journalId, ledger.status).catch(() => undefined);
          accountingProblem(err);
        }
      }
      const posting: JournalPosting = {
        id,
        entityId: p.entity.id,
        tenantId: ledger.tenantId,
        tenantName: tenantName(org, ledger.tenantId),
        weekStart: req.body.weekStart,
        date: journal.date,
        basis: p.basis,
        status: ledger.status,
        journalId,
        ...(reversalId && back ? { reversalId, reversalDate: back.date } : {}),
        debits: journalDebits(p.lines),
        lineCount: p.lines.length,
        fingerprint: p.fingerprint,
        postedAt: ctx.now().toISOString(),
        postedBy: by,
      };
      acc.postings.push(posting);
      audit(org, by, 'journal.posted', { entityId: p.entity.id, weekStart: req.body.weekStart, journalId, debits: posting.debits, status: posting.status, replaced: !!p.active });
      return posting;
    },
  );

  app.get<{ Querystring: { entityId?: string } }>(
    '/v1/journal/xero/postings',
    { ...read, schema: { tags: ['Finance'], description: 'Labour accrual journals posted to Xero, newest first, with any that were voided or replaced.', querystring: { type: 'object', properties: { entityId: { type: 'string' } } } } },
    async (req) => {
      const org = orgOf(req);
      guard(ctx, req, org).allow('close.export');
      const postings = (org.accounting?.postings ?? []).filter((p) => !req.query.entityId || p.entityId === req.query.entityId);
      // Newest first; two posted in the same moment keep the later one first.
      return { postings: [...postings].reverse().sort((a, b) => b.postedAt.localeCompare(a.postedAt)).slice(0, 100) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/journal/xero/postings/:id/remove',
    { ...write, schema: { tags: ['Finance'], description: 'Takes a posted journal and its reversal back out of Xero: voided if posted, deleted if still a draft.', params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      g.allow('close.export');
      const posting = org.accounting?.postings.find((p) => p.id === req.params.id);
      if (!posting) throw notFound('Posting');
      if (posting.removedAt) throw new HttpError(409, 'already_removed', `Already taken out on ${posting.removedAt.slice(0, 10)} by ${posting.removedBy}.`);
      await takeOut(providerFor(org), posting);
      Object.assign(posting, { removedAt: ctx.now().toISOString(), removedBy: actorName(g) });
      audit(org, actorName(g), 'journal.removed', { entityId: posting.entityId, weekStart: posting.weekStart, journalId: posting.journalId });
      return posting;
    },
  );
}
