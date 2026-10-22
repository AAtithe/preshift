import { useMemo, useState } from 'react';
import { employeeWeekCost } from '../engine/cost';
import { isEmployedOn, reviewEmployee } from '../engine/employees';
import { holidayBalance, STATUTORY_WEEKS } from '../engine/holiday';
import { formatMinute, parseClock } from '../engine/time';
import type { Availability, Employee, HolidayRecord, RotaState } from '../engine/types';
import { fileSize, MAX_UPLOAD_BYTES, shrinkPhoto } from './files';
import { money } from './format';
import type { DocumentAccess } from './store';

interface Props {
  state: RotaState;
  employee: Employee;
  today: string;
  /** May change the rate, salary and pay basis. Without it pay is shown locked, or not at all if withheld. */
  canEditPay: boolean;
  onSave: (employee: Employee) => void;
  onLeaver: (id: string, leaveDate: string) => void;
  /** Right to work copies are stored at once, not on Save, so they need a record that already exists. */
  onAddDocument: (id: string, file: Blob, fileName: string) => Promise<Employee>;
  onDeleteDocument: (id: string, documentId: string) => Promise<Employee>;
  onDocumentHistory: (id: string, documentId: string) => Promise<DocumentAccess[]>;
  onClose: () => void;
}

const LONDON_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' });
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// Without these the record cannot be costed or checked, so it cannot be saved.
const HARD_STOPS = new Set(['name', 'roles', 'dob', 'dates', 'hours']);

