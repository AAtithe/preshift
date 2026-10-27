import type { DemandRule, Department, PrivateEvent, PrivateEventStyle, RotaState } from './types';

// Private events: the wedding, the buyout, the Christmas party in the private room.
// Unlike walk-ins and table bookings they are known weeks ahead, to the guest, and
// staffed by ratio rather than by how fast covers turn: 120 guests seated at 18:00
// need their servers from before they arrive until after they leave, all at once.
// So a confirmed event is laid over the forecast rather than learnt by it: its own
// staff on top of the day's normal trade, its spend on top of the day's sales, and
// for an exclusive hire, the public's trade taken out while it runs.

/** Staff are in this long before guests arrive, to set the room. */
export const SETUP_MINUTES = 60;
/** And this long after they leave, to clear it. */
export const CLEAR_MINUTES = 30;

/**
 * Guests one person looks after at a seated event, used until the site sets its own ratio on any
 * role. Seated service is the industry's usual one server per ten to twelve guests, one chef per
 * thirty and one bartender per fifty. No standard is set for managers: that is the GM's call.
 */
export const STANDARD_GUESTS_PER_STAFF: Partial<Record<Department, number>> = { FOH: 12, BOH: 30, BAR: 50 };

/**
 * How each service style stretches the seated ratio: a server looks after twice as many guests at a
 * standing reception as at a plated dinner. A drinks reception needs no kitchen and more bar.
 * Null: the department is not needed for that style.
 */
export const STYLE_STRETCH: Record<PrivateEventStyle, Record<Department, number | null>> = {
  seated: { FOH: 1, BOH: 1, BAR: 1, MGMT: 1 },
  buffet: { FOH: 1.5, BOH: 1.25, BAR: 1, MGMT: 1 },
  standing: { FOH: 2, BOH: 1.5, BAR: 1, MGMT: 1 },
  drinks: { FOH: 3, BOH: null, BAR: 0.8, MGMT: 1 },
};

export const KIND_LABEL: Record<PrivateEvent['kind'], string> = {
  wedding: 'Wedding',
  private_hire: 'Private hire',
  party: 'Party',
  corporate: 'Corporate',
  other: 'Function',
};

export const STYLE_LABEL: Record<PrivateEventStyle, string> = { seated: 'seated', buffet: 'buffet', standing: 'standing', drinks: 'drinks' };

/** Only a confirmed event moves the rota. */
export const counts = (e: Pick<PrivateEvent, 'status'>) => e.status === 'confirmed';

/** A short description, with no client's name in it because none is ever held. */
export const describeEvent = (e: PrivateEvent) =>
  `${KIND_LABEL[e.kind]}, ${e.guests} ${STYLE_LABEL[e.style]}${e.exclusive ? ', exclusive' : e.space ? `, ${e.space}` : ''}`;

/** The trading-day hours staff are needed for an event, from set-up to clear-down: [from, to). */
export function staffHours(e: Pick<PrivateEvent, 'startMinute' | 'endMinute'>): { from: number; to: number } {
  return { from: Math.max(0, Math.floor((e.startMinute - SETUP_MINUTES) / 60)), to: Math.ceil((e.endMinute + CLEAR_MINUTES) / 60) };
}

/** The trading-day hours guests are in, and spending: [from, to). */
export function guestHours(e: Pick<PrivateEvent, 'startMinute' | 'endMinute'>): { from: number; to: number } {
  return { from: Math.floor(e.startMinute / 60), to: Math.max(Math.floor(e.startMinute / 60) + 1, Math.ceil(e.endMinute / 60)) };
}

/** Confirmed events on a site's trading day. */
export function eventsOn(state: Pick<RotaState, 'privateEvents'>, siteId: string, date: string, all = false): PrivateEvent[] {
  return (state.privateEvents ?? []).filter((e) => e.siteId === siteId && e.date === date && (all ? e.status !== 'cancelled' : counts(e)));
}

/**
 * The guests one person in a role looks after at a seated event at its site. The role's own ratio
 * where any role at the site has one set; until then the standard ratio, given to the first role of
 * each department only, so two front-of-house roles do not both staff the same guests.
 */
export function guestsPerStaff(state: Pick<RotaState, 'demandRules' | 'roles'>, rule: DemandRule): { ratio: number; standard: boolean } | null {
  const atSite = state.demandRules.filter((r) => r.siteId === rule.siteId);
  if (atSite.some((r) => r.guestsPerStaff)) return rule.guestsPerStaff ? { ratio: rule.guestsPerStaff, standard: false } : null;
  const dept = state.roles.find((r) => r.id === rule.roleId)?.department;
  if (!dept || STANDARD_GUESTS_PER_STAFF[dept] === undefined) return null;
  const first = atSite.find((r) => state.roles.find((x) => x.id === r.roleId)?.department === dept);
  return first?.roleId === rule.roleId ? { ratio: STANDARD_GUESTS_PER_STAFF[dept]!, standard: true } : null;
}

/** People in one role an event needs while it runs. */
export function staffFor(state: Pick<RotaState, 'demandRules' | 'roles'>, rule: DemandRule, e: Pick<PrivateEvent, 'guests' | 'style'>): number {
  const per = guestsPerStaff(state, rule);
  const dept = state.roles.find((r) => r.id === rule.roleId)?.department;
  if (!per || !dept) return 0;
  const stretch = STYLE_STRETCH[e.style][dept];
  if (stretch === null) return 0;
  return Math.ceil(e.guests / (per.ratio * stretch));
}

/** Everyone an event needs, by role, at a site. */
export function eventTeam(state: Pick<RotaState, 'demandRules' | 'roles'>, e: PrivateEvent): { roleId: string; people: number; standard: boolean }[] {
  return state.demandRules
    .filter((r) => r.siteId === e.siteId)
    .map((r) => ({ roleId: r.roleId, people: staffFor(state, r, e), standard: guestsPerStaff(state, r)?.standard ?? false }))
    .filter((x) => x.people > 0);
}

/** An event's spend in one trading-day hour, spread evenly over the hours guests are in. */
export function spendIn(e: PrivateEvent, hour: number): number {
  const g = guestHours(e);
  if (!e.spend || hour < g.from || hour >= g.to) return 0;
  return e.spend / (g.to - g.from);
}

/** Whether an exclusive hire has the site in a trading-day hour: the public are not served then. */
export const exclusiveAt = (events: PrivateEvent[], hour: number) =>
  events.some((e) => e.exclusive && hour >= staffHours(e).from && hour < staffHours(e).to);

/** The last trading-day hour any of the events needs staff in, so the day can run on to cover it. */
export const lastHour = (events: PrivateEvent[]) => events.reduce((m, e) => Math.max(m, staffHours(e).to), 0);

/** Lays incoming events over those held, by id. */
export function mergePrivateEvents(held: PrivateEvent[], incoming: PrivateEvent[]): PrivateEvent[] {
  const ids = new Set(incoming.map((e) => e.id));
  return [...held.filter((e) => !ids.has(e.id)), ...incoming];
}
