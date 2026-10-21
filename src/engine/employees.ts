import type { Employee } from './types';
import { addDays, ageOn, daysBetween, weekDates } from './time';
import { UK_RATES_2026_27, minimumWageFor, type UkRates } from './ukRates';
import type { Severity } from './compliance';

/** Days ahead we warn about a time-limited right to work or a minimum wage step. */
export const LOOKAHEAD_DAYS = 60;

export function isEmployedOn(employee: Employee, date: string): boolean {
  if (employee.startDate && date < employee.startDate) return false;
  if (employee.leaveDate && date > employee.leaveDate) return false;
  return true;
}

/** Share of the week the person is on the books, for pro-rating salary and guaranteed hours. */
export function employedShare(employee: Employee, weekStartDate: string): number {
  return weekDates(weekStartDate).filter((d) => isEmployedOn(employee, d)).length / 7;
}

export type EmployeeStatus = 'starter' | 'active' | 'leaving' | 'left';

export function employeeStatus(employee: Employee, today: string): EmployeeStatus {
  if (employee.leaveDate && employee.leaveDate < today) return 'left';
  if (employee.startDate && employee.startDate > today) return 'starter';
  if (employee.leaveDate) return 'leaving';
  return 'active';
}

export interface RecordCheck {
  code: string;
  severity: Severity;
  message: string;
}

/** The next birthday that moves the person into a higher minimum wage band, if it falls soon. */
function nextWageStep(employee: Employee, today: string, rates: UkRates) {
  const age = ageOn(employee.dateOfBirth, today);
  const step = [...rates.minimumWage].reverse().find((band) => band.minAge > age);
  if (!step) return null;
  const birthday = `${Number(employee.dateOfBirth.slice(0, 4)) + step.minAge}${employee.dateOfBirth.slice(4)}`;
  return daysBetween(today, birthday) <= LOOKAHEAD_DAYS ? { ...step, date: birthday } : null;
}

/**
 * Checks a person's employment record, independent of any rota: the things that
 * must be right before they work a shift, and the things about to go wrong.
 */
export function reviewEmployee(
  employee: Employee,
  today: string,
  rates: UkRates = UK_RATES_2026_27,
): RecordCheck[] {
  const checks: RecordCheck[] = [];
  const push = (code: string, severity: Severity, message: string) => checks.push({ code, severity, message });
  const age = employee.dateOfBirth ? ageOn(employee.dateOfBirth, today) : NaN;

  if (!employee.name.trim()) push('name', 'block', 'Name is required.');
  if (employee.roleIds.length === 0) push('roles', 'block', 'Give them at least one role.');
  if (!employee.dateOfBirth || Number.isNaN(age)) {
    push('dob', 'block', 'Date of birth is required to check minimum wage and young worker limits.');
  } else if (age < 16) {
    push('dob', 'block', 'Under school leaving age. Needs a local authority permit and cannot work in a bar or kitchen.');
  }
  if (employee.startDate && employee.leaveDate && employee.leaveDate < employee.startDate) {
    push('dates', 'block', 'Leaving date is before the start date.');
  }

  if (employee.payBasis === 'hourly' && !Number.isNaN(age)) {
    const band = minimumWageFor(age, rates);
    if (band && employee.hourlyRate < band.hourly) {
      push('minimum-wage', 'block', `£${employee.hourlyRate.toFixed(2)}/h is below the ${band.label} of £${band.hourly.toFixed(2)}.`);
    } else {
      const step = nextWageStep(employee, today, rates);
      if (step && employee.hourlyRate < step.hourly) {
        push('wage-step', 'warn', `Moves to the ${step.label} on ${step.date}. Rate must rise to £${step.hourly.toFixed(2)} from that day.`);
      }
    }
  }
  if (employee.payBasis === 'salaried' && !Number.isNaN(age) && employee.maxWeeklyHours > 0) {
    // Salaried staff still have to clear minimum wage on the hours they actually work.
    const effective = employee.annualSalary / 52 / employee.maxWeeklyHours;
    const band = minimumWageFor(age, rates);
    if (band && effective < band.hourly) {
      push('salary-nmw', 'warn', `At their ${employee.maxWeeklyHours}h maximum the salary works out at £${effective.toFixed(2)}/h, below the ${band.label}.`);
    }
  }

  if (employee.contractedHours > employee.maxWeeklyHours) {
    push('hours', 'block', `Contracted ${employee.contractedHours}h is more than their ${employee.maxWeeklyHours}h maximum.`);
  }
  if (age < 18) {
    if (employee.optedOutOf48) push('opt-out', 'block', 'Under 18s cannot opt out of the 48 hour limit.');
    if (employee.maxWeeklyHours > 40) push('young-hours', 'warn', 'Under 18s are capped at 40 hours a week.');
  } else if (employee.maxWeeklyHours > 48 && !employee.optedOutOf48) {
    push('wtr-48', 'warn', 'Maximum above 48 hours without a signed opt-out.');
  }

  const rtw = employee.rightToWork;
  if (!rtw?.checked) {
    push('right-to-work', 'block', 'No right to work check on file. Do it before their first shift or carry the civil penalty risk.');
  } else if (rtw.expiry && rtw.expiry < today) {
    push('right-to-work', 'block', `Right to work expired on ${rtw.expiry}. They cannot work until a follow-up check is done.`);
  } else if (rtw.expiry && rtw.expiry <= addDays(today, LOOKAHEAD_DAYS)) {
    push('right-to-work-expiring', 'warn', `Right to work expires on ${rtw.expiry}. Book the follow-up check now.`);
  }

  if (!employee.pensionEnrolled && age >= rates.pensionMinAge && age < rates.pensionMaxAge) {
    const weekly =
      employee.payBasis === 'salaried' ? employee.annualSalary / 52 : employee.contractedHours * employee.hourlyRate;
    if (weekly > rates.pensionTriggerWeekly) {
      push('pension', 'warn', `Contract pays about £${weekly.toFixed(0)} a week, over the £${rates.pensionTriggerWeekly} trigger. They must be auto-enrolled.`);
    }
  }
  return checks;
}

/** A blank starter at a site, employed by that site's company unless changed. */
export function newEmployee(siteId: string, entityId: string, roleId: string, today: string): Employee {
  return {
    id: `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: '',
    siteId,
    entityId,
    coverSiteIds: [],
    roleIds: [roleId],
    payBasis: 'hourly',
    hourlyRate: UK_RATES_2026_27.minimumWage[0].hourly,
    annualSalary: 0,
    dateOfBirth: '',
    contractedHours: 0,
    maxWeeklyHours: 48,
    optedOutOf48: false,
    irregularHours: true,
    pensionEnrolled: true,
    availability: [],
    leave: [],
    startDate: today,
    rightToWork: { checked: false },
  };
}
