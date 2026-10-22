import type { DailyWeather, ForecastAdjustment, LocalEvent, RotaState } from './types';
import { bookingSignals, type BookingSignal } from './bookings';
import { occasionEffect, occasionsBetween, type Occasion } from './calendar';
import { eventWindow, learnEventEffect, type EventEffect } from './events';
import { siteHistory } from './history';
import { addDays, formatMinute, parseISODate, weekday } from './time';
import type { SchoolPeriod } from './types';
import { inHoliday, learnSchoolEffect, schoolDayFactor, schoolHolidays, type SchoolEffect } from './school';
import { DAYPARTS } from './forecast';
import { isChildOn } from './compliance';
import { describeWeather, learnWeatherEffect, seasonalTemp, weatherFactor, type WeatherEffect } from './weather';

// Planning ahead: everything known about the coming weeks at a site (the
// trading calendar, local events and the weather) turned into automatic
// adjustments to the forecast where the site's own history says what they do,
// and into reminders where it does not, or where something needs doing first.

export type AutoKind = 'occasion' | 'event' | 'weather' | 'school';
export type ReminderKind = AutoKind | 'bookings';

/** An adjustment the model made itself, with the evidence behind it. Never zero: only a person can close a site. */
export interface AutoAdjustment extends ForecastAdjustment {
  source: 'auto';
  kind: AutoKind;
  evidence: string;
}

export interface CalendarDay {
  date: string;
  occasions: Occasion[];
  events: LocalEvent[];
  weather?: DailyWeather;
  weatherText?: string;
  adjustments: AutoAdjustment[];
  /** Manual adjustments people have set for the day. */
  manual: ForecastAdjustment[];
  /** What the books say, by daypart. */
  bookings: BookingSignal[];
  /** The school holiday the day falls in, estimated or confirmed. */
  school?: SchoolPeriod;
}

export interface Reminder {
  /** Stable across refreshes, so a dismissal sticks. */
  key: string;
  kind: ReminderKind;
  date: string;
  /** From when it should be shown. */
  dueFrom: string;
  title: string;
  advice: string;
  /** What the model has already applied for it; empty when it needs a person's view. */
  applied: AutoAdjustment[];
  /** No history to learn from: the GM should set an expectation. */
  needsInput: boolean;
  fromHour?: number;
  toHour?: number;
}

export interface Plan {
  siteId: string;
  from: string;
  to: string;
  days: CalendarDay[];
  reminders: Reminder[];
  weatherEffect: WeatherEffect;
  eventEffects: EventEffect[];
  /** Every booking signal in the range, for the model run to set against its own covers. */
  bookingSignals: BookingSignal[];
  schoolEffects: SchoolEffect[];
}

/** Pace well ahead of or behind usual must be at least this many covers before it is a reminder. */
export const PACE_MIN_COVERS = 10;
const pctText = (f: number) => `${f >= 1 ? '+' : ''}${Math.round((f - 1) * 100)}%`;
const money = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;
const span = (from?: number, to?: number) => (from === undefined && to === undefined ? '' : ` ${String(from ?? 0).padStart(2, '0')}:00 to ${String(to ?? 24).padStart(2, '0')}:00`);

/**
 * Days that were not normal trade at a site: occasions, bank holidays, local
 * events and anything someone adjusted by hand. They are left out when working
 * out what a normal day looks like and when the model learns.
 */
export function unusualDays(state: RotaState, siteId: string): Set<string> {
  const actuals = (state.actuals ?? []).filter((a) => a.siteId === siteId);
  const out = new Set<string>();
  if (actuals.length) {
    const dates = actuals.map((a) => a.date).sort();
    // A year either side of the history, so occasions in the dates being forecast count too.
    const from = addDays(dates[0], -1);
    const to = addDays(dates[dates.length - 1], 400);
    for (const o of occasionsBetween(from, to)) if (o.kind === 'occasion' || o.kind === 'bank_holiday') out.add(o.date);
  }
  for (const e of state.localEvents ?? []) if (e.siteId === siteId) out.add(e.date);
  for (const a of state.forecastAdjustments ?? []) if (a.siteId === siteId) out.add(a.date);
  return out;
}

