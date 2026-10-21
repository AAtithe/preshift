import type { HourSales } from '../../../src/engine/types';
import { londonParts } from '../../context';
import type { TillSale } from './provider';

/**
 * Bills into UK clock hours per site, keyed like the forecast. A bill closed at 00:40 on
 * Saturday lands in Saturday's 00:00 hour, as the forecast and the rota count it.
 */
export function bucketSales(sales: TillSale[], siteOf: (locationId: string) => string | undefined, source: string): HourSales[] {
  const hours = new Map<string, HourSales & { coversKnown: boolean }>();
  for (const s of sales) {
    const siteId = siteOf(s.locationId);
    if (!siteId) continue;
    const { date, minute } = londonParts(new Date(s.closedAt));
    const hour = Math.floor(minute / 60);
    const k = `${siteId}|${date}|${hour}`;
    const row = hours.get(k) ?? { siteId, date, hour, sales: 0, covers: 0, transactions: 0, source, coversKnown: true };
    row.sales += s.netSales;
    row.transactions += 1;
    if (s.covers === undefined) row.coversKnown = false;
    else row.covers = (row.covers ?? 0) + s.covers;
    hours.set(k, row);
  }
  return [...hours.values()].map(({ coversKnown, ...r }) => ({
    ...r,
    sales: Math.round(r.sales * 100) / 100,
    covers: coversKnown ? r.covers : undefined,
  }));
}
