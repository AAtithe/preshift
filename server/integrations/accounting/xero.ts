import type { LedgerAccount, LedgerTracking, ManualJournal } from '../../../src/engine/ledger';
import { AccountingError, type AccountingProvider, type JournalStatus, type XeroTenant } from './provider';

type Fetch = typeof fetch;

const IDENTITY = 'https://identity.xero.com/connect/token';
const AUTHORIZE = 'https://login.xero.com/identity/connect/authorize';
const API = 'https://api.xero.com';

/**
 * What Preshift asks Xero for: to sign the person in, to stay connected without asking again
 * (offline_access), to post manual journals, and to read the chart of accounts and tracking it checks
 * them against. Apps created under Xero's granular scopes set XERO_SCOPES to the equivalents.
 */
export const XERO_SCOPES = 'openid profile email offline_access accounting.transactions accounting.settings.read';

export interface XeroAppConfig {
  clientId: string;
  clientSecret: string;
  /** Where Xero sends the person back: this server's /v1/integrations/xero/callback. */
  redirectUri: string;
  scopes: string;
}

export interface XeroTokens {
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since the epoch. Xero's access tokens last 30 minutes. */
  expiresAt: number;
}

/** The app's side of Xero's OAuth 2.0 sign-in: the consent screen, tokens, and which organisations were allowed. */
export class XeroAuth {
  constructor(
    private readonly config: XeroAppConfig,
    private readonly fetch: Fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  authorizeUrl(state: string): string {
    const q = new URLSearchParams({ response_type: 'code', client_id: this.config.clientId, redirect_uri: this.config.redirectUri, scope: this.config.scopes, state });
    return `${AUTHORIZE}?${q}`;
  }

  exchange(code: string): Promise<XeroTokens> {
    return this.token({ grant_type: 'authorization_code', code, redirect_uri: this.config.redirectUri });
  }

  /** Xero rotates the refresh token on every use: the new one must be saved before the old is lost. */
  refresh(refreshToken: string): Promise<XeroTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  private async token(form: Record<string, string>): Promise<XeroTokens> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    let res: Response;
    try {
      res = await this.fetch(IDENTITY, {
        method: 'POST',
        headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new AccountingError(`Could not reach Xero: ${(err as Error).message}`, true);
    }
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new AccountingError(retryable ? `Xero sign-in answered ${res.status}. Try again shortly.` : 'Xero refused the connection. Connect Xero again from Integrations.', retryable, res.status);
    }
    const body = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
    return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: this.now().getTime() + body.expires_in * 1000 };
  }

  /** The Xero organisations this connection reaches. */
  async tenants(accessToken: string): Promise<XeroTenant[]> {
    const res = await call(this.fetch, 'GET', `${API}/connections`, accessToken);
    const list = (await res.json()) as { id: string; tenantId: string; tenantType: string; tenantName: string }[];
    return list.filter((c) => c.tenantType === 'ORGANISATION').map((c) => ({ tenantId: c.tenantId, name: c.tenantName, connectionId: c.id }));
  }

  /** Removes the link to one organisation, so the app no longer appears in its connected apps. */
  async disconnect(accessToken: string, connectionId: string): Promise<void> {
    await call(this.fetch, 'DELETE', `${API}/connections/${encodeURIComponent(connectionId)}`, accessToken);
  }
}

