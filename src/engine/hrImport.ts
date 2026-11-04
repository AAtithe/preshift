// The personnel side of moving from another system: absences, time off in lieu, the documents and
// contract details on each file, training certificates and right to work checks. Read from the same
// Excel or CSV files as the team and the rota (src/engine/externalImport.ts), matched to people
// already on Preshift by email or name, and saved through the same endpoints as the screens.
//
// The rules, as for the rest of the import:
// - Nothing is invented. A date that cannot be read holds the row back with the reason; a figure that
//   is not given is left as it was, never set to nought.
// - Nothing on file is overwritten with something older: a right to work check already recorded with
//   a later date stays; a field already on the HR file stays unless the file gives a value for it.
// - Copies of documents (passports, contracts, certificates, fit notes) cannot come through a
//   spreadsheet. The dates and details do; the copies are uploaded on each person's file, and the
//   preview says how many are still needed, because without a copy there is no statutory excuse.

import {
  dateOf,
  finder,
  fullName,
  matchColumns,
  nameKey,
  normal,
  sorted,
  table,
  tally,
  type ColumnMatch,
} from './externalImport';
import { COURSES } from './hr';
import { addDays } from './time';
import type { Absence, AbsenceType, ContractType, Employee, HrProfile, HrRecord, RightToWork, RotaState } from './types';

const PERSON = {
  name: ['full name', 'employee name', 'staff name', 'team member', 'name', 'employee', 'staff member'],
  firstName: ['first name', 'forename', 'given name'],
  lastName: ['last name', 'surname', 'family name'],
  email: ['email', 'email address', 'work email'],
};

export const ABSENCE_COLUMNS = {
  ...PERSON,
  type: ['absence type', 'type', 'leave type', 'category', 'absence category', 'absence reason category'],
  from: ['first day', 'start date', 'from', 'date from', 'absence start', 'start', 'date', 'first day off'],
  to: ['last day', 'end date', 'to', 'date to', 'absence end', 'end', 'last day off', 'returned'],
  days: ['days', 'days lost', 'duration days', 'number of days', 'total days', 'duration'],
  reason: ['reason', 'illness', 'details', 'description', 'cause'],
  fitNote: ['fit note', 'fit note received', 'sick note', 'medical certificate', 'doctors note'],
  returnToWork: ['return to work', 'return to work date', 'rtw interview', 'return to work interview', 'rtw meeting'],
  notes: ['notes', 'comments', 'comment'],
};
export const TOIL_COLUMNS = {
  ...PERSON,
  balance: ['toil balance', 'toil hours', 'balance', 'toil owed', 'hours owed', 'lieu balance', 'toil', 'time off in lieu', 'remaining', 'toil balance hours'],
  earned: ['toil earned', 'earned', 'hours earned', 'accrued'],
  taken: ['toil taken', 'taken', 'hours taken', 'used'],
  asOf: ['as at', 'as of', 'balance date', 'date'],
};
export const DOCUMENT_COLUMNS = {
  ...PERSON,
  jobTitle: ['job title', 'title', 'position title'],
  contractType: ['contract type', 'employment type', 'contract', 'employment status', 'type'],
  contractIssuedOn: ['contract issued', 'written statement issued', 'contract issued on', 'statement issued', 'contract sent'],
  contractSignedOn: ['contract signed', 'written statement signed', 'contract signed on', 'statement signed', 'contract returned'],
  handbookAcknowledgedOn: ['handbook acknowledged', 'handbook signed', 'handbook', 'handbook received'],
  probationEnd: ['probation end', 'probation end date', 'probation ends', 'end of probation'],
  probationPassedOn: ['probation passed', 'probation passed on', 'probation completed', 'probation signed off'],
  fixedTermEnd: ['fixed term end', 'contract end date', 'contract end', 'end of contract'],
  noticeWeeks: ['notice weeks', 'notice period weeks', 'notice period', 'notice'],
  niNumber: ['ni number', 'national insurance number', 'nino', 'ni no', 'national insurance', 'ni'],
  address: ['address', 'home address', 'address line 1', 'street'],
  postcode: ['postcode', 'post code', 'postal code', 'zip'],
  emergencyName: ['emergency contact', 'emergency contact name', 'next of kin', 'nok name', 'next of kin name'],
  emergencyRelationship: ['emergency contact relationship', 'relationship', 'next of kin relationship'],
  emergencyPhone: ['emergency contact phone', 'emergency phone', 'emergency contact number', 'next of kin phone', 'nok phone'],
  manager: ['line manager', 'manager', 'reports to'],
  document: ['document', 'document name', 'document title', 'file'],
  documentDate: ['document date', 'date signed', 'signed on', 'dated'],
};
export const TRAINING_COLUMNS = {
  ...PERSON,
  course: ['course', 'course name', 'training', 'certificate', 'qualification', 'training course', 'module'],
  date: ['completed', 'date completed', 'completed on', 'completion date', 'date passed', 'passed', 'date', 'achieved'],
  expiry: ['expiry', 'expires', 'expiry date', 'expires on', 'valid until', 'renewal date', 'renewal due'],
  notes: ['provider', 'notes', 'certificate number', 'awarding body'],
};
export const RTW_COLUMNS = {
  ...PERSON,
  checkedOn: ['right to work checked on', 'rtw checked on', 'date checked', 'check date', 'checked on', 'rtw check date', 'right to work date', 'rtw date', 'checked'],
  evidence: ['evidence', 'document type', 'document seen', 'evidence seen', 'rtw document', 'proof', 'id type', 'document'],
  expiry: ['visa expiry', 'permission expiry', 'rtw expiry', 'expiry', 'expiry date', 'leave to remain until', 'brp expiry', 'follow up check due'],
  studentHours: ['term time hour limit', 'student hours', 'student weekly hours', 'term time hours', 'weekly hour limit'],
};