/**
 * The weather's effect on each past day, so the model learns from trade with
 * the weather taken out: a heatwave fortnight should not make next week's
 * forecast hot.
 */
export function historyWeatherFactors(state: RotaState, siteId: string, effect: WeatherEffect): Map<string, number> {
  const out = new Map<string, number>();
  if (!effect.usable) return out;
  const mine = (state.weather ?? []).filter((w) => w.siteId === siteId);
  for (const w of mine) if (w.observed) out.set(w.date, weatherFactor(effect, w, seasonalTemp(mine, w.date)));
  return out;
}

/** Everything a site has learnt from its own history that is not about one day: school holidays and weather. */
export interface SiteLearning {
  unusual: Set<string>;
  /** Holidays from the start of the history to a year ahead: the council's where given, the estimate otherwise. */
  holidays: SchoolPeriod[];
  schoolEffects: SchoolEffect[];
  weatherEffect: WeatherEffect;
  /** What school holidays and the weather did to each past day, taken out of training figures. */
  factors: Map<string, number>;
}

/**
 * Learns, in order: what school holidays do (on raw history, unusual days
 * left out), then what the weather does (with the holidays taken out), then
 * the two together for each past day, so neither is counted twice.
 */
export function learnSite(state: RotaState, siteId: string): SiteLearning {
  const unusual = unusualDays(state, siteId);
  const actuals = state.actuals ?? [];
  const dates = actuals.filter((a) => a.siteId === siteId).map((a) => a.date).sort();
  const site = state.sites.find((s) => s.id === siteId);
  const estimate = !site?.nation || site.nation === 'england' || site.nation === 'wales';
  const confirmed = (state.schoolHolidays ?? []).filter((p) => p.siteId === siteId);
  const holidays = dates.length ? schoolHolidays(confirmed, dates[0], addDays(dates[dates.length - 1], 400), estimate) : [];
  const raw = siteHistory(actuals, siteId);
  const schoolEffects = learnSchoolEffect(raw, holidays, unusual);
  const schoolF = new Map<string, number>();
  for (const d of raw.days.keys()) {
    if (unusual.has(d) || !inHoliday(holidays, d)) continue;
    const f = schoolDayFactor(schoolEffects, raw, d);
    if (f !== 1) schoolF.set(d, f);
  }
  const weatherEffect = learnWeatherEffect(siteHistory(actuals, siteId, schoolF), (state.weather ?? []).filter((w) => w.siteId === siteId), siteId, unusual);
  const factors = new Map(schoolF);
  for (const [d, f] of historyWeatherFactors(state, siteId, weatherEffect)) factors.set(d, (factors.get(d) ?? 1) * f);
  return { unusual, holidays, schoolEffects, weatherEffect, factors };
}

/** Drops automatic adjustments a person has already decided on. A closure overrides everything. */
function manualWins(auto: AutoAdjustment[], manual: ForecastAdjustment[]): AutoAdjustment[] {
  return auto.filter((a) => {
    const same = manual.filter((m) => m.date === a.date && m.siteId === a.siteId);
    if (same.some((m) => m.reason === 'closure')) return false;
    if (a.kind === 'weather') return !same.some((m) => m.reason === 'weather');
    return !same.some((m) => m.reason === 'event' || m.reason === 'bank_holiday' || m.reason === 'other');
  });
}

