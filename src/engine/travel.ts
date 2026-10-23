import type { Issue } from './compliance';
import { absoluteMinute, ageOn, formatMinute } from './time';
import type { Employee, Entity, Shift, Site, SiteTravel } from './types';
import { minimumWageFor, UK_RATES_2026_27, type UkRates } from './ukRates';

/** Extra slack, on top of the journey, before a same-day move between sites stops being tight. */
export const TRAVEL_SLACK_MINUTES = 10;
/** Shifts further apart than this are separate trips, not a move from one site to the next. */
const SAME_TRIP_MINUTES = 6 * 60;

export interface Journey {
  minutes: number;
  source: SiteTravel['source'];
  /** How the minutes were found, for the UI: "TfL, tube and bus" or "straight-line estimate". */
  label: string;
}

/** Where a site is: its own location, or the centre of its clocking geofence. */
export function siteLocation(site: Site | undefined): { lat: number; lng: number } | null {
  if (!site) return null;
  if (site.location) return site.location;
  if (site.geofence) return { lat: site.geofence.lat, lng: site.geofence.lng };
  return null;
}

/** Great-circle distance in kilometres. */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * A city journey from straight-line distance when no planner time is held: walking pace for short
 * hops, otherwise about twelve minutes to get to and from the stops plus six a kilometre. Checked
 * against TfL for central London sites to within a few minutes; it is shown as an estimate.
 */
export function estimateMinutes(km: number): number {
  if (km <= 1.2) return Math.max(5, Math.round(km * 13));
  return Math.round(12 + 6 * km);
}

/** The journey between two sites: a held time either way round, else an estimate, else unknown. */
export function journeyBetween(sites: Site[], fromId: string, toId: string): Journey | null {
  if (fromId === toId) return { minutes: 0, source: 'manual', label: 'same site' };
  const from = sites.find((s) => s.id === fromId);
  const to = sites.find((s) => s.id === toId);
  const held = from?.travel?.[toId] ?? to?.travel?.[fromId];
  if (held) {
    const label = held.source === 'tfl' ? `TfL${held.mode ? `, ${held.mode}` : ''}` : held.source === 'manual' ? 'set by hand' : 'estimate';
    return { minutes: held.minutes, source: held.source, label };
  }
  const a = siteLocation(from);
  const b = siteLocation(to);
  if (!a || !b) return null;
  return { minutes: estimateMinutes(haversineKm(a, b)), source: 'estimate', label: 'straight-line estimate' };
}

/**
 * Paid travel for one person's shifts: when they move between sites within a working day, the
 * journey is working time (National Minimum Wage Regulations 2015, reg. 34; only travel between
 * home and work is excluded). Each journey is counted against the shift travelled to, so its cost
 * lands on the site that asked for the move. Unknown journeys cost nothing until a time is held.
 */
export function travelMinutesInto(shifts: Shift[], sites: Site[]): Map<string, number> {
  const out = new Map<string, number>();
  if (sites.length === 0) return out;
  for (const { prev, next } of sameDayMoves(shifts)) {
    const journey = journeyBetween(sites, prev.siteId, next.siteId);
    if (journey) out.set(next.id, (out.get(next.id) ?? 0) + journey.minutes);
  }
  return out;
}

/**
 * Same-day moves between sites with no journey time, because a site has no postcode: they are
 * paid in fact but cost nothing here until a time is held, so the P&L says how many there are.
 */
export function unpricedMoves(shifts: Shift[], sites: Site[]): { shiftId: string; fromId: string; toId: string }[] {
  return sameDayMoves(shifts)
    .filter(({ prev, next }) => !journeyBetween(sites, prev.siteId, next.siteId))
    .map(({ prev, next }) => ({ shiftId: next.id, fromId: prev.siteId, toId: next.siteId }));
}

/** Each person's moves from one site to another within a working day, in order. */
function sameDayMoves(shifts: Shift[]): { prev: Shift; next: Shift }[] {
  if (shifts.length < 2) return [];
  const anchor = shifts.reduce((min, s) => (s.date < min ? s.date : min), shifts[0].date);
  const at = (s: Shift) => ({ start: absoluteMinute(anchor, s.date, s.startMinute), end: absoluteMinute(anchor, s.date, s.endMinute) });
  const byPerson = new Map<string, Shift[]>();
  for (const s of shifts) byPerson.set(s.employeeId, [...(byPerson.get(s.employeeId) ?? []), s]);
  const moves: { prev: Shift; next: Shift }[] = [];
  for (const mine of byPerson.values()) {
    const ordered = [...mine].sort((a, b) => at(a).start - at(b).start);
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1];
      const next = ordered[i];
      if (prev.siteId === next.siteId) continue;
      const gap = at(next).start - at(prev).end;
      if (gap < 0 || gap > SAME_TRIP_MINUTES) continue;
      moves.push({ prev, next });
    }
  }
  return moves;
}

