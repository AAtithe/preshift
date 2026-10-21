import type { Site } from './types';

// Columns any till export can be shaped into. Dates as 2026-10-19 or 19/10/2026; site by name, tracking code or id.
export const SALES_CSV_COLUMNS = 'date, hour, site, sales, covers (covers optional)';

/** Parses an hourly sales export into rows for the API, or says which line is wrong. */
export function parseSalesCsv(text: string, sites: Site[]): { rows: { siteId: string; date: string; hour: number; sales: number; covers?: number }[]; errors: string[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  // Quoted cells may hold commas, as exports write "£1,204.50".
  const cells = (l: string) => [...l.matchAll(/("([^"]*(?:""[^"]*)*)"|[^,]*)(,|$)/g)].slice(0, -1).map((m) => (m[2] ?? m[1]).replace(/""/g, '"').trim());
  const head = cells(lines[0] ?? '').map((h) => h.toLowerCase());
  const col = (name: string) => head.findIndex((h) => h === name || h.startsWith(name) || h.split(/[^a-z]+/).includes(name));
  const at = { date: col('date'), hour: col('hour'), site: col('site'), sales: col('sales'), covers: col('covers') };
  if (at.date < 0 || at.hour < 0 || at.site < 0 || at.sales < 0) return { rows: [], errors: [`The first line must name the columns: ${SALES_CSV_COLUMNS}.`] };
  const siteOf = (v: string) => sites.find((s) => [s.id, s.name, s.trackingCode].some((x) => x.toLowerCase() === v.toLowerCase()))?.id;
  const rows: ReturnType<typeof parseSalesCsv>['rows'] = [];
  const errors: string[] = [];
  lines.slice(1).forEach((line, i) => {
    const c = cells(line).concat(Array(head.length).fill(''));
    const uk = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(c[at.date]);
    const date = uk ? `${uk[3]}-${uk[2].padStart(2, '0')}-${uk[1].padStart(2, '0')}` : c[at.date];
    const hour = c[at.hour] === '' ? NaN : Number(c[at.hour].split(':')[0]);
    const sales = c[at.sales] === '' ? NaN : Number(c[at.sales].replace(/[£,]/g, ''));
    const siteId = siteOf(c[at.site] ?? '');
    const covers = at.covers >= 0 && c[at.covers] !== '' ? Number(c[at.covers]) : undefined;
    const problemWith = !/^\d{4}-\d{2}-\d{2}$/.test(date) ? 'date' : !(hour >= 0 && hour <= 23) ? 'hour' : !siteId ? `site "${c[at.site]}"` : Number.isNaN(sales) ? 'sales' : covers !== undefined && !(covers >= 0) ? 'covers' : null;
    if (problemWith) errors.push(`Line ${i + 2}: ${problemWith} not recognised.`);
    else rows.push({ siteId: siteId!, date, hour, sales, covers: covers === undefined ? undefined : Math.round(covers) });
  });
  return { rows, errors };
}
