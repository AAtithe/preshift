const gbp0 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
const gbp2 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

export const money = (n: number) => gbp0.format(n);
export const money2 = (n: number) => gbp2.format(n);
export const pct = (n: number, dp = 1) => `${(n * 100).toFixed(dp)}%`;
export const hours = (n: number) => `${n.toFixed(1)}h`;

export function dayLabel(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  return {
    short: d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }),
    date: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
  };
}

export function download(filename: string, content: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Rows to CSV: figures to two places, text quoted. */
export const toCsv = (rows: (string | number)[][]) =>
  rows.map((r) => r.map((v) => (typeof v === 'number' ? v.toFixed(2) : `"${v.replace(/"/g, '""')}"`)).join(',')).join('\n');
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const signed = (n: number, f: (n: number) => string) => `${n > 0 ? '+' : ''}${f(n)}`;

/** One CSV row, quoting cells that hold a comma, quote or line break. */
export function csvLine(cells: (string | number)[]) {
  return cells.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(',');
}

/** Accounting style: costs in brackets, as they would sit in a management P&L. */
export const ledger = (n: number) => (n < 0 ? `(${gbp0.format(-n).replace('£', '')})` : gbp0.format(n).replace('£', ''));

/**
 * Round to whole pounds so the parts add up to the rounded total (largest remainder).
 * Pass the total when the parts must tie to a figure shown elsewhere.
 */
export function roundToTotal(values: number[], total = values.reduce((a, b) => a + b, 0)) {
  const floors = values.map(Math.floor);
  let gap = Math.round(total) - floors.reduce((a, b) => a + b, 0);
  // Largest fractions take a pound up; if the parts overshoot the total, the smallest give one back.
  const order = values.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; gap !== 0 && k < order.length * (Math.abs(gap) + 1); k++) {
    const i = gap > 0 ? order[k % order.length][1] : order[order.length - 1 - (k % order.length)][1];
    floors[i] += gap > 0 ? 1 : -1;
    gap += gap > 0 ? -1 : 1;
  }
  return floors;
}

/** ISO 8601 week number, the way most hospitality groups number their trading weeks. */
export function isoWeek(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  // The ISO week belongs to the year of its Thursday.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
}