export function EmployeeEditor({ state, employee, today, canEditPay, onSave, onLeaver, onAddDocument, onDeleteDocument, onDocumentHistory, onClose }: Props) {
  const payLocked = !canEditPay;
  const [draft, setDraft] = useState<Employee>(employee);
  const [uploading, setUploading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ documentId: string; entries: DocumentAccess[] } | null>(null);
  const [leaveDay, setLeaveDay] = useState('');
  const [leaving, setLeaving] = useState<string | null>(null);
  const isNew = !state.employees.some((e) => e.id === employee.id);
  const set = <K extends keyof Employee>(key: K, value: Employee[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const rtw = draft.rightToWork ?? { checked: false };

  const checks = useMemo(() => reviewEmployee(draft, today), [draft, today]);
  const canSave = !checks.some((c) => c.severity === 'block' && HARD_STOPS.has(c.code));
  const guaranteed = useMemo(() => employeeWeekCost(draft, []), [draft]);
  const shifts = state.shifts.filter((s) => s.employeeId === draft.id);
  const dropped = shifts.filter((s) => !isEmployedOn(draft, s.date)).length;
  const homeEntity = state.sites.find((x) => x.id === draft.siteId)?.entityId;
  const siteName = (id: string) => state.sites.find((x) => x.id === id)?.name ?? id;
  const holiday = draft.holiday ?? {};
  const setHoliday = (patch: Partial<HolidayRecord>) => set('holiday', { ...holiday, ...patch });
  const leaveYearStart = state.entities.find((x) => x.id === draft.entityId)?.leaveYearStart;
  // The editor has the rota only; the Holiday tab also counts clocked time.
  const balance = useMemo(
    () => holidayBalance(draft, state.shifts.filter((s) => s.date <= today), today, leaveYearStart),
    [draft, state.shifts, today, leaveYearStart],
  );
  const numberOrUndefined = (v: string) => (v === '' ? undefined : Number(v));

  function toggleRole(roleId: string) {
    const has = draft.roleIds.includes(roleId);
    set('roleIds', has ? draft.roleIds.filter((r) => r !== roleId) : [...draft.roleIds, roleId]);
  }

  function toggleCover(siteId: string) {
    const has = draft.coverSiteIds.includes(siteId);
    set('coverSiteIds', has ? draft.coverSiteIds.filter((x) => x !== siteId) : [...draft.coverSiteIds, siteId]);
  }

  // Changing home site should not leave them "covering" the site they are now based at.
  function setHome(siteId: string) {
    setDraft((d) => ({ ...d, siteId, coverSiteIds: d.coverSiteIds.filter((x) => x !== siteId) }));
  }

  function makePrimary(roleId: string) {
    set('roleIds', [roleId, ...draft.roleIds.filter((r) => r !== roleId)]);
  }

  // No availability rows means available any time; once one day is set, unset days are unavailable.
  const anyTime = draft.availability.length === 0;
  const dayRow = (weekday: number) => draft.availability.find((a) => a.weekday === weekday);
  function setDay(weekday: number, row: Availability | null) {
    const rest = draft.availability.filter((a) => a.weekday !== weekday);
    set('availability', row ? [...rest, row].sort((a, b) => a.weekday - b.weekday) : rest);
  }
  function restrictAvailability() {
    set('availability', WEEKDAYS.map((_, weekday) => ({ weekday, fromMinute: 9 * 60, toMinute: 24 * 60 })));
  }

  // The server owns the list of copies; take it from the saved record and keep the rest of the draft.
  const takeDocuments = (saved: Employee) =>
    setDraft((d) => ({ ...d, rightToWork: { ...(d.rightToWork ?? { checked: false }), documents: saved.rightToWork?.documents ?? [] } }));
  const documents = rtw.documents ?? [];

  async function addDocuments(files: FileList | null) {
    if (!files?.length) return;
    setDocError(null);
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const body = await shrinkPhoto(file);
        if (body.size > MAX_UPLOAD_BYTES) throw new Error(`${file.name} is ${fileSize(body.size)}. The limit is ${fileSize(MAX_UPLOAD_BYTES)}: scan it at a lower resolution.`);
        const name = body === file ? file.name : file.name.replace(/\.[^.]*$/, '') + '.jpg';
        takeDocuments(await onAddDocument(draft.id, body, name));
      }
    } catch (e) {
      setDocError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function deleteDocument(documentId: string, fileName: string) {
    if (!window.confirm(`Delete ${fileName}? Without a copy of each document checked there is no statutory excuse.`)) return;
    setDocError(null);
    try {
      takeDocuments(await onDeleteDocument(draft.id, documentId));
    } catch (e) {
      setDocError((e as Error).message);
    }
  }

  async function toggleHistory(documentId: string) {
    if (history?.documentId === documentId) return setHistory(null);
    setDocError(null);
    try {
      setHistory({ documentId, entries: await onDocumentHistory(draft.id, documentId) });
    } catch (e) {
      setDocError((e as Error).message);
    }
  }

  function addLeave() {
    if (!leaveDay || draft.leave.includes(leaveDay)) return;
    set('leave', [...draft.leave, leaveDay].sort());
    setLeaveDay('');
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>{isNew ? 'New employee' : draft.name || 'Employee'}</h2>
        <p className="muted">
          {isNew ? 'Set up the record before their first shift.' : `${shifts.length} shift${shifts.length === 1 ? '' : 's'} on record.`}
        </p>

        <h3 className="section">Details</h3>
        <div className="form">
          <label>
            Full name
            <input value={draft.name} onChange={(e) => set('name', e.target.value)} autoFocus={isNew} />
          </label>
          <label>
            Date of birth
            <input type="date" value={draft.dateOfBirth} onChange={(e) => set('dateOfBirth', e.target.value)} />
          </label>
          <label>
            Email
            <input type="email" value={draft.email ?? ''} onChange={(e) => set('email', e.target.value || undefined)} />
          </label>
          <label>
            Phone
            <input type="tel" value={draft.phone ?? ''} onChange={(e) => set('phone', e.target.value || undefined)} />
          </label>
          <label>
            Home site
            <select value={draft.siteId} onChange={(e) => setHome(e.target.value)}>
              {state.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label>
            Employer
            <select value={draft.entityId} onChange={(e) => set('entityId', e.target.value)}>
              {state.entities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <label>
            Start date
            <input type="date" value={draft.startDate ?? ''} onChange={(e) => set('startDate', e.target.value || undefined)} />
          </label>
          <label>
            Leaving date
            <input type="date" value={draft.leaveDate ?? ''} disabled title="Set through Mark as leaver, which tells payroll" />
          </label>
        </div>
        {homeEntity && homeEntity !== draft.entityId && (
          <p className="hint muted">
            Employed by a different company from the one {siteName(draft.siteId)} trades in. Their cost at that site is
            recharged between the two companies at close.
          </p>
        )}
        {state.sites.length > 1 && (
          <>
            <p className="muted small">Other sites they will cover. Auto-build only borrows people who have agreed.</p>
            <div className="role-list">
              {state.sites.filter((x) => x.id !== draft.siteId).map((x) => (
                <div key={x.id} className={`role-pill${draft.coverSiteIds.includes(x.id) ? ' on' : ''}`}>
                  <label>
                    <input type="checkbox" checked={draft.coverSiteIds.includes(x.id)} onChange={() => toggleCover(x.id)} /> {x.name}
                    {x.entityId !== draft.entityId && <span className="muted small"> (recharge)</span>}
                  </label>
                </div>
              ))}
            </div>
          </>
        )}
        {dropped > 0 && (
          <p className="hint warn-text">
            {dropped} rostered shift{dropped === 1 ? '' : 's'} outside these dates will be removed on save.
          </p>
        )}

        <h3 className="section">Roles</h3>
        <p className="muted small">Tick every role they are signed off for. The primary role sets where they sit on the rota.</p>
        <div className="role-list">
          {state.roles.map((r) => {
            const on = draft.roleIds.includes(r.id);
            const primary = draft.roleIds[0] === r.id;
            return (
              <div key={r.id} className={`role-pill dept-${r.department}${on ? ' on' : ''}`}>
                <label>
                  <input type="checkbox" checked={on} onChange={() => toggleRole(r.id)} /> {r.name}
                </label>
                {on && (primary ? <span className="tag">Primary</span> : <button className="link" onClick={() => makePrimary(r.id)}>Make primary</button>)}
              </div>
            );
          })}
        </div>

        <h3 className="section">Contract and pay</h3>
        {draft.payHidden && <p className="muted small">Pay is withheld from your view. Whoever manages pay sets the rate.</p>}
        {!draft.payHidden && payLocked && <p className="muted small">Pay is set by whoever manages pay, never by the person managing the team.</p>}
        <div className="form">
          {!draft.payHidden && (<>
          <label>
            Pay basis
            <select disabled={payLocked} value={draft.payBasis} onChange={(e) => set('payBasis', e.target.value as Employee['payBasis'])}>
              <option value="hourly">Hourly</option>
              <option value="salaried">Salaried</option>
            </select>
          </label>
          {draft.payBasis === 'hourly' ? (
            <label>
              Hourly rate (£)
              <input type="number" min={0} step={0.01} disabled={payLocked} value={draft.hourlyRate} onChange={(e) => set('hourlyRate', Number(e.target.value))} />
            </label>
          ) : (
            <label>
              Annual salary (£)
              <input type="number" min={0} step={500} disabled={payLocked} value={draft.annualSalary} onChange={(e) => set('annualSalary', Number(e.target.value))} />
            </label>
          )}
          </>)}
          <label>
            Contracted hours a week (0 = flexible)
            <input type="number" min={0} step={1} value={draft.contractedHours} onChange={(e) => set('contractedHours', Number(e.target.value))} />
          </label>
          <label>
            Maximum hours a week
            <input type="number" min={0} step={1} value={draft.maxWeeklyHours} onChange={(e) => set('maxWeeklyHours', Number(e.target.value))} />
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.optedOutOf48} onChange={(e) => set('optedOutOf48', e.target.checked)} />
            Signed 48 hour opt-out
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.irregularHours} onChange={(e) => set('irregularHours', e.target.checked)} />
            Irregular hours (holiday accrues at 12.07%)
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.pensionEnrolled} onChange={(e) => set('pensionEnrolled', e.target.checked)} />
            Enrolled in workplace pension
          </label>
        </div>
        {!draft.payHidden && (
        <div className="cost-box">
          <div>
            <div className="muted small">Guaranteed weekly cost</div>
            <div className="big">{money(guaranteed.total)}</div>
          </div>
          <div className="muted small">
            {guaranteed.total === 0
              ? 'Flexible contract: nothing is paid until they are rostered.'
              : `${money(guaranteed.total * 52)} a year, loaded with holiday, employer NI and pension. You pay this whether or not the rota uses them.`}
          </div>
        </div>
        )}

        <h3 className="section">Right to work</h3>
        <div className="form">
          <label className="check">
            <input type="checkbox" checked={rtw.checked} onChange={(e) => set('rightToWork', { ...rtw, checked: e.target.checked })} />
            Check done
          </label>
          <label>
            Checked on
            <input type="date" value={rtw.checkedOn ?? ''} onChange={(e) => set('rightToWork', { ...rtw, checkedOn: e.target.value || undefined })} />
          </label>
          <label>
            Evidence
            <select value={rtw.evidence ?? ''} onChange={(e) => set('rightToWork', { ...rtw, evidence: e.target.value || undefined })}>
              <option value="">Select</option>
              <option>British or Irish passport</option>
              <option>Share code</option>
              <option>Birth certificate and NI number</option>
              <option>Identity service provider</option>
            </select>
          </label>
          <label>
            Permission expires (if time limited)
            <input type="date" value={rtw.expiry ?? ''} onChange={(e) => set('rightToWork', { ...rtw, expiry: e.target.value || undefined })} />
          </label>
        </div>
        <p className="muted small">
          Keep a clear copy of every document checked: the photo page of a passport, both sides of a card, or the online
          check result for a share code. Hold it for the whole employment and at least two years after; the retention schedule under GDPR deletes it when your policy says.
          Copies are encrypted, and every time one is opened it is logged.
        </p>
        {documents.length > 0 && (
          <ul className="doc-list">
            {documents.map((d) => (
              <li key={d.id}>
                <a href={`/v1/employees/${draft.id}/right-to-work/documents/${d.id}`} target="_blank" rel="noopener noreferrer">{d.fileName}</a>
                <span className="muted small">
                  {fileSize(d.bytes)}, added {d.uploadedAt.slice(0, 10)} by {d.uploadedBy}
                </span>
                <button className="link" onClick={() => void toggleHistory(d.id)}>{history?.documentId === d.id ? 'Hide history' : 'History'}</button>
                <button className="link danger" onClick={() => void deleteDocument(d.id, d.fileName)}>Delete</button>
                {history?.documentId === d.id && (
                  <ol className="doc-history">
                    {history.entries.map((a, i) => (
                      <li key={i} className="muted small">
                        {LONDON_TIME.format(new Date(a.at))} {a.action} by {a.actor}
                        {a.via === 'api key' ? ' (integration)' : ''}
                        {a.ip ? ` from ${a.ip}` : ''}
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            ))}
          </ul>
        )}
        {isNew ? (
          <p className="muted small">Save the record first, then add the copies.</p>
        ) : (
          <label className={`file-pick${uploading ? ' busy' : ''}`}>
            <input
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              multiple
              disabled={uploading}
              onChange={(e) => { void addDocuments(e.target.files); e.target.value = ''; }}
            />
            {uploading ? 'Uploading...' : documents.length ? 'Add another copy' : 'Add copy (PDF or photo)'}
          </label>
        )}
        {docError && <p className="hint bad-text">{docError}</p>}

        <h3 className="section">Availability</h3>
        {anyTime ? (
          <p className="muted small">
            Available any time. <button className="link" onClick={restrictAvailability}>Set days and hours</button>
          </p>
        ) : (
          <>
            <div className="avail">
              {WEEKDAYS.map((label, weekday) => {
                const row = dayRow(weekday);
                return (
                  <div key={label} className="avail-row">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={!!row}
                        onChange={(e) => setDay(weekday, e.target.checked ? { weekday, fromMinute: 9 * 60, toMinute: 24 * 60 } : null)}
                      />
                      {label}
                    </label>
                    {row ? (
                      <>
                        <input type="time" value={formatMinute(row.fromMinute)} onChange={(e) => setDay(weekday, { ...row, fromMinute: parseClock(e.target.value) })} />
                        <span className="muted">to</span>
                        <input
                          type="time"
                          value={formatMinute(row.toMinute)}
                          onChange={(e) => {
                            const m = parseClock(e.target.value);
                            setDay(weekday, { ...row, toMinute: m <= row.fromMinute ? m + 1440 : m });
                          }}
                        />
                      </>
                    ) : (
                      <span className="muted small">Not available</span>
                    )}
                  </div>
                );
              })}
            </div>
            <button className="link" onClick={() => set('availability', [])}>Available any time</button>
          </>
        )}

        <h3 className="section">Rota notes</h3>
        <label className="notes">
          <span className="muted small">
            Preferences and commitments the rota should respect, for example "Prefers not to close on Sundays" or "College
            on Tuesdays until June". The rota assistant reads these.
          </span>
          <textarea rows={2} maxLength={1000} value={draft.rotaNotes ?? ''} onChange={(e) => set('rotaNotes', e.target.value)} />
        </label>

        <h3 className="section">Holiday</h3>
        <div className="cost-box holiday-box">
          <div>
            <div className="muted small">Remaining this leave year</div>
            <div className={`big${balance.remainingHours < 0 ? ' bad-text' : ''}`}>{balance.remainingHours.toFixed(1)}h</div>
          </div>
          <div className="muted small">
            {balance.year.start} to {balance.year.end}.{' '}
            {balance.basis === 'fixed'
              ? `${balance.entitlementHours.toFixed(1)}h entitlement`
              : `${balance.accruedHours.toFixed(1)}h accrued at 12.07% of hours worked`}
            {balance.carriedOverHours > 0 && `, ${balance.carriedOverHours.toFixed(1)}h carried over`}
            , {balance.takenHours.toFixed(1)}h taken, {balance.bookedHours.toFixed(1)}h booked. A normal day counts as {balance.dayHours.toFixed(1)}h.
          </div>
        </div>
        <div className="form">
          {balance.basis === 'fixed' ? (
            <label>
              Entitlement (weeks a year, statutory {STATUTORY_WEEKS})
              <input
                type="number"
                min={STATUTORY_WEEKS}
                step={0.2}
                value={holiday.entitlementWeeks ?? STATUTORY_WEEKS}
                onChange={(e) => setHoliday({ entitlementWeeks: Math.max(STATUTORY_WEEKS, Number(e.target.value)) })}
              />
            </label>
          ) : (
            <label>
              Accrued before records began (hours)
              <input type="number" min={0} step={0.5} value={holiday.openingAccruedHours ?? ''} onChange={(e) => setHoliday({ openingAccruedHours: numberOrUndefined(e.target.value) })} />
            </label>
          )}
          <label>
            Taken before records began (hours)
            <input type="number" min={0} step={0.5} value={holiday.openingTakenHours ?? ''} onChange={(e) => setHoliday({ openingTakenHours: numberOrUndefined(e.target.value) })} />
          </label>
          <label>
            Carried over from last year (hours)
            <input type="number" min={0} step={0.5} value={holiday.carriedOverHours ?? ''} onChange={(e) => setHoliday({ carriedOverHours: numberOrUndefined(e.target.value) })} />
          </label>
        </div>

        <h3 className="section">Approved leave</h3>
        <div className="leave-add">
          <input type="date" value={leaveDay} onChange={(e) => setLeaveDay(e.target.value)} />
          <button onClick={addLeave} disabled={!leaveDay}>Add day</button>
        </div>
        {draft.leave.length > 0 && (
          <div className="leave-list">
            {draft.leave.map((d) => (
              <span key={d} className="leave-chip">
                {d}
                <input
                  type="number"
                  className="day-hours"
                  min={0}
                  max={24}
                  step={0.5}
                  value={holiday.dayHours?.[d] ?? balance.dayHours}
                  aria-label={`Hours of leave on ${d}`}
                  onChange={(e) => {
                    const { [d]: _old, ...rest } = holiday.dayHours ?? {};
                    const v = Number(e.target.value);
                    setHoliday({ dayHours: v === balance.dayHours ? rest : { ...rest, [d]: v } });
                  }}
                />
                h
                <button className="link" aria-label={`Remove ${d}`} onClick={() => set('leave', draft.leave.filter((x) => x !== d))}>Remove</button>
              </span>
            ))}
          </div>
        )}

        {checks.length + balance.checks.length > 0 && (
          <ul className="issues">
            {[...checks, ...balance.checks].map((c) => <li key={c.code} className={c.severity}>{c.message}</li>)}
          </ul>
        )}

        <div className="modal-actions">
          {!isNew && draft.status !== 'leaver' && leaving === null && (
            <button className="danger" onClick={() => setLeaving(today)}>Mark as leaver</button>
          )}
          {leaving !== null && (
            <span className="leaver-confirm">
              <label className="muted small">
                Last day <input type="date" value={leaving} onChange={(e) => setLeaving(e.target.value)} />
              </label>
              <button className="danger" disabled={!leaving} onClick={() => onLeaver(draft.id, leaving)}>
                Confirm leaver ({shifts.filter((s) => s.date > leaving).length} later shifts removed, payroll told)
              </button>
              <button className="link" onClick={() => setLeaving(null)}>Cancel</button>
            </span>
          )}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!canSave} onClick={() => onSave({ ...draft, name: draft.name.trim() })}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
