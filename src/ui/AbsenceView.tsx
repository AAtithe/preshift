import { useMemo, useState } from 'react';
import { employeeStatus } from '../engine/employees';
import {
  ABSENCE_LABEL, absenceDays, bradfordFactor, BRADFORD_FORMAL, BRADFORD_REVIEW, FIT_NOTE_AFTER_DAYS, isAbsentOn,
} from '../engine/hr';
import { addDays } from '../engine/time';
import type { Absence, Employee, RotaState } from '../engine/types';
import { csvLine, download } from './format';
import { AbsenceForm } from './HrFile';
import type { HrSection } from './HrFile';

interface Props {
  state: RotaState;
  siteIds: string[];
  today: string;
  onOpen: (employee: Employee, section?: HrSection) => void;
  onSaveAbsence: (employeeId: string, absence: Absence, isNew: boolean) => Promise<{ clashes: string[] } | undefined>;
}

export function AbsenceView({ state, siteIds, today, onOpen, onSaveAbsence }: Props) {
  const [recordFor, setRecordFor] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const yearAgo = addDays(today, -365);
  const people = useMemo(
    () => state.employees.filter((e) => siteIds.includes(e.siteId) && employeeStatus(e, today) !== 'left').sort((a, b) => a.name.localeCompare(b.name)),
    [state.employees, siteIds, today],
  );
  const spells = people
    .flatMap((e) => (e.absences ?? []).map((a) => ({ e, a })))
    .filter(({ a }) => (a.to ?? today) > yearAgo)
    .sort((x, y) => y.a.from.localeCompare(x.a.from));
  const offToday = people.filter((e) => isAbsentOn(e, today));
  const bradford = people
    .map((e) => ({ e, b: bradfordFactor(e, today) }))
    .filter((x) => x.b.score > 0)
    .sort((x, y) => y.b.score - x.b.score);
  const rtwOutstanding = spells.filter(({ a }) => (a.type === 'sickness' || a.type === 'unauthorised') && a.to && a.to < today && !a.returnToWorkOn).length;
  const sickDays = spells.filter(({ a }) => a.type === 'sickness').reduce((s, { a }) => s + absenceDays(a, today), 0);

  async function record(a: Absence) {
    const res = await onSaveAbsence(recordFor, a, true);
    if (!res) return;
    const name = people.find((e) => e.id === recordFor)?.name;
    setNote(`${name}: absence recorded.${res.clashes.length ? ` ${res.clashes.length} rostered shift${res.clashes.length === 1 ? ' is' : 's are'} now blocked on the rota. Re-cover ${res.clashes.length === 1 ? 'it' : 'them'}.` : ''}`);
    setRecordFor('');
  }

  function exportCsv() {
    const header = ['Name', 'Type', 'From', 'To', 'Days', 'Reason', 'Fit note', 'Return to work', 'Excluded from triggers'];
    const lines = spells.map(({ e, a }) => [
      e.name, a.type ? ABSENCE_LABEL[a.type] : 'Absent', a.from, a.to ?? 'Still off', absenceDays(a, today), a.reason ?? '',
      a.fitNote ? 'Yes' : 'No', a.returnToWorkOn ?? '', a.excludeFromTriggers ? 'Yes' : 'No',
    ]);
    download(`absence-${today}.csv`, [header, ...lines].map(csvLine).join('\n'));
  }

  return (
    <div>
      <div className="kpis people-kpis">
        <div className={`kpi ${offToday.length ? 'warn' : 'good'}`}>
          <div className="kpi-label">Off today</div>
          <div className="kpi-value">{offToday.length}</div>
          <div className="kpi-hint">{offToday.map((e) => e.name).join(', ') || 'Everyone available'}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Sick days, 12 months</div>
          <div className="kpi-value">{sickDays}</div>
          <div className="kpi-hint">{people.length ? (sickDays / people.length).toFixed(1) : '0'} per head, calendar days</div>
        </div>
        <div className={`kpi ${bradford.some((x) => x.b.score >= BRADFORD_REVIEW) ? 'warn' : 'good'}`}>
          <div className="kpi-label">Over the review trigger</div>
          <div className="kpi-value">{bradford.filter((x) => x.b.score >= BRADFORD_REVIEW).length}</div>
          <div className="kpi-hint">Bradford factor {BRADFORD_REVIEW} or more</div>
        </div>
        <div className={`kpi ${rtwOutstanding ? 'warn' : 'good'}`}>
          <div className="kpi-label">Return to work not held</div>
          <div className="kpi-value">{rtwOutstanding}</div>
          <div className="kpi-hint">The cheapest absence control there is</div>
        </div>
      </div>

      <div className="people-bar">
        <div className="people-actions">
          <select value={recordFor} onChange={(e) => { setRecordFor(e.target.value); setNote(null); }} aria-label="Record absence for">
            <option value="">Record absence for</option>
            {people.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
        <div className="people-actions">
          <button onClick={exportCsv} disabled={spells.length === 0}>Absence CSV</button>
        </div>
      </div>
      {note && <p className="notice">{note}</p>}
      {recordFor && (
        <AbsenceForm key={recordFor} absence={{ id: '', type: 'sickness', from: today, to: today }} onSave={(a) => void record(a)} onCancel={() => setRecordFor('')} />
      )}

      <div className="split hr-split">
        <div className="grid-wrap">
          <h3 className="section-title">Absence in the last 12 months</h3>
          <table className="table people">
            <thead>
              <tr><th>Name</th><th>Type</th><th>From</th><th>To</th><th className="num">Days</th><th>Follow up</th></tr>
            </thead>
            <tbody>
              {spells.length === 0 && <tr><td colSpan={6} className="muted">No absence recorded.</td></tr>}
              {spells.map(({ e, a }) => {
                const days = absenceDays(a, today);
                const todo = [
                  a.type === 'sickness' && days > FIT_NOTE_AFTER_DAYS && !a.fitNote && !a.fitNotes?.length && 'Fit note',
                  (a.type === 'sickness' || a.type === 'unauthorised') && a.to && a.to < today && !a.returnToWorkOn && 'Return to work',
                ].filter(Boolean);
                return (
                  <tr key={a.id} className="clickable" tabIndex={0} onClick={() => onOpen(e, 'absence')} onKeyDown={(ev) => { if (ev.key === 'Enter') onOpen(e, 'absence'); }}>
                    <td className="strong">{e.name}</td>
                    <td>{a.type ? ABSENCE_LABEL[a.type] : 'Absent'}{a.reason && <div className="muted small">{a.reason}</div>}</td>
                    <td>{a.from}</td>
                    <td>{a.to ?? <span className="warn-text">Still off</span>}</td>
                    <td className="num">{days}</td>
                    <td>{todo.length ? <span className="warn-text">{todo.join(', ')}</span> : <span className="muted">Done</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="grid-wrap">
          <h3 className="section-title">Bradford factor</h3>
          <table className="table">
            <thead><tr><th>Name</th><th className="num">Spells</th><th className="num">Days</th><th className="num">Score</th></tr></thead>
            <tbody>
              {bradford.length === 0 && <tr><td colSpan={4} className="muted">No sickness or unauthorised absence.</td></tr>}
              {bradford.map(({ e, b }) => (
                <tr key={e.id} className="clickable" onClick={() => onOpen(e, 'absence')}>
                  <td>{e.name}</td>
                  <td className="num">{b.spells}</td>
                  <td className="num">{b.days}</td>
                  <td className={`num strong${b.score >= BRADFORD_FORMAL ? ' bad-text' : b.score >= BRADFORD_REVIEW ? ' warn-text' : ''}`}>{b.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            Spells squared times days, over 52 weeks. Six one-day absences score 216; one six-day absence scores 6, because
            short, frequent absence is what breaks a rota. A score is a prompt for a conversation, never a decision on its
            own. Disability and pregnancy related absence is kept out.
          </p>
        </div>
      </div>
    </div>
  );
}
