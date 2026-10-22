import { describe, expect, it } from 'vitest';
import { mergeTill, tradingDays, tradingHour, type TillOrder } from './epos';
import type { DaySales } from './types';

const LONDON = 'Europe/London';

describe('trading day', () => {
  it('keeps the early hours with the night before, in UK local time either side of the clocks changing', () => {
    // British Summer Time: 23:30 UTC is 00:30 on the Sunday morning, still Saturday night's trade.
    expect(tradingHour('2026-10-24T23:30:00Z', LONDON)).toEqual({ date: '2026-10-24', hour: 24 });
    // Winter time: 01:15 UTC is 01:15 local.
    expect(tradingHour('2026-11-02T01:15:00Z', LONDON)).toEqual({ date: '2026-11-01', hour: 25 });
    // Lunch on a summer day is an hour ahead of UTC.
    expect(tradingHour('2026-07-01T11:59:00Z', LONDON)).toEqual({ date: '2026-07-01', hour: 12 });
  });

  it('adds orders up by trading day and hour', () => {
    const orders: TillOrder[] = [
      { locationId: 'L', closedAt: '2026-10-19T11:10:00Z', netSales: 40 },
      { locationId: 'L', closedAt: '2026-10-19T11:50:00Z', netSales: 22.5 },
      { locationId: 'L', closedAt: '2026-10-19T19:00:00Z', netSales: 100 },
      { locationId: 'L', closedAt: '2026-10-19T23:20:00Z', netSales: 10 },
    ];
    const day = tradingDays(orders, LONDON).get('2026-10-19')!;
    expect(day.netSales).toBe(172.5);
    expect(day.orders).toBe(4);
    expect(day.hours).toEqual([
      { hour: 12, netSales: 62.5, orders: 2 },
      { hour: 20, netSales: 100, orders: 1 },
      { hour: 24, netSales: 10, orders: 1 },
    ]);
  });
});

describe('merging till takings', () => {
  const existing: DaySales[] = [
    { siteId: 'mar', date: '2026-10-19', netSales: 4000, source: 'manual' },
    { siteId: 'mar', date: '2026-10-20', netSales: 3000, source: 'import' },
    { siteId: 'fitz', date: '2026-10-20', netSales: 999, source: 'till' },
  ];
  const days = new Map([['2026-10-20', { date: '2026-10-20', netSales: 3210.4, orders: 80, hours: [{ hour: 12, netSales: 3210.4, orders: 80 }] }]]);

  it('never overwrites a figure keyed in by hand, replaces imports, and records a day with no orders as nil', () => {
    const r = mergeTill(existing, 'mar', ['2026-10-19', '2026-10-20', '2026-10-21'], days);
    expect(r.kept).toEqual([{ siteId: 'mar', date: '2026-10-19' }]);
    expect(r.written).toBe(2);
    const mar = (d: string) => r.sales.find((s) => s.siteId === 'mar' && s.date === d);
    expect(mar('2026-10-19')).toMatchObject({ netSales: 4000, source: 'manual' });
    expect(mar('2026-10-20')).toMatchObject({ netSales: 3210.4, orders: 80, source: 'till' });
    expect(mar('2026-10-21')).toMatchObject({ netSales: 0, orders: 0, source: 'till' });
    // Another site's takings are untouched.
    expect(r.sales.find((s) => s.siteId === 'fitz')?.netSales).toBe(999);
    expect(r.sales.filter((s) => s.siteId === 'mar' && s.date === '2026-10-20')).toHaveLength(1);
  });
});