export function planAhead(state: RotaState, siteId: string, from: string, to: string, today: string): Plan {
  const learnt = learnSite(state, siteId);
  const { unusual, weatherEffect, schoolEffects } = learnt;
  const site = state.sites.find((s) => s.id === siteId);
  const estimate = !site?.nation || site.nation === 'england' || site.nation === 'wales';
  // Holidays for the range itself, even with no history yet.
  const holidaysAhead = schoolHolidays((state.schoolHolidays ?? []).filter((p) => p.siteId === siteId), from, to, estimate);
  const weather = (state.weather ?? []).filter((w) => w.siteId === siteId);
  // Occasions and events are judged with the weather and school holidays taken out, so a hot Easter last year is not learnt as Easter.
  const h = siteHistory(state.actuals ?? [], siteId, learnt.factors);
  const events = (state.localEvents ?? []).filter((e) => e.siteId === siteId);
  const manual = (state.forecastAdjustments ?? []).filter((a) => a.siteId === siteId);
  const occasionDays = new Set([...unusual].filter((d) => !events.some((e) => e.date === d)));
  const feedIds = [...new Set(events.map((e) => e.feedId).filter((f): f is string => !!f))];
  const eventEffects = feedIds.map((feedId) => learnEventEffect(h, events, feedId, today, unusual, occasionDays));

  const reminders: Reminder[] = [];
  const weatherAt = (date: string) => {
    const w = weather.find((x) => x.date === date && !x.observed);
    return w ? weatherFactor(weatherEffect, w, seasonalTemp(weather, date)) : 1;
  };
  const signals = bookingSignals(state.bookings ?? [], state.bookingPace ?? [], state.actuals ?? [], siteId, from, to, today, {
    unusual,
    weatherFactor: weatherAt,
    historyFactors: learnt.factors,
  });
  // Children on the team, by date, for the holiday reminders.
  const children = (date: string) => state.employees.filter((e) => e.siteId === siteId && e.status !== 'leaver' && isChildOn(e, date, site?.nation ?? 'england'));
  for (const p of holidaysAhead.filter((x) => x.kind !== 'inset' && x.start >= from)) {
    const kids = children(p.start).length;
    reminders.push({
      key: `school:${p.id}`,
      kind: 'school',
      date: p.start,
      dueFrom: addDays(p.start, -21),
      title: `${p.name} starts${p.source === 'estimate' ? ' (estimated)' : ''}`,
      advice:
        'Parents on the team will ask for time off and students will want more hours: check holiday requests and availability before you build.' +
        (kids ? ` ${kids} on the team ${kids === 1 ? 'is' : 'are'} of school age: longer holiday hours apply only once the council's dates are in.` : '') +
        (p.source === 'estimate' ? ' These dates are the usual pattern, not your council\'s: add the council\'s dates for the site.' : ''),
      applied: [],
      needsInput: false,
    });
  }
  const dayName = (d: string) => ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][weekday(d)];

  const occs = occasionsBetween(from, addDays(to, 0));
  const days: CalendarDay[] = [];

  for (let date = from; date <= to; date = addDays(date, 1)) {
    const dayOccasions = occs.filter((o) => o.date === date);
    const dayEvents = events.filter((e) => e.date === date);
    const w = weather.find((x) => x.date === date);
    const auto: AutoAdjustment[] = [];

    for (const o of dayOccasions) {
      const effect = o.kind === 'occasion' && !o.bankHoliday ? occasionEffect(h, o, unusual) : null;
      const applied: AutoAdjustment[] = [];
      if (effect && Math.abs(effect.factor - 1) >= 0.05) {
        applied.push({
          id: `auto:occasion:${o.key}:${date}`,
          source: 'auto',
          kind: 'occasion',
          siteId,
          date,
          factor: Math.min(2.5, Math.max(0.5, effect.factor)),
          reason: 'event',
          note: o.name,
          fromHour: o.fromHour,
          toHour: o.toHour,
          evidence: `Last year ${o.name} took ${money(effect.lastSales)}${span(o.fromHour, o.toHour)} against ${money(effect.normalSales)} on a normal day then (${pctText(effect.factor)}).`,
        });
      }
      auto.push(...applied);
      reminders.push({
        key: `occasion:${o.key}:${date}`,
        kind: 'occasion',
        date,
        dueFrom: addDays(date, -o.leadDays),
        title: o.name,
        advice: o.advice,
        applied,
        // Bank holidays are forecast by the model's own rule; operational dates need a check, not a number.
        needsInput: o.kind === 'occasion' && !o.bankHoliday && !effect,
        fromHour: o.fromHour,
        toHour: o.toHour,
      });
    }

    for (const e of dayEvents) {
      const effect = e.feedId ? eventEffects.find((x) => x.feedId === e.feedId) : undefined;
      const window = eventWindow(e) ?? undefined;
      const applied: AutoAdjustment[] = [];
      if (effect?.usable && Math.abs(effect.factor - 1) >= 0.05 && date >= today) {
        applied.push({
          id: `auto:event:${e.id}`,
          source: 'auto',
          kind: 'event',
          siteId,
          date,
          factor: effect.factor,
          reason: 'event',
          note: e.name,
          fromHour: window?.fromHour,
          toHour: window?.toHour,
          evidence: `The last ${effect.events} events from this feed traded ${pctText(effect.factor)} on normal${window ? ' around the start time' : ''}.`,
        });
      }
      auto.push(...applied);
      reminders.push({
        key: `event:${e.id}`,
        kind: 'event',
        date,
        dueFrom: addDays(date, -10),
        title: e.name,
        advice: `${e.venue ? `At ${e.venue}. ` : ''}${applied.length ? 'Applied from past events of the same kind; check it against what you know.' : 'No history for this kind of event yet: say what you expect, and the model will learn from what happens.'}`,
        applied,
        needsInput: !applied.length,
        fromHour: window?.fromHour,
        toHour: window?.toHour,
      });
    }

    if (w && !w.observed && date >= today) {
      const factor = weatherFactor(weatherEffect, w, seasonalTemp(weather, date));
      const applied: AutoAdjustment[] = [];
      if (Math.abs(factor - 1) >= 0.02) {
        applied.push({
          id: `auto:weather:${date}`,
          source: 'auto',
          kind: 'weather',
          siteId,
          date,
          factor,
          reason: 'weather',
          note: describeWeather(w),
          evidence: `Forecast ${describeWeather(w)}. This site trades ${weatherEffect.perDegree >= 0 ? '+' : ''}${(weatherEffect.perDegree * 100).toFixed(1)}% per degree warmer than normal and ${pctText(1 + weatherEffect.wet)} on wet days, from ${weatherEffect.days} days of its own history.`,
        });
      }
      auto.push(...applied);
      const notable = Math.abs(factor - 1) >= 0.05 || w.precipitationMm >= 10 || w.tempMax >= 27;
      if (notable) {
        reminders.push({
          key: `weather:${date}`,
          kind: 'weather',
          date,
          dueFrom: addDays(date, -5),
          title: `Weather: ${describeWeather(w)}`,
          advice: applied.length
            ? `Applied ${pctText(factor)} from how this site trades in weather like it. Check terrace and outside cover, stock and staffing.`
            : weatherEffect.usable
              ? 'Unusual weather, but this site has barely moved with the weather before, so nothing is applied. Check outside cover and stock.'
              : 'Unusual weather, but not enough history yet to say what it does here. Use your judgement and the model will learn from it.',
          applied,
          needsInput: !applied.length && !weatherEffect.usable,
        });
      }
    }

    const holiday = inHoliday(holidaysAhead, date);
    const bankHoliday = occasionsBetween(date, date).some((o) => o.bankHoliday);
    if (holiday && !bankHoliday && date >= today) {
      const weekend = weekday(date) >= 5;
      // Under five per cent is within the noise of a few weeks' history: shown in what the site has learnt, not applied.
      for (const e of schoolEffects.filter((x) => x.usable && x.weekend === weekend && Math.abs(x.factor - 1) >= 0.05)) {
        const dp = DAYPARTS.find((d) => d.id === e.daypart)!;
        auto.push({
          id: `auto:school:${date}:${e.daypart}`,
          source: 'auto',
          kind: 'school',
          siteId,
          date,
          factor: e.factor,
          reason: 'event',
          note: holiday.name,
          fromHour: dp.from,
          toHour: dp.to,
          evidence: `${dp.label} in the school holidays here has traded ${pctText(e.factor)} on term time (${e.days} ${weekend ? 'weekend' : 'week'} days learnt)${holiday.source === 'estimate' ? '; holiday dates estimated' : ''}.`,
        });
      }
    }

    const daySignals = signals.filter((sg) => sg.date === date);
    for (const sg of daySignals) {
      for (const p of sg.largeParties) {
        reminders.push({
          key: `bookings:party:${p.id}`,
          kind: 'bookings',
          date,
          dueFrom: addDays(date, -14),
          title: `Party of ${p.covers}, ${formatMinute(p.startMinute)}`,
          advice: 'Roster for it by name: a server who owns the table, the kitchen told the numbers and timing, and the deposit and pre-order checked.',
          applied: [],
          needsInput: false,
          fromHour: sg.fromHour,
          toHour: sg.toHour,
        });
      }
      // Pace well ahead of or behind a normal day, in the next fortnight, is worth a look before the rota is built.
      // A percentage on small numbers is noise: four booked against seven is not worth a GM's attention. It must be
      // at least ten covers and a quarter either side of usual.
      const gap = sg.usualAtLead === null ? 0 : sg.booked - sg.usualAtLead;
      const material = sg.usualAtLead !== null && Math.abs(gap) >= Math.max(PACE_MIN_COVERS, 0.25 * sg.usualAtLead);
      if (sg.usable && sg.pace !== null && sg.lead <= 14 && material && sg.expected !== null) {
        const ahead = sg.pace >= 1;
        reminders.push({
          key: `bookings:pace:${date}:${sg.daypart}`,
          kind: 'bookings',
          date,
          dueFrom: addDays(date, -14),
          title: `${dayName(date)} ${sg.label.toLowerCase()} pacing ${ahead ? '+' : ''}${Math.round((sg.pace - 1) * 100)}% on a normal ${dayName(date)}`,
          advice:
            `${sg.booked} covers booked against ${sg.usualAtLead} usually on the books at this point. Expect ${sg.expected} covers. ` +
            (ahead ? 'Build the forecast again and check the rota covers it before you publish.' : 'Check whether the rota still needs everyone on it before you publish.'),
          applied: [],
          needsInput: false,
          fromHour: sg.fromHour,
          toHour: sg.toHour,
        });
      }
    }

    // One occasion and one event per day at most: two occasions on a day (Valentine's on Shrove Tuesday) or
    // the same match listed by two feeds are one effect, not two. The strongest stands.
    const strongest = (kind: AutoKind) =>
      auto.filter((a) => a.kind === kind).sort((a, b) => Math.abs(b.factor - 1) - Math.abs(a.factor - 1)).slice(0, 1);
    const single = [...strongest('occasion'), ...strongest('event'), ...auto.filter((a) => a.kind === 'weather' || a.kind === 'school')];
    // Each is held to a sensible range, and the model caps them in total too. An occasion can genuinely
    // double a lunch (Mothering Sunday), so it gets more room than weather or an event.
    const kept = manualWins(single, manual).map((a) => ({ ...a, factor: a.kind === 'occasion' ? Math.min(2.5, Math.max(0.5, a.factor)) : Math.min(1.6, Math.max(0.6, a.factor)) }));
    days.push({ date, occasions: dayOccasions, events: dayEvents, weather: w, weatherText: w ? describeWeather(w) : undefined, adjustments: kept, manual: manual.filter((m) => m.date === date), bookings: daySignals, school: holiday });
  }

  // A reminder only shows what survived a person's own decision.
  const keptIds = new Set(days.flatMap((d) => d.adjustments.map((a) => a.id)));
  for (const r of reminders) r.applied = r.applied.filter((a) => keptIds.has(a.id));

  return { siteId, from, to, days, reminders: reminders.sort((a, b) => a.date.localeCompare(b.date)), weatherEffect, eventEffects, bookingSignals: signals, schoolEffects };
}

/** Reminders that are due now: on or after their due date and not yet past. */
export function dueReminders(plan: Plan, today: string): Reminder[] {
  return plan.reminders.filter((r) => r.dueFrom <= today && r.date >= today);
}

/** The automatic adjustments to feed the model for a set of dates. */
export function autoAdjustmentsFor(plan: Plan, dates: string[]): AutoAdjustment[] {
  const set = new Set(dates);
  return plan.days.filter((d) => set.has(d.date)).flatMap((d) => d.adjustments);
}

/** The years a history spans, for computing bank holidays on demand. */
export function yearsOf(dates: string[]): number[] {
  const ys = dates.map((d) => parseISODate(d).getUTCFullYear());
  if (!ys.length) return [];
  const out: number[] = [];
  for (let y = Math.min(...ys) - 1; y <= Math.max(...ys) + 1; y++) out.push(y);
  return out;
}