type Aliases = Record<string, string[]>;
type Cell = (field: string) => string;

interface Base<F extends string> extends ColumnMatch<F> {
  errors: string[];
  unknownPeople: { name: string; rows: number }[];
}

/**
 * Walks the rows of a table, finds each row's person on Preshift by email or name, and hands the row
 * to `read`. Rows naming nobody on Preshift are counted; rows naming nobody at all are skipped.
 */
function walk<F extends string>(
  input: string | string[][],
  aliases: Aliases,
  employees: Employee[],
  chosen: Partial<Record<F, string>> | undefined,
  needs: { field: F; message: string }[],
  read: (cell: Cell, e: Employee, where: string, line: number, base: Base<F>) => void,
): Base<F> {
  const { rows, at } = table(input, aliases);
  const match = matchColumns(rows[0] ?? [], aliases as Record<F, string[]>, chosen);
  const base: Base<F> = { ...match, errors: [], unknownPeople: [] };
  if (!rows.length) return base;
  const c = match.columns as Record<string, number | undefined>;
  if (c.name === undefined && c.firstName === undefined && c.email === undefined) base.errors.push('No employee column found. Choose which column holds the name.');
  for (const n of needs) if (c[n.field] === undefined) base.errors.push(n.message);
  if (base.errors.length) return base;
  const people = employees.filter((e) => !e.anonymisedOn);
  const person = finder(people);
  const byEmail = new Map(people.filter((e) => e.email).map((e) => [e.email!.toLowerCase(), e.id]));
  const unknown = new Map<string, number>();
  rows.slice(1).forEach((cells, i) => {
    const line = at + i + 2;
    const cell: Cell = (f) => {
      const k = c[f];
      return k === undefined ? '' : (cells[k] ?? '').trim();
    };
    const name = fullName(cell);
    if (!name && !cell('email')) return;
    const id = (cell('email') && byEmail.get(cell('email').toLowerCase())) || (name ? person(name) : undefined);
    if (!id) return void tally(unknown, name || cell('email'));
    const e = people.find((x) => x.id === id)!;
    read(cell, e, `Row ${line} (${e.name})`, line, base);
  });
  base.unknownPeople = sorted(unknown);
  return base;
}

