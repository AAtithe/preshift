import type { TillOrder } from '../../../src/engine/epos';

/** A till location as the EPOS knows it: usually one per venue. */
export interface EposLocation {
  id: string;
  name: string;
  /** IANA time zone the venue trades in, for bucketing orders into its trading day. */
  timeZone: string;
}

/**
 * The contract between Preshift and an EPOS. Square is the first implementation; Lightspeed, Zonal
 * or Tevalis would implement the same two calls, so nothing above this line knows which till it is.
 */
export interface EposProvider {
  readonly name: string;
  listLocations(): Promise<EposLocation[]>;
  /** Completed orders closed in [start, end), both ISO instants, net of VAT, tips and service charge, each with its card tips. */
  fetchOrders(locationIds: string[], start: string, end: string): Promise<TillOrder[]>;
}

export class EposError extends Error {
  constructor(
    message: string,
    /** Whether trying again later could succeed (network, 5xx, 429) or not (a refused token). */
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type EposEnvironment = 'production' | 'sandbox' | 'simulator';

/** What the organisation has connected. The access token is kept apart, in the settings store. */
export interface EposConnection {
  provider: 'square';
  environment: EposEnvironment;
  connectedAt: string;
  connectedBy: string;
  /** The Square account's own name for itself, shown so nobody connects the wrong business. */
  accountName?: string;
  lastSync?: EposSyncResult;
  /** The last re-sync of past takings, so the restatement stays on record beside the connection. */
  lastResync?: EposResyncResult;
}

/**
 * Past takings read again from the till after a fix to how takings are worked out. Only days the
 * till wrote in the first place are rewritten, and only takings: tips are left as they are.
 */
export interface EposResyncResult {
  at: string;
  from: string;
  to: string;
  ok: boolean;
  error?: string;
  /** Till days read again. */
  read: number;
  /** Till days this till has no orders for, left as they were rather than zeroed. */
  unmatched: number;
  /** Of those, days whose takings changed. */
  changed: number;
  /** By site: the days that changed, and their takings before and after. */
  sites: { siteId: string; changed: number; before: number; after: number }[];
}

export interface EposSyncResult {
  at: string;
  from: string;
  to: string;
  ok: boolean;
  error?: string;
  /** Trading days written from the till. */
  written: number;
  /** Days keyed in by hand, left as they were. */
  kept: { siteId: string; date: string }[];
  sites: { siteId: string; netSales: number; orders: number }[];
  /** Card tips brought in as each day's card-tip figure. Absent on syncs from before the till fed tips. */
  tips?: TillTipsResult;
  /** Service charge brought in the same way. Absent on syncs from before the till fed it. */
  serviceCharge?: TillTipsResult;
}

export interface TillTipsResult {
  written: number;
  /** Days a manager keyed in by hand, left as they were. */
  kept: { siteId: string; date: string }[];
  /** Paid days the till now disagrees with: left as paid, for payroll to look at. */
  paidDiffers: { siteId: string; date: string; paid: number; till: number }[];
  total: number;
}
