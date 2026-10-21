/** One closed bill or order as the till reports it. Amounts in pounds. */
export interface TillSale {
  id: string;
  locationId: string;
  /** When the bill closed, as an instant (ISO 8601 with offset). Bucketed into UK clock hours. */
  closedAt: string;
  /** After VAT, discounts and refunds; tips and service charge excluded. */
  netSales: number;
  /** Guests on the bill, when the till records them. */
  covers?: number;
}

/** A trading location in the till: usually one per site. */
export interface TillLocation {
  id: string;
  name: string;
  active: boolean;
}

/**
 * The contract between Preshift and a till. Square is the first native implementation;
 * Lightspeed, Tevalis or Zonal would implement the same two calls, so nothing above
 * this line knows which till a site runs.
 */
export interface EposProvider {
  readonly name: string;
  listLocations(): Promise<TillLocation[]>;
  /** Every bill closed in [from, to) at these locations. */
  closedSales(locationIds: string[], from: Date, to: Date): Promise<TillSale[]>;
}

export class EposError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}
