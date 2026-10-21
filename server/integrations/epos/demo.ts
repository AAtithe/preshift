import { DEMO_AVERAGE_SPEND, typicalHourSales } from '../../../src/engine/seed';
import { londonParts } from '../../context';
import type { EposProvider, TillLocation, TillSale } from './provider';

// One till location per demo site, named the way an operator would name them in their till.
const LOCATIONS: (TillLocation & { siteId: string })[] = [
  { id: 'demo-mar', name: 'Marylebone', active: true, siteId: 'mar' },
  { id: 'demo-fitz', name: 'Fitzrovia', active: true, siteId: 'fitz' },
  { id: 'demo-shd', name: 'Shoreditch', active: true, siteId: 'shd' },
];

/** Repeatable noise from a string, so the same hour always trades the same and a re-sync changes nothing. */
function noise(seed: string): number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * A till for the demo group. It trades around the demo forecast, a little over or under each
 * hour as a real site would, with guests on every bill, so the whole path from till to
 * forecast can be shown without a real Square account. Never offered on a live system.
 */
export class DemoTill implements EposProvider {
  readonly name = 'Demo till';

  async listLocations(): Promise<TillLocation[]> {
    return LOCATIONS.map(({ siteId: _s, ...l }) => l);
  }

  async closedSales(locationIds: string[], from: Date, to: Date): Promise<TillSale[]> {
    const sales: TillSale[] = [];
    const end = Math.min(to.getTime(), Date.now());
    for (const loc of LOCATIONS.filter((l) => locationIds.includes(l.id))) {
      for (let t = Math.floor(from.getTime() / 3_600_000) * 3_600_000; t < end; t += 3_600_000) {
        const { date, minute } = londonParts(new Date(t));
        const hour = Math.floor(minute / 60);
        const typical = typicalHourSales(loc.siteId, date, hour);
        if (!typical) continue;
        // Whole days run up to 12% either side of typical, as weather and events move trade; hours vary on top.
        const day = 0.88 + noise(`${loc.id}|${date}`) * 0.24;
        const hourTotal = typical * day * (0.85 + noise(`${loc.id}|${date}|${hour}`) * 0.3);
        const bills = Math.max(1, Math.round(hourTotal / (DEMO_AVERAGE_SPEND * 2.4)));
        for (let b = 0; b < bills; b++) {
          const at = t + Math.floor(((b + 0.5) / bills) * 3_600_000);
          if (at < from.getTime() || at >= end) continue;
          const net = Math.round((hourTotal / bills) * 100) / 100;
          sales.push({
            id: `${loc.id}-${date}-${hour}-${b}`,
            locationId: loc.id,
            closedAt: new Date(at).toISOString(),
            netSales: net,
            covers: Math.max(1, Math.round(net / DEMO_AVERAGE_SPEND)),
          });
        }
      }
    }
    return sales;
  }
}
