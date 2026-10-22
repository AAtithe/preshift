import { describe, expect, it } from 'vitest';
import { learnEventEffect, parseIcs } from './events';
import { baselineForecast } from './forecast';
import { siteHistory } from './history';
import { dueReminders, historyWeatherFactors, planAhead, unusualDays } from './plan';
import { seedState } from './seed';
import { addDays, weekday } from './time';
import type { DailyWeather, HourActual, LocalEvent, RotaState } from './types';
import { learnWeatherEffect, weatherFactor } from './weather';

const TODAY = '2026-10-21';

/** A site trading £100 an hour 11:00 to 22:00, plus `extra` on chosen days and hours. */
function history(from: string, to: string, extra: (date: string, hour: number) => number = () => 0): HourActual[] {
  const rows: HourActual[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    for (let hour = 11; hour < 22; hour++) rows.push({ siteId: 'mar', date: d, hour, sales: 100 + extra(d, hour), covers: 3 });
  }
  return rows;
}

function weatherRows(from: string, to: string, temp: (d: string) => number, rain: (d: string) => number = () => 0, observedUntil = TODAY): DailyWeather[] {
  const rows: DailyWeather[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    rows.push({ siteId: 'mar', date: d, tempMax: temp(d), tempMin: temp(d) - 8, precipitationMm: rain(d), observed: d < observedUntil, fetchedAt: '2026-10-21T06:00:00Z' });
  }
  return rows;
}

const base = (over: Partial<RotaState>): RotaState => ({ ...seedState(TODAY), actuals: [], weather: [], localEvents: [], forecastAdjustments: [], ...over });

describe('weather', () => {
  // Every third day is 6 degrees warmer and trades 12% up; every fifth day is wet and trades 10% down.
  const warm = (d: string) => Number(d.slice(8)) % 3 === 0;
  const wet = (d: string) => Number(d.slice(8)) % 5 === 0;
  const actuals = history('2026-07-01', '2026-10-20', (d) => (warm(d) ? 12 : 0) - (wet(d) ? 10 : 0));
  const weather = weatherRows('2026-07-01', '2026-10-31', (d) => (warm(d) ? 24 : 18), (d) => (wet(d) ? 6 : 0));

  it('learns how this site trades in warm and wet weather', () => {
    const effect = learnWeatherEffect(siteHistory(actuals, 'mar'), weather, 'mar', new Set());
    expect(effect.usable).toBe(true);
    expect(effect.perDegree).toBeGreaterThan(0.01);
    expect(effect.wet).toBeLessThan(-0.05);
  });

  it('needs four weeks of history before it adjusts anything', () => {
    const effect = learnWeatherEffect(siteHistory(actuals.filter((a) => a.date >= '2026-10-01'), 'mar'), weather, 'mar', new Set());
    expect(effect.usable).toBe(false);
    expect(weatherFactor(effect, weather[0], 18)).toBe(1);
  });

  it('applies the learnt effect to forecast days, with the evidence', () => {
    const plan = planAhead(base({ actuals, weather }), 'mar', '2026-10-24', '2026-10-30', TODAY);
    const hot = plan.days.find((d) => d.date === '2026-10-27')!; // the 27th is a warm day
    const adj = hot.adjustments.find((a) => a.kind === 'weather')!;
    expect(adj.factor).toBeGreaterThan(1);
    expect(adj.evidence).toMatch(/per degree warmer/);
  });

  it('takes the weather out of the figures the model learns from', () => {
    const state = base({ actuals, weather });
    const effect = learnWeatherEffect(siteHistory(actuals, 'mar'), weather, 'mar', new Set());
    const factors = historyWeatherFactors(state, 'mar', effect);
    expect(factors.get('2026-10-12')).toBeGreaterThan(1); // warm and dry
    // The mechanism: a run of days the weather lifted 20% is learnt as normal trade, not as the new level.
    const lifted = new Map(actuals.map((a) => [a.date, 1.2]));
    const raw = baselineForecast(actuals, 'mar', ['2026-10-26'], { bankHolidays: [] }).rows.find((r) => r.hour === 12)!.sales;
    const clean = baselineForecast(actuals, 'mar', ['2026-10-26'], { bankHolidays: [], historyFactors: lifted }).rows.find((r) => r.hour === 12)!.sales;
    expect(clean).toBeCloseTo(raw / 1.2, -1);
  });
});