/**
 * The hourly rate a person is paid for travel between sites, under their employer's policy. A
 * fixed rate is lifted to the minimum wage for their age on `date`, so every hour of travel is
 * safe on its own, unless the company averages: then the rate stands and travelPay tops up the
 * pay period instead. Salaried pay does not change with travel, so their rate is returned as is.
 */
export function travelRate(employee: Employee, entities: Entity[], date: string, rates: UkRates = UK_RATES_2026_27): number {
  const policy = travelPolicy(employee, entities);
  // Withheld pay reads as nought; costs for that reader stay nought rather than show a policy rate.
  if (!policy || policy.basis === 'normal' || employee.payBasis === 'salaried' || employee.payHidden) return employee.hourlyRate;
  const minimum = minimumWageOn(employee, date, rates);
  if (policy.basis === 'minimum') return minimum;
  return policy.averaging ? policy.hourly : Math.max(policy.hourly, minimum);
}

/**
 * What a pay period's travel pays: its hours at the travel rate, plus any top-up needed for the
 * period's pay over work and travel to average the minimum wage. Only an averaging company can
 * need a top-up; every other policy pays at least the minimum on each hour.
 */
export function travelPay(
  employee: Employee,
  entities: Entity[],
  date: string,
  period: { workHours: number; workPay: number; travelHours: number },
  rates: UkRates = UK_RATES_2026_27,
): { pay: number; topUp: number } {
  if (period.travelHours <= 0) return { pay: 0, topUp: 0 };
  const pay = period.travelHours * travelRate(employee, entities, date, rates);
  const policy = travelPolicy(employee, entities);
  if (policy?.basis !== 'fixed' || !policy.averaging || employee.payBasis === 'salaried' || employee.payHidden) return { pay, topUp: 0 };
  const minimum = minimumWageOn(employee, date, rates) * (period.workHours + period.travelHours);
  return { pay, topUp: Math.max(0, minimum - period.workPay - pay) };
}

function travelPolicy(employee: Employee, entities: Entity[]) {
  return entities.find((e) => e.id === employee.entityId)?.travelPay;
}

function minimumWageOn(employee: Employee, date: string, rates: UkRates) {
  return minimumWageFor(ageOn(employee.dateOfBirth, date), rates)?.hourly ?? 0;
}

/**
 * A person moving between sites on the same day must be able to make the journey. Too little
 * time to get there is blocking (nobody can be in two places), and only the journey's length of
 * slack is a warning. Travel between workplaces during the day also counts as working time for
 * the National Minimum Wage, so the warning says so. Issues sit on the shift being travelled to.
 */
export function travelIssues(employee: Employee, context: Shift[], sites: Site[]): Issue[] {
  const name = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
  const mine = context.filter((s) => s.employeeId === employee.id);
  if (mine.length < 2) return [];
  const anchor = mine.reduce((min, s) => (s.date < min ? s.date : min), mine[0].date);
  const at = (s: Shift) => ({ start: absoluteMinute(anchor, s.date, s.startMinute), end: absoluteMinute(anchor, s.date, s.endMinute) });
  const ordered = [...mine].sort((a, b) => at(a).start - at(b).start);
  const issues: Issue[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const next = ordered[i];
    if (prev.siteId === next.siteId) continue;
    const gap = at(next).start - at(prev).end;
    // Overlaps are double booking, reported elsewhere; long gaps are separate trips.
    if (gap < 0 || gap > SAME_TRIP_MINUTES) continue;
    const journey = journeyBetween(sites, prev.siteId, next.siteId);
    const base = { employeeId: employee.id, shiftId: next.id, date: next.date };
    const route = `${name(prev.siteId)} (ends ${formatMinute(prev.endMinute)}) to ${name(next.siteId)} (starts ${formatMinute(next.startMinute)})`;
    if (!journey) {
      if (gap < 60) {
        issues.push({ ...base, code: 'travel-unknown', severity: 'warn', message: `${gap} minutes from ${route}. Set both sites' postcodes to check the journey.` });
      }
      continue;
    }
    if (gap < journey.minutes) {
      issues.push({
        ...base,
        code: 'travel',
        severity: 'block',
        message: `Cannot get from ${route}: ${gap} minutes, the journey takes about ${journey.minutes} (${journey.label}).`,
      });
    } else if (gap < journey.minutes + TRAVEL_SLACK_MINUTES) {
      issues.push({
        ...base,
        code: 'travel-tight',
        severity: 'warn',
        message: `Tight move from ${route}: ${gap} minutes for a ${journey.minutes} minute journey (${journey.label}). The journey is paid working time.`,
      });
    }
  }
  return issues;
}
