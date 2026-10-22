import { mergeTill, tradingDays, tradingHour } from '../../../src/engine/epos';
import { addDays } from '../../../src/engine/time';
import type { OrgData } from '../../store';
import { EposError, type EposBackfill, type EposProvider, type EposSyncResult } from './provider';

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
      const inRange = dates.map((d) => days.get(d)).filter((d) => d !== undefined);
      result.sites.push({
        siteId: site.id,
        netSales: Math.round(inRange.reduce((s, d) => s + d.netSales, 0) * 100) / 100,
        orders: inRange.reduce((s, d) => s + d.orders, 0),
      });
    }
  } catch (err) {
    return { ...result, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return result;
}

/** Days one backfill step brings in: short enough for any request to finish well inside its limit. */
export const BACKFILL_CHUNK_DAYS = 14;

/** Thirteen months: a year to forecast from the same week last year, plus the four weeks that set its trend. */
export const BACKFILL_DAYS = 400;

/**
 * Brings in the next chunk of a backfill. A failed chunk is not skipped: the job stops on it with
 * the reason, and the next step tries the same days again, so no gap is left behind silently.
 */
export async function backfillStep(org: OrgData, provider: EposProvider, now: Date): Promise<EposBackfill | undefined> {
  const job = org.epos?.backfill;
  if (!job || job.finishedAt) return job;
  const last = addDays(job.next, BACKFILL_CHUNK_DAYS - 1) < job.to ? addDays(job.next, BACKFILL_CHUNK_DAYS - 1) : job.to;
  const result = await syncEpos(org, provider, job.next, last, now);
  if (!result.ok) {
    job.error = result.error;
    return job;
  }
  delete job.error;
  job.written += result.written;
  job.next = addDays(last, 1);
  if (job.next > job.to) job.finishedAt = now.toISOString();
  return job;
}