const yes = (v: string) => /^(y|yes|true|1|received|seen|held|done|x)$/i.test(v.trim());
const r2 = (n: number) => Math.round(n * 100) / 100;
const hoursOf = (raw: string) => {
  const v = raw.replace(/,/g, '').replace(/\s*(hours?|hrs?|h|days?|d)$/i, '').trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};
const dayHoursOf = (e: Employee) => (e.contractedHours > 0 ? e.contractedHours / 5 : null);

// ---- Absences ----

export type AbsenceField = keyof typeof ABSENCE_COLUMNS;

/** What an old system's absence type means here. Holiday and TOIL are not absences: they have their own records. */
export function absenceTypeOf(raw: string): AbsenceType | 'holiday' | 'toil' | null {
  const v = normal(raw);
  if (!v) return null;
  if (/\b(toil|lieu)\b/.test(v)) return 'toil';
  if (/\b(holiday|annual leave|vacation|al|bank holiday)\b/.test(v)) return 'holiday';
  if (/\b(sick|sickness|ill|illness|ssp|medical|injury|covid)\b/.test(v)) return 'sickness';
  if (/\b(unauthori[sz]ed|awol|no show|absent without)\b/.test(v)) return 'unauthorised';
  if (/\b(compassionate|bereavement|funeral)\b/.test(v)) return 'compassionate';
  if (/\b(dependant|dependent|emergency|childcare)\b/.test(v)) return 'dependants';
  if (/\b(maternity|paternity|adoption|parental|shared parental|family)\b/.test(v)) return 'family';
  if (/\bunpaid\b/.test(v)) return 'unpaid';
  return 'other';
}

export interface AbsenceImport extends Base<AbsenceField> {
  absences: { line: number; employeeId: string; name: string; absence: Omit<Absence, 'id'> }[];
  /** Holiday booked for days still to come, added to the person's leave. */
  leave: { employeeId: string; name: string; dates: string[] }[];
  /** Holiday already taken: counted in the holiday balance at go-live, so not added again. */
  pastHoliday: number;
  /** TOIL rows: kept in the TOIL balance, not as absences. */
  toilRows: number;
  /** Absence already on Preshift with the same first day and type. */
  duplicates: number;
  /** True when the file has no type column and every row was read as sickness. */
  assumedSickness: boolean;
  /** Spells of sickness over seven days without a fit note recorded. */
  fitNotesMissing: number;
}

