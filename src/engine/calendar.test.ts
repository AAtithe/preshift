import { describe, expect, it } from 'vitest';
import { bankHolidays, easterSunday, occasionEffect, occasions, occasionsBetween } from './calendar';
import { BANK_HOLIDAYS_ENGLAND_WALES } from './forecast';
import { siteHistory } from './history';
import { addDays, weekday } from './time';
import type { HourActual } from './types';

describe('UK trading calendar', () => {
  it('finds Easter for any year', () => {
    expect(easterSunday(2025)).toBe('2025-04-20');
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
    expect(easterSunday(2028)).toBe('2028-04-16');
    expect(easterSunday(2038)).toBe('2038-04-25');
  });

  it('computes the same bank holidays as the published list, substitute days included', () => {
    const computed = [2025, 2026, 2027, 2028].flatMap((y) => bankHolidays(y).map((h) => h.date));
    expect(computed).toEqual(BANK_HOLIDAYS_ENGLAND_WALES);
  });

  it('places the moving occasions', () => {
    const y = occasions(2026);
    const on = (key: string) => y.find((o) => o.key === key)!.date;
    expect(on('mothering-sunday')).toBe('2026-03-15');
    expect(on('shrove-tuesday')).toBe('2026-02-17');
    expect(on('fathers-day')).toBe('2026-06-21');
    expect(on('clocks-forward')).toBe('2026-03-29');
    expect(on('clocks-back')).toBe('2026-10-25');
    expect(on('black-friday')).toBe('2026-11-27');
    expect(on('mad-friday')).toBe('2026-12-18');
    expect(on('party-season')).toBe('2026-12-04');
    for (const key of ['mothering-sunday', 'fathers-day', 'clocks-back', 'easter-sunday']) expect(weekday(on(key))).toBe(6);
  });

  it('never calls Christmas Eve Mad Friday, and names Christmas and Boxing Day right in a Sunday year', () => {
    expect(occasions(2027).find((o) => o.key === 'mad-friday')!.date).toBe('2027-12-17');
    expect(occasions(2021).find((o) => o.key === 'mad-friday')!.date).toBe('2021-12-17');
    expect(bankHolidays(2022).filter((h) => h.date >= '2022-12-01')).toEqual([
      { date: '2022-12-26', name: 'Boxing Day' },
      { date: '2022-12-27', name: 'Christmas Day' },
    ]);
  });

  it('carries the one-off holidays that no rule predicts', () => {
    const d2022 = bankHolidays(2022).map((h) => h.date);
    expect(d2022).toContain('2022-06-03');
    expect(d2022).toContain('2022-09-19');
    expect(d2022).not.toContain('2022-05-30');
    expect(bankHolidays(2023).map((h) => h.date)).toContain('2023-05-08');
    expect(bankHolidays(2020).map((h) => h.date)).not.toContain('2020-05-04');
  });

  it('marks occasions that fall on bank holidays so they are not adjusted twice', () => {
    const y = occasions(2026);
    expect(y.find((o) => o.key === 'bh-good-friday')!.bankHoliday).toBe(true);
    expect(y.find((o) => o.key === 'easter-sunday')!.bankHoliday).toBe(false);
  });

  it('lists occasions across a year end', () => {
    expect(occasionsBetween('2026-12-30', '2027-01-02').map((o) => o.key)).toEqual(['new-years-eve', 'bh-new-year-s-day']);
  });
});

describe('occasion effect', () => {
  // Fifteen months of flat Sunday lunch at £1,000, then last Mothering Sunday at £1,800.
  const rows: HourActual[] = [];
  for (let d = '2025-01-05'; d <= '2026-03-01'; d = addDays(d, 7)) {
    rows.push({ siteId: 'mar', date: d, hour: 13, sales: d === '2025-03-30' ? 1800 : 1000, covers: 25 });
  }
  const h = siteHistory(rows, 'mar');
  const mothering2026 = occasions(2026).find((o) => o.key === 'mothering-sunday')!;

  it('learns last year’s uplift against the level the site traded at then', () => {
    const effect = occasionEffect(h, mothering2026, new Set(['2025-03-30']));
    expect(effect).toMatchObject({ lastDate: '2025-03-30', lastSales: 1800, normalSales: 1000 });
    expect(effect!.factor).toBeCloseTo(1.8);
  });

  it('is unknown without last year’s history', () => {
    expect(occasionEffect(siteHistory([], 'mar'), mothering2026, new Set())).toBeNull();
  });
});
