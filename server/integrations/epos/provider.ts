import type { TillOrder } from '../../../src/engine/epos';

/** A till location as the EPOS knows it: usually one per venue. */
export interface EposLocation {
  id: string;
  name: string;
  /** IANA time zone the venue trades in, for bucketing orders into its trading day. */
  timeZone: string;
}

/**
 * The contract between Preshift and an EPOS. Square, Toast and Lightspeed implement it; Zonal or
 * Tevalis would implement the same two calls, so nothing above this line knows which till it is.
 */
export interface EposProvider {
  readonly name: string;
  listLocations(): Promise<EposLocation[]>;
  /** Completed orders closed in [start, end), both ISO instants, net of VAT, tips and service charge. */
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

export type EposProviderName = 'square' | 'toast' | 'lightspeed';

export const PROVIDER_LABEL: Record<EposProviderName, string> = { square: 'Square', toast: 'Toast', lightspeed: 'Lightspeed' };

/** A year's backfill, worked a chunk at a time so no single request runs long. */
export interface EposBackfill {
  from: string;
  to: string;
  /** The first day not yet brought in. Past `to` once finished. */
  next: string;
  startedAt: string;
  startedBy: string;
  written: number;
  finishedAt?: string;
  error?: string;
}

/** What the organisation has connected. Its credentials are kept apart, in the settings store. */
export interface EposConnection {
  provider: EposProviderName;
  environment: EposEnvironment;
  connectedAt: string;
  connectedBy: string;
  /** The Square account's own name for itself, shown so nobody connects the wrong business. */
  accountName?: string;
  lastSync?: EposSyncResult;
  backfill?: EposBackfill;
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
}