export function importAbsences(input: string | string[][], state: Pick<RotaState, 'employees'>, today: string, options: { usDates?: boolean; columns?: Partial<Record<AbsenceField, string>> } = {}): AbsenceImport {
  const absences: AbsenceImport['absences'] = [];
  const leave = new Map<string, { employeeId: string; name: string; dates: Set<string> }>();
  let pastHoliday = 0;
  let toilRows = 0;
  let duplicates = 0;
  let fitNotesMissing = 0;
  const us = !!options.usDates;
  const base = walk<AbsenceField>(input, ABSENCE_COLUMNS, state.employees, options.columns, [{ field: 'from', message: 'No column for the first day off. Choose which column holds it.' }], (cell, e, where, line, base) => {
    const from = dateOf(cell('from'), us);
    if (!from) return void base.errors.push(`${where}: first day "${cell('from')}" not recognised.`);
    const ongoing = /^(ongoing|open|still off|current|n\/?a)$/i.test(cell('to'));
    let to = ongoing ? undefined : cell('to') ? dateOf(cell('to'), us) : null;
    if (to === null && cell('to')) return void base.errors.push(`${where}: last day "${cell('to')}" not recognised.`);
    if (to === null) {
      const days = hoursOf(cell('days'));
      // A number of days with no last day: calendar days from the first.
      to = days && days >= 1 ? addDays(from, Math.ceil(days) - 1) : from;
    }
    if (to && to < from) return void base.errors.push(`${where}: the last day is before the first.`);
    const kind = base.columns.type === undefined ? 'sickness' : absenceTypeOf(cell('type')) ?? 'other';
    if (kind === 'toil') return void toilRows++;
    if (kind === 'holiday') {
      const last = to ?? from;
      const dates: string[] = [];
      for (let d = from < today ? today : from; d <= last; d = addDays(d, 1)) dates.push(d);
      if (from < today) pastHoliday++;
      if (dates.length) {
        const entry = leave.get(e.id) ?? { employeeId: e.id, name: e.name, dates: new Set<string>() };
        for (const d of dates) if (!e.leave.includes(d)) entry.dates.add(d);
        if (entry.dates.size) leave.set(e.id, entry);
      }
      return;
    }
    if ((e.absences ?? []).some((a) => a.from === from && (a.type ?? 'sickness') === kind)) return void duplicates++;
    const returnToWorkOn = cell('returnToWork') && !yes(cell('returnToWork')) ? dateOf(cell('returnToWork'), us) ?? undefined : undefined;
    if (returnToWorkOn && returnToWorkOn < from) return void base.errors.push(`${where}: the return to work conversation is dated before the absence began.`);
    const fitNote = cell('fitNote') ? yes(cell('fitNote')) : undefined;
    const end = to ?? today;
    if (kind === 'sickness' && !fitNote && end >= addDays(from, 7)) fitNotesMissing++;
    // An unrecognised type keeps the old system's word, so nothing it said is lost.
    const reason = cell('reason') || (kind === 'other' && cell('type') ? cell('type') : '');
    absences.push({
      line,
      employeeId: e.id,
      name: e.name,
      absence: {
        type: kind,
        from,
        ...(to ? { to } : {}),
        ...(reason ? { reason } : {}),
        ...(fitNote !== undefined ? { fitNote } : {}),
        ...(returnToWorkOn ? { returnToWorkOn } : {}),
        ...(cell('notes') ? { notes: cell('notes') } : {}),
      },
    });
  });
  return {
    ...base,
    absences,
    leave: [...leave.values()].map((l) => ({ employeeId: l.employeeId, name: l.name, dates: [...l.dates].sort() })),
    pastHoliday,
    toilRows,
    duplicates,
    assumedSickness: !base.errors.length && base.columns.type === undefined,
    fitNotesMissing,
  };
}

// ---- TOIL ----

export type ToilField = keyof typeof TOIL_COLUMNS;

export interface ToilImport extends Base<ToilField> {
  rows: { line: number; employeeId: string; name: string; date: string; hours: number }[];
  /** Already has an opening balance on Preshift: left alone, so the old system's hours are not counted twice. */
  existing: string[];
  inDays: boolean;
}

/**
 * Each person's TOIL owed at go-live, as one opening balance: the balance given, or earned less taken.
 * Read as days, turned into hours on the contracted day, when every figure column's header says days.
 */
