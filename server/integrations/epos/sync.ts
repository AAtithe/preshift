import { mergeTill, mergeTillTips, tradingDays, tradingHour } from '../../../src/engine/epos';
import { addDays } from '../../../src/engine/time';
import type { OrgData } from '../../store';
import { EposError, type EposProvider, type EposResyncResult, type EposSyncResult, type TillTipsResult } from './provider';

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
  const fresh = (): TillTipsResult => ({ written: 0, kept: [], paidDiffers: [], total: 0 });
  const fed = { 'card-tip': fresh(), 'service-charge': fresh() };
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
      // Card tips and service charge on the same finished days, as each day's figures for the tronc.
      for (const source of ['card-tip', 'service-charge'] as const) {
        const merged = mergeTillTips(org.state.tips ?? [], site.id, dates, days, source);
        org.state.tips = merged.tips;
        fed[source].written += merged.written;
        fed[source].kept.push(...merged.kept);
        fed[source].paidDiffers.push(...merged.paidDiffers);
      }
      const inRange = dates.map((d) => days.get(d)).filter((d) => d !== undefined);
      result.sites.push({
        siteId: site.id,
        netSales: Math.round(inRange.reduce((s, d) => s + d.netSales, 0) * 100) / 100,
        orders: inRange.reduce((s, d) => s + d.orders, 0),
      });
      fed['card-tip'].total += inRange.reduce((s, d) => s + (d.tips ?? 0), 0);
      fed['service-charge'].total += inRange.reduce((s, d) => s + (d.serviceCharge ?? 0), 0);
    }
    for (const r of Object.values(fed)) r.total = Math.round(r.total * 100) / 100;
    result.tips = fed['card-tip'];
    result.serviceCharge = fed['service-charge'];
  } catch (err) {
    return { ...result, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return result;
}

/** The longest history one re-sync reads: two years, in quarters. */
export const MAX_RESYNC_DAYS = 731;

/**
 * Reads past takings again from the till, for days the till wrote in the first place and has orders
 * for, after a fix to how takings are worked out from it. A day keyed in by hand or loaded from a
 * file is left alone, as is a till day this till has no orders for,
 * and so are tips: backfilling those would put months the tronc never ran as unpaid, which would
 * read as tips owed. Fetched a quarter at a time, as a sync is. What changed is reported by site,
 * before and after, so finance can see the restatement.
 */
export async function resyncTakings(org: OrgData, provider: EposProvider, from: string, to: string, now: Date): Promise<EposResyncResult> {
  const at = now.toISOString();
  const result: EposResyncResult = { at, from, to, ok: true, read: 0, unmatched: 0, changed: 0, sites: [] };
  const mapped = org.state.sites.filter((s) => s.eposLocationId);
  if (mapped.length === 0) return { ...result, ok: false, error: 'No site is matched to a till location yet.' };
  const bySite = new Map(mapped.map((s) => [s.id, { siteId: s.id, changed: 0, before: 0, after: 0 }]));

  try {
    const locations = await provider.listLocations();
    const zoneOf = (id: string) => locations.find((l) => l.id === id)?.timeZone ?? 'Europe/London';
    const missing = mapped.filter((s) => !locations.some((l) => l.id === s.eposLocationId));
    if (missing.length) throw new EposError(`${missing.map((s) => s.name).join(', ')} ${missing.length > 1 ? 'are' : 'is'} matched to a location the till no longer has. Match again in Settings.`, false);

    for (let start = from; start <= to; start = addDays(start, MAX_SYNC_DAYS)) {
      const end = addDays(start, MAX_SYNC_DAYS - 1) < to ? addDays(start, MAX_SYNC_DAYS - 1) : to;
      const tillDays = (siteId: string) =>
        (org.state.sales ?? []).filter((s) => s.siteId === siteId && s.source === 'till' && s.date >= start && s.date <= end).map((s) => s.date);
      const wanted = mapped.filter((s) => tillDays(s.id).length > 0);
      if (wanted.length === 0) continue;
      const orders = await provider.fetchOrders(
        wanted.map((s) => s.eposLocationId!),
        `${addDays(start, -1)}T00:00:00Z`,
        `${addDays(end, 2)}T00:00:00Z`,
      );
      for (const site of wanted) {
        const zone = zoneOf(site.eposLocationId!);
        const today = tradingHour(at, zone).date;
        const days = tradingDays(orders.filter((o) => o.locationId === site.eposLocationId), zone);
        // Only days the till has orders for. A day marked till that this till knows nothing of (another
        // till, a feed through the API, a closure) keeps its figure: reading it again would zero it.
        const finished = tillDays(site.id).filter((d) => d < today);
        const dates = finished.filter((d) => days.has(d)).sort();
        result.unmatched += finished.length - dates.length;
        const before = new Map((org.state.sales ?? []).filter((s) => s.siteId === site.id && dates.includes(s.date)).map((s) => [s.date, s.netSales]));
        org.state.sales = mergeTill(org.state.sales ?? [], site.id, dates, days).sales;
        result.read += dates.length;
        const tally = bySite.get(site.id)!;
        for (const date of dates) {
          const after = org.state.sales.find((s) => s.siteId === site.id && s.date === date)?.netSales ?? 0;
          if (Math.abs(after - (before.get(date) ?? 0)) < 0.005) continue;
          tally.changed++;
          tally.before += before.get(date) ?? 0;
          tally.after += after;
        }
      }
    }
  } catch (err) {
    return { ...result, ok: false, error: err instanceof Error ? err.message : String(err), ...summary() };
  }
  return { ...result, ...summary() };

  function summary() {
    const sites = [...bySite.values()]
      .filter((s) => s.changed > 0)
      .map((s) => ({ ...s, before: Math.round(s.before * 100) / 100, after: Math.round(s.after * 100) / 100 }));
    return { sites, changed: sites.reduce((n, s) => n + s.changed, 0) };
  }
}
