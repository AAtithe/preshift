import { isEmployedOn } from './employees';
import { annualImpact } from './payChanges';
import { addDays, ageOn } from './time';
import type { Employee, PayChange, Shift } from './types';
import { UK_RATES_2026_27 } from './ukRates';

// The April minimum wage uprating. Every April the National Living Wage and the National Minimum
// Wage bands rise, and anyone below the new rate for their age on that day is underpaid from it.
// This works out who, and what each should move to, so finance approves one batch in March rather
// than payroll finding the shortfall in April. The new rates are announced each autumn; they are
// entered here, never guessed.

export interface WageBand {
  minAge: number;
  hourly: number;
  label: string;
}

export interface UpratingRates {
  /** The day the new rates take effect, normally 1 April. */
  effectiveFrom: string;
  /** Bands by minimum age, highest age first. */
  bands: WageBand[];
  /** For apprentices under 19, or in the first year of their apprenticeship. */
  apprentice: number;
}

/**
 * How a rise is set. `floor` lifts each person below the new minimum for their age onto it.
 * `differential` gives everyone paid up to a margin over the old minimum the same rise as the
 * minimum itself, so a supervisor 30p over the old rate stays 30p over the new one and the pay
 * ladder does not collapse onto the floor. Anyone below the new minimum still gets at least it.
 */
export type UpratingMethod = 'floor' | 'differential';

/** With `differential`: how far above the old minimum, in pounds an hour, a rate still moves with it. */
export const DEFAULT_DIFFERENTIAL_MARGIN = 1;

export interface UpratingLine {
  employeeId: string;
  name: string;
  siteId: string;
  /** Age on the day the new rates take effect: a birthday before then moves the band. */
  age: number;
  band: string;
  current: number;
  newMinimum: number;
  proposed: number;
  /** What the rise adds over a year at full cost (holiday, employer NI, pension), on their usual hours. */
  fullCostAYear: number;
  /** Contracted hours, else the last four weeks of rota: nought means the cost cannot be put on a year yet. */
  hoursPerWeek: number;
  /** Why a rise could not be proposed here, for finance to settle by hand. */
  blocked?: string;
}

export interface UpratingResult {
  effectiveFrom: string;
  method: UpratingMethod;
  lines: UpratingLine[];
  /** Salaried people whose salary on their maximum hours falls below the new minimum: to check by hand. */
  salaryChecks: { employeeId: string; name: string; effectiveHourly: number; newMinimum: number }[];
  total: number;
}

/** The next 1 April on or after a date: when the new rates take effect. */
export function nextApril(today: string): string {
  const year = Number(today.slice(0, 4));
  const april = `${year}-04-01`;
  return today <= april ? april : `${year + 1}-04-01`;
}

/** The rates in force today, as the starting point of the form: the new ones replace them once announced. */
export function currentRates(today: string): UpratingRates {
  return { effectiveFrom: nextApril(today), bands: UK_RATES_2026_27.minimumWage.map((b) => ({ ...b })), apprentice: UK_RATES_2026_27.apprenticeRate };
}

const bandFor = (bands: WageBand[], age: number) => [...bands].sort((a, b) => b.minAge - a.minAge).find((b) => age >= b.minAge);

