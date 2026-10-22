import type { TillOrder } from '../../../src/engine/epos';
import { EposError, type EposLocation, type EposProvider } from './provider';

type Fetch = typeof fetch;

const BASE = {
  production: 'https://api.lsk.lightspeed.app',
  sandbox: 'https://api.trial.lsk.lightspeed.app',
};

/** What Preshift asks Lightspeed for: the financial data, read only. */
export const LIGHTSPEED_SCOPE = 'financial-api';

/** Preshift's own Lightspeed app, registered once with Lightspeed and set on the server. */
export interface LightspeedApp {
  clientId: string;
  clientSecret: string;
}

export interface LightspeedTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export function lightspeedAuthoriseUrl(app: LightspeedApp, environment: 'production' | 'sandbox', redirectUri: string, state: string) {
  const q = new URLSearchParams({ response_type: 'code', client_id: app.clientId, scope: LIGHTSPEED_SCOPE, redirect_uri: redirectUri, state });
  return `${BASE[environment]}/oauth/authorize?${q}`;
}

async function tokenRequest(app: LightspeedApp, environment: 'production' | 'sandbox', form: Record<string, string>, fetchImpl: Fetch, now: number): Promise<LightspeedTokens> {
  let res: Response;
  try {
    res = await fetchImpl(`${BASE[environment]}/oauth/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(form).toString(),
    });
  } catch (err) {
    throw new EposError(`Could not reach Lightspeed: ${(err as Error).message}`, true);
  }
  if (res.status === 400 || res.status === 401) {
    throw new EposError(form.grant_type === 'refresh_token' ? 'Lightspeed no longer accepts this connection. Connect Lightspeed again in Settings.' : 'Lightspeed refused the sign-in. Try connecting again.', false, res.status);
  }
  if (!res.ok) throw new EposError(`Lightspeed returned ${res.status}`, res.status === 429 || res.status >= 500, res.status);
  const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!body.access_token || !body.refresh_token) throw new EposError('Lightspeed signed in but sent no tokens.', true);
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 };
}

/** Swaps the code Lightspeed sent back for tokens. */
export const exchangeLightspeedCode = (app: LightspeedApp, environment: 'production' | 'sandbox', code: string, redirectUri: string, fetchImpl: Fetch, now = Date.now()) =>
  tokenRequest(app, environment, { grant_type: 'authorization_code', code, redirect_uri: redirectUri }, fetchImpl, now);

interface Receipt {
  receiptId?: string;
  cancelled?: boolean;
  timeOfCloseAndPaid?: string;
  nbCovers?: number;
  salesLines?: { totalNetAmountWithoutTax?: number | string; serviceCharge?: boolean }[];
}

const num = (v: number | string | undefined) => (v === undefined ? 0 : Number(v) || 0);

/**
 * A Lightspeed receipt's takings: the lines net of tax, less any service charge line, which belongs
 * to the team. Tips are payments, not sales lines, so they never enter. Refunds are negative lines,
 * so they come off on their own. Cancelled receipts count for nothing.
 */
export function lightspeedNetSales(r: Receipt): number {
  if (r.cancelled) return 0;
  const net = (r.salesLines ?? []).filter((l) => !l.serviceCharge).reduce((s, l) => s + num(l.totalNetAmountWithoutTax), 0);
  return Math.round(net * 100) / 100;
}

/**
 * Lightspeed Restaurant (K-Series) business locations and financial data, on an OAuth connection
 * the venue approved. The access token is refreshed when it nears expiry and the new pair handed
 * back to be saved, because Lightspeed retires the old refresh token as it issues a new one.
 */
export class LightspeedProvider implements EposProvider {
  readonly name: string;

  constructor(
    private readonly opts: {
      app: LightspeedApp;
      environment: 'production' | 'sandbox';
      tokens: LightspeedTokens;
      fetch: Fetch;
      onTokens: (tokens: LightspeedTokens) => Promise<void>;
      now?: () => number;
    },
  ) {
    this.name = opts.environment === 'sandbox' ? 'Lightspeed (trial)' : 'Lightspeed';
  }

  private async accessToken(): Promise<string> {
    const now = this.opts.now?.() ?? Date.now();
    if (this.opts.tokens.expiresAt > now + 60_000) return this.opts.tokens.accessToken;
    const fresh = await tokenRequest(this.opts.app, this.opts.environment, { grant_type: 'refresh_token', refresh_token: this.opts.tokens.refreshToken }, this.opts.fetch, now);
    this.opts.tokens = fresh;
    await this.opts.onTokens(fresh);
    return fresh.accessToken;
  }

  private async get<T>(path: string): Promise<T> {
    const token = await this.accessToken();
    let res: Response;
    try {
      res = await this.opts.fetch(`${BASE[this.opts.environment]}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    } catch (err) {
      throw new EposError(`Could not reach Lightspeed: ${(err as Error).message}`, true);
    }
    if (res.status === 401) throw new EposError('Lightspeed refused the connection. Connect Lightspeed again in Settings.', false, 401);
    if (res.status === 403) throw new EposError('The Lightspeed connection lacks access to financial data for this location.', false, 403);
    if (!res.ok) throw new EposError(`Lightspeed returned ${res.status}`, res.status === 429 || res.status >= 500, res.status);
    return (await res.json()) as T;
  }

  async listLocations(): Promise<EposLocation[]> {
    const body = await this.get<
      { businessName?: string; businessLocations?: { blName?: string; blId: number | string; timezone?: string }[] }[] | { businesses?: { businessName?: string; businessLocations?: { blName?: string; blId: number | string; timezone?: string }[] }[] }
    >('/f/data/businesses');
    const businesses = Array.isArray(body) ? body : body.businesses ?? [];
    return businesses.flatMap((b) =>
      (b.businessLocations ?? []).map((l) => ({ id: String(l.blId), name: l.blName || b.businessName || String(l.blId), timeZone: l.timezone || 'Europe/London' })),
    );
  }

  async fetchOrders(locationIds: string[], start: string, end: string): Promise<TillOrder[]> {
    const orders: TillOrder[] = [];
    for (const location of locationIds) {
      // A day at a time: Lightspeed caps how much one financial request returns.
      for (let from = Date.parse(start); from < Date.parse(end); from += 86_400_000) {
        const to = Math.min(from + 86_400_000, Date.parse(end));
        const body = await this.get<{ sales?: Receipt[] }>(`/f/finance/${encodeURIComponent(location)}/financials/${new Date(from).toISOString()}/${new Date(to).toISOString()}`);
        for (const r of body.sales ?? []) {
          if (!r.timeOfCloseAndPaid || r.cancelled) continue;
          orders.push({
            locationId: location,
            closedAt: new Date(r.timeOfCloseAndPaid).toISOString(),
            netSales: lightspeedNetSales(r),
            ...(r.nbCovers !== undefined ? { covers: r.nbCovers } : {}),
          });
        }
      }
    }
    return orders;
  }
}
