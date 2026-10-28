import { describe, expect, it } from 'vitest';
import { dayDemand, forecastSalesForDay } from './demand';
import { planAhead, unusualDays } from './plan';
import { importPrivateEvents } from './privateEventImport';
import { eventTeam, guestsPerStaff } from './privateEvents';
import type { DemandRule, HourForecast, PrivateEvent, RotaState } from './types';

const DAY = '2026-11-14'; // a Saturday

/** A site open 12:00 to 23:00, £500 and 20 covers an hour, a server per 10 covers and a chef per £1,000. */
function state(rules?: Partial<DemandRule>[], events: PrivateEvent[] = []): RotaState {
  const forecast: HourForecast[] = [];
  for (let hour = 12; hour < 23; hour++) forecast.push({ siteId: 'mar', date: DAY, hour, sales: 500, covers: 20 });
  const base: DemandRule[] = [
    { roleId: 'server', siteId: 'mar', coversPerHour: 10, minimumWhileOpen: 1, maximum: 6 },
    { roleId: 'runner', siteId: 'mar', coversPerHour: 20, minimumWhileOpen: 1, maximum: 4 },
    { roleId: 'chef', siteId: 'mar', salesPerLabourHour: 1000, minimumWhileOpen: 1, maximum: 4 },
    { roleId: 'bartender', siteId: 'mar', salesPerLabourHour: 1000, minimumWhileOpen: 1, maximum: 4 },
  ];
  return {
    entities: [],
    sites: [{ id: 'mar', name: 'Marylebone', entityId: 'e', labourTargetPct: 0.28, trackingCode: 'MAR', openMinute: 12 * 60, closeMinute: 23 * 60 }],
    roles: [
      { id: 'server', name: 'Server', department: 'FOH', nominalCode: '7000' },
      { id: 'runner', name: 'Runner', department: 'FOH', nominalCode: '7000' },
      { id: 'chef', name: 'Chef', department: 'BOH', nominalCode: '7001' },
      { id: 'bartender', name: 'Bartender', department: 'BAR', nominalCode: '7002' },
    ],
    employees: [],
    shifts: [],
    forecast,
    demandRules: base.map((r, i) => ({ ...r, ...(rules?.[i] ?? {}) })),
    privateEvents: events,
  };
}

const wedding = (over: Partial<PrivateEvent> = {}): PrivateEvent => ({
  id: 'tripleseat:1',
  siteId: 'mar',
  source: 'tripleseat',
  date: DAY,
  startMinute: 18 * 60,
  endMinute: 24 * 60 + 30,
  guests: 120,
  kind: 'wedding',
  style: 'seated',
  status: 'confirmed',
  exclusive: false,
  spend: 9000,
  ...over,
});

const at = (s: RotaState, role: string, hour: number) => dayDemand(s, 'mar', role, DAY).find((h) => h.hour === hour)!;

