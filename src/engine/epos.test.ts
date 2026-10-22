import { describe, expect, it } from 'vitest';
import { mergeTill, mergeTillTips, tradingDays, tradingHour, type TillOrder, type TradingDay } from './epos';
import type { DaySales, TipsTaken } from './types';

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

describe('card tips from the till', () => {
  const day = (date: string, tips: number): [string, TradingDay] => [date, { date, netSales: 1000, orders: 30, hours: [], tips }];
  const days = new Map([day('2026-10-19', 84.5), day('2026-10-20', 61), day('2026-10-21', 0), day('2026-10-22', 40)]);
  const existing: TipsTaken[] = [
    // Keyed in by hand at cash-up: it stands.
    { id: 'h', siteId: 'mar', date: '2026-10-19', source: 'card-tip', amount: 90 },
    // An earlier sync's figure: the till moves it.
    { id: 'old', siteId: 'mar', date: '2026-10-20', source: 'card-tip', amount: 55, fromTill: true },
    // A till figure on a day the till now shows none on: cleared.
    { id: 'gone', siteId: 'mar', date: '2026-10-21', source: 'card-tip', amount: 12, fromTill: true },
    // Service charge and another site are none of the till feed's business.
    { id: 'sc', siteId: 'mar', date: '2026-10-20', source: 'service-charge', amount: 300 },
    { id: 'fz', siteId: 'fitz', date: '2026-10-20', source: 'card-tip', amount: 7, fromTill: true },
  ];

  it('adds each order’s card tips into its trading day, apart from takings', () => {
    const orders = [
      { locationId: 'L', closedAt: '2026-10-19T12:00:00Z', netSales: 40, tips: 4 },
      { locationId: 'L', closedAt: '2026-10-19T23:30:00Z', netSales: 20, tips: 2.5 },
      { locationId: 'L', closedAt: '2026-10-19T13:00:00Z', netSales: 30 },
    ];
    expect(tradingDays(orders, 'Europe/London').get('2026-10-19')).toMatchObject({ netSales: 90, tips: 6.5 });
  });

  it('keeps hand-keyed figures, follows its own, clears a day it now shows none on, and leaves the rest alone', () => {
    const r = mergeTillTips(existing, 'mar', ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'], days);
    const card = (d: string) => r.tips.find((t) => t.siteId === 'mar' && t.date === d && t.source === 'card-tip');
    expect(r.kept).toEqual([{ siteId: 'mar', date: '2026-10-19' }]);
    expect(card('2026-10-19')).toMatchObject({ amount: 90 });
    expect(card('2026-10-20')).toMatchObject({ id: 'old', amount: 61, fromTill: true });
    expect(card('2026-10-21')).toBeUndefined();
    expect(card('2026-10-22')).toMatchObject({ amount: 40, fromTill: true });
    expect(r.written).toBe(3);
    expect(r.tips.find((t) => t.id === 'sc')?.amount).toBe(300);
    expect(r.tips.find((t) => t.id === 'fz')?.amount).toBe(7);
  });

  it('never changes a figure payroll has paid, and says where the till now disagrees', () => {
    const paid: TipsTaken[] = [{ id: 'p', siteId: 'mar', date: '2026-10-20', source: 'card-tip', amount: 55, fromTill: true, paidOn: '2026-10-25' }];
    const r = mergeTillTips(paid, 'mar', ['2026-10-20'], days);
    expect(r.tips).toEqual(paid);
    expect(r.written).toBe(0);
    expect(r.paidDiffers).toEqual([{ siteId: 'mar', date: '2026-10-20', paid: 55, till: 61 }]);
    expect(mergeTillTips([{ ...paid[0], amount: 61 }], 'mar', ['2026-10-20'], days).paidDiffers).toEqual([]);
  });
});

describe('service charge from the till', () => {
  const days = new Map<string, TradingDay>([
    ['2026-10-19', { date: '2026-10-19', netSales: 1000, orders: 30, hours: [], tips: 40, serviceCharge: 125 }],
    ['2026-10-20', { date: '2026-10-20', netSales: 800, orders: 20, hours: [], tips: 30, serviceCharge: 0 }],
  ]);

  it('adds each order’s service charge into its trading day', () => {
    const orders = [
      { locationId: 'L', closedAt: '2026-10-19T12:00:00Z', netSales: 40, serviceCharge: 5 },
      { locationId: 'L', closedAt: '2026-10-19T23:30:00Z', netSales: 20, serviceCharge: 2.5, tips: 1 },
    ];
    expect(tradingDays(orders, 'Europe/London').get('2026-10-19')).toMatchObject({ netSales: 60, serviceCharge: 7.5, tips: 1 });
  });

  it('writes it as its own figure, by the same rules, and leaves the card tips alone', () => {
    const existing: TipsTaken[] = [
      { id: 'c', siteId: 'mar', date: '2026-10-19', source: 'card-tip', amount: 99 },
      { id: 'sc', siteId: 'mar', date: '2026-10-20', source: 'service-charge', amount: 80, fromTill: true },
    ];
    const r = mergeTillTips(existing, 'mar', ['2026-10-19', '2026-10-20'], days, 'service-charge');
    const sc = (d: string) => r.tips.find((t) => t.date === d && t.source === 'service-charge');
    expect(sc('2026-10-19')).toMatchObject({ id: 'tip-mar-2026-10-19-service-charge', amount: 125, fromTill: true });
    // The till now shows none on Tuesday (taken off, or refunded): its own figure goes.
    expect(sc('2026-10-20')).toBeUndefined();
    expect(r.tips.find((t) => t.id === 'c')?.amount).toBe(99);
    expect(r.written).toBe(2);
  });
});
