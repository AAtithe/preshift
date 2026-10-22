import { employeeStatus, isEmployedOn, LOOKAHEAD_DAYS, type RecordCheck } from './employees';
import { addDays, daysBetween } from './time';
import type { Absence, AbsenceType, CaseType, Department, Employee, HrRecord, ReviewType, Role } from './types';

export const ABSENCE_LABEL: Record<AbsenceType, string> = {
  sickness: 'Sickness',
  unauthorised: 'Unauthorised',
  compassionate: 'Compassionate',
  dependants: 'Time off for dependants',
  family: 'Maternity, paternity or adoption',
  unpaid: 'Unpaid leave',
  other: 'Other',
};

export const REVIEW_LABEL: Record<ReviewType, string> = {
  probation: 'Probation review',
  appraisal: 'Appraisal',
  'one-to-one': 'One to one',
};

export const CASE_LABEL: Record<CaseType, string> = {
  investigation: 'Investigation',
  disciplinary: 'Disciplinary',
  grievance: 'Grievance',
  capability: 'Capability',
};

/** Outcomes in the order the ACAS code escalates them. */
export const CASE_OUTCOMES = [
  'No action',
  'Informal action',
  'Verbal warning',
  'First written warning',
  'Final written warning',
  'Dismissal',
  'Grievance upheld',
  'Grievance partly upheld',
  'Grievance not upheld',
];

/** Self-certification covers seven calendar days of sickness; after that a fit note is needed. */
export const FIT_NOTE_AFTER_DAYS = 7;
/** Days after a spell ends that a missing return to work conversation is still worth chasing. */
export const RETURN_TO_WORK_WINDOW_DAYS = 90;
/** Bradford factor scores at which absence should be reviewed, and the formal procedure considered. */
export const BRADFORD_REVIEW = 51;
export const BRADFORD_FORMAL = 201;
/** Days before probation ends that the review is flagged. */
export const PROBATION_NOTICE_DAYS = 14;

// Only absence the person chose or could not explain counts towards triggers. Family, dependants
// and compassionate leave are statutory rights and must never count against anyone.
const TRIGGER_TYPES: AbsenceType[] = ['sickness', 'unauthorised'];

export interface Course {
  name: string;
  /** Departments where the business expects every person to hold it. */
  requiredFor: Department[];
  /** Usual refresh period, used to suggest the expiry when a course is recorded. */
  renewYears?: number;
}

/**
 * The certificates a hospitality operator is asked for by an environmental health officer,
 * a licensing officer or an insurer. Food hygiene and allergen training are how a business
 * shows food handlers are "supervised and instructed or trained" as the law requires.
 */
export const COURSES: Course[] = [
  { name: 'Food hygiene level 2', requiredFor: ['BOH'], renewYears: 3 },
  { name: 'Food hygiene level 3', requiredFor: ['MGMT'], renewYears: 3 },
  { name: 'Allergen awareness', requiredFor: ['FOH', 'BAR', 'BOH', 'MGMT'], renewYears: 3 },
  { name: 'Licensing and Challenge 25', requiredFor: ['BAR'], renewYears: 1 },
  { name: 'Personal licence', requiredFor: ['MGMT'] },
  { name: 'First aid at work', requiredFor: [], renewYears: 3 },
  { name: 'Fire marshal', requiredFor: [], renewYears: 3 },
  { name: 'Manual handling', requiredFor: [], renewYears: 3 },
  { name: 'COSHH', requiredFor: [], renewYears: 3 },
];

export function isAbsentOn(employee: Employee, date: string): boolean {
  return (employee.absences ?? []).some((a) => date >= a.from && (!a.to || date <= a.to));
}

/** Calendar days of a spell up to today: a spell still running counts to today, a future one not at all. */
export function absenceDays(absence: Absence, today: string): number {
  if (absence.from > today) return 0;
  const end = absence.to && absence.to < today ? absence.to : today;
  return daysBetween(absence.from, end) + 1;
}

export interface Bradford {
  spells: number;
  days: number;
  /** Spells squared times days, over the last 52 weeks. */
  score: number;
}

/**
 * Bradford factor over the last 52 weeks, on calendar days. Frequent short spells score far
 * higher than one long one, which is the point: they disrupt a rota more. Spells marked as
 * disability or pregnancy related are left out.
 */
export function bradfordFactor(employee: Employee, today: string): Bradford {
  const windowStart = addDays(today, -364);
  const spells = (employee.absences ?? []).filter(
    (a) => TRIGGER_TYPES.includes(a.type) && !a.excludeFromTriggers && a.from <= today && (a.to ?? today) >= windowStart,
  );
  const days = spells.reduce((sum, a) => sum + absenceDays({ ...a, from: a.from < windowStart ? windowStart : a.from }, today), 0);
  return { spells: spells.length, days, score: spells.length * spells.length * days };
}

