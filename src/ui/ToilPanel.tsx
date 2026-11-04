import { useState } from 'react';
import { toilBalance } from '../engine/toil';
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const balance = toilBalance({ ...employee, toil: entries }, today);

  async function add() {
    const n = Number(hours);
    // An adjustment corrects either way; earned and taken are typed as the hours themselves.
    if (kind === 'adjustment' ? !(n !== 0 && Number.isFinite(n)) : !(n > 0)) return setError(kind === 'adjustment' ? 'Give the hours to add, or a negative figure to take off.' : 'Give the hours as a positive number.');
    setBusy(true);
    setError(null);
    try {
      // Taken is stored as a negative figure; the manager types the hours as they think of them.
      const signed = kind === 'taken' ? -n : n;
      const res = await api.post<{ entry: ToilEntry }>(`/v1/employees/${encodeURIComponent(employee.id)}/toil`, { kind, date, hours: signed, ...(note.trim() ? { note: note.trim() } : {}) });
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
      {balance.warnings.length > 0 && <ul className="issues compact">{balance.warnings.map((w, i) => <li key={i} className="warn">{w}</li>)}</ul>}
      {entries.length > 0 && (
        <table className="table compact">
          <thead><tr><th>Date</th><th>Entry</th><th className="num">Hours</th><th>Note</th></tr></thead>
          <tbody>
            {[...entries].sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at)).map((t) => (
              <tr key={t.id}>
                <td>{when(t.date)}</td>
                <td className="muted">{t.kind === 'opening' ? 'Opening balance' : t.kind[0].toUpperCase() + t.kind.slice(1)}</td>
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
          <button disabled={busy || !hours} onClick={() => void add()}>Add</button>
        </div>
      )}
      {kind === 'adjustment' && canEdit && <p className="muted small">An adjustment corrects the balance: a positive figure adds hours, a negative one takes them off. Say why in the note.</p>}
      {error && <p className="notice error">{error}</p>}
    </div>
  );
}
