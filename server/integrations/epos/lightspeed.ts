import type { TillOrder } from '../../../src/engine/epos';
import { EposError, type EposLocation, type EposProvider } from './provider';

type Fetch = typeof fetch;

// Lightspeed Restaurant (K-Series), through its Financial API. A business signs in to Lightspeed and
// approves Preshift (OAuth2 authorization code, scope financial-api); Preshift keeps the refresh token
// and swaps it for a short-lived access token on each run. Lightspeed rotates refresh tokens, so every
// swap hands back a new one to save. Written against https://api-docs.lsk.lightspeed.app.

export interface LightspeedConfig {
  clientId: string;
  clientSecret: string;
  /** The Keycloak realm Lightspeed signs in through, ending .../realms/k-series. */
  authBase: string;
  apiBase: string;
}

export const LIGHTSPEED_SCOPE = 'financial-api';

/** Lightspeed's production hosts. A trial account's hosts are set in the environment instead. */
export const LIGHTSPEED_PRODUCTION = {
  authBase: 'https://auth.lsk-prod.app/realms/k-series',
  apiBase: 'https://api.lsk.lightspeed.app',
};

/** The connection's secret: what Preshift needs to act for the business, kept in the settings store. */
export interface LightspeedTokens {
  refreshToken: string;
  accessToken?: string;
  /** When the access token stops working, as an ISO instant. */
  expiresAt?: string;
}

/** The address Lightspeed sends someone to sign in and approve Preshift. */
export function lightspeedAuthorizeUrl(config: LightspeedConfig, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: redirectUri, scope: LIGHTSPEED_SCOPE, state });
  return `${config.authBase}/protocol/openid-connect/auth?${q}`;
}

