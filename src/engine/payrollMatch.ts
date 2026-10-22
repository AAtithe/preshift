// Matching Preshift's people to the records a payroll already holds, so a team that is already on
// TeamPay is linked rather than set up a second time. Pure, so the API and the screen agree.

import type { Employee, PayrollDifference } from './types';

/** What the payroll holds about a person, as far as matching needs it. */
export interface PayrollPerson {
  payrollId: string;
  externalRef?: string;
  name: string;
  dateOfBirth?: string;
  payBasis?: 'hourly' | 'salaried';
  hourlyRate?: number;
  annualSalary?: number;
  contractedHours?: number;
  leaveDate?: string;
}

/**
 * exact: same name and date of birth, which is safe to link without asking.
 * likely: same date of birth and surname, or same name with no date of birth on the payroll side.
 * name: same name but a different date of birth, shown so a typo can be spotted, never linked alone.
 */
export type MatchLevel = 'exact' | 'likely' | 'name';

export interface Match {
  record: PayrollPerson;
  level: MatchLevel;
}

/** Lower case, accents and punctuation gone, titles dropped, single spaces: "Mr. José O'Neil" is "jose oneil". */
export function normaliseName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’`-]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !['mr', 'mrs', 'ms', 'miss', 'mx', 'dr'].includes(w))
    .join(' ');
}

const surname = (name: string) => normaliseName(name).split(' ').at(-1) ?? '';

export function matchLevel(e: Pick<Employee, 'name' | 'dateOfBirth'>, r: PayrollPerson): MatchLevel | null {
  const sameName = normaliseName(e.name) === normaliseName(r.name);
  const sameDob = !!e.dateOfBirth && e.dateOfBirth === r.dateOfBirth;
  if (sameName && sameDob) return 'exact';
  if ((sameDob && surname(e.name) === surname(r.name)) || (sameName && !r.dateOfBirth)) return 'likely';
  if (sameName) return 'name';
  return null;
}

const ORDER: Record<MatchLevel, number> = { exact: 0, likely: 1, name: 2 };

/**
 * Payroll records that could be this person, best first. Records already linked to someone else in
 * Preshift and leavers are left out: hours must never reach a record that is somebody else's.
 */
export function candidates(e: Pick<Employee, 'id' | 'name' | 'dateOfBirth'>, records: PayrollPerson[], linkedElsewhere: Set<string>): Match[] {
  return records
    .filter((r) => !linkedElsewhere.has(r.payrollId) && !r.leaveDate)
    .map((record) => ({ record, level: matchLevel(e, record) }))
    .filter((m): m is Match => m.level !== null)
    .sort((a, b) => ORDER[a.level] - ORDER[b.level] || a.record.name.localeCompare(b.record.name));
}

/**
 * Where Preshift and the payroll record disagree. Only fields the payroll actually holds are
 * compared; pay is compared on the person's basis, so an hourly rate is not set against a salary.
 */
export function differences(e: Employee, r: PayrollPerson): PayrollDifference[] {
  const out: PayrollDifference[] = [];
  const add = (field: PayrollDifference['field'], label: string, preshift: string | number, payroll: string | number | undefined, pay = false) => {
    if (payroll === undefined || payroll === '') return;
    const same = typeof preshift === 'number' && typeof payroll === 'number' ? Math.abs(preshift - payroll) < 0.005 : preshift === payroll;
    if (!same) out.push({ field, label, preshift, payroll, pay });
  };
  if (normaliseName(e.name) !== normaliseName(r.name)) add('name', 'Name', e.name, r.name);
  add('dateOfBirth', 'Date of birth', e.dateOfBirth, r.dateOfBirth);
  add('payBasis', 'Paid', e.payBasis, r.payBasis, true);
  const basis = r.payBasis ?? e.payBasis;
  if (basis === 'hourly' && e.payBasis === 'hourly') add('hourlyRate', 'Hourly rate', e.hourlyRate, r.hourlyRate, true);
  if (basis === 'salaried' && e.payBasis === 'salaried') add('annualSalary', 'Annual salary', e.annualSalary, r.annualSalary, true);
  add('contractedHours', 'Contracted hours', e.contractedHours, r.contractedHours);
  return out;
}

/** Preshift's record with the payroll's values taken for each difference. */
export function adoptPayroll(e: Employee, diffs: PayrollDifference[], r: PayrollPerson): Employee {
  const next: Employee = { ...e };
  for (const d of diffs) {
    if (d.field === 'name') next.name = r.name;
    if (d.field === 'dateOfBirth' && r.dateOfBirth) next.dateOfBirth = r.dateOfBirth;
    if (d.field === 'payBasis' && r.payBasis) next.payBasis = r.payBasis;
    if (d.field === 'hourlyRate' && r.hourlyRate !== undefined) next.hourlyRate = r.hourlyRate;
    if (d.field === 'annualSalary' && r.annualSalary !== undefined) next.annualSalary = r.annualSalary;
    if (d.field === 'contractedHours' && r.contractedHours !== undefined) {
      next.contractedHours = r.contractedHours;
      next.irregularHours = r.contractedHours === 0;
    }
  }
  // A change of basis brings the other side's pay figure with it.
  if (next.payBasis === 'hourly' && r.payBasis === 'hourly' && r.hourlyRate !== undefined) next.hourlyRate = r.hourlyRate;
  if (next.payBasis === 'salaried' && r.payBasis === 'salaried' && r.annualSalary !== undefined) next.annualSalary = r.annualSalary;
  return next;
}
