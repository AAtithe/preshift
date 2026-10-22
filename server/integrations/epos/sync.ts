import { mergeTill, mergeTillTips, tradingDays, tradingHour } from '../../../src/engine/epos';
import { addDays } from '../../../src/engine/time';
import type { OrgData } from '../../store';
import { EposError, type EposProvider, type EposSyncResult } from './provider';

/** The longest range one sync fetches. A quarter covers a first backfill; longer goes in chunks. */
export const MAX_SYNC_DAYS = 92;

/**
 * Brings the till's takings for [from, to] into the organisation, for every site mapped to a
 * location. Only trading days that have finished are written: today's partial takings would read as
 * a whole day and make today's labour % look terrible.
 */
export async function syncEpos(org: OrgData, provider: EposProvider, from: string, to: string, now: Date): Promise<EposSyncResult> {
  const at = now.toISOString();
  const result: EposSyncResult = { at, from, to, ok: true, written: 0, kept: [], sites: [] };
  const tips: NonNullable<EposSyncResult['tips']> = { written: 0, kept: [], paidDiffers: [], total: 0 };
  const mapped = org.state.sites.filter((s) => s.eposLocationId);
  if (mapped.length === 0) return { ...result, ok: false, error: 'No site is matched to a till location yet.' };

  try {
    const locations = await provider.listLocations();
    const zoneOf = (id: string) => locations.find((l) => l.id === id)?.timeZone ?? 'Europe/London';
    const missing = mapped.filter((s) => !locations.some((l) => l.id === s.eposLocationId));
    if (missing.length) throw new EposError(`${missing.map((s) => s.name).join(', ')} ${missing.length > 1 ? 'are' : 'is'} matched to a location the till no longer has. Match again in Settings.`, false);

    // A day either side covers every time zone offset and the early hours of the last night.
    const orders = await provider.fetchOrders(
      mapped.map((s) => s.eposLocationId!),
      `${addDays(from, -1)}T00:00:00Z`,
      `${addDays(to, 2)}T00:00:00Z`,
    );

    for (const site of mapped) {
      const zone = zoneOf(site.eposLocationId!);
      const today = tradingHour(at, zone).date;
      const dates: string[] = [];
      for (let d = from; d <= to && d < today; d = addDays(d, 1)) dates.push(d);
      const days = tradingDays(orders.filter((o) => o.locationId === site.eposLocationId), zone);
      const merged = mergeTill(org.state.sales ?? [], site.id, dates, days);
      org.state.sales = merged.sales;
      result.written += merged.written;
      result.kept.push(...merged.kept);
      // Card tips on the same finished days, as each day's card-tip figure for the tronc.
      const tipped = mergeTillTips(org.state.tips ?? [], site.id, dates, days);
      org.state.tips = tipped.tips;
      tips.written += tipped.written;
      tips.kept.push(...tipped.kept);
      tips.paidDiffers.push(...tipped.paidDiffers);
      const inRange = dates.map((d) => days.get(d)).filter((d) => d !== undefined);
      result.sites.push({
        siteId: site.id,
        netSales: Math.round(inRange.reduce((s, d) => s + d.netSales, 0) * 100) / 100,
        orders: inRange.reduce((s, d) => s + d.orders, 0),
      });
      tips.total += inRange.reduce((s, d) => s + (d.tips ?? 0), 0);
    }
    tips.total = Math.round(tips.total * 100) / 100;
    result.tips = tips;
  } catch (err) {
    return { ...result, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return result;
}
