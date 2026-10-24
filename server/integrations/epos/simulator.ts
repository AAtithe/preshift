import type { TillOrder } from '../../../src/engine/epos';
import type { RotaState } from '../../../src/engine/types';
import type { EposLocation, EposProvider } from './provider';

const AVERAGE_SPEND = 42;
const LONDON = 'Europe/London';

/** UTC instant of a London wall-clock time. British Summer Time runs late March to late October. */
function londonInstant(date: string, hour: number, minute: number): string {
  const naive = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour, minute);
  const asLondon = new Date(naive).toLocaleString('en-GB', { timeZone: LONDON, hour: '2-digit', hourCycle: 'h23' });
  const offsetHours = (Number(asLondon) - hour + 24) % 24;
  return new Date(naive - offsetHours * 3600_000).toISOString();
}

/**
 * A till for the demo and development: one location per site, trading close to the forecast with a
 * steady daily swing, so the reports have real variance without anyone owning a Square account.
 */
export class SquareSimulator implements EposProvider {
  readonly name = 'Square (simulator)';

  constructor(private readonly state: Pick<RotaState, 'sites' | 'forecast' | 'troncSchemes'>) {}

  async listLocations(): Promise<EposLocation[]> {
    return this.state.sites.map((s) => ({ id: `sim-${s.id}`, name: `${s.name} (simulated till)`, timeZone: LONDON }));
  }

  async fetchOrders(locationIds: string[], start: string, end: string): Promise<TillOrder[]> {
    const orders: TillOrder[] = [];
    for (const f of this.state.forecast) {
      const locationId = `sim-${f.siteId}`;
      if (!locationIds.includes(locationId) || f.sales <= 0) continue;
      const seed = [...`${f.siteId}${f.date}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1000, 11);
      const sales = f.sales * (0.86 + (seed % 25) / 100);
      const count = Math.max(1, Math.round(sales / AVERAGE_SPEND));
      for (let i = 0; i < count; i++) {
        const closedAt = londonInstant(f.date, f.hour, Math.floor((i * 60) / count));
        if (closedAt < start || closedAt >= end) continue;
        const net = Math.round((sales / count) * 100) / 100;
        // About one table in three leaves a card tip of around ten per cent.
        const tips = (seed + i) % 3 === 0 ? Math.round(net * 0.1 * 100) / 100 : 0;
        // A site whose scheme takes a service charge adds 12.5% to every bill.
        const charged = (this.state.troncSchemes ?? []).some((s) => s.siteId === f.siteId && s.serviceCharge !== 'none');
        const serviceCharge = charged ? Math.round(net * 0.125 * 100) / 100 : 0;
        orders.push({ locationId, closedAt, netSales: net, tips, serviceCharge });
      }
    }
    return orders;
  }
}
