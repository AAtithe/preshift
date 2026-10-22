import type { TillOrder } from '../../../src/engine/epos';
import { EposError, type EposLocation, type EposProvider } from './provider';

type Fetch = typeof fetch;

/** The Square API version Preshift is written against. Square keeps old versions working. */
export const SQUARE_VERSION = '2025-01-23';

const BASE = {
  production: 'https://connect.squareup.com',
  sandbox: 'https://connect.squareupsandbox.com',
};

interface Money {
  amount?: number;
  currency?: string;
}

interface SquareOrder {
  id: string;
  location_id: string;
  closed_at?: string;
  state?: string;
  total_money?: Money;
  total_tax_money?: Money;
  total_tip_money?: Money;
  total_service_charge_money?: Money;
  /** Sales less returns. Present on any order that has had money returned against it. */
  net_amounts?: { total_money?: Money; tax_money?: Money; tip_money?: Money; service_charge_money?: Money };
}

const pence = (m?: Money) => m?.amount ?? 0;

/**
 * An order's takings as a hospitality P&L counts them: what the guest paid, less VAT, less tips and
 * service charge (which belong to the team under the Employment (Allocation of Tips) Act 2023, not
 * the business), less anything refunded. Square's money is in pence.
 */
export function squareNetSales(order: SquareOrder): number {
  const n = order.net_amounts;
  const gross = n ? pence(n.total_money) : pence(order.total_money);
  const tax = n ? pence(n.tax_money) : pence(order.total_tax_money);
  const tip = n ? pence(n.tip_money) : pence(order.total_tip_money);
  const service = n ? pence(n.service_charge_money) : pence(order.total_service_charge_money);
  return (gross - tax - tip - service) / 100;
}

/** Square's Locations and Orders APIs, with a seller's access token. */
export class SquareProvider implements EposProvider {
  readonly name: string;

  constructor(
    private readonly opts: { accessToken: string; environment: 'production' | 'sandbox'; fetch: Fetch },
  ) {
    this.name = opts.environment === 'sandbox' ? 'Square (sandbox)' : 'Square';
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.opts.fetch(`${BASE[this.opts.environment]}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.accessToken}`,
          'square-version': SQUARE_VERSION,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new EposError(`Could not reach Square: ${(err as Error).message}`, true);
    }
    if (res.ok) return (await res.json()) as T;
    const detail = await res
      .json()
      .then((b: { errors?: { detail?: string; code?: string }[] }) => b.errors?.[0]?.detail ?? b.errors?.[0]?.code)
      .catch(() => undefined);
    if (res.status === 401) throw new EposError('Square refused the access token. Check it is the production token for the right account, or create a new one.', false, 401);
    if (res.status === 403) throw new EposError(`The access token lacks a permission Preshift needs (ORDERS_READ and MERCHANT_PROFILE_READ). ${detail ?? ''}`.trim(), false, 403);
    const retryable = res.status === 429 || res.status >= 500;
    throw new EposError(`Square returned ${res.status}${detail ? `: ${detail}` : ''}`, retryable, res.status);
  }

  async merchantName(): Promise<string | undefined> {
    const body = await this.call<{ merchant?: { business_name?: string }[] }>('GET', '/v2/merchants');
    return body.merchant?.[0]?.business_name;
  }

  async listLocations(): Promise<EposLocation[]> {
    const body = await this.call<{ locations?: { id: string; name: string; timezone?: string; status?: string }[] }>('GET', '/v2/locations');
    return (body.locations ?? [])
      .filter((l) => l.status !== 'INACTIVE')
      .map((l) => ({ id: l.id, name: l.name, timeZone: l.timezone || 'Europe/London' }));
  }

  async fetchOrders(locationIds: string[], start: string, end: string): Promise<TillOrder[]> {
    const orders: TillOrder[] = [];
    // Square searches at most ten locations at a time.
    for (let i = 0; i < locationIds.length; i += 10) {
      let cursor: string | undefined;
      let pages = 0;
      do {
        const body = await this.call<{ orders?: SquareOrder[]; cursor?: string }>('POST', '/v2/orders/search', {
          location_ids: locationIds.slice(i, i + 10),
          limit: 500,
          cursor,
          query: {
            filter: {
              state_filter: { states: ['COMPLETED'] },
              date_time_filter: { closed_at: { start_at: start, end_at: end } },
            },
            sort: { sort_field: 'CLOSED_AT', sort_order: 'ASC' },
          },
        });
        for (const o of body.orders ?? []) {
          if (!o.closed_at) continue;
          const currency = o.total_money?.currency;
          if (currency && currency !== 'GBP') throw new EposError(`Square order ${o.id} is in ${currency}. Preshift reports in pounds.`, false);
          orders.push({ locationId: o.location_id, closedAt: o.closed_at, netSales: squareNetSales(o) });
        }
        cursor = body.cursor;
        if (++pages > 400) throw new EposError('Square kept returning pages; stopped after 200,000 orders. Sync a shorter range.', false);
      } while (cursor);
    }
    return orders;
  }
}