describe('occasions in the plan', () => {
  it('applies last year’s Mothering Sunday lift to its hours, and reminds five weeks ahead', () => {
    // Fifteen months of history with last Mothering Sunday lunch at double.
    const actuals = history('2025-01-01', '2026-03-01', (d, h) => (d === '2025-03-30' && h >= 11 && h < 17 ? 100 : 0));
    const plan = planAhead(base({ actuals }), 'mar', '2026-03-09', '2026-03-15', '2026-02-10');
    const day = plan.days.find((d) => d.date === '2026-03-15')!;
    const adj = day.adjustments.find((a) => a.kind === 'occasion')!;
    expect(adj).toMatchObject({ fromHour: 11, toHour: 17, reason: 'event', source: 'auto' });
    expect(adj.factor).toBeCloseTo(2, 1);
    expect(adj.evidence).toMatch(/^Last year Mothering Sunday took/);
    const r = plan.reminders.find((x) => x.key === 'occasion:mothering-sunday:2026-03-15')!;
    expect(r.dueFrom).toBe('2026-02-08');
    expect(dueReminders(plan, '2026-02-10').map((x) => x.key)).toContain(r.key);
    expect(dueReminders(plan, '2026-02-01')).toEqual([]);
  });

  it('never adjusts a bank holiday twice, and asks for a view where there is no history', () => {
    const plan = planAhead(base({ actuals: history('2026-07-01', '2026-10-20') }), 'mar', '2026-12-18', '2026-12-28', TODAY);
    const christmas = plan.days.find((d) => d.date === '2026-12-25')!;
    expect(christmas.adjustments).toEqual([]);
    expect(plan.reminders.find((r) => r.key.startsWith('occasion:bh-christmas'))!.needsInput).toBe(false);
    const mad = plan.reminders.find((r) => r.key === 'occasion:mad-friday:2026-12-18')!;
    expect(mad.needsInput).toBe(true);
    expect(mad.applied).toEqual([]);
  });

  it('lets a person’s own adjustment win over the automatic one', () => {
    const actuals = history('2025-01-01', '2026-03-01', (d, h) => (d === '2025-03-30' && h >= 11 && h < 17 ? 100 : 0));
    const manual = [{ id: 'm', siteId: 'mar', date: '2026-03-15', factor: 1.3, reason: 'event' as const, note: 'Booked to 120 covers' }];
    const plan = planAhead(base({ actuals, forecastAdjustments: manual }), 'mar', '2026-03-09', '2026-03-15', '2026-02-10');
    expect(plan.days.find((d) => d.date === '2026-03-15')!.adjustments).toEqual([]);
    expect(plan.reminders.find((x) => x.key === 'occasion:mothering-sunday:2026-03-15')!.applied).toEqual([]);
  });

  it('treats occasion and event days as unusual so they do not distort normal days', () => {
    const state = base({ actuals: history('2026-01-01', '2026-10-20'), localEvents: [{ id: 'e', siteId: 'mar', date: '2026-09-12', name: 'Match', source: 'manual' }] });
    const days = unusualDays(state, 'mar');
    expect(days.has('2026-03-15')).toBe(true); // Mothering Sunday
    expect(days.has('2026-09-12')).toBe(true);
    expect(days.has('2026-03-29')).toBe(false); // clocks change is operational, not unusual trade
  });
});

describe('local events', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:m1@club',
    'DTSTART:20260912T143000Z',
    'SUMMARY:Home v Rovers',
    'LOCATION:The Ground\\, N5',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:m2@club',
    'DTSTART;TZID=Europe/Paris:20261003T190000',
    'SUMMARY:Home v City (kick-off moved',
    // Folding adds one space, which unfolding removes: the word gap is the second space.
    '  for TV)',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:fair',
    'DTSTART;VALUE=DATE:20261108',
    'SUMMARY:Christmas market opens',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  it('skips cancelled fixtures and copes with colons inside parameters', () => {
    const feed = [
      'BEGIN:VEVENT', 'UID:c', 'DTSTART:20261024T140000Z', 'STATUS:CANCELLED', 'SUMMARY:Postponed', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:d', 'DTSTART:20261025T140000Z', 'DESCRIPTION;ALTREP="https://club.example/x":Details', 'SUMMARY:Home v United', 'END:VEVENT',
    ].join('\r\n');
    expect(parseIcs(feed).map((e) => e.summary)).toEqual(['Home v United']);
  });

  it('reads iCal feeds into London time, folded lines and all', () => {
    const events = parseIcs(ics);
    expect(events).toEqual([
      { uid: 'm1@club', summary: 'Home v Rovers', date: '2026-09-12', startMinute: 15 * 60 + 30, location: 'The Ground, N5' },
      { uid: 'm2@club', summary: 'Home v City (kick-off moved for TV)', date: '2026-10-03', startMinute: 18 * 60, location: undefined },
      { uid: 'fair', summary: 'Christmas market opens', date: '2026-11-08', location: undefined },
    ]);
  });

  it('learns a feed’s effect from its past events and applies it to the next one', () => {
    const matchDays = ['2026-08-22', '2026-09-05', '2026-09-19'];
    const actuals = history('2026-07-01', '2026-10-20', (d, h) => (matchDays.includes(d) && h >= 12 && h < 20 ? 50 : 0));
    const events: LocalEvent[] = [...matchDays, '2026-10-31'].map((date, i) => ({ id: `m${i}`, siteId: 'mar', feedId: 'club', date, startMinute: 15 * 60, name: 'Home game', source: 'ics' }));
    const effect = learnEventEffect(siteHistory(actuals, 'mar'), events, 'club', TODAY, new Set());
    expect(effect.usable).toBe(true);
    expect(effect.factor).toBeCloseTo(1.5, 1);
    const plan = planAhead(base({ actuals, localEvents: events }), 'mar', '2026-10-26', '2026-11-01', TODAY);
    const adj = plan.days.find((d) => d.date === '2026-10-31')!.adjustments.find((a) => a.kind === 'event')!;
    expect(adj).toMatchObject({ fromHour: 12, toHour: 20 });
    expect(adj.factor).toBeCloseTo(1.5, 1);
    expect(weekday('2026-10-31')).toBe(5);
  });

  it('asks for a view on an event with no history', () => {
    const events: LocalEvent[] = [{ id: 'x', siteId: 'mar', date: '2026-10-30', name: 'Arena concert', source: 'manual' }];
    const plan = planAhead(base({ actuals: history('2026-07-01', '2026-10-20'), localEvents: events }), 'mar', '2026-10-26', '2026-11-01', TODAY);
    const r = plan.reminders.find((x) => x.key === 'event:x')!;
    expect(r.needsInput).toBe(true);
    expect(plan.days.find((d) => d.date === '2026-10-30')!.adjustments).toEqual([]);
  });
});