export function requiredCourses(employee: Employee, roles: Role[]): Course[] {
  const departments = new Set(employee.roleIds.map((id) => roles.find((r) => r.id === id)?.department).filter(Boolean));
  return COURSES.filter((c) => c.requiredFor.some((d) => departments.has(d)));
}

export type TrainingStatus = 'valid' | 'expiring' | 'expired' | 'missing';

/** The latest record of a course for one person, and whether it is still in date. */
export function trainingStatus(records: HrRecord[], employeeId: string, course: string, today: string) {
  const latest = records
    .filter((r) => r.kind === 'training' && r.employeeId === employeeId && r.title === course)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  let status: TrainingStatus = 'missing';
  if (latest) {
    if (latest.expiresOn && latest.expiresOn < today) status = 'expired';
    else if (latest.expiresOn && latest.expiresOn <= addDays(today, LOOKAHEAD_DAYS)) status = 'expiring';
    else status = 'valid';
  }
  return { status, latest };
}

/** Statutory minimum notice from the employer: one week after a month, then a week a year to twelve. */
export function statutoryNoticeWeeks(employee: Employee, today: string): number {
  if (!employee.startDate) return 0;
  const days = daysBetween(employee.startDate, today);
  if (days < 30) return 0;
  return Math.min(12, Math.max(1, Math.floor(days / 365.25)));
}

export function lengthOfService(employee: Employee, today: string): string {
  if (!employee.startDate) return 'Not recorded';
  if (employee.startDate > today) return 'Not started';
  const months = Math.floor(daysBetween(employee.startDate, today) / 30.44);
  const years = Math.floor(months / 12);
  if (years === 0) return `${months}m`;
  return months % 12 ? `${years}y ${months % 12}m` : `${years}y`;
}

/**
 * Checks a personnel file: what the law requires to be on it, and what a manager should be
 * acting on this week. Separate from reviewEmployee, which decides whether someone can work a shift.
 */
export function hrChecks(employee: Employee, records: HrRecord[], roles: Role[], today: string): RecordCheck[] {
  const checks: RecordCheck[] = [];
  const push = (code: string, severity: RecordCheck['severity'], message: string) => checks.push({ code, severity, message });
  const hr = employee.hr ?? {};
  const mine = records.filter((r) => r.employeeId === employee.id);
  const status = employeeStatus(employee, today);
  if (status === 'left') return checks;

  if (!hr.contractIssuedOn) {
    if (status === 'starter') {
      push('statement', 'warn', `Issue the written statement of particulars before they start on ${employee.startDate}.`);
    } else {
      push('statement', 'block', 'No written statement of particulars on file. It is a day one right, and a tribunal can add two to four weeks\' pay to any award without one.');
    }
  } else if (!hr.contractSignedOn) {
    push('contract-signed', 'warn', `Contract issued on ${hr.contractIssuedOn} but no signed copy is on file.`);
  }
  if (!hr.niNumber) push('ni-number', 'warn', 'No National Insurance number. Payroll will tax them on an emergency basis until it is given.');
  if (!hr.emergencyContact?.phone) push('emergency-contact', 'warn', 'No emergency contact.');

  if (hr.probationEnd && !hr.probationPassedOn) {
    if (hr.probationEnd < today) {
      push('probation', 'warn', `Probation ended on ${hr.probationEnd} with no outcome recorded. Confirm it, or extend it in writing.`);
    } else if (hr.probationEnd <= addDays(today, PROBATION_NOTICE_DAYS)) {
      push('probation', 'warn', `Probation ends on ${hr.probationEnd}. Hold the review before then.`);
    }
  }

  if (hr.contractType === 'fixed-term' && hr.fixedTermEnd && !employee.leaveDate) {
    if (hr.fixedTermEnd < today) {
      push('fixed-term', 'warn', `Fixed-term contract ended on ${hr.fixedTermEnd}. Renew it in writing or process them as a leaver.`);
    } else if (hr.fixedTermEnd <= addDays(today, LOOKAHEAD_DAYS)) {
      push('fixed-term', 'warn', `Fixed-term contract ends on ${hr.fixedTermEnd}. Decide on renewal now.`);
    }
  }

  for (const a of employee.absences ?? []) {
    const days = absenceDays(a, today);
    if (a.from <= today && (!a.to || a.to >= today)) {
      push(`off:${a.id}`, 'warn', `Off since ${a.from} (${ABSENCE_LABEL[a.type].toLowerCase()})${a.to ? `, due back after ${a.to}` : ', no return date'}.`);
    }
    if (a.type === 'sickness' && days > FIT_NOTE_AFTER_DAYS && !a.fitNote && !a.fitNotes?.length) {
      push(`fit-note:${a.id}`, 'warn', `Off sick ${days} days from ${a.from} with no fit note. One is needed after seven days.`);
    }
    if (
      TRIGGER_TYPES.includes(a.type) && a.to && a.to < today && !a.returnToWorkOn &&
      daysBetween(a.to, today) <= RETURN_TO_WORK_WINDOW_DAYS
    ) {
      push(`rtw:${a.id}`, 'warn', `No return to work conversation recorded after the absence from ${a.from}.`);
    }
  }
  const bradford = bradfordFactor(employee, today);
  if (bradford.score >= BRADFORD_FORMAL) {
    push('bradford', 'warn', `Bradford factor ${bradford.score} (${bradford.spells} spells, ${bradford.days} days). Consider the formal absence procedure.`);
  } else if (bradford.score >= BRADFORD_REVIEW) {
    push('bradford', 'warn', `Bradford factor ${bradford.score} (${bradford.spells} spells, ${bradford.days} days). Hold an informal absence review.`);
  }

  for (const course of requiredCourses(employee, roles)) {
    const { status: s, latest } = trainingStatus(mine, employee.id, course.name, today);
    if (s === 'missing') push(`training:${course.name}`, 'warn', `${course.name} not on file. Expected for their role.`);
    if (s === 'expired') push(`training:${course.name}`, 'warn', `${course.name} expired on ${latest!.expiresOn}.`);
    if (s === 'expiring') push(`training:${course.name}`, 'warn', `${course.name} expires on ${latest!.expiresOn}. Book the refresher.`);
  }
  // Optional courses still need renewing once someone holds them.
  for (const course of COURSES.filter((c) => !requiredCourses(employee, roles).includes(c))) {
    const { status: s, latest } = trainingStatus(mine, employee.id, course.name, today);
    if (s === 'expired') push(`training:${course.name}`, 'warn', `${course.name} expired on ${latest!.expiresOn}.`);
  }

  const reviews = mine.filter((r) => r.kind === 'review').sort((a, b) => b.date.localeCompare(a.date));
  const lastReview = reviews.find((r) => r.reviewType !== 'probation') ?? reviews[0];
  if (lastReview?.nextDue && lastReview.nextDue < today) {
    push('review-due', 'warn', `${REVIEW_LABEL[lastReview.reviewType ?? 'one-to-one']} was due on ${lastReview.nextDue}.`);
  } else if (
    (!employee.startDate || daysBetween(employee.startDate, today) > 365) &&
    !reviews.some((r) => r.date > addDays(today, -365))
  ) {
    push('review-due', 'warn', 'No appraisal or one to one recorded in the last year.');
  }

  for (const c of mine.filter((r) => r.kind === 'case')) {
    if (c.caseStatus !== 'closed') {
      push(`case:${c.id}`, 'warn', `Open ${CASE_LABEL[c.caseType ?? 'investigation'].toLowerCase()} case since ${c.date}: ${c.title}.`);
    } else if (c.warningExpires && c.warningExpires >= today) {
      push(`warning:${c.id}`, 'warn', `${c.outcome ?? 'Warning'} live until ${c.warningExpires}.`);
    }
  }
  return checks;
}