/** An apprentice is paid the apprentice rate under 19, or in the first year of the apprenticeship. */
function onApprenticeRate(e: Employee, age: number, on: string): boolean {
  if (e.hr?.contractType !== 'apprentice') return false;
  return age < 19 || (!!e.startDate && e.startDate > addDays(on, -365));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Who needs a rise for the new rates, and to what. Only people employed on the day and paid by
 * the hour are proposed; salaried pay is checked against the new minimum on their maximum hours
 * and listed for a person to decide, as a salary change is a contract conversation.
 */
export function uprating(
  employees: Employee[],
  shifts: Shift[],
  rates: UpratingRates,
  method: UpratingMethod,
  today: string,
  /** Changes on record, so someone with pay already moving is shown rather than proposed twice. */
  changes: Pick<PayChange, 'employeeId' | 'status' | 'appliedOn'>[] = [],
  oldRates: { bands: WageBand[]; apprentice: number } = { bands: UK_RATES_2026_27.minimumWage, apprentice: UK_RATES_2026_27.apprenticeRate },
  margin = DEFAULT_DIFFERENTIAL_MARGIN,
): UpratingResult {
  const on = rates.effectiveFrom;
  const lines: UpratingLine[] = [];
  const salaryChecks: UpratingResult['salaryChecks'] = [];
  for (const e of employees) {
    if (!isEmployedOn(e, on) || e.status === 'leaver' || !e.dateOfBirth || e.anonymisedOn) continue;
    const age = ageOn(e.dateOfBirth, on);
    if (age < 16) continue;
    const apprentice = onApprenticeRate(e, age, on);
    const band = bandFor(rates.bands, age);
    const newMinimum = apprentice ? rates.apprentice : band?.hourly ?? 0;
    const label = apprentice ? 'Apprentice rate' : band?.label ?? '';
    if (e.payBasis === 'salaried') {
      const effective = e.maxWeeklyHours > 0 ? e.annualSalary / 52 / e.maxWeeklyHours : Infinity;
      if (effective < newMinimum) salaryChecks.push({ employeeId: e.id, name: e.name, effectiveHourly: round2(effective), newMinimum });
      continue;
    }
    // The old minimum for the band they are in today, so the pence above it can be kept.
    const oldMinimum = apprentice ? oldRates.apprentice : bandFor(oldRates.bands, ageOn(e.dateOfBirth, today))?.hourly ?? 0;
    const keepsGap = method === 'differential' && e.hourlyRate < oldMinimum + margin;
    if (e.hourlyRate >= newMinimum && !keepsGap) continue;
    const gap = Math.max(0, e.hourlyRate - oldMinimum);
    const proposed = round2(Math.max(newMinimum, keepsGap ? newMinimum + gap : newMinimum));
    if (proposed <= e.hourlyRate) continue;
    const moving = changes.find((c) => c.employeeId === e.id && (c.status === 'pending' || (c.status === 'approved' && !c.appliedOn)));
    const impact = annualImpact({ before: { payBasis: 'hourly', hourlyRate: e.hourlyRate, annualSalary: 0 }, after: { payBasis: 'hourly', hourlyRate: proposed, annualSalary: 0 } }, e, shifts, today);
    lines.push({
      employeeId: e.id,
      name: e.name,
      siteId: e.siteId,
      age,
      band: label,
      current: e.hourlyRate,
      newMinimum,
      proposed,
      fullCostAYear: impact.fullDifference,
      hoursPerWeek: impact.hoursPerWeek,
      ...(moving ? { blocked: moving.status === 'pending' ? 'A pay change is already waiting for finance: decide that first.' : 'New pay is already approved to take effect later: withdraw it or propose this after.' } : {}),
    });
  }
  lines.sort((a, b) => a.siteId.localeCompare(b.siteId) || a.name.localeCompare(b.name));
  return { effectiveFrom: on, method, lines, salaryChecks, total: round2(lines.filter((l) => !l.blocked).reduce((s, l) => s + l.fullCostAYear, 0)) };
}

/** A problem with the rates as entered, or null. Rates fall only by mistake, so a fall is refused. */
export function upratingRatesProblem(rates: UpratingRates, today: string): string | null {
  if (rates.effectiveFrom <= today) return 'The new rates take effect on a day still to come.';
  if (!rates.bands.length) return 'Enter the rate for each age band.';
  for (const b of rates.bands) {
    const old = UK_RATES_2026_27.minimumWage.find((x) => x.minAge === b.minAge);
    if (!(b.hourly > 0)) return `Enter the ${b.label}.`;
    if (old && b.hourly < old.hourly) return `The ${b.label} of £${b.hourly.toFixed(2)} is below today's £${old.hourly.toFixed(2)}. Minimum wage rates do not fall.`;
  }
  if (rates.apprentice < UK_RATES_2026_27.apprenticeRate) return `The apprentice rate cannot fall below today's £${UK_RATES_2026_27.apprenticeRate.toFixed(2)}.`;
  return null;
}
