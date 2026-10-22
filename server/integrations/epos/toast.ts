import type { TillOrder } from '../../../src/engine/epos';
import { addDays } from '../../../src/engine/time';
import { EposError, type EposLocation, type EposProvider } from './provider';

type Fetch = typeof fetch;

const HOSTS = {
  production: 'https://ws-api.toasttab.com',
  sandbox: 'https://ws-sandbox-api.eng.toasttab.com',
};

/** Orders a page holds: Toast's maximum for ordersBulk. */
const PAGE_SIZE = 100;

interface ToastCheck {
  amount?: number;
  taxAmount?: number;
  voided?: boolean;
  deleted?: boolean;
  closedDate?: string;
  appliedServiceCharges?: { chargeAmount?: number }[];
  payments?: { refund?: { refundAmount?: number } | null; refundStatus?: string }[];
}

interface ToastOrder {
  guid: string;
  businessDate?: number;
  closedDate?: string;
  voided?: boolean;
  deleted?: boolean;
  numberOfGuests?: number;
  checks?: ToastCheck[];
}

/**
 * A Toast order's takings as a hospitality P&L counts them. Toast's check amount is after discounts
 * and before tax and tip; service charges are taken off, as they belong to the team, and so are
 * refunds against the check. Voided and deleted checks and orders count for nothing. Toast's money
 * is in pounds, not pence.
 */
export function toastNetSales(order: ToastOrder): number {
  if (order.voided || order.deleted) return 0;
  let net = 0;
  for (const c of order.checks ?? []) {
    if (c.voided || c.deleted) continue;
    const service = (c.appliedServiceCharges ?? []).reduce((s, x) => s + (x.chargeAmount ?? 0), 0);
    const refunds = (c.payments ?? []).reduce((s, p) => s + (p.refund?.refundAmount ?? 0), 0);
    net += (c.amount ?? 0) - service - refunds;
  }
  return Math.round(net * 100) / 100;
}

/** Toast's business date, 20261019, as an ISO date. */
const businessDate = (n: number) => {
  const s = String(n);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};

/**
 * Toast's Restaurants and Orders APIs, with the client credentials Toast issues to an integration.
 * Orders are asked for by business date, so each lands on the trading day the restaurant's own
 * closeout hour put it on.
 */
export class ToastProvider implements EposProvider {
  readonly name: string;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly opts: { clientId: string; clientSecret: string; environment: 'production' | 'sandbox'; fetch: Fetch; now?: () => number }) {
    this.name = opts.environment === 'sandbox' ? 'Toast (sandbox)' : 'Toast';
  }

  private get host() {
    return HOSTS[this.opts.environment];
  }

  private async login(): Promise<string> {
    const now = this.opts.now?.() ?? Date.now();
    if (this.token && this.token.expiresAt > now + 60_000) return this.token.value;
    const res = await this.send(`${this.host}/authentication/v1/authentication/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: this.opts.clientId, clientSecret: this.opts.clientSecret, userAccessType: 'TOAST_MACHINE_CLIENT' }),
    });
    if (res.status === 401 || res.status === 403) throw new EposError('Toast refused the client ID and secret. Check they are the production credentials Toast issued for this restaurant group.', false, res.status);
    if (!res.ok) throw await this.failure(res);
    const body = (await res.json()) as { token?: { accessToken?: string; expiresIn?: number } };
    if (!body.token?.accessToken) throw new EposError('Toast signed in but sent no access token.', true);
    this.token = { value: body.token.accessToken, expiresAt: now + (body.token.expiresIn ?? 3600) * 1000 };
    return this.token.value;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.opts.fetch(url, init);
    } catch (err) {
      throw new EposError(`Could not reach Toast: ${(err as Error).message}`, true);
    }
  }

  private async failure(res: Response): Promise<EposError> {
    const detail = await res.json().then((b: { message?: string }) => b.message).catch(() => undefined);
    return new EposError(`Toast returned ${res.status}${detail ? `: ${detail}` : ''}`, res.status === 429 || res.status >= 500, res.status);
  }

  private async get<T>(path: string, restaurant?: string): Promise<T> {
    const token = await this.login();
    const res = await this.send(`${this.host}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(restaurant ? { 'toast-restaurant-external-id': restaurant } : {}) },
    });
    if (res.status === 401) throw new EposError('Toast refused the access token for this restaurant. Check the integration is still connected in Toast.', false, 401);
    if (res.status === 403) throw new EposError('The Toast credentials lack access to this restaurant, or to orders. Ask Toast to grant orders:read for it.', false, 403);
    if (!res.ok) throw await this.failure(res);
    return (await res.json()) as T;
  }

  async listLocations(): Promise<EposLocation[]> {
    const restaurants = await this.get<{ restaurantGuid: string; restaurantName?: string; locationName?: string }[]>('/partners/v1/restaurants');
    const out: EposLocation[] = [];
    for (const r of restaurants) {
      // Each restaurant's own time zone, so its orders' clock times read as the floor saw them.
      const config = await this.get<{ general?: { timeZone?: string } }>(`/restaurants/v1/restaurants/${r.restaurantGuid}`, r.restaurantGuid).catch(() => ({ general: undefined }));
      const name = [r.restaurantName, r.locationName].filter(Boolean).join(', ') || r.restaurantGuid;
      out.push({ id: r.restaurantGuid, name, timeZone: config.general?.timeZone || 'Europe/London' });
    }
    return out;
  }

  async fetchOrders(locationIds: string[], start: string, end: string): Promise<TillOrder[]> {
    const orders: TillOrder[] = [];
    const first = start.slice(0, 10);
    const last = addDays(end.slice(0, 10), -1);
    for (const restaurant of locationIds) {
      for (let d = first; d <= last; d = addDays(d, 1)) {
        for (let page = 1; ; page++) {
          const batch = await this.get<ToastOrder[]>(`/orders/v2/ordersBulk?businessDate=${d.replace(/-/g, '')}&pageSize=${PAGE_SIZE}&page=${page}`, restaurant);
          for (const o of batch) {
            const closedAt = o.closedDate ?? o.checks?.find((c) => c.closedDate)?.closedDate;
            // An order still open has not been paid for yet: it counts when it closes.
            if (!closedAt || o.voided || o.deleted) continue;
            orders.push({
              locationId: restaurant,
              closedAt,
              netSales: toastNetSales(o),
              ...(o.numberOfGuests !== undefined ? { covers: o.numberOfGuests } : {}),
              ...(o.businessDate ? { tradingDate: businessDate(o.businessDate) } : {}),
            });
          }
          if (batch.length < PAGE_SIZE) break;
          if (page >= 200) throw new EposError(`Toast kept returning pages for ${d}; stopped after 20,000 orders.`, false);
        }
      }
    }
    return orders;
  }
}
