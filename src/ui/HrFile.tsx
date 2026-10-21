import { useMemo, useState } from 'react';
import { employeeStatus } from '../engine/employees';
import {
  ABSENCE_LABEL, absenceDays, bradfordFactor, CASE_LABEL, CASE_OUTCOMES, COURSES, hrChecks, lengthOfService,
  REVIEW_LABEL, requiredCourses, statutoryNoticeWeeks, trainingStatus,
} from '../engine/hr';
import { addDays } from '../engine/time';
import type { Absence, AbsenceType, CaseType, ContractType, Employee, HrProfile, HrRecord, HrRecordKind, ReviewType, RotaState } from '../engine/types';
import type { HrRecords } from './store';

export type HrSection = 'summary' | 'profile' | 'absence' | 'training' | 'reviews' | 'cases' | 'documents';

interface Props {
  state: RotaState;
  employee: Employee;
  hr: HrRecords;
  today: string;
  isAdmin: boolean;
  initialSection?: HrSection;
  onSaveProfile: (employeeId: string, profile: HrProfile) => Promise<unknown>;
  onSaveAbsence: (employeeId: string, absence: Absence, isNew: boolean) => Promise<{ clashes: string[] } | undefined>;
  onDeleteAbsence: (employeeId: string, absenceId: string) => Promise<unknown>;
  onClose: () => void;
}

const CONTRACT_LABEL: Record<ContractType, string> = {
  permanent: 'Permanent',
  'fixed-term': 'Fixed term',
  casual: 'Casual or zero hours',
  apprentice: 'Apprentice',
};

const orUndefined = (v: string) => (v === '' ? undefined : v);
const plusYears = (iso: string, years: number) => `${Number(iso.slice(0, 4)) + years}${iso.slice(4)}`;

