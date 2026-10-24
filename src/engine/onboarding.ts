// Onboarding a new person: everything that has to be true before, on and soon after their first
// day, in the order a GM should do it. Pure, shared by the People screens and their tests.
//
// It reads the same rules as the rest of the record (reviewEmployee for what blocks a shift,
// hrChecks for what the personnel file needs) and lays them out as one list per starter, so a
// new person is finished once, properly, rather than chased item by item for months.

import { employeeStatus, reviewEmployee } from './employees';
import { requiredCourses, trainingStatus } from './hr';
import { addDays, daysBetween } from './time';
import type { Employee, HrRecord, Role } from './types';

/** How far ahead a starter shows: far enough to get the paperwork done before day one. */
export const ONBOARDING_AHEAD_DAYS = 60;
/** How long after the first day someone counts as new: probation's first review usually lands here. */
export const ONBOARDING_WINDOW_DAYS = 90;

/** Where the step is put right, so the screen can open the right form. */
export type OnboardingArea = 'record' | 'profile' | 'training' | 'payroll' | 'clocking';

/** The record checks that stop a shift, other than right to work, which has steps of its own. */
const RECORD_CODES = ['name', 'roles', 'dob', 'minimum-wage', 'hours', 'opt-out', 'dates'];

export type StepState = 'done' | 'todo' | 'late' | 'hidden';

export interface OnboardingStep {
  code: string;
  label: string;
  area: OnboardingArea;
  state: StepState;
  /** Due by: before the first day for the legal steps, within the first weeks for the rest. */
  due?: string;
  /** Must be done before they work a shift. */
  blocking: boolean;
  /** What is missing, or what was recorded. */
  detail: string;
}

export interface Onboarding {
  employee: Employee;
  firstDay?: string;
  /** Days until the first day: negative once they have started. */
  daysToStart: number | null;
  steps: OnboardingStep[];
  done: number;
  /** Steps the reader can see. */
  total: number;
  /** Something that stops them working a shift, or a step past its due date. */
  blocked: boolean;
  late: number;
  complete: boolean;
}

/** What the reader may see, as the API withholds the rest: pay, personnel file, training. */
export interface OnboardingSight {
  hr: boolean;
  pay: boolean;
}

/** What the server knows that the record does not: whether the person has the staff app. */
export interface OnboardingExtras {
  staffApp?: 'active' | 'invited' | 'expired';
}

/** Is this person new enough to be onboarding: starting soon, or started inside the window. */
export function isNewStarter(e: Employee, today: string): boolean {
  if (!e.startDate || e.anonymisedOn) return false;
  const status = employeeStatus(e, today);
  if (status === 'left') return false;
  return e.startDate <= addDays(today, ONBOARDING_AHEAD_DAYS) && e.startDate >= addDays(today, -ONBOARDING_WINDOW_DAYS);
}