export interface HrSummary {
  headcount: number;
  startersLastYear: number;
  leaversLastYear: number;
  /** Leavers in the last 12 months over average headcount. */
  turnover: number;
  /** Average length of service of current staff, in years. */
  averageTenureYears: number;
  /** Calendar days lost to sickness in the last 12 months, per head. */
  sickDaysPerHead: number;
  offToday: number;
}

export function hrSummary(employees: Employee[], today: string): HrSummary {
  const yearAgo = addDays(today, -365);
  const current = employees.filter((e) => ['active', 'leaving'].includes(employeeStatus(e, today)));
  const thenCount = employees.filter((e) => isEmployedOn(e, yearAgo) && (!e.startDate || e.startDate <= yearAgo)).length;
  const leavers = employees.filter((e) => e.leaveDate && e.leaveDate > yearAgo && e.leaveDate <= today).length;
  const starters = employees.filter((e) => e.startDate && e.startDate > yearAgo && e.startDate <= today).length;
  const averageHeadcount = (current.length + thenCount) / 2;
  const tenured = current.filter((e) => e.startDate);
  const sickDays = current.reduce(
    (sum, e) =>
      sum +
      (e.absences ?? [])
        .filter((a) => a.type === 'sickness' && (a.to ?? today) > yearAgo)
        .reduce((s, a) => s + absenceDays({ ...a, from: a.from < yearAgo ? addDays(yearAgo, 1) : a.from }, today), 0),
    0,
  );
  return {
    headcount: current.length,
    startersLastYear: starters,
    leaversLastYear: leavers,
    turnover: averageHeadcount > 0 ? leavers / averageHeadcount : 0,
    averageTenureYears: tenured.length ? tenured.reduce((s, e) => s + daysBetween(e.startDate!, today), 0) / tenured.length / 365.25 : 0,
    sickDaysPerHead: current.length ? sickDays / current.length : 0,
    offToday: current.filter((e) => isAbsentOn(e, today)).length,
  };
}
