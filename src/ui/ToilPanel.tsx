import { useState } from 'react';
import { useEffect } from 'react';
import { overtimeWeeks, toilBalance, type OvertimeWeek } from '../engine/toil';
import type { TimeEntry } from '../engine/types';
import { addDays } from '../engine/time';
import type { Employee, ToilEntry } from '../engine/types';
import { api, ApiError } from './api';

// Time off in lieu on a person's record: the balance owed, every entry behind it, and a line to add
// hours earned or taken. Entries are never edited or removed: a mistake is put right with an adjustment.

const KINDS: { id: ToilEntry['kind']; label: string }[] = [
  { id: 'earned', label: 'Earned' },
  { id: 'taken', label: 'Taken' },
  { id: 'adjustment', label: 'Adjustment' },
];
const when = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function ToilPanel({ employee, today, canEdit }: { employee: Employee; today: string; canEdit: boolean }) {
  const [entries, setEntries] = useState<ToilEntry[]>(employee.toil ?? []);
  const [kind, setKind] = useState<ToilEntry['kind']>('earned');
  const [date, setDate] = useState(today);
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');
  // TOIL taken is a whole day off unless said otherwise: the rota then treats the day like leave.
  const [dayOff, setDayOff] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const balance = toilBalance({ ...employee, toil: entries }, today);
  // Weeks over contract from approved hours, offered to bank as TOIL instead of paying them.
  const [overtime, setOvertime] = useState<OvertimeWeek[]>([]);
  useEffect(() => {
    if (!canEdit || employee.payBasis !== 'salaried' || !(employee.contractedHours > 0)) return;
    api
      .get<TimeEntry[]>(`/v1/time-entries?from=${addDays(today, -63)}&to=${today}`)
      .then((list) => setOvertime(overtimeWeeks({ ...employee, toil: entries }, list, today)))
      .catch(() => setOvertime([]));
  }, [employee, entries, today, canEdit]);

  async function bank(w: OvertimeWeek) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ entry: ToilEntry }>(`/v1/employees/${encodeURIComponent(employee.id)}/toil`, {
        kind: 'earned', date: addDays(w.weekStart, 6), hours: w.overHours, fromWeek: w.weekStart, note: `${w.workedHours}h worked against ${employee.contractedHours}h contracted`,
      });
      setEntries((list) => [...list, res.entry]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  async function add() {
    const n = Number(hours);
    // An adjustment corrects either way; earned and taken are typed as the hours themselves.
    if (kind === 'adjustment' ? !(n !== 0 && Number.isFinite(n)) : !(n > 0)) return setError(kind === 'adjustment' ? 'Give the hours to add, or a negative figure to take off.' : 'Give the hours as a positive number.');
    setBusy(true);
    setError(null);
    try {
      // Taken is stored as a negative figure; the manager types the hours as they think of them.
      const signed = kind === 'taken' ? -n : n;
      const res = await api.post<{ entry: ToilEntry }>(`/v1/employees/${encodeURIComponent(employee.id)}/toil`, { kind, date, hours: signed, ...(kind === 'taken' && dayOff ? { dayOff: true } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
      setEntries((list) => [...list, res.entry]);
      setHours('');
      setNote('');
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  return (
    <div className="toil-panel">
      <h3 className="section">Time off in lieu</h3>
      <p className="small">
        <span className="strong">{balance.hours.toFixed(1)}h owed</span>
        <span className="muted"> ({balance.earned.toFixed(1)}h earned, {balance.taken.toFixed(1)}h taken)</span>
      </p>
      {overtime.length > 0 && (
        <div className="small">
          <p className="muted">Weeks worked over contract, from approved hours. A salary pays the contract, so these hours are owed: bank a week as TOIL where that is the agreement, or pay it as overtime.</p>
          <ul className="issues compact">
            {overtime.map((w) => (
              <li key={w.weekStart}>
                Week of {when(w.weekStart)}: {w.overHours}h over ({w.workedHours}h worked).{' '}
                <button className="link" disabled={busy} onClick={() => void bank(w)}>Bank as TOIL</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {balance.warnings.length > 0 && <ul className="issues compact">{balance.warnings.map((w, i) => <li key={i} className="warn">{w}</li>)}</ul>}
      {entries.length > 0 && (
        <table className="table compact">
          <thead><tr><th>Date</th><th>Entry</th><th className="num">Hours</th><th>Note</th></tr></thead>
          <tbody>
            {[...entries].sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at)).map((t) => (
              <tr key={t.id}>
                <td>{when(t.date)}</td>
                <td className="muted">{t.kind === 'opening' ? 'Opening balance' : t.kind[0].toUpperCase() + t.kind.slice(1)}{t.dayOff ? ', day off' : ''}</td>
                <td className="num">{t.hours > 0 ? `+${t.hours}` : t.hours}</td>
                <td className="muted small">{t.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canEdit && (
        <div className="leave-add">
          <select value={kind} onChange={(e) => setKind(e.target.value as ToilEntry['kind'])} aria-label="TOIL entry">
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
          <input type="number" min={kind === 'adjustment' ? undefined : 0} step={0.25} placeholder="Hours" value={hours} onChange={(e) => setHours(e.target.value)} aria-label="Hours" />
          <input type="text" placeholder="Note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
          {kind === 'taken' && <label className="check small"><input type="checkbox" checked={dayOff} onChange={(e) => setDayOff(e.target.checked)} /> Whole day off</label>}
          <button disabled={busy || !hours} onClick={() => void add()}>Add</button>
        </div>
      )}
      {employee.payBasis === 'hourly' && canEdit && kind === 'earned' && <p className="muted small">Paid by the hour: every approved hour already goes to payroll. Record TOIL earned only for hours taken off the timesheet, or they are paid twice.</p>}
      {kind === 'adjustment' && canEdit && <p className="muted small">An adjustment corrects the balance: a positive figure adds hours, a negative one takes them off. Say why in the note.</p>}
      {error && <p className="notice error">{error}</p>}
    </div>
  );
}
