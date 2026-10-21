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