export function importToil(input: string | string[][], state: Pick<RotaState, 'employees'>, today: string, options: { usDates?: boolean; columns?: Partial<Record<ToilField, string>> } = {}): ToilImport {
  const rows: ToilImport['rows'] = [];
  const existing: string[] = [];
  const seen = new Set<string>();
  const head = table(input, TOIL_COLUMNS).rows[0] ?? [];
  const m = matchColumns(head, TOIL_COLUMNS as Record<ToilField, string[]>, options.columns);
  const figures = (['balance', 'earned', 'taken'] as ToilField[]).map((f) => m.columns[f]).filter((i): i is number => i !== undefined).map((i) => normal(m.headers[i]));
  const inDays = figures.length > 0 && figures.every((h) => /\bdays?\b/.test(h));
  const base = walk<ToilField>(input, TOIL_COLUMNS, state.employees, options.columns, [], (cell, e, where, line, base) => {
    if (seen.has(e.id)) return void base.errors.push(`${where}: listed twice; the first is used.`);
    if (e.toil?.some((t) => t.kind === 'opening')) return void existing.push(e.name);
    const balance = hoursOf(cell('balance'));
    const earned = hoursOf(cell('earned'));
    const taken = hoursOf(cell('taken'));
    if ([balance, earned, taken].some((n) => Number.isNaN(n))) return void base.errors.push(`${where}: a TOIL figure is not a number.`);
    let hours = balance ?? (earned !== null ? earned - (taken ?? 0) : null);
    if (hours === null || hours === 0) return;
    if (hours < 0) return void base.errors.push(`${where}: a negative TOIL balance means more was taken than earned. Agree the figure with them and enter it by hand.`);
    if (inDays) {
      const d = dayHoursOf(e);
      if (!d) return void base.errors.push(`${where}: figures are in days, but ${e.name} has no contracted hours to turn a day into hours. Give hours for them.`);
      hours *= d;
    }
    const date = cell('asOf') ? dateOf(cell('asOf'), !!options.usDates) : today;
    if (!date) return void base.errors.push(`${where}: date "${cell('asOf')}" not recognised.`);
    if (date > today) return void base.errors.push(`${where}: a balance cannot stand at a day still to come.`);
    seen.add(e.id);
    rows.push({ line, employeeId: e.id, name: e.name, date, hours: r2(hours) });
  });
  if (!base.errors.length && base.columns.balance === undefined && base.columns.earned === undefined) {
    base.errors.push('No TOIL figures found. Choose the column for the balance, or for earned and taken.');
  }
  return { ...base, rows, existing, inDays };
}

// ---- Documents and the HR file ----

export type DocumentField = keyof typeof DOCUMENT_COLUMNS;