describe('private events on the rota', () => {
  it('staffs a confirmed wedding by ratio on top of normal trade, from set-up to clear-down', () => {
    const s = state(undefined, [wedding()]);
    // Normal trade needs 2 servers an hour; 120 seated guests at the standard 12 each need 10 more.
    expect(at(s, 'server', 15)).toMatchObject({ required: 2 });
    expect(at(s, 'server', 17)).toMatchObject({ required: 12, event: 10 });
    expect(at(s, 'server', 22)).toMatchObject({ required: 12, event: 10 });
    // The day runs on past the site's close to cover the event, through clear-down to 01:00.
    expect(at(s, 'server', 24)).toMatchObject({ required: 10, event: 10 });
    expect(dayDemand(s, 'mar', 'server', DAY)).toHaveLength(25);
    // The standard ratio goes to the first role of each department only: the runner is not staffed twice.
    expect(at(s, 'runner', 19).event).toBeUndefined();
    expect(at(s, 'chef', 19).event).toBe(4);
    expect(at(s, 'bartender', 19).event).toBe(3);
  });

  it('moves nothing for a provisional event or an enquiry', () => {
    const s = state(undefined, [wedding({ status: 'provisional' })]);
    expect(at(s, 'server', 19)).toMatchObject({ required: 2 });
    expect(at(s, 'server', 19).event).toBeUndefined();
    expect(forecastSalesForDay(s, 'mar', DAY)).toBe(5500);
  });

  it('uses the site\'s own ratios once any are set, and stretches them by service style', () => {
    const own = state([{ guestsPerStaff: 10 }, {}, { guestsPerStaff: 25 }], [wedding()]);
    expect(guestsPerStaff(own, own.demandRules[3])).toBeNull();
    expect(eventTeam(own, wedding()).map((t) => [t.roleId, t.people, t.standard])).toEqual([['server', 12, false], ['chef', 5, false]]);
    // A drinks reception needs no kitchen, and a third of the servers.
    expect(eventTeam(own, wedding({ style: 'drinks' })).map((t) => [t.roleId, t.people])).toEqual([['server', 4]]);
  });

  it('takes the public out while an exclusive hire has the site, and puts the hire\'s spend in', () => {
    const s = state(undefined, [wedding({ exclusive: true, kind: 'private_hire' })]);
    // From 17:00 (set-up) the public are not served: the event's team only.
    expect(at(s, 'server', 16)).toMatchObject({ required: 2, sales: 500 });
    expect(at(s, 'server', 17)).toMatchObject({ required: 10, covers: 0, sales: 0 });
    expect(at(s, 'server', 18).sales).toBeCloseTo(9000 / 7);
    // Twelve to five is five hours of public trade at £500, plus the hire.
    expect(forecastSalesForDay(s, 'mar', DAY)).toBe(2500 + 9000);
    expect(forecastSalesForDay(state(undefined, [wedding()]), 'mar', DAY)).toBe(5500 + 9000);
  });

  it('keeps the event team on when the site is closed to the public that night', () => {
    const s = { ...state(undefined, [wedding()]), forecastAdjustments: [{ id: 'c', siteId: 'mar', date: DAY, factor: 0, reason: 'closure' as const, fromHour: 17 }] };
    expect(at(s, 'server', 19)).toMatchObject({ required: 10, event: 10 });
  });

  it('marks a confirmed event day as unusual so the model does not learn a wedding as a Saturday', () => {
    expect(unusualDays(state(undefined, [wedding()]), 'mar').has(DAY)).toBe(true);
    expect(unusualDays(state(undefined, [wedding({ status: 'provisional' })]), 'mar').has(DAY)).toBe(false);
  });

  it('reminds the GM to roster a confirmed event and to chase a held one', () => {
    const s = state(undefined, [wedding(), wedding({ id: 'tripleseat:2', date: '2026-11-13', status: 'provisional', guests: 40, style: 'standing' })]);
    const plan = planAhead(s, 'mar', '2026-11-01', '2026-11-20', '2026-11-01');
    const confirmed = plan.reminders.find((r) => r.key === 'private:tripleseat:1')!;
    expect(confirmed.title).toBe('Wedding, 120 seated, 18:00 to 00:30');
    expect(confirmed.advice).toContain('10 Server, 4 Chef, 3 Bartender');
    expect(confirmed.dueFrom).toBe('2026-10-31');
    const held = plan.reminders.find((r) => r.key === 'private:hold:tripleseat:2')!;
    expect(held.advice).toContain('Not in the forecast or the rota until it is confirmed');
    expect(plan.days.find((d) => d.date === DAY)!.privateEvents).toHaveLength(1);
  });
});

describe('reading an events export', () => {
  it('reads a Tripleseat export and never touches the client\'s details', () => {
    const csv = [
      'Event ID,Event Name,Event Date,Start Time,End Time,Guest Count,Status,Event Type,Event Style,Room(s),Grand Total,Contact Name,Contact Email',
      'TS100,Smith Wedding,14/11/2026,6:00 PM,12:30 AM,120,Definite,Wedding,Plated Dinner,Garden Room,"£10,800.00",Jane Smith,jane@example.com',
      'TS101,Acme Xmas,11/12/2026,19:00,23:00,60,Tentative,Corporate,Canapes and drinks,Whole venue,3600,Bob Jones,bob@example.com',
      'TS102,Lost lead,12/12/2026,19:00,,30,Lost,Birthday,,Bar,,Ann Lee,ann@example.com',
      'TS103,No time,13/12/2026,,,30,Definite,Birthday,,Bar,,Ann Lee,ann@example.com',
    ].join('\n');
    const r = importPrivateEvents(csv, 'mar', 'tripleseat');
    expect(r.ignored).toEqual(['Event Name', 'Contact Name', 'Contact Email']);
    expect(r.skipped).toEqual([{ line: 5, reason: 'No start time' }]);
    expect(r.rows[0]).toEqual({
      id: 'tripleseat:TS100', siteId: 'mar', source: 'tripleseat', date: '2026-11-14', startMinute: 1080, endMinute: 1470,
      guests: 120, kind: 'wedding', style: 'seated', status: 'confirmed', exclusive: false, space: 'Garden Room', spend: 9000,
    });
    expect(r.rows[1]).toMatchObject({ kind: 'corporate', style: 'standing', status: 'provisional', exclusive: true, spend: 3000 });
    // A missing end runs the usual length for the kind of event.
    expect(r.rows[2]).toMatchObject({ kind: 'party', status: 'cancelled', endMinute: 23 * 60 });
    expect(JSON.stringify(r.rows)).not.toMatch(/Smith|Acme|jane|Jones/);
  });

  it('reads a SevenRooms-style export with a combined date and time, and spend already net', () => {
    const csv = ['Reservation ID;Date;Party Size;Status;Event Type;Min Spend;Client', 'sr1;2026-11-14T19:30:00Z;45;Confirmed;Private hire;2000;Ann Lee'].join('\n');
    const r = importPrivateEvents(csv, 'mar', 'sevenrooms', { spendIncludesVat: false });
    expect(r.rows).toEqual([
      { id: 'sevenrooms:sr1', siteId: 'mar', source: 'sevenrooms', date: '2026-11-14', startMinute: 19 * 60 + 30, endMinute: 24 * 60 + 30, guests: 45, kind: 'private_hire', style: 'seated', status: 'confirmed', exclusive: true, spend: 2000 },
    ]);
  });
});