describe('effects that land together', () => {
  it('caps the model’s own adjustments in total, but leaves what people set alone', () => {
    const rows = history('2026-07-01', '2026-10-20');
    const auto = (factor: number, kind: string) => ({ id: kind, siteId: 'mar', date: '2026-10-26', factor, reason: 'event' as const, source: 'auto' as const });
    const capped = baselineForecast(rows, 'mar', ['2026-10-26'], { bankHolidays: [], adjustments: [auto(2.5, 'o'), auto(1.6, 'e'), auto(1.3, 'w')] });
    expect(capped.rows.find((r) => r.hour === 12)!.sales).toBe(250);
    const manual = baselineForecast(rows, 'mar', ['2026-10-26'], { bankHolidays: [], adjustments: [auto(2.5, 'o'), { ...auto(2, 'm'), source: undefined }] });
    expect(manual.rows.find((r) => r.hour === 12)!.sales).toBe(500);
  });

  it('applies one event when two feeds list the same match', () => {
    const matchDays = ['2026-08-22', '2026-09-05', '2026-09-19'];
    const actuals = history('2026-07-01', '2026-10-20', (d, h) => (matchDays.includes(d) && h >= 12 && h < 20 ? 50 : 0));
    const events: LocalEvent[] = ['a', 'b'].flatMap((feed) =>
      [...matchDays, '2026-10-31'].map((date, i) => ({ id: `${feed}${i}`, siteId: 'mar', feedId: feed, date, startMinute: 15 * 60, name: 'Home game', source: 'ics' as const })),
    );
    const plan = planAhead(base({ actuals, localEvents: events }), 'mar', '2026-10-26', '2026-11-01', TODAY);
    expect(plan.days.find((d) => d.date === '2026-10-31')!.adjustments.filter((a) => a.kind === 'event')).toHaveLength(1);
  });

  it('does not learn a feed’s effect from events on bank holidays', () => {
    // Boxing Day fixtures trade huge because it is Boxing Day; ordinary fixtures do nothing.
    const fixtures = ['2025-12-26', '2026-04-06', '2026-08-15', '2026-09-12'];
    const actuals = history('2025-11-01', '2026-10-20', (d) => (d === '2025-12-26' || d === '2026-04-06' ? 200 : 0));
    const events: LocalEvent[] = fixtures.map((date, i) => ({ id: `f${i}`, siteId: 'mar', feedId: 'club', date, startMinute: 15 * 60, name: 'Home game', source: 'ics' }));
    const effect = learnEventEffect(siteHistory(actuals, 'mar'), events, 'club', TODAY, new Set(), new Set(['2025-12-26', '2026-04-06']));
    expect(effect.events).toBe(2);
    expect(effect.factor).toBeCloseTo(1, 1);
  });
});

describe('automatic adjustments are never a closure', () => {
  it('keeps every automatic factor well clear of zero', () => {
    const matchDays = ['2026-08-22', '2026-09-05'];
    const actuals = history('2026-07-01', '2026-10-20', (d) => (matchDays.includes(d) ? -99 : 0));
    const events: LocalEvent[] = [...matchDays, '2026-10-31'].map((date, i) => ({ id: `m${i}`, siteId: 'mar', feedId: 'club', date, name: 'Road closed', source: 'ics' }));
    const plan = planAhead(base({ actuals, localEvents: events }), 'mar', '2026-10-26', '2026-11-01', TODAY);
    const all = plan.days.flatMap((d) => d.adjustments);
    expect(all.length).toBeGreaterThan(0);
    for (const a of all) expect(a.factor).toBeGreaterThanOrEqual(0.5);
  });
});