/** A UK National Insurance number: two prefix letters (not D, F, I, Q, U or V; not O second), six digits, A to D. */
export const NI_NUMBER = /^(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/;

export function contractTypeOf(raw: string): ContractType | null {
  const v = normal(raw);
  if (!v) return null;
  if (/apprentic/.test(v)) return 'apprentice';
  if (/fixed|temporary|temp|seasonal/.test(v)) return 'fixed-term';
  if (/casual|zero|bank|flexible|as and when|ad hoc/.test(v)) return 'casual';
  if (/permanent|full time|part time|salaried|perm/.test(v)) return 'permanent';
  return null;
}

export interface DocumentImport extends Base<DocumentField> {
  /** The HR file each person will have: what is on Preshift now, with the file's values over it. */
  profiles: { line: number; employeeId: string; name: string; profile: HrProfile; fields: string[]; notes: string[] }[];
  /** Documents on file in the old system, recorded with their date. Their copies are uploaded on the person's file. */
  documents: { line: number; employeeId: string; name: string; record: Pick<HrRecord, 'employeeId' | 'kind' | 'date' | 'title'> }[];
  /** Statements recorded as issued or signed with no copy on Preshift yet. */
  copiesNeeded: number;
}

export function importDocuments(input: string | string[][], state: Pick<RotaState, 'employees'>, hrRecords: Pick<HrRecord, 'employeeId' | 'kind' | 'title' | 'date'>[], options: { usDates?: boolean; columns?: Partial<Record<DocumentField, string>> } = {}): DocumentImport {
  const profiles: DocumentImport['profiles'] = [];
  const documents: DocumentImport['documents'] = [];
  let copiesNeeded = 0;
  const us = !!options.usDates;
  const seen = new Set<string>();
  const managers = finder(state.employees.filter((e) => !e.anonymisedOn));
  const base = walk<DocumentField>(input, DOCUMENT_COLUMNS, state.employees, options.columns, [], (cell, e, where, line, base) => {
    const notes: string[] = [];
    const before: HrProfile = e.hr ?? {};
    const p: HrProfile = { ...before };
    const fields: string[] = [];
    const date = (f: DocumentField, key: keyof HrProfile) => {
      if (!cell(f)) return true;
      const d = yes(cell(f)) ? null : dateOf(cell(f), us);
      if (!d) {
        base.errors.push(`${where}: ${f.replace(/[A-Z]/g, (x) => ` ${x.toLowerCase()}`)} "${cell(f)}" is not a date.`);
        return false;
      }
      (p as Record<string, unknown>)[key] = d;
      fields.push(key);
      return true;
    };
    const ok = [
      date('contractIssuedOn', 'contractIssuedOn'),
      date('contractSignedOn', 'contractSignedOn'),
      date('handbookAcknowledgedOn', 'handbookAcknowledgedOn'),
      date('probationEnd', 'probationEnd'),
      date('probationPassedOn', 'probationPassedOn'),
      date('fixedTermEnd', 'fixedTermEnd'),
    ].every(Boolean);
    if (!ok) return;
    if (cell('jobTitle')) (p.jobTitle = cell('jobTitle')), fields.push('jobTitle');
    if (cell('contractType')) {
      const t = contractTypeOf(cell('contractType'));
      if (t) (p.contractType = t), fields.push('contractType');
      else notes.push(`Contract type "${cell('contractType')}" not recognised; set it on the file.`);
    }
    if (cell('noticeWeeks')) {
      const n = Number(cell('noticeWeeks').replace(/\s*weeks?$/i, ''));
      if (Number.isFinite(n) && n >= 0 && n <= 52) (p.noticeWeeks = n), fields.push('noticeWeeks');
      else notes.push(`Notice "${cell('noticeWeeks')}" is not a number of weeks; left off.`);
    }
    if (cell('niNumber')) {
      const ni = cell('niNumber').replace(/\s/g, '').toUpperCase();
      if (NI_NUMBER.test(ni)) (p.niNumber = ni), fields.push('niNumber');
      else notes.push('The NI number is not in a valid format; left off, so payroll will ask for it.');
    }
    if (cell('address')) (p.address = cell('address')), fields.push('address');
    if (cell('postcode')) (p.postcode = cell('postcode').toUpperCase()), fields.push('postcode');
    if (cell('emergencyName') || cell('emergencyPhone')) {
      if (cell('emergencyName') && cell('emergencyPhone')) {
        p.emergencyContact = { name: cell('emergencyName'), phone: cell('emergencyPhone'), ...(cell('emergencyRelationship') ? { relationship: cell('emergencyRelationship') } : {}) };
        fields.push('emergencyContact');
      } else notes.push('An emergency contact needs both a name and a phone number; left off.');
    }
    if (cell('manager')) {
      const id = managers(cell('manager'));
      if (id && id !== e.id) (p.managerId = id), fields.push('managerId');
      else notes.push(`Line manager "${cell('manager')}" is not on Preshift; set them on the file once they are.`);
    }
    if (p.contractSignedOn && p.contractIssuedOn && p.contractSignedOn < p.contractIssuedOn) notes.push('The statement is signed before it was issued: check the dates.');
    if (p.probationPassedOn && p.probationEnd && p.probationPassedOn > addDays(p.probationEnd, 60)) notes.push('Probation was passed long after it ended: check the dates.');
    if (fields.length && !seen.has(e.id)) {
      seen.add(e.id);
      profiles.push({ line, employeeId: e.id, name: e.name, profile: p, fields, notes });
      if (fields.includes('contractIssuedOn') || fields.includes('contractSignedOn')) copiesNeeded++;
    } else if (seen.has(e.id) && fields.length) base.errors.push(`${where}: listed twice for the HR file; the first is used.`);
    if (cell('document')) {
      const d = cell('documentDate') ? dateOf(cell('documentDate'), us) : null;
      if (!d) return void base.errors.push(`${where}: document "${cell('document')}" needs the date it was signed or given.`);
      const title = cell('document');
      if (!hrRecords.some((r) => r.employeeId === e.id && r.kind === 'document' && nameKey(r.title) === nameKey(title) && r.date === d)) {
        documents.push({ line, employeeId: e.id, name: e.name, record: { employeeId: e.id, kind: 'document', date: d, title } });
      }
    }
  });
  return { ...base, profiles, documents, copiesNeeded };
}

// ---- Training ----

export type TrainingField = keyof typeof TRAINING_COLUMNS;

const COURSE_WORDS: [RegExp, string][] = [
  [/(food (hygiene|safety)).*(3|three|iii)|level 3.*(food|hygiene)/, 'Food hygiene level 3'],
  [/(food (hygiene|safety))|level 2.*(food|hygiene)|basic food/, 'Food hygiene level 2'],
  [/allerg/, 'Allergen awareness'],
  [/personal licen[cs]e|aplh/, 'Personal licence'],
  [/challenge 2[15]|licensing|age verification|responsible (alcohol|retail)/, 'Licensing and Challenge 25'],
  [/first aid/, 'First aid at work'],
  [/fire/, 'Fire marshal'],
  [/manual handling/, 'Manual handling'],
  [/coshh|hazardous substances/, 'COSHH'],
];

/** The course on Preshift's list that a certificate's name means, or the name as given. */
export function courseOf(raw: string): { title: string; known: boolean } {
  const v = normal(raw);
  const exact = COURSES.find((c) => normal(c.name) === v);
  if (exact) return { title: exact.name, known: true };
  const hit = COURSE_WORDS.find(([re]) => re.test(v));
  return hit ? { title: hit[1], known: true } : { title: raw.trim(), known: false };
}

export interface TrainingImport extends Base<TrainingField> {
  records: { line: number; employeeId: string; name: string; record: Pick<HrRecord, 'employeeId' | 'kind' | 'date' | 'title' | 'expiresOn' | 'notes'>; from: string; suggestedExpiry: boolean }[];
  /** Courses not on Preshift's list, kept under their own name. */
  otherCourses: { name: string; rows: number }[];
  duplicates: number;
  /** Certificates already expired: recorded, and shown as due on Training. */
  expired: number;
}

export function importTraining(input: string | string[][], state: Pick<RotaState, 'employees'>, hrRecords: Pick<HrRecord, 'employeeId' | 'kind' | 'title' | 'date'>[], today: string, options: { usDates?: boolean; columns?: Partial<Record<TrainingField, string>> } = {}): TrainingImport {
  const records: TrainingImport['records'] = [];
  const other = new Map<string, number>();
  let duplicates = 0;
  let expired = 0;
  const us = !!options.usDates;
  const inFile = new Set<string>();
  const base = walk<TrainingField>(input, TRAINING_COLUMNS, state.employees, options.columns, [
    { field: 'course', message: 'No course column found. Choose which column holds the course or certificate.' },
    { field: 'date', message: 'No completion date column found. Choose which column holds the date passed.' },
  ], (cell, e, where, line, base) => {
    if (!cell('course')) return;
    const date = dateOf(cell('date'), us);
    if (!date) return void base.errors.push(`${where}: date passed "${cell('date')}" not recognised.`);
    if (date > today) return void base.errors.push(`${where}: a course cannot be passed on a day still to come.`);
    const { title, known } = courseOf(cell('course'));
    if (!known) tally(other, title);
    let expiresOn = cell('expiry') && !/^(none|n\/?a|never|-)$/i.test(cell('expiry')) ? dateOf(cell('expiry'), us) : undefined;
    if (expiresOn === null) return void base.errors.push(`${where}: expiry "${cell('expiry')}" not recognised.`);
    if (expiresOn && expiresOn < date) return void base.errors.push(`${where}: the certificate expires before the course date.`);
    // As when a course is recorded by hand: its usual renewal period suggests the expiry.
    const renew = COURSES.find((c) => c.name === title)?.renewYears;
    const suggested = !expiresOn && !cell('expiry') && !!renew;
    if (suggested) expiresOn = `${Number(date.slice(0, 4)) + renew!}${date.slice(4)}`;
    const key = `${e.id}|${nameKey(title)}|${date}`;
    if (inFile.has(key) || hrRecords.some((r) => r.employeeId === e.id && r.kind === 'training' && nameKey(r.title) === nameKey(title) && r.date === date)) return void duplicates++;
    inFile.add(key);
    if (expiresOn && expiresOn < today) expired++;
    records.push({
      line,
      employeeId: e.id,
      name: e.name,
      from: cell('course'),
      suggestedExpiry: suggested,
      record: { employeeId: e.id, kind: 'training', date, title, ...(expiresOn ? { expiresOn } : {}), ...(cell('notes') ? { notes: cell('notes') } : {}) },
    });
  });
  return { ...base, records, otherCourses: sorted(other), duplicates, expired };
}

// ---- Right to work ----

export type RtwField = keyof typeof RTW_COLUMNS;

export interface RtwImport extends Base<RtwField> {
  checks: { line: number; employeeId: string; name: string; rightToWork: RightToWork; notes: string[] }[];
  /** A later check is already on Preshift: left as it is. */
  newerOnFile: string[];
  /** Checks recorded with no copy held: there is no statutory excuse until the copy is uploaded. */
  copiesNeeded: number;
  /** Time-limited permission already past its expiry: they cannot be rostered until a follow-up check. */
  expired: number;
}

export function importRightToWork(input: string | string[][], state: Pick<RotaState, 'employees'>, today: string, options: { usDates?: boolean; columns?: Partial<Record<RtwField, string>> } = {}): RtwImport {
  const checks: RtwImport['checks'] = [];
  const newerOnFile: string[] = [];
  let copiesNeeded = 0;
  let expired = 0;
  const us = !!options.usDates;
  const seen = new Set<string>();
  const base = walk<RtwField>(input, RTW_COLUMNS, state.employees, options.columns, [{ field: 'checkedOn', message: 'No column for the date the check was done. Choose which column holds it.' }], (cell, e, where, line, base) => {
    if (!cell('checkedOn')) return void base.errors.push(`${where}: no date for the check. A check without its date is not a statutory excuse, so it is left off.`);
    const checkedOn = dateOf(cell('checkedOn'), us);
    if (!checkedOn) return void base.errors.push(`${where}: check date "${cell('checkedOn')}" not recognised.`);
    if (checkedOn > today) return void base.errors.push(`${where}: a check cannot be dated in the future.`);
    const expiry = cell('expiry') && !/^(none|n\/?a|indefinite|ilr|settled|british|irish|-)$/i.test(cell('expiry')) ? dateOf(cell('expiry'), us) : undefined;
    if (expiry === null) return void base.errors.push(`${where}: expiry "${cell('expiry')}" not recognised.`);
    if (expiry && expiry < checkedOn) return void base.errors.push(`${where}: the permission expires before the check was done.`);
    if (seen.has(e.id)) return void base.errors.push(`${where}: listed twice; the first is used.`);
    const current = e.rightToWork;
    if (current?.checked && current.checkedOn && current.checkedOn > checkedOn) return void newerOnFile.push(e.name);
    const notes: string[] = [];
    const hours = cell('studentHours') ? Number(cell('studentHours').replace(/\s*(h|hours?)$/i, '')) : undefined;
    if (hours !== undefined && !(hours > 0 && hours <= 48)) notes.push(`Term time limit "${cell('studentHours')}" is not a number of hours; left off.`);
    if (expiry && expiry < today) {
      expired++;
      notes.push(`Permission expired on ${expiry}: they cannot be rostered until a follow-up check is recorded.`);
    } else if (expiry && expiry <= addDays(today, 60)) notes.push(`Permission expires on ${expiry}: book the follow-up check now.`);
    if (!(current?.documents?.length)) copiesNeeded++;
    seen.add(e.id);
    checks.push({
      line,
      employeeId: e.id,
      name: e.name,
      notes,
      rightToWork: {
        ...(current?.studentWeeklyHourLimit !== undefined ? { studentWeeklyHourLimit: current.studentWeeklyHourLimit } : {}),
        ...(current?.termVacations ? { termVacations: current.termVacations } : {}),
        checked: true,
        checkedOn,
        ...(cell('evidence') ? { evidence: cell('evidence') } : current?.evidence ? { evidence: current.evidence } : {}),
        ...(expiry ? { expiry } : {}),
        ...(hours !== undefined && hours > 0 && hours <= 48 ? { studentWeeklyHourLimit: hours } : {}),
      },
    });
  });
  return { ...base, checks, newerOnFile, copiesNeeded, expired };
}
