// What an import will do, worked out before anything is saved: for each kind of file, how many rows
// are ready, what the manager should know, what is held back and why, a table to check, and the API
// calls that will carry it out. Pure, so the screen only shows it and runs the calls.

import type { ImportKind } from '../ai/importMapper';
import { newEmployee } from '../engine/employees';
import { HOLIDAY_COLUMNS, importHoliday, importPeople, importShifts, PEOPLE_COLUMNS, SHIFT_COLUMNS } from '../engine/externalImport';
import {
  ABSENCE_COLUMNS, DOCUMENT_COLUMNS, HOURS_COLUMNS, importAbsences, importDocuments, importHours, importManagers, importReviews, importRightToWork, importTakings, importToil, importTraining,
  MANAGER_COLUMNS, REVIEW_COLUMNS, RTW_COLUMNS, TAKINGS_COLUMNS, TOIL_COLUMNS, TRAINING_COLUMNS,
} from '../engine/hrImport';
import { TEMPLATE_SHEETS } from '../engine/importTemplate';
import type { Employee, HrRecord, RotaState } from '../engine/types';

export const IMPORT_KINDS: { id: ImportKind; label: string; sheet: string; about: string }[] = [
  { id: 'team', label: 'Team', sheet: TEMPLATE_SHEETS.team, about: 'Everyone who works for you, with their working time opt-out, pension, availability and clock card. Do this first: everything else is matched to people already on Preshift.' },
  { id: 'managers', label: 'Managers', sheet: TEMPLATE_SHEETS.managers, about: 'The managers who need their own sign-in, invited by email with their role and sites, exactly as from Access.' },
  { id: 'rtw', label: 'Right to work', sheet: TEMPLATE_SHEETS.rtw, about: 'The date each check was done, the evidence seen and any expiry. Without a dated check nobody can be rostered.' },
  { id: 'documents', label: 'HR file and documents', sheet: TEMPLATE_SHEETS.documents, about: 'Contract type, written statement issued and signed, probation, notice, NI number, emergency contact, line manager, and other documents on file.' },
  { id: 'training', label: 'Training', sheet: TEMPLATE_SHEETS.training, about: 'Certificates an inspector, licensing officer or insurer asks for, with their dates and expiry.' },
  { id: 'reviews', label: 'Reviews', sheet: TEMPLATE_SHEETS.reviews, about: 'Probation reviews, appraisals and one-to-ones, with outcomes and when the next is due. Disciplinary cases are entered by hand, never from a file.' },
  { id: 'holiday', label: 'Holiday balances', sheet: TEMPLATE_SHEETS.holiday, about: "Each person's holiday position on the day you go live, so balances and the holiday pay accrual carry on from your old system." },
  { id: 'toil', label: 'TOIL', sheet: TEMPLATE_SHEETS.toil, about: 'Time off in lieu owed at go-live, as one opening balance per person. It is owed pay, so it is valued as a liability.' },
  { id: 'absences', label: 'Absences', sheet: TEMPLATE_SHEETS.absences, about: 'Sickness and other absence, for absence triggers, the Bradford factor and return to work. Holiday booked ahead goes to leave.' },
  { id: 'hours', label: 'Past hours', sheet: TEMPLATE_SHEETS.hours, about: 'Hours worked in the last 17 weeks or more, from timesheets or payroll, so the 48 hour average, night work, guaranteed hours offers and holiday accrual start from fact. Already paid by your old payroll, so never sent to payroll again.' },
  { id: 'takings', label: 'Takings', sheet: TEMPLATE_SHEETS.takings, about: 'Daily takings for at least the last eight weeks, so the forecast learns how each site trades from day one. Days the till has already sent are kept.' },
  { id: 'rota', label: 'Rota', sheet: TEMPLATE_SHEETS.rota, about: 'Shifts already planned for the weeks ahead. They arrive as a draft for you to check and publish.' },
];