interface TokenReply {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function tokenCall(config: LightspeedConfig, f: Fetch, form: Record<string, string>, now: Date): Promise<LightspeedTokens> {
  let res: Response;
  try {
    res = await f(`${config.authBase}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
        accept: 'application/json',
      },
      body: new URLSearchParams(form).toString(),
    });
  } catch (err) {
    throw new EposError(`Could not reach Lightspeed: ${(err as Error).message}`, true);
  }
  if (!res.ok) {
    // A refused grant is not worth retrying: the business has to approve Preshift again.
    if (res.status === 400 || res.status === 401) throw new EposError('Lightspeed no longer accepts this connection. Someone who manages settings connects Lightspeed again.', false, res.status);
    throw new EposError(`Lightspeed sign-in returned ${res.status}`, res.status === 429 || res.status >= 500, res.status);
  }
  const body = (await res.json()) as TokenReply;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? form.refresh_token,
    expiresAt: new Date(now.getTime() + (body.expires_in ?? 300) * 1000).toISOString(),
  };
}

/** Exchanges the code Lightspeed sent back after sign-in for the business's tokens. */
export function lightspeedExchangeCode(config: LightspeedConfig, f: Fetch, code: string, redirectUri: string, now: Date) {
  return tokenCall(config, f, { grant_type: 'authorization_code', code, redirect_uri: redirectUri }, now);
}

/** Amounts come as decimal strings, to six places. */
const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
};

interface LightspeedLine {
  totalNetAmountWithoutTax?: string;
  serviceCharge?: string;
  currency?: string;
}

interface LightspeedPayment {
  tip?: string;
}

export interface LightspeedSale {
  accountReference?: string;
  timeClosed?: string;
  cancelled?: boolean;
  type?: string;
  salesLines?: LightspeedLine[];
  payments?: LightspeedPayment[];
}

/**
 * Sales Preshift counts. A sale is the takings; a refund is a negative sale on the day it was given.
 * Voids, cancellations, and the bookkeeping records Lightspeed writes when a bill is split, moved,
 * recalled or updated are left out, so no bill is counted twice.
 */
const COUNTED = new Set(['SALE', 'REFUND']);

/**
 * A closed sale as takings: the lines' value before VAT, after discounts. Service charge and card
 * tips are kept apart, as they belong to the team under the Employment (Allocation of Tips) Act 2023.
 * Null when the record is not a sale Preshift counts.
 */
export function lightspeedOrder(sale: LightspeedSale, locationId: string): TillOrder | null {
  if (!sale.timeClosed || sale.cancelled || !COUNTED.has(sale.type ?? 'SALE')) return null;
  const lines = sale.salesLines ?? [];
  const foreign = lines.find((l) => l.currency && l.currency !== 'GBP');
  if (foreign) throw new EposError(`Lightspeed sale ${sale.accountReference ?? ''} is in ${foreign.currency}. Preshift reports in pounds.`.replace('  ', ' '), false);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    locationId,
    closedAt: new Date(sale.timeClosed).toISOString(),
    netSales: r2(lines.reduce((s, l) => s + num(l.totalNetAmountWithoutTax), 0)),
    serviceCharge: r2(lines.reduce((s, l) => s + num(l.serviceCharge), 0)),
    tips: r2((sale.payments ?? []).reduce((s, p) => s + num(p.tip), 0)),
  };
}

/** Lightspeed's Financial API with a business's tokens. `onTokens` saves each rotated refresh token. */
export class LightspeedProvider implements EposProvider {
  readonly name = 'Lightspeed';
  private tokens: LightspeedTokens;

  constructor(
    private readonly opts: {
      config: LightspeedConfig;
      tokens: LightspeedTokens;
      fetch: Fetch;
      now: () => Date;
      onTokens: (tokens: LightspeedTokens) => Promise<void>;
    },
  ) {
    this.tokens = opts.tokens;
  }

  private async accessToken(): Promise<string> {
    const fresh = this.tokens.accessToken && this.tokens.expiresAt && new Date(this.tokens.expiresAt).getTime() - 30_000 > this.opts.now().getTime();
    if (fresh) return this.tokens.accessToken!;
    this.tokens = await tokenCall(this.opts.config, this.opts.fetch, { grant_type: 'refresh_token', refresh_token: this.tokens.refreshToken }, this.opts.now());
    await this.opts.onTokens(this.tokens);
    return this.tokens.accessToken!;
  }

  private async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await this.opts.fetch(`${this.opts.config.apiBase}${path}`, { headers: { authorization: `Bearer ${await this.accessToken()}`, accept: 'application/json' } });
    } catch (err) {
      if (err instanceof EposError) throw err;
      throw new EposError(`Could not reach Lightspeed: ${(err as Error).message}`, true);
    }
    if (res.ok) return (await res.json()) as T;
    if (res.status === 401) throw new EposError('Lightspeed refused the connection. Someone who manages settings connects Lightspeed again.', false, 401);
    if (res.status === 403) throw new EposError('Lightspeed has not given Preshift the Financial API for this business. Ask Lightspeed to enable it, then connect again.', false, 403);
    throw new EposError(`Lightspeed returned ${res.status}`, res.status === 429 || res.status >= 500, res.status);
  }

  /** The business's own name, shown so nobody connects the wrong one. */
  async businessName(): Promise<string | undefined> {
    const body = await this.get<{ _embedded?: { businessList?: { businessName?: string }[] } }>('/f/data/businesses?page=0&size=1');
    return body._embedded?.businessList?.[0]?.businessName;
  }

  async listLocations(): Promise<EposLocation[]> {
    const out: EposLocation[] = [];
    for (let page = 0; page < 50; page++) {
      const body = await this.get<{ _embedded?: { businessList?: { businessName?: string; businessLocations?: { blID: number; blName?: string; timezone?: string }[] }[] } }>(
        `/f/data/businesses?page=${page}&size=100`,
      );
      const list = body._embedded?.businessList ?? [];
      for (const b of list) for (const l of b.businessLocations ?? []) out.push({ id: String(l.blID), name: l.blName ?? `${b.businessName ?? 'Location'} ${l.blID}`, timeZone: l.timezone || 'Europe/London' });
      if (list.length < 100) break;
    }
    return out;
  }

  async fetchOrders(locationIds: string[], start: string, end: string): Promise<TillOrder[]> {
    const orders: TillOrder[] = [];
    for (const id of locationIds) {
      let token = '';
      let pages = 0;
      do {
        const q = new URLSearchParams({ from: start, to: end, include: 'payments', pageSize: '100' });
        if (token) q.set('nextPageToken', token);
        const body = await this.get<{ sales?: LightspeedSale[]; nextPageToken?: string }>(`/f/v2/business-location/${encodeURIComponent(id)}/sales?${q}`);
        for (const sale of body.sales ?? []) {
          const o = lightspeedOrder(sale, id);
          if (o) orders.push(o);
        }
        token = body.nextPageToken ?? '';
        if (++pages > 2000) throw new EposError('Lightspeed kept returning pages; stopped after 200,000 sales. Sync a shorter range.', false);
      } while (token);
    }
    return orders;
  }
}
