// Who an open shift is offered to, and in what order. Cost decides: the shift goes first to people
// the business already pays for (short of their contracted hours this week), then to the cheapest
// few to add, and only then to everyone eligible. Pure, shared by the API, the scheduled run and tests.

import { breakFor, complianceOptions } from './compliance';
import { employeeWeekCost, shiftPaidHours, shiftsInWeek } from './cost';
import { employedShare } from './employees';
import { weekMetrics } from './metrics';
import { addDays, weekStart } from './time';
import type { Employee, OfferWave, OpenShift, RotaState, Shift } from './types';

export type OfferTier = OfferWave['tier'];

export const OFFER_TIER_LABEL: Record<OfferTier, string> = {
  contracted: 'Short of contracted hours',
  cheapest: 'Cheapest to add',
  everyone: 'Everyone eligible',
};

/** How long each wave has to claim before the next is told. */
export const OFFER_WAVE_MINUTES = 120;
/** Inside this many hours of the start there is no time for waves: everyone eligible is told at once. */
export const OFFER_ALL_WITHIN_HOURS = 24;
/** The cheapest wave is this many people at most, so it stays a short list. */
export const CHEAPEST_WAVE = 3;

export interface OfferRank {
  employeeId: string;
  tier: OfferTier;
  /** What adding the shift costs the business: the change to the person's whole loaded week. */
  marginal: number;
  /** Contracted hours not yet rostered in that week, before this shift. */
  shortHours: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The shift as this person would work it: the posted times, with at least the break they are owed. */
export function shiftFor(state: RotaState, slot: Shift, e: Employee, breakMinutes = slot.breakMinutes): Shift {
  const owed = breakFor(e, slot.date, slot.endMinute - slot.startMinute, complianceOptions(state, e).nation);
  return { ...slot, employeeId: e.id, breakMinutes: Math.max(breakMinutes, owed) };
}

/** One person's cost and contracted hours gap for a slot. */
export function offerCost(state: RotaState, slot: Shift, e: Employee): { marginal: number; shortHours: number } {
  const ws = weekStart(slot.date);
  const week = shiftsInWeek(state.shifts, ws).filter((s) => s.employeeId === e.id);
  const share = employedShare(e, ws);
  const before = employeeWeekCost(e, week, undefined, share, state.sites, state.entities);
  const after = employeeWeekCost(e, [...week, shiftFor(state, slot, e)], undefined, share, state.sites, state.entities);
  const rostered = week.reduce((sum, s) => sum + shiftPaidHours(s), 0);
  const shortHours = e.payBasis === 'hourly' && e.contractedHours > 0 ? Math.max(0, e.contractedHours * share - rostered) : 0;
  return { marginal: round2(after.total - before.total), shortHours: round2(shortHours) };
}

/**
 * Everyone eligible, in the order they are offered the shift: those short of their contracted hours
 * first (cheapest of them first), then the cheapest few, then the rest by cost.
 */
export function rankOffer(state: RotaState, slot: Shift, eligible: Employee[]): OfferRank[] {
  const priced = eligible
    .map((e) => ({ employeeId: e.id, name: e.name, ...offerCost(state, slot, e) }))
    .sort((a, b) => a.marginal - b.marginal || a.name.localeCompare(b.name));
  const contracted = priced.filter((p) => p.shortHours > 0);
  const rest = priced.filter((p) => p.shortHours <= 0);
  const tiered = (list: typeof priced, tier: OfferTier) => list.map(({ name: _, ...p }) => ({ ...p, tier }));
  return [...tiered(contracted, 'contracted'), ...tiered(rest.slice(0, CHEAPEST_WAVE), 'cheapest'), ...tiered(rest.slice(CHEAPEST_WAVE), 'everyone')];
}

/** The waves to tell, in order, leaving out any that are empty. The last wave is always everyone else. */
export function offerWaves(ranks: OfferRank[]): OfferWave[] {
  const tiers: OfferTier[] = ['contracted', 'cheapest', 'everyone'];
  return tiers.map((tier) => ({ tier, employeeIds: ranks.filter((r) => r.tier === tier).map((r) => r.employeeId) })).filter((w) => w.employeeIds.length > 0);
}

/** The tier a person was offered the shift in: the wave they were in, or everyone for those eligible later. */
export function tierOf(o: OpenShift, employeeId: string): OfferTier | null {
  if (!o.offer) return null;
  return o.offer.waves.find((w) => w.employeeIds.includes(employeeId))?.tier ?? 'everyone';
}

/** Minutes from now until the shift starts. */
export function minutesUntil(slot: Pick<Shift, 'date' | 'startMinute'>, now: { date: string; minute: number }): number {
  let days = 0;
  for (let d = now.date; d < slot.date && days < 400; d = addDays(d, 1)) days++;
  return days * 1440 + slot.startMinute - now.minute;
}

/** Too close to the start for waves: tell everyone. */
export const tooCloseForWaves = (slot: Pick<Shift, 'date' | 'startMinute'>, now: { date: string; minute: number }) =>
  minutesUntil(slot, now) <= OFFER_ALL_WITHIN_HOURS * 60;

/** Whether this person has been offered the shift yet. Before waves existed, and once all are out, it is everyone eligible. */
export function offeredTo(o: OpenShift, employeeId: string): boolean {
  return !o.offer || o.offer.released >= o.offer.waves.length || o.offer.told.includes(employeeId);
}

/**
 * Whether the site's labour for that week, with this shift added, stays at or under its target
 * share of forecast sales. No forecast means it cannot be shown to be within budget.
 */
export function withinBudget(state: RotaState, shift: Shift): { ok: boolean; labourPct: number; targetPct: number } {
  const ws = weekStart(shift.date);
  const m = weekMetrics({ ...state, shifts: [...state.shifts, shift] }, shift.siteId, ws);
  return { ok: m.forecastSales > 0 && m.targetPct > 0 && m.labourPct <= m.targetPct, labourPct: m.labourPct, targetPct: m.targetPct };
}
