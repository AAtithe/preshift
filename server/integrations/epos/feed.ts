import { feedOrders, type TillFeedRow } from '../../../src/engine/tillFeed';
import type { TillOrder } from '../../../src/engine/epos';
import { addDays } from '../../../src/engine/time';
import type { EposFeedData, EposLocation, EposProvider } from './provider';

/** How long a feed's rows are kept: long enough to re-sync a correction, short enough to stay small. */
export const FEED_RETENTION_DAYS = 62;

/**
 * A till that sends a file rather than answering calls. Its locations are the site references the
 * feed has used, and its orders are the rows it sent, read through the same trading day rules.
 */
export class FeedProvider implements EposProvider {
  constructor(
    readonly name: string,
    private readonly feed: EposFeedData,
  ) {}

  async listLocations(): Promise<EposLocation[]> {
    return this.feed.locations.map((l) => ({ id: l.id, name: l.name, timeZone: 'Europe/London' }));
  }

  async fetchOrders(locationIds: string[], start: string, end: string): Promise<TillOrder[]> {
    return feedOrders(this.feed.rows.filter((r) => locationIds.includes(r.locationId)), () => 'Europe/London').filter((o) => o.closedAt >= start && o.closedAt < end);
  }
}

/**
 * Takes in a feed's rows: each replaces the same site, day and hour sent before, so a resent file
 * corrects rather than doubles. Returns the trading days the rows cover, oldest first, for the sync.
 */
export function receiveFeed(feed: EposFeedData, rows: TillFeedRow[], today: string, at: string): string[] {
  const key = (r: TillFeedRow) => `${r.locationId}|${r.date}|${r.hour ?? 'day'}`;
  // A day sent as a total and later by the hour (or the other way) keeps the latest shape only.
  const days = new Set(rows.map((r) => `${r.locationId}|${r.date}`));
  const incoming = new Map(rows.map((r) => [key(r), r]));
  const oldest = addDays(today, -FEED_RETENTION_DAYS);
  feed.rows = [...feed.rows.filter((r) => !days.has(`${r.locationId}|${r.date}`)), ...incoming.values()].filter((r) => r.date >= oldest);
  for (const r of rows) {
    const known = feed.locations.find((l) => l.id === r.locationId);
    if (known) {
      known.lastSeen = at;
      if (r.locationName) known.name = r.locationName;
    } else feed.locations.push({ id: r.locationId, name: r.locationName ?? `Site ${r.locationId}`, lastSeen: at });
  }
  return [...new Set(rows.map((r) => r.date))].filter((d) => d >= oldest).sort();
}
