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