export function onboardingFor(
  e: Employee,
  records: HrRecord[],
  roles: Role[],
  today: string,
  sight: OnboardingSight,
  extras: OnboardingExtras = {},
): Onboarding {
  const steps: OnboardingStep[] = [];
  const first = e.startDate;
  // Legal steps are due by the first day; the rest within the first fortnight or month.
  const byDay = (days: number) => (first ? addDays(first, days) : undefined);
  const add = (s: Omit<OnboardingStep, 'state'> & { ok: boolean; visible?: boolean }) => {
    const { ok, visible = true, ...rest } = s;
    const state: StepState = !visible ? 'hidden' : ok ? 'done' : rest.due && rest.due < today ? 'late' : 'todo';
    steps.push({ ...rest, state });
  };

  // 1. Right to work: the civil penalty is per person, and the excuse needs the check before day one.
  const rtw = e.rightToWork;
  const personal = !e.personalHidden;
  add({
    code: 'right-to-work', label: 'Right to work checked', area: 'record', blocking: true, due: first, ok: !!rtw?.checked,
    detail: rtw?.checked ? (rtw.evidence ? `Checked: ${rtw.evidence}${rtw.checkedOn ? ` on ${rtw.checkedOn}` : ''}` : 'Checked') : 'Not checked. They cannot be rostered until it is.',
  });
  add({
    code: 'right-to-work-copy', label: 'Copy of the documents held, with the date checked', area: 'record', blocking: false, due: first,
    visible: personal, ok: !!rtw?.checked && (rtw.documents?.length ?? 0) > 0 && !!rtw.checkedOn,
    detail: !rtw?.checked ? 'Do the check first.' : (rtw.documents?.length ?? 0) === 0 ? 'No copy held: without one there is no statutory excuse.' : !rtw.checkedOn ? 'Record the date of the check.' : `${rtw.documents!.length} ${rtw.documents!.length === 1 ? 'copy' : 'copies'} held`,
  });

  // 2. Roles, age and pay at or above the legal minimum for that age, as the record check decides.
  // Hidden from those who may not see pay, whose copy reads as nought.
  const problem = reviewEmployee(e, today).find((c) => c.severity === 'block' && RECORD_CODES.includes(c.code));
  const paid = e.payBasis === 'salaried' ? e.annualSalary > 0 : e.hourlyRate > 0;
  add({
    code: 'details', label: 'Roles, date of birth and pay recorded', area: 'record', blocking: true, due: first,
    visible: sight.pay, ok: !problem && paid,
    detail: problem?.message ?? (paid ? 'Recorded and checked against the minimum wage band.' : 'No pay recorded.'),
  });

  // 3. The personnel file. A written statement is a day one right.
  const hr = e.hr ?? {};
  add({
    code: 'statement', label: 'Written statement of particulars issued', area: 'profile', blocking: false, due: first,
    visible: sight.hr, ok: !!hr.contractIssuedOn,
    detail: hr.contractIssuedOn ? `Issued on ${hr.contractIssuedOn}` : 'Due on or before the first day. A tribunal can add two to four weeks\' pay without one.',
  });
  // Sent to sign in the staff app: the newest of each kind, so the step can say where it stands.
  const sent = (kind: 'statement' | 'handbook') =>
    records.filter((r) => r.employeeId === e.id && r.signing?.kind === kind).sort((a, b) => b.signing!.sentAt.localeCompare(a.signing!.sentAt))[0]?.signing;
  const waiting = (s: ReturnType<typeof sent>, otherwise: string) =>
    s && !s.signedAt ? `Sent to sign in the staff app on ${s.sentAt.slice(0, 10)}${s.openedAt ? ', opened, not yet signed.' : ', not yet opened.'}` : otherwise;
  const statement = sent('statement');
  add({
    code: 'contract-signed', label: 'Signed contract on file', area: 'profile', blocking: false, due: byDay(14),
    visible: sight.hr, ok: !!hr.contractSignedOn,
    detail: hr.contractSignedOn
      ? `Signed on ${hr.contractSignedOn}${statement?.signedAt ? ' in the staff app' : ''}`
      : waiting(statement, 'Send it to sign in the staff app on day one, or chase the signed copy in the first fortnight.'),
  });
  const handbook = sent('handbook');
  add({
    code: 'handbook', label: 'Handbook read and signed', area: 'profile', blocking: false, due: byDay(7),
    visible: sight.hr, ok: !!hr.handbookAcknowledgedOn,
    detail: hr.handbookAcknowledgedOn
      ? `Signed on ${hr.handbookAcknowledgedOn}${handbook?.signedAt ? ' in the staff app' : ''}`
      : waiting(handbook, 'Send the handbook to sign in the staff app, so the rules they work to are on record.'),
  });
  add({
    code: 'ni-number', label: 'National Insurance number', area: 'profile', blocking: false, due: first,
    visible: sight.hr, ok: !!hr.niNumber,
    detail: hr.niNumber ? 'Recorded' : 'Without it payroll taxes them on an emergency code.',
  });
  add({
    code: 'emergency-contact', label: 'Address and emergency contact', area: 'profile', blocking: false, due: first,
    visible: sight.hr, ok: !!hr.emergencyContact?.phone && !!hr.address,
    detail: !hr.address ? 'No address.' : !hr.emergencyContact?.phone ? 'No emergency contact.' : `Emergency contact: ${hr.emergencyContact.name ?? 'recorded'}`,
  });
  add({
    code: 'probation', label: 'Probation end date set', area: 'profile', blocking: false, due: byDay(7),
    visible: sight.hr, ok: !!hr.probationEnd,
    detail: hr.probationEnd ? `Review by ${hr.probationEnd}` : 'Set it, so the review is held before it passes by default.',
  });

  // 4. Training the role needs. Allergen awareness and food hygiene are what an EHO asks for first.
  for (const course of requiredCourses(e, roles)) {
    const { status, latest } = trainingStatus(records, e.id, course.name, today);
    add({
      code: `training:${course.name}`, label: course.name, area: 'training', blocking: false, due: byDay(28),
      visible: sight.hr, ok: status === 'valid' || status === 'expiring',
      detail: latest ? (latest.expiresOn ? `On file, expires ${latest.expiresOn}` : 'On file') : 'Expected for their role. Book it inside the first month.',
    });
  }

  // 5. Payroll: set up in TeamPay before the first pay run, or their hours have nowhere to go.
  add({
    code: 'payroll', label: 'Set up in payroll', area: 'payroll', blocking: false, due: byDay(7),
    ok: !!e.payrollId, detail: e.payrollId ? 'In TeamPay' : 'Not in TeamPay yet. Their hours cannot be paid until they are.',
  });

  // 6. Clocking: a card or the staff app, so their hours come from the door, not from memory.
  const app = extras.staffApp;
  add({
    code: 'clocking', label: 'Can clock in: card issued or staff app set up', area: 'clocking', blocking: false, due: first,
    ok: !!e.badgeId || app === 'active',
    detail: e.badgeId ? 'Card issued' : app === 'active' ? 'Uses the staff app' : app === 'invited' ? 'Staff app invited, not yet joined' : app === 'expired' ? 'Staff app invitation expired: send a new one' : 'No card and no staff app.',
  });

  const seen = steps.filter((s) => s.state !== 'hidden');
  const done = seen.filter((s) => s.state === 'done').length;
  const late = seen.filter((s) => s.state === 'late').length;
  const blocked = seen.some((s) => s.blocking && s.state !== 'done') || late > 0;
  return {
    employee: e,
    firstDay: first,
    daysToStart: first ? daysBetween(today, first) : null,
    steps,
    done,
    total: seen.length,
    blocked,
    late,
    complete: done === seen.length,
  };
}

/** Everyone onboarding in scope, those starting soonest and those stuck first. */
export function onboardingList(
  employees: Employee[],
  records: HrRecord[],
  roles: Role[],
  today: string,
  sight: (e: Employee) => OnboardingSight,
  extras: (e: Employee) => OnboardingExtras = () => ({}),
): Onboarding[] {
  return employees
    .filter((e) => isNewStarter(e, today))
    .map((e) => onboardingFor(e, records, roles, today, sight(e), extras(e)))
    .sort((a, b) => Number(a.complete) - Number(b.complete) || Number(b.blocked) - Number(a.blocked) || (a.firstDay ?? '').localeCompare(b.firstDay ?? ''));
}
