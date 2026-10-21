import { EposError, type EposProvider, type TillLocation, type TillSale } from './provider';

export interface SquareConfig {
  accessToken: string;
  environment: 'production' | 'sandbox';
  fetchImpl?: typeof fetch;
}

interface Money { amount?: number; currency?: string }
interface SquareOrder {
  id: string;
  location_id: string;
  closed_at?: string;
  state: string;
  net_amounts?: { total_money?: Money; tax_money?: Money; tip_money?: Money; service_charge_money?: Money };
}

// Pinned so a change on Square's side cannot alter what we read without a deliberate upgrade here.
const SQUARE_VERSION = '2025-01-23';
const BATCH = 10; // Square's limit on location_ids per order search.

/**
 * Native Square client. Every Square path and field lives in this file and nowhere else.
 * Sales are read from completed orders by closed time, using net_amounts so refunds made
 * against an order come off it. Net sales are total less VAT, tips and service charge:
 * tips and discretionary service charge belong to staff through the tronc, not to sales,
 * and counting them would flatter labour %. Square orders carry no guest count, so covers
 * are left for Preshift to derive from the site's spend per head.
 */
export class SquareProvider implements EposProvider {
  readonly name = 'Square';
  private readonly fetch: typeof fetch;
  private readonly base: string;

  constructor(private readonly config: SquareConfig) {
    this.fetch = config.fetchImpl ?? fetch;
    this.base = config.environment === 'sandbox' ? 'https://connect.squareupsandbox.com/v2' : 'https://connect.squareup.com/v2';
  }

  async listLocations(): Promise<TillLocation[]> {
    const res = await this.request<{ locations?: { id: string; name: string; status: string }[] }>('GET', '/locations');
    return (res.locations ?? []).map((l) => ({ id: l.id, name: l.name, active: l.status === 'ACTIVE' }));
  }

  async closedSales(locationIds: string[], from: Date, to: Date): Promise<TillSale[]> {
    const sales: TillSale[] = [];
    for (let i = 0; i < locationIds.length; i += BATCH) {
      let cursor: string | undefined;
      do {
        const res = await this.request<{ orders?: SquareOrder[]; cursor?: string }>('POST', '/orders/search', {
          location_ids: locationIds.slice(i, i + BATCH),
          cursor,
          limit: 500,
          query: {
            filter: {
              state_filter: { states: ['COMPLETED'] },
              date_time_filter: { closed_at: { start_at: from.toISOString(), end_at: to.toISOString() } },
            },
            // Square requires the sort field to match the time filter used.
            sort: { sort_field: 'CLOSED_AT', sort_order: 'ASC' },
          },
        });
        for (const o of res.orders ?? []) {
          if (!o.closed_at) continue;
          const n = o.net_amounts ?? {};
          const pence = (n.total_money?.amount ?? 0) - (n.tax_money?.amount ?? 0) - (n.tip_money?.amount ?? 0) - (n.service_charge_money?.amount ?? 0);
          sales.push({ id: o.id, locationId: o.location_id, closedAt: o.closed_at, netSales: pence / 100 });
        }
        cursor = res.cursor;
      } while (cursor);
    }
    return sales;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.config.accessToken}`,
          'square-version': SQUARE_VERSION,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new EposError('Could not reach Square. Try again shortly.');
    }
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { errors?: { detail?: string }[] } | null;
      const reason =
        res.status === 401
          ? 'Square refused the access token. Check it is the production token for this account, or reconnect.'
          : res.status === 403
            ? 'The Square token is missing the ORDERS_READ or MERCHANT_PROFILE_READ permission.'
            : detail?.errors?.[0]?.detail ?? `Square returned ${res.status}.`;
      throw new EposError(reason, res.status);
    }
    return (await res.json()) as T;
  }
}