export const IMPORT_ALIASES: Record<ImportKind, Record<string, string[]>> = {
  team: PEOPLE_COLUMNS, rota: SHIFT_COLUMNS, holiday: HOLIDAY_COLUMNS,
  absences: ABSENCE_COLUMNS, toil: TOIL_COLUMNS, documents: DOCUMENT_COLUMNS, training: TRAINING_COLUMNS, rtw: RTW_COLUMNS,
  hours: HOURS_COLUMNS, takings: TAKINGS_COLUMNS, managers: MANAGER_COLUMNS, reviews: REVIEW_COLUMNS,
};

/** A call that puts back what an import saved: the shapes the server accepts are in server/routes/imports.ts. */
export interface UndoCall {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
}

export interface ImportCall {
  method: 'POST' | 'PATCH' | 'PUT';
  path: string;
  body: unknown;
  /** Who or what it is about, for the result list. */
  label: string;
  /** The calls that put it back, from what the server answered. Kept with the upload, so it can be undone. */
  undo: (res: unknown) => UndoCall[];
  /** Calls to make straight after, once the server has answered: a clock card for a person just added. */
  then?: (res: unknown) => { method: 'PUT' | 'PATCH' | 'POST'; path: string; body: unknown }[];
}

export interface ImportPlan {
  ready: number;
  /** What is being saved, for the button: "people", "absences". */
  noun: string;
  verb: 'Add' | 'Save' | 'Send';
  headers: string[];
  columns: Record<string, number | undefined>;
  unused: string[];
  /** Plain facts about what will happen. */
  info: string[];
  /** Things to act on, before or after saving. */
  warnings: string[];
  /** Rows held back, with the reason. */
  errors: string[];
  unknownPeople: { name: string; rows: number }[];
  table?: { head: string[]; rows: string[][] };
  calls: ImportCall[];
}