export function HrFile({ state, employee, hr, today, isAdmin, initialSection = 'summary', onSaveProfile, onSaveAbsence, onDeleteAbsence, onClose }: Props) {
  const [section, setSection] = useState<HrSection>(initialSection);
  const records = useMemo(() => (hr.records ?? []).filter((r) => r.employeeId === employee.id), [hr.records, employee.id]);
  const checks = useMemo(() => hrChecks(employee, hr.records ?? [], state.roles, today), [employee, hr.records, state.roles, today]);
  const status = employeeStatus(employee, today);
  const manager = state.employees.find((e) => e.id === employee.hr?.managerId);

  const SECTIONS: { id: HrSection; label: string; hidden?: boolean }[] = [
    { id: 'summary', label: 'Summary' },
    { id: 'profile', label: 'Contract and details' },
    { id: 'absence', label: `Absence (${employee.absences?.length ?? 0})` },
    { id: 'training', label: 'Training' },
    { id: 'reviews', label: 'Reviews' },
    { id: 'cases', label: 'Cases', hidden: !isAdmin },
    { id: 'documents', label: 'Documents and notes' },
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide hr-file" role="dialog" aria-modal="true" aria-label={`HR file for ${employee.name}`} onClick={(e) => e.stopPropagation()}>
        <h2>{employee.name}</h2>
        <p className="muted">
          {employee.hr?.jobTitle ?? state.roles.find((r) => r.id === employee.roleIds[0])?.name}
          {' at '}{state.sites.find((s) => s.id === employee.siteId)?.name}
          {', '}{lengthOfService(employee, today)} service
          {manager ? `, reports to ${manager.name}` : ''}
          {status !== 'active' && ` (${status})`}
        </p>
        <div className="day-pills hr-sections">
          {SECTIONS.filter((s) => !s.hidden).map((s) => (
            <button key={s.id} className={section === s.id ? 'active' : ''} onClick={() => setSection(s.id)}>{s.label}</button>
          ))}
        </div>

        {section === 'summary' && <Summary employee={employee} records={records} checks={checks} today={today} state={state} />}
        {section === 'profile' && <ProfileForm state={state} employee={employee} today={today} onSave={(p) => onSaveProfile(employee.id, p)} />}
        {section === 'absence' && <AbsenceSection employee={employee} today={today} onSave={(a, isNew) => onSaveAbsence(employee.id, a, isNew)} onDelete={(id) => onDeleteAbsence(employee.id, id)} />}
        {section === 'training' && <TrainingSection state={state} employee={employee} records={records} hr={hr} today={today} />}
        {section === 'reviews' && <RecordSection kind="review" employee={employee} records={records} hr={hr} today={today} />}
        {section === 'cases' && isAdmin && <RecordSection kind="case" employee={employee} records={records} hr={hr} today={today} />}
        {section === 'documents' && (
          <>
            <RecordSection kind="document" employee={employee} records={records} hr={hr} today={today} />
            <RecordSection kind="note" employee={employee} records={records} hr={hr} today={today} />
          </>
        )}

        <div className="modal-actions">
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function Summary({ employee, records, checks, today, state }: { employee: Employee; records: HrRecord[]; checks: ReturnType<typeof hrChecks>; today: string; state: RotaState }) {
  const hr = employee.hr ?? {};
  const bradford = bradfordFactor(employee, today);
  const statutory = statutoryNoticeWeeks(employee, today);
  const required = requiredCourses(employee, state.roles);
  const valid = required.filter((c) => !['missing', 'expired'].includes(trainingStatus(records, employee.id, c.name, today).status)).length;
  return (
    <>
      <div className="kpis people-kpis">
        <div className="kpi">
          <div className="kpi-label">Contract</div>
          <div className="kpi-value small-value">{hr.contractType ? CONTRACT_LABEL[hr.contractType] : 'Not set'}</div>
          <div className="kpi-hint">{employee.contractedHours ? `${employee.contractedHours}h a week` : 'No guaranteed hours'}{hr.fixedTermEnd ? `, ends ${hr.fixedTermEnd}` : ''}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Notice owed by employer</div>
          <div className="kpi-value small-value">{Math.max(statutory, hr.noticeWeeks ?? 0)} weeks</div>
          <div className="kpi-hint">Statutory {statutory}{hr.noticeWeeks ? `, contract ${hr.noticeWeeks}` : ''}</div>
        </div>
        <div className={`kpi ${bradford.score >= 51 ? 'warn' : 'good'}`}>
          <div className="kpi-label">Bradford factor</div>
          <div className="kpi-value small-value">{bradford.score}</div>
          <div className="kpi-hint">{bradford.spells} spells, {bradford.days} days in 52 weeks</div>
        </div>
        <div className={`kpi ${valid < required.length ? 'warn' : 'good'}`}>
          <div className="kpi-label">Required training</div>
          <div className="kpi-value small-value">{valid} of {required.length}</div>
          <div className="kpi-hint">In date for their roles</div>
        </div>
      </div>
      <h3 className="section">To act on</h3>
      {checks.length === 0 ? <p className="muted">Nothing outstanding. The file is in order.</p> : (
        <ul className="issues">{checks.map((c) => <li key={c.code} className={c.severity}>{c.message}</li>)}</ul>
      )}
    </>
  );
}

function ProfileForm({ state, employee, today, onSave }: { state: RotaState; employee: Employee; today: string; onSave: (p: HrProfile) => Promise<unknown> }) {
  const [draft, setDraft] = useState<HrProfile>(employee.hr ?? {});
  const [saved, setSaved] = useState(false);
  const set = <K extends keyof HrProfile>(key: K, value: HrProfile[K]) => { setSaved(false); setDraft((d) => ({ ...d, [key]: value })); };
  const contact = draft.emergencyContact ?? { name: '', phone: '' };
  const setContact = (patch: Partial<typeof contact>) => {
    const next = { ...contact, ...patch };
    set('emergencyContact', next.name || next.phone || next.relationship ? next : undefined);
  };
  const contactIncomplete = !!draft.emergencyContact && (!contact.name || !contact.phone);
  const fixedTermMissing = draft.contractType === 'fixed-term' && !draft.fixedTermEnd;

  async function save() {
    // Blank strings are cleared rather than stored.
    const clean = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== '' && v !== undefined)) as HrProfile;
    if ((await onSave(clean)) !== undefined) setSaved(true);
  }

  return (
    <>
      <h3 className="section">Contract</h3>
      <div className="form">
        <label>
          Job title
          <input value={draft.jobTitle ?? ''} onChange={(e) => set('jobTitle', orUndefined(e.target.value))} placeholder={state.roles.find((r) => r.id === employee.roleIds[0])?.name} />
        </label>
        <label>
          Contract type
          <select value={draft.contractType ?? ''} onChange={(e) => set('contractType', (orUndefined(e.target.value) as ContractType | undefined))}>
            <option value="">Not set</option>
            {Object.entries(CONTRACT_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        {draft.contractType === 'fixed-term' && (
          <label>
            Fixed term ends
            <input type="date" value={draft.fixedTermEnd ?? ''} onChange={(e) => set('fixedTermEnd', orUndefined(e.target.value))} />
          </label>
        )}
        <label>
          Line manager
          <select value={draft.managerId ?? ''} onChange={(e) => set('managerId', orUndefined(e.target.value))}>
            <option value="">None</option>
            {state.employees
              .filter((e) => e.id !== employee.id && employeeStatus(e, today) !== 'left')
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <label>
          Written statement issued
          <input type="date" value={draft.contractIssuedOn ?? ''} onChange={(e) => set('contractIssuedOn', orUndefined(e.target.value))} />
        </label>
        <label>
          Signed copy received
          <input type="date" value={draft.contractSignedOn ?? ''} onChange={(e) => set('contractSignedOn', orUndefined(e.target.value))} />
        </label>
        <label>
          Handbook acknowledged
          <input type="date" value={draft.handbookAcknowledgedOn ?? ''} onChange={(e) => set('handbookAcknowledgedOn', orUndefined(e.target.value))} />
        </label>
        <label>
          Contractual notice (weeks)
          <input type="number" min={0} max={52} value={draft.noticeWeeks ?? ''} onChange={(e) => set('noticeWeeks', e.target.value === '' ? undefined : Number(e.target.value))} />
        </label>
        <label>
          Probation ends
          <input type="date" value={draft.probationEnd ?? ''} onChange={(e) => set('probationEnd', orUndefined(e.target.value))} />
        </label>
        <label>
          Probation passed on
          <input type="date" value={draft.probationPassedOn ?? ''} onChange={(e) => set('probationPassedOn', orUndefined(e.target.value))} disabled={!draft.probationEnd} />
        </label>
      </div>

      <h3 className="section">Personal details</h3>
      <div className="form">
        <label>
          National Insurance number
          <input value={draft.niNumber ?? ''} onChange={(e) => set('niNumber', orUndefined(e.target.value.toUpperCase()))} placeholder="QQ 12 34 56 C" />
        </label>
        <label>
          Postcode
          <input value={draft.postcode ?? ''} onChange={(e) => set('postcode', orUndefined(e.target.value.toUpperCase()))} />
        </label>
        <label className="wide-field">
          Address
          <textarea rows={2} value={draft.address ?? ''} onChange={(e) => set('address', orUndefined(e.target.value))} />
        </label>
        <label>
          Emergency contact
          <input value={contact.name} onChange={(e) => setContact({ name: e.target.value })} />
        </label>
        <label>
          Relationship
          <input value={contact.relationship ?? ''} onChange={(e) => setContact({ relationship: e.target.value || undefined })} />
        </label>
        <label>
          Their phone
          <input type="tel" value={contact.phone} onChange={(e) => setContact({ phone: e.target.value })} />
        </label>
      </div>
      {contactIncomplete && <p className="hint warn-text">An emergency contact needs a name and a phone number.</p>}
      {fixedTermMissing && <p className="hint warn-text">A fixed-term contract needs its end date.</p>}
      <div className="modal-actions">
        {saved && <span className="good-text small">Saved</span>}
        <span className="spacer" />
        <button className="primary" disabled={contactIncomplete || fixedTermMissing} onClick={() => void save()}>Save details</button>
      </div>
    </>
  );
}

const blankAbsence = (today: string): Absence => ({ id: '', type: 'sickness', from: today, to: today });

function AbsenceSection({ employee, today, onSave, onDelete }: {
  employee: Employee;
  today: string;
  onSave: (a: Absence, isNew: boolean) => Promise<{ clashes: string[] } | undefined>;
  onDelete: (id: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState<Absence | null>(null);
  const [clashNote, setClashNote] = useState<string | null>(null);
  const list = [...(employee.absences ?? [])].sort((a, b) => b.from.localeCompare(a.from));

  async function save(a: Absence) {
    const res = await onSave(a, !a.id);
    if (!res) return;
    setEditing(null);
    setClashNote(res.clashes.length ? `${res.clashes.length} rostered shift${res.clashes.length === 1 ? '' : 's'} fall in this absence. They are blocked on the rota until re-covered.` : null);
  }

  return (
    <>
      <div className="modal-actions">
        <span className="muted small">Holiday is booked on the Holiday tab. Record everything else here.</span>
        <span className="spacer" />
        {!editing && <button className="primary" onClick={() => setEditing(blankAbsence(today))}>Record absence</button>}
      </div>
      {clashNote && <p className="notice">{clashNote}</p>}
      {editing && <AbsenceForm absence={editing} onSave={save} onCancel={() => setEditing(null)} />}
      <table className="table">
        <thead>
          <tr><th>Type</th><th>From</th><th>To</th><th className="num">Days</th><th>Fit note</th><th>Return to work</th><th /></tr>
        </thead>
        <tbody>
          {list.length === 0 && <tr><td colSpan={7} className="muted">No absence recorded.</td></tr>}
          {list.map((a) => (
            <tr key={a.id}>
              <td>{ABSENCE_LABEL[a.type]}{a.excludeFromTriggers && <span className="tag">Excluded</span>}{a.reason && <div className="muted small">{a.reason}</div>}</td>
              <td>{a.from}</td>
              <td>{a.to ?? <span className="warn-text">Still off</span>}</td>
              <td className="num">{absenceDays(a, today)}</td>
              <td>{a.type === 'sickness' ? (a.fitNote ? 'Yes' : 'No') : '-'}</td>
              <td>{a.returnToWorkOn ?? <span className="muted">Not held</span>}</td>
              <td className="nowrap">
                <button className="link" onClick={() => setEditing(a)}>Edit</button>{' '}
                <button className="link" onClick={() => { if (confirm('Delete this absence?')) void onDelete(a.id); }}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function AbsenceForm({ absence, onSave, onCancel }: { absence: Absence; onSave: (a: Absence) => void; onCancel: () => void }) {
  const [d, setD] = useState<Absence>(absence);
  const [stillOff, setStillOff] = useState(!absence.to && !!absence.id);
  const set = <K extends keyof Absence>(key: K, value: Absence[K]) => setD((x) => ({ ...x, [key]: value }));
  const result: Absence = { ...d, to: stillOff ? undefined : d.to };
  const invalid = !d.from || (!stillOff && !d.to) || (!!result.to && result.to < d.from);
  return (
    <div className="hr-form">
      <div className="form">
        <label>
          Type
          <select value={d.type} onChange={(e) => set('type', e.target.value as AbsenceType)}>
            {Object.entries(ABSENCE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label>
          First day off
          <input type="date" value={d.from} onChange={(e) => set('from', e.target.value)} />
        </label>
        <label>
          Last day off
          <input type="date" value={d.to ?? ''} disabled={stillOff} onChange={(e) => set('to', orUndefined(e.target.value))} />
        </label>
        <label className="check">
          <input type="checkbox" checked={stillOff} onChange={(e) => setStillOff(e.target.checked)} /> Still off, return date unknown
        </label>
        <label>
          Reason
          <input value={d.reason ?? ''} onChange={(e) => set('reason', orUndefined(e.target.value))} />
        </label>
        <label>
          Return to work conversation
          <input type="date" value={d.returnToWorkOn ?? ''} onChange={(e) => set('returnToWorkOn', orUndefined(e.target.value))} />
        </label>
        {d.type === 'sickness' && (
          <label className="check">
            <input type="checkbox" checked={!!d.fitNote} onChange={(e) => set('fitNote', e.target.checked || undefined)} /> Fit note seen
          </label>
        )}
        {(d.type === 'sickness' || d.type === 'unauthorised') && (
          <label className="check">
            <input type="checkbox" checked={!!d.excludeFromTriggers} onChange={(e) => set('excludeFromTriggers', e.target.checked || undefined)} />
            Disability or pregnancy related (kept out of triggers)
          </label>
        )}
        <label className="wide-field">
          Notes
          <textarea rows={2} value={d.notes ?? ''} onChange={(e) => set('notes', orUndefined(e.target.value))} />
        </label>
      </div>
      <div className="modal-actions">
        <span className="spacer" />
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={invalid} onClick={() => onSave(result)}>Save absence</button>
      </div>
    </div>
  );
}

function TrainingSection({ state, employee, records, hr, today }: { state: RotaState; employee: Employee; records: HrRecord[]; hr: HrRecords; today: string }) {
  const required = new Set(requiredCourses(employee, state.roles).map((c) => c.name));
  const extra = [...new Set(records.filter((r) => r.kind === 'training').map((r) => r.title))].filter((t) => !COURSES.some((c) => c.name === t));
  const [adding, setAdding] = useState<HrRecord | null>(null);
  const start = (title: string) => {
    const years = COURSES.find((c) => c.name === title)?.renewYears;
    setAdding(newRecord('training', employee.id, today, { title, expiresOn: years ? plusYears(today, years) : undefined }));
  };
  return (
    <>
      {adding && <RecordForm record={adding} hr={hr} onDone={() => setAdding(null)} />}
      <table className="table">
        <thead><tr><th>Course</th><th>Status</th><th>Passed</th><th>Expires</th><th /></tr></thead>
        <tbody>
          {[...COURSES.map((c) => c.name), ...extra].map((name) => {
            const { status, latest } = trainingStatus(records, employee.id, name, today);
            if (status === 'missing' && !required.has(name)) return null;
            return (
              <tr key={name}>
                <td>{name}{required.has(name) && <span className="tag">Required</span>}</td>
                <td><TrainingBadge status={status} /></td>
                <td>{latest?.date ?? '-'}</td>
                <td>{latest?.expiresOn ?? (latest ? 'No expiry' : '-')}</td>
                <td><button className="link" onClick={() => start(name)}>{latest ? 'Record refresher' : 'Record'}</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!adding && (
        <div className="modal-actions">
          <span className="spacer" />
          <select aria-label="Add a course" value="" onChange={(e) => e.target.value && start(e.target.value)}>
            <option value="">Add another course</option>
            {COURSES.map((c) => <option key={c.name}>{c.name}</option>)}
          </select>
          <button onClick={() => start('')}>Other course</button>
        </div>
      )}
      <RecordList records={records.filter((r) => r.kind === 'training')} hr={hr} />
    </>
  );
}

export function TrainingBadge({ status }: { status: ReturnType<typeof trainingStatus>['status'] }) {
  const label = { valid: 'In date', expiring: 'Expiring', expired: 'Expired', missing: 'Missing' }[status];
  const cls = { valid: 'status-active', expiring: 'status-starter', expired: 'status-bad', missing: 'status-bad' }[status];
  return <span className={`status ${cls}`}>{label}</span>;
}

const KIND_HEADING: Record<HrRecordKind, string> = {
  training: 'Training history',
  review: 'Reviews',
  case: 'Disciplinary, grievance and capability',
  document: 'Documents on file',
  note: 'Notes',
};

const KIND_ADD: Record<HrRecordKind, string> = {
  training: 'Record course',
  review: 'Record review',
  case: 'Open a case',
  document: 'Add document',
  note: 'Add note',
};

export function newRecord(kind: HrRecordKind, employeeId: string, today: string, extra: Partial<HrRecord> = {}): HrRecord {
  const base: HrRecord = { id: '', employeeId, kind, date: today, title: '', createdBy: '', createdAt: '' };
  if (kind === 'review') return { ...base, reviewType: 'one-to-one', title: 'One to one', nextDue: addDays(today, 90), ...extra };
  if (kind === 'case') return { ...base, caseType: 'investigation', caseStatus: 'open', ...extra };
  return { ...base, ...extra };
}

function RecordSection({ kind, employee, records, hr, today }: { kind: HrRecordKind; employee: Employee; records: HrRecord[]; hr: HrRecords; today: string }) {
  const [adding, setAdding] = useState<HrRecord | null>(null);
  return (
    <>
      <div className="modal-actions">
        <h3 className="section-inline">{KIND_HEADING[kind]}</h3>
        <span className="spacer" />
        {!adding && <button className="primary" onClick={() => setAdding(newRecord(kind, employee.id, today))}>{KIND_ADD[kind]}</button>}
      </div>
      {kind === 'case' && (
        <p className="muted small">
          Follow the ACAS code: investigate first, give the allegations in writing, allow a companion at any hearing,
          and offer an appeal. Only admins can see cases.
        </p>
      )}
      {adding && <RecordForm record={adding} hr={hr} onDone={() => setAdding(null)} />}
      <RecordList records={records.filter((r) => r.kind === kind)} hr={hr} />
    </>
  );
}

function RecordList({ records, hr }: { records: HrRecord[]; hr: HrRecords }) {
  const [editing, setEditing] = useState<string | null>(null);
  const sorted = [...records].sort((a, b) => b.date.localeCompare(a.date));
  if (sorted.length === 0) return <p className="muted small">Nothing recorded yet.</p>;
  return (
    <ul className="hr-records">
      {sorted.map((r) =>
        editing === r.id ? (
          <li key={r.id}><RecordForm record={r} hr={hr} onDone={() => setEditing(null)} /></li>
        ) : (
          <li key={r.id}>
            <div className="hr-record-head">
              <span className="strong">{r.title}</span>
              {r.reviewType && <span className="tag">{REVIEW_LABEL[r.reviewType]}</span>}
              {r.caseType && <span className={`tag${r.caseStatus === 'open' ? ' bad' : ''}`}>{CASE_LABEL[r.caseType]}, {r.caseStatus}</span>}
              <span className="spacer" />
              <span className="muted small">{r.date}</span>
              <button className="link" onClick={() => setEditing(r.id)}>Edit</button>
              <button className="link" onClick={() => { if (confirm(`Delete "${r.title}"?`)) void hr.remove(r.id); }}>Delete</button>
            </div>
            <div className="muted small">
              {[
                r.outcome && `Outcome: ${r.outcome}`,
                r.expiresOn && `Expires ${r.expiresOn}`,
                r.nextDue && `Next due ${r.nextDue}`,
                r.warningExpires && `Warning live until ${r.warningExpires}`,
                `Recorded by ${r.createdBy}`,
              ].filter(Boolean).join('. ')}
            </div>
            {r.notes && <p className="hr-notes">{r.notes}</p>}
          </li>
        ),
      )}
    </ul>
  );
}

export function RecordForm({ record, hr, onDone }: { record: HrRecord; hr: HrRecords; onDone: () => void }) {
  const [d, setD] = useState<HrRecord>(record);
  const set = <K extends keyof HrRecord>(key: K, value: HrRecord[K]) => setD((x) => ({ ...x, [key]: value }));
  const isNew = !record.id;
  const invalid = !d.title.trim() || !d.date || (d.kind === 'training' && !!d.expiresOn && d.expiresOn < d.date);

  async function save() {
    if (await hr.save({ ...d, title: d.title.trim() }, isNew)) onDone();
  }

  return (
    <div className="hr-form">
      <div className="form">
        {d.kind === 'review' && (
          <label>
            Review type
            <select
              value={d.reviewType}
              onChange={(e) => {
                const t = e.target.value as ReviewType;
                setD((x) => ({ ...x, reviewType: t, title: x.title && !Object.values(REVIEW_LABEL).includes(x.title) ? x.title : REVIEW_LABEL[t] }));
              }}
            >
              {Object.entries(REVIEW_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        )}
        {d.kind === 'case' && (
          <label>
            Case type
            <select value={d.caseType} onChange={(e) => set('caseType', e.target.value as CaseType)}>
              {Object.entries(CASE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        )}
        <label>
          {d.kind === 'training' ? 'Course' : d.kind === 'case' ? 'Summary' : 'Title'}
          <input value={d.title} onChange={(e) => set('title', e.target.value)} autoFocus={isNew && !d.title} list={d.kind === 'training' ? 'hr-courses' : undefined} />
          {d.kind === 'training' && <datalist id="hr-courses">{COURSES.map((c) => <option key={c.name} value={c.name} />)}</datalist>}
        </label>
        <label>
          {d.kind === 'training' ? 'Passed on' : d.kind === 'case' ? 'Opened on' : 'Date'}
          <input type="date" value={d.date} onChange={(e) => set('date', e.target.value)} />
        </label>
        {d.kind === 'training' && (
          <label>
            Certificate expires
            <input type="date" value={d.expiresOn ?? ''} onChange={(e) => set('expiresOn', orUndefined(e.target.value))} />
          </label>
        )}
        {d.kind === 'review' && (
          <>
            <label>
              Outcome
              <input value={d.outcome ?? ''} onChange={(e) => set('outcome', orUndefined(e.target.value))} list="hr-review-outcomes" />
              <datalist id="hr-review-outcomes">
                {['Exceeds expectations', 'Meets expectations', 'Below expectations', 'Probation passed', 'Probation extended', 'Probation not passed'].map((o) => <option key={o} value={o} />)}
              </datalist>
            </label>
            <label>
              Next review due
              <input type="date" value={d.nextDue ?? ''} onChange={(e) => set('nextDue', orUndefined(e.target.value))} />
            </label>
          </>
        )}
        {d.kind === 'case' && (
          <>
            <label>
              Status
              <select value={d.caseStatus} onChange={(e) => set('caseStatus', e.target.value as HrRecord['caseStatus'])}>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </select>
            </label>
            <label>
              Outcome
              <select value={d.outcome ?? ''} onChange={(e) => set('outcome', orUndefined(e.target.value))}>
                <option value="">Not decided</option>
                {CASE_OUTCOMES.map((o) => <option key={o}>{o}</option>)}
              </select>
            </label>
            {d.outcome?.includes('warning') && (
              <label>
                Warning live until
                <input type="date" value={d.warningExpires ?? ''} onChange={(e) => set('warningExpires', orUndefined(e.target.value))} />
              </label>
            )}
          </>
        )}
        <label className="wide-field">
          Notes
          <textarea rows={3} value={d.notes ?? ''} onChange={(e) => set('notes', orUndefined(e.target.value))} />
        </label>
      </div>
      <div className="modal-actions">
        <span className="spacer" />
        <button onClick={onDone}>Cancel</button>
        <button className="primary" disabled={invalid} onClick={() => void save()}>Save</button>
      </div>
    </div>
  );
}