async function call(fetchFn: Fetch, method: string, url: string, accessToken: string, opts: { tenantId?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        ...(opts.tenantId ? { 'xero-tenant-id': opts.tenantId } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new AccountingError(`Could not reach Xero: ${(err as Error).message}`, true);
  }
  if (res.ok) return res;
  if (res.status === 401) throw new AccountingError('Xero no longer accepts this connection. Connect Xero again from Integrations.', false, 401);
  if (res.status === 403) throw new AccountingError('Xero refused: the connection does not reach this organisation, or lacks permission to post journals.', false, 403);
  if (res.status === 429) throw new AccountingError('Xero is limiting requests. Try again in a minute.', true, 429);
  const text = await res.text().catch(() => '');
  if (res.status === 400) throw new AccountingError(`Xero refused the journal: ${validationMessages(text) || text.slice(0, 200)}`, false, 400);
  throw new AccountingError(`Xero answered ${res.status}. Try again shortly.`, res.status >= 500, res.status);
}

/** The reasons in a Xero validation error, joined. Xero nests them under each element sent. */
function validationMessages(text: string): string {
  try {
    const body = JSON.parse(text) as { Message?: string; Elements?: { ValidationErrors?: { Message: string }[] }[] };
    const messages = (body.Elements ?? []).flatMap((e) => (e.ValidationErrors ?? []).map((v) => v.Message));
    return [...new Set(messages)].join(' ') || body.Message || '';
  } catch {
    return '';
  }
}

/**
 * Xero's accounting API, as one connection. Manual journals are sent without tax (they move cost
 * between accounts, they are not supplies), each line tagged with the site's tracking option.
 *
 *   GET  /api.xro/2.0/Accounts              chart of accounts
 *   GET  /api.xro/2.0/TrackingCategories    tracking and its options
 *   POST /api.xro/2.0/ManualJournals        post, with Idempotency-Key; void or delete by ManualJournalID
 */
export class XeroProvider implements AccountingProvider {
  readonly name = 'Xero';

  constructor(private readonly opts: { accessToken: () => Promise<string>; fetch: Fetch }) {}

  private async api(method: 'GET' | 'POST', path: string, tenantId: string, body?: unknown, idempotencyKey?: string) {
    const res = await call(this.opts.fetch, method, `${API}/api.xro/2.0${path}`, await this.opts.accessToken(), { tenantId, body, idempotencyKey });
    return res.json();
  }

  async accounts(tenantId: string): Promise<LedgerAccount[]> {
    const body = (await this.api('GET', '/Accounts', tenantId)) as { Accounts?: { Code?: string; Name: string; Status: string }[] };
    return (body.Accounts ?? []).filter((a) => a.Code).map((a) => ({ code: a.Code!, name: a.Name, status: a.Status === 'ACTIVE' ? 'ACTIVE' : 'ARCHIVED' }));
  }

  async tracking(tenantId: string): Promise<LedgerTracking[]> {
    const body = (await this.api('GET', '/TrackingCategories', tenantId)) as { TrackingCategories?: { Name: string; Status: string; Options?: { Name: string; Status: string }[] }[] };
    return (body.TrackingCategories ?? [])
      .filter((t) => t.Status === 'ACTIVE')
      .map((t) => ({ name: t.Name, options: (t.Options ?? []).filter((o) => o.Status === 'ACTIVE').map((o) => o.Name) }));
  }

  async postJournal(tenantId: string, journal: ManualJournal, status: JournalStatus, idempotencyKey: string) {
    const body = (await this.api(
      'POST',
      '/ManualJournals',
      tenantId,
      {
        ManualJournals: [
          {
            Narration: journal.narration,
            Date: journal.date,
            Status: status,
            LineAmountTypes: 'NoTax',
            JournalLines: journal.lines.map((l) => ({
              LineAmount: l.amount,
              AccountCode: l.accountCode,
              Description: l.description,
              TaxType: 'NONE',
              ...(l.tracking ? { Tracking: [{ Name: l.tracking.name, Option: l.tracking.option }] } : {}),
            })),
          },
        ],
      },
      idempotencyKey,
    )) as { ManualJournals?: { ManualJournalID: string }[] };
    const journalId = body.ManualJournals?.[0]?.ManualJournalID;
    if (!journalId) throw new AccountingError('Xero accepted the journal but did not say which it was. Check Manual Journals in Xero before posting again.', false);
    return { journalId };
  }

  async removeJournal(tenantId: string, journalId: string, status: JournalStatus) {
    // Xero voids a posted journal and deletes a draft; neither can be undone.
    await this.api('POST', '/ManualJournals', tenantId, { ManualJournals: [{ ManualJournalID: journalId, Status: status === 'POSTED' ? 'VOIDED' : 'DELETED' }] });
  }
}