export interface PlanInput {
  kind: ImportKind;
  rows: string[][];
  state: RotaState;
  hrRecords: Pick<HrRecord, 'employeeId' | 'kind' | 'title' | 'date' | 'reviewType'>[];
  /** People with a sign-in here, by email: a manager already invited is not invited again. */
  users: { email: string }[];
  today: string;
  siteId: string;
  usDates: boolean;
  columns: Record<string, string>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const h = (n: number) => `${Math.round(n * 10) / 10}h`;
const day = (iso?: string) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const enc = encodeURIComponent;

const deleteRecord = (res: unknown): UndoCall[] => [{ method: 'DELETE', path: `/v1/hr/records/${enc((res as { id: string }).id)}` }];

export function planImport(p: PlanInput): ImportPlan {
  const { kind, rows, state, today } = p;
  // The record as it stands before the upload: what an undo puts back.
  const person = (id: string) => state.employees.find((e) => e.id === id);
  const o = { usDates: p.usDates, columns: p.columns as never };
  const base = (r: { headers: string[]; columns: object; unused: string[]; errors: string[] }, unknownPeople: { name: string; rows: number }[] = []) => ({
    headers: r.headers, columns: r.columns as Record<string, number | undefined>, unused: r.unused, errors: r.errors, unknownPeople, info: [] as string[], warnings: [] as string[],
  });

  if (kind === 'team') {
    const r = importPeople(rows, state, { ...o, today });
    const out: ImportPlan = { ...base(r), ready: r.people.length, noun: r.people.length === 1 ? 'person' : 'people', verb: 'Add', calls: [] };
    out.info.push(`${plural(r.people.length, 'person', 'people')} ready to add.${r.existing.length ? ` ${r.existing.length} already on Preshift, left out.` : ''}`);
    const noRtw = r.people.filter((x) => !x.person.rightToWork?.checked).length;
    if (noRtw) out.warnings.push(`${plural(noRtw, 'person has', 'people have')} no right to work check date: added, but cannot be rostered until the check is recorded. Import the checks next, under Right to work.`);
    const optedOut = r.people.filter((x) => x.extra.optedOutOf48).length;
    if (optedOut) out.info.push(`${plural(optedOut, 'person has', 'people have')} a signed 48 hour opt-out recorded. Keep the signed copy: upload it on each file under HR file and documents.`);
    const notes = r.people.flatMap((x) => x.notes.map((n) => `${x.person.name}: ${n}`));
    if (notes.length) out.warnings.push(...notes.slice(0, 20));
    if (r.unknownRoles.length) out.warnings.push(`Roles not set up here: ${r.unknownRoles.map((x) => `${x.name} (${x.rows})`).join(', ')}. Add them under Set-up, Roles, then upload again, or those rows are left out.`);
    if (r.unknownSites.length) out.warnings.push(`Sites not set up here: ${r.unknownSites.map((x) => `${x.name} (${x.rows})`).join(', ')}. Those people go to the site chosen above.`);
    out.calls = r.people.flatMap((x) => {
      const site = state.sites.find((s) => s.id === (x.siteId ?? p.siteId));
      if (!site) return [];
      const b = newEmployee(site.id, site.entityId, x.person.roleIds[0], today);
      const { id: _id, startDate: _start, ...rest } = { ...b, ...x.person };
      const body: Partial<Employee> = { ...rest, ...x.extra, ...(x.person.startDate ? { startDate: x.person.startDate } : {}), ...(x.email ? { email: x.email } : {}) };
      return [{
        method: 'POST' as const, path: '/v1/employees', body, label: x.person.name,
        undo: (res: unknown) => [{ method: 'DELETE' as const, path: `/v1/import/people/${enc((res as Employee).id)}` }],
        ...(x.badge ? { then: (res: unknown) => [{ method: 'PUT' as const, path: `/v1/employees/${enc((res as Employee).id)}/badge`, body: { badgeId: x.badge } }] } : {}),
      }];
    });
    return out;
  }

  if (kind === 'holiday') {
    const r = importHoliday(rows, state, today, o);
    const out: ImportPlan = { ...base(r, r.unknownPeople), ready: r.rows.length, noun: r.rows.length === 1 ? 'holiday balance' : 'holiday balances', verb: 'Save', calls: [] };
    out.info.push(`${plural(r.rows.length, 'balance')} ready${r.inDays ? ", read as days and turned into hours on each person's contracted day" : ', in hours'}.`);
    out.info.push("Remaining on Preshift is what each person will see today: the leave year's entitlement for fixed hours staff, holiday earned so far for irregular hours staff. Check three against your old system before saving: the untaken balance is the holiday pay accrual on the balance sheet.");
    out.table = {
      head: ['Name', 'Carried over', 'Accrued at go-live', 'Taken at go-live', 'Remaining on Preshift', ''],
      rows: r.rows.map((x) => [x.name, x.holiday.carriedOverHours !== undefined ? h(x.holiday.carriedOverHours) : '-', x.holiday.openingAccruedHours !== undefined ? h(x.holiday.openingAccruedHours) : 'From the dates', x.holiday.openingTakenHours !== undefined ? h(x.holiday.openingTakenHours) : '-', h(x.remainingHours), x.note ?? '']),
    };
    out.calls = r.rows.map((x) => ({
      method: 'PATCH' as const, path: `/v1/employees/${enc(x.employeeId)}`, body: { holiday: x.holiday }, label: x.name,
      undo: () => [{ method: 'PATCH' as const, path: `/v1/employees/${enc(x.employeeId)}`, body: { holiday: person(x.employeeId)?.holiday ?? {} } }],
    }));
    return out;
  }

  if (kind === 'toil') {
    const r = importToil(rows, state, today, o);
    const out: ImportPlan = { ...base(r, r.unknownPeople), ready: r.rows.length, noun: r.rows.length === 1 ? 'TOIL balance' : 'TOIL balances', verb: 'Save', calls: [] };
    const total = r.rows.reduce((n, x) => n + x.hours, 0);
    out.info.push(`${plural(r.rows.length, 'opening balance')} ready, ${h(total)} owed in all${r.inDays ? ", read as days and turned into hours on each person's contracted day" : ''}.`);
    if (r.existing.length) out.info.push(`Already opened on Preshift, left alone: ${r.existing.join(', ')}. Correct a balance there with an adjustment.`);
    out.table = { head: ['Name', 'Owed', 'As at'], rows: r.rows.map((x) => [x.name, h(x.hours), day(x.date)]) };
    // TOIL is never deleted: the undo is an adjustment that takes the opening balance back off.
    out.calls = r.rows.map((x) => ({
      method: 'POST' as const, path: `/v1/employees/${enc(x.employeeId)}/toil`, body: { kind: 'opening', date: x.date, hours: x.hours, note: 'Opening balance from the previous system' }, label: x.name,
      undo: () => [{ method: 'POST' as const, path: `/v1/employees/${enc(x.employeeId)}/toil`, body: { kind: 'adjustment', date: today, hours: -x.hours, note: 'Import of the opening balance undone' } }],
    }));
    return out;
  }

  if (kind === 'absences') {
    const r = importAbsences(rows, state, today, o);
    const leaveDays = r.leave.reduce((n, l) => n + l.dates.length, 0);
    const out: ImportPlan = { ...base(r, r.unknownPeople), ready: r.absences.length + r.leave.length, noun: 'records', verb: 'Save', calls: [] };
    out.info.push(`${plural(r.absences.length, 'absence')} ready${leaveDays ? `, and ${plural(leaveDays, 'day')} of holiday booked ahead for ${plural(r.leave.length, 'person', 'people')}` : ''}.`);
    if (r.duplicates) out.info.push(`${plural(r.duplicates, 'absence')} already on Preshift, left out.`);
    if (r.pastHoliday) out.info.push(`${plural(r.pastHoliday, 'holiday row')} already taken: counted in the holiday balance at go-live, so not added again.`);
    if (r.toilRows) out.info.push(`${plural(r.toilRows, 'TOIL row')} left out: TOIL comes across as a balance, under TOIL.`);
    if (r.assumedSickness) out.warnings.push('The file has no absence type column, so every row is read as sickness. Choose the type column above if it has one.');
    if (r.fitNotesMissing) out.warnings.push(`${plural(r.fitNotesMissing, 'sickness spell')} of more than seven days with no fit note recorded. Upload the fit note on each person's file, or record that none was given.`);
    out.warnings.push('Why someone was off is health data: it is kept on the HR file and shown only to those who read it.');
    out.table = { head: ['Name', 'Type', 'From', 'To'], rows: r.absences.slice(0, 200).map((x) => [x.name, x.absence.type ?? '', day(x.absence.from), x.absence.to ? day(x.absence.to) : 'Still off']) };
    out.calls = [
      ...r.absences.map((x) => ({
        method: 'POST' as const, path: `/v1/employees/${enc(x.employeeId)}/absences`, body: x.absence, label: `${x.name}, ${day(x.absence.from)}`,
        undo: (res: unknown) => [{ method: 'DELETE' as const, path: `/v1/employees/${enc(x.employeeId)}/absences/${enc((res as { absence: { id: string } }).absence.id)}` }],
      })),
      ...r.leave.map((l) => {
        const e = state.employees.find((x) => x.id === l.employeeId)!;
        return {
          method: 'PATCH' as const, path: `/v1/employees/${enc(l.employeeId)}`, body: { leave: [...new Set([...e.leave, ...l.dates])].sort() }, label: `${l.name}, holiday booked`,
          undo: () => [{ method: 'PATCH' as const, path: `/v1/employees/${enc(l.employeeId)}`, body: { leave: e.leave } }],
        };
      }),
    ];
    return out;
  }

  if (kind === 'documents') {
    const r = importDocuments(rows, state, p.hrRecords, o);
    const out: ImportPlan = { ...base(r, r.unknownPeople), ready: r.profiles.length + r.documents.length, noun: 'records', verb: 'Save', calls: [] };
    out.info.push(`${plural(r.profiles.length, 'HR file')} to update${r.documents.length ? `, and ${plural(r.documents.length, 'document')} to record` : ''}. Fields not in the file are left as they are.`);
    if (r.copiesNeeded) out.warnings.push(`${plural(r.copiesNeeded, 'written statement')} recorded by date only. Upload the signed copy on each person's file, or send it to sign in the staff app: the copy is the evidence.`);
    const notes = r.profiles.flatMap((x) => x.notes.map((n) => `${x.name}: ${n}`));
    if (notes.length) out.warnings.push(...notes.slice(0, 20));
    out.table = { head: ['Name', 'Updates'], rows: r.profiles.map((x) => [x.name, x.fields.map((f) => FIELD_NAMES[f] ?? f).join(', ')]) };
    out.calls = [
      ...r.profiles.map((x) => ({
        method: 'PUT' as const, path: `/v1/employees/${enc(x.employeeId)}/hr`, body: x.profile, label: x.name,
        undo: () => [{ method: 'PUT' as const, path: `/v1/employees/${enc(x.employeeId)}/hr`, body: person(x.employeeId)?.hr ?? {} }],
      })),
      ...r.documents.map((x) => ({ method: 'POST' as const, path: '/v1/hr/records', body: x.record, label: `${x.name}, ${x.record.title}`, undo: deleteRecord })),
    ];
    return out;
  }

  if (kind === 'training') {
    const r = importTraining(rows, state, p.hrRecords, today, o);
    const out: ImportPlan = { ...base(r, r.unknownPeople), ready: r.records.length, noun: r.records.length === 1 ? 'certificate' : 'certificates', verb: 'Add', calls: [] };
    out.info.push(`${plural(r.records.length, 'certificate')} ready.${r.duplicates ? ` ${r.duplicates} already on file, left out.` : ''}`);
    const suggested = r.records.filter((x) => x.suggestedExpiry).length;
    if (suggested) out.info.push(`${plural(suggested, 'certificate')} with no expiry in the file: given the course's usual renewal date, as when recorded by hand.`);
    if (r.expired) out.warnings.push(`${plural(r.expired, 'certificate')} already expired: they show as due on Training.`);
    if (r.otherCourses.length) out.info.push(`Kept under their own name: ${r.otherCourses.map((x) => `${x.name} (${x.rows})`).join(', ')}.`);
    out.table = { head: ['Name', 'In the file', 'Recorded as', 'Passed', 'Expires'], rows: r.records.slice(0, 200).map((x) => [x.name, x.from, x.record.title, day(x.record.date), x.record.expiresOn ? `${day(x.record.expiresOn)}${x.suggestedExpiry ? ' (usual renewal)' : ''}` : 'Does not expire']) };
    out.calls = r.records.map((x) => ({ method: 'POST' as const, path: '/v1/hr/records', body: x.record, label: `${x.name}, ${x.record.title}`, undo: deleteRecord }));
    return out;
  }

  if (kind === 'rtw') {
    const r = importRightToWork(rows, state, today, o);
    const out: ImportPlan = { ...base(r, r.unknownPeople), ready: r.checks.length, noun: r.checks.length === 1 ? 'check' : 'checks', verb: 'Save', calls: [] };
    out.info.push(`${plural(r.checks.length, 'check')} ready.`);
    if (r.newerOnFile.length) out.info.push(`A later check is already on Preshift for ${r.newerOnFile.join(', ')}: left as it is.`);
    if (r.copiesNeeded) out.warnings.push(`${plural(r.copiesNeeded, 'check')} with no copy of the documents held. The date alone is not a statutory excuse: upload a clear copy of what was seen on each person's file. The civil penalty is up to £60,000 per illegal worker.`);
    if (r.expired) out.warnings.push(`${plural(r.expired, 'person', 'people')} with permission already expired: they cannot be rostered until a follow-up check is recorded.`);
    const notes = r.checks.flatMap((x) => x.notes.map((n) => `${x.name}: ${n}`));
    if (notes.length) out.warnings.push(...notes.slice(0, 20));
    out.table = { head: ['Name', 'Checked', 'Evidence', 'Expires'], rows: r.checks.map((x) => [x.name, day(x.rightToWork.checkedOn), x.rightToWork.evidence ?? '', x.rightToWork.expiry ? day(x.rightToWork.expiry) : 'No time limit']) };
    out.calls = r.checks.map((x) => ({
      method: 'PATCH' as const, path: `/v1/employees/${enc(x.employeeId)}`, body: { rightToWork: x.rightToWork }, label: x.name,
      // Copies held are the server's and stay; only the check details are put back.
      undo: () => {
        const { documents: _d, ...before } = person(x.employeeId)?.rightToWork ?? { checked: false };
        return [{ method: 'PATCH' as const, path: `/v1/employees/${enc(x.employeeId)}`, body: { rightToWork: before } }];
      },
    }));
    return out;
  }

  if (kind === 'managers') {
    const r = importManagers(rows, state, p.users, { columns: p.columns as never });
    const out: ImportPlan = { ...base(r), ready: r.invites.length, noun: r.invites.length === 1 ? 'invitation' : 'invitations', verb: 'Send', calls: [] };
    out.info.push(`${plural(r.invites.length, 'manager')} to invite. Each gets an email to choose their own password; the link lasts seven days.${r.existing.length ? ` Already signed in here: ${r.existing.join(', ')}.` : ''}`);
    out.info.push('Directors and managers of the business need an authenticator before pay, payroll and access open to them; Preshift asks them for it on first sign-in.');
    out.table = { head: ['Name', 'Email', 'Role', 'Sites'], rows: r.invites.map((x) => [x.name, x.email, x.roleName, x.siteIds ? x.siteIds.map((id) => state.sites.find((s) => s.id === id)?.name ?? id).join(', ') : 'Every site']) };
    out.calls = r.invites.map((x) => ({
      method: 'POST' as const, path: '/v1/users', label: x.name,
      body: { name: x.name, email: x.email, audience: 'operator', roleId: x.roleId, siteIds: x.siteIds, ...(x.employeeId ? { employeeId: x.employeeId } : {}) },
      undo: (res: unknown) => [{ method: 'DELETE' as const, path: `/v1/users/${enc((res as { user: { id: string } }).user.id)}/invite` }],
    }));
    return out;
  }

  if (kind === 'reviews') {
    const r = importReviews(rows, state, p.hrRecords, today, o);
    const out: ImportPlan = { ...base(r, r.unknownPeople), ready: r.records.length, noun: r.records.length === 1 ? 'review' : 'reviews', verb: 'Add', calls: [] };
    out.info.push(`${plural(r.records.length, 'review')} ready.${r.duplicates ? ` ${r.duplicates} already on file, left out.` : ''}`);
    if (r.probationsPassed.length) out.info.push(`${plural(r.probationsPassed.length, 'probation')} passed: the date is set on each HR file too.`);
    out.table = { head: ['Name', 'Review', 'Held', 'Outcome', 'Next due'], rows: r.records.slice(0, 200).map((x) => [x.name, x.record.title, day(x.record.date), x.record.outcome ?? '', x.record.nextDue ? day(x.record.nextDue) : '']) };
    out.calls = [
      ...r.records.map((x) => ({ method: 'POST' as const, path: '/v1/hr/records', body: x.record, label: `${x.name}, ${x.record.title}`, undo: deleteRecord })),
      ...r.probationsPassed.map((x) => {
        const before = person(x.employeeId)?.hr ?? {};
        return {
          method: 'PUT' as const, path: `/v1/employees/${enc(x.employeeId)}/hr`, body: { ...before, probationPassedOn: x.date }, label: `${person(x.employeeId)?.name ?? ''}, probation passed`,
          undo: () => [{ method: 'PUT' as const, path: `/v1/employees/${enc(x.employeeId)}/hr`, body: before }],
        };
      }),
    ];
    return out;
  }

  if (kind === 'hours') {
    const r = importHours(rows, state, today, { ...o, siteId: undefined });
    const out: ImportPlan = { ...base(r, r.unknownPeople), ready: r.entries.length, noun: r.entries.length === 1 ? 'day worked' : 'days worked', verb: 'Add', calls: [] };
    out.info.push(`${plural(r.entries.length, 'day')} worked, ${h(r.hoursTotal)} in all, over ${plural(r.weeks, 'week')}. Stored as already paid by your old payroll: never sent to payroll, never approved again.`);
    if (r.weeks < 17) out.warnings.push(`${plural(r.weeks, 'week')} of history. The 48 hour week and night work are averaged over 17 weeks: bring 17 or more if your old system has them.`);
    if (r.fromWeeklyTotals) out.warnings.push(`${plural(r.fromWeeklyTotals, 'weekly total')} spread evenly over Monday to Friday, with no times. Enough for the 48 hour average and holiday accrual; night work and rest need clock in and out times.`);
    if (r.withoutTimes) out.info.push(`${plural(r.withoutTimes, 'day')} with hours and no times, placed from 09:00.`);
    if (r.fromToday) out.info.push(`${plural(r.fromToday, 'row')} dated today or later left out: from go-live, hours are clocked on Preshift.`);
    out.calls = r.entries.length
      ? [{ method: 'POST', path: '/v1/import/hours', body: { entries: r.entries }, label: 'Past hours', undo: (res) => ((res as { added?: string[] }).added ?? []).map((id) => ({ method: 'DELETE' as const, path: `/v1/import/hours/${enc(id)}` })) }]
      : [];
    return out;
  }

  if (kind === 'takings') {
    const r = importTakings(rows, state, today, { ...o, siteId: p.siteId });
    const out: ImportPlan = { ...base(r, []), ready: r.rows.length, noun: r.rows.length === 1 ? 'day of takings' : 'days of takings', verb: 'Add', calls: [] };
    const sites = new Set(r.rows.map((x) => x.siteId)).size;
    out.info.push(`${plural(r.rows.length, 'day')} of takings for ${plural(sites, 'site')}, net of VAT.${r.kept ? ` ${r.kept} days already held, from the till or keyed in, kept as they are.` : ''}`);
    if (r.fromGross) out.warnings.push(`${plural(r.fromGross, 'day')} given only including VAT, turned into net at 20%. If some sales are zero-rated or reduced, give net figures instead.`);
    if (r.days && r.days < 56) out.warnings.push(`${plural(r.days, 'day')} of history. The forecast weighs the last eight weeks: bring at least 56 days if you have them.`);
    if (r.unknownSites.length) out.warnings.push(`Sites not set up here: ${r.unknownSites.map((x) => `${x.name} (${x.rows})`).join(', ')}. Those rows are left out.`);
    out.calls = r.rows.length
      ? [{
          method: 'PUT', path: '/v1/sales', body: { rows: r.rows.map((x) => ({ ...x, source: 'import' })) }, label: 'Takings',
          undo: () => r.rows.map((x) => ({ method: 'DELETE' as const, path: `/v1/sales?siteId=${enc(x.siteId)}&date=${x.date}` })),
        }]
      : [];
    return out;
  }

  const r = importShifts(rows, state, { ...o, siteId: p.siteId });
  const out: ImportPlan = { ...base(r, r.unknownPeople), ready: r.shifts.length, noun: r.shifts.length === 1 ? 'shift' : 'shifts', verb: 'Add', calls: [] };
  out.info.push(`${plural(r.shifts.length, 'shift')} ready${r.weeks.length ? `, in the weeks of ${r.weeks.map(day).join(', ')}` : ''}.${r.duplicates ? ` ${r.duplicates} already on the rota, left out.` : ''}`);
  if (r.roleFromPerson) out.info.push(`${plural(r.roleFromPerson, 'shift')} with no role Preshift recognises given the person's own role.`);
  if (r.unknownSites.length) out.warnings.push(`Sites not set up here: ${r.unknownSites.map((x) => `${x.name} (${x.rows})`).join(', ')}. Those shifts are left out.`);
  out.calls = r.shifts.length
    ? [{ method: 'POST', path: '/v1/rota/import', body: { shifts: r.shifts.map(({ published: _p, ...s }) => s) }, label: 'Rota', undo: (res) => ((res as { ids?: string[] }).ids ?? []).map((id) => ({ method: 'DELETE' as const, path: `/v1/shifts/${enc(id)}` })) }]
    : [];
  return out;
}

const FIELD_NAMES: Record<string, string> = {
  jobTitle: 'job title', contractType: 'contract type', contractIssuedOn: 'statement issued', contractSignedOn: 'statement signed', handbookAcknowledgedOn: 'handbook',
  probationEnd: 'probation end', probationPassedOn: 'probation passed', fixedTermEnd: 'fixed term end', noticeWeeks: 'notice', niNumber: 'NI number',
  address: 'address', postcode: 'postcode', emergencyContact: 'emergency contact', managerId: 'line manager',
};
