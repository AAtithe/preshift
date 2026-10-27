import { useState, type ChangeEvent } from 'react';
import { formatMinute, parseClock } from '../engine/time';
import type { RotaState, ShiftType, Site } from '../engine/types';

interface Props {
  state: RotaState;
  site: Site;
  onAdd: (type: Omit<ShiftType, 'id'>) => Promise<unknown>;
  onRemove: (id: string) => Promise<unknown>;
  onClose: () => void;
}

/** A site's shift types: set up once (times, break, role), then picked from a list when building. */
export function ShiftTypesPanel({ state, site, onAdd, onRemove, onClose }: Props) {
  const types = (state.shiftTypes ?? []).filter((t) => t.siteId === site.id).sort((a, b) => a.startMinute - b.startMinute || a.name.localeCompare(b.name));
  const [draft, setDraft] = useState({ name: '', startMinute: site.openMinute, endMinute: Math.min(site.closeMinute, site.openMinute + 6 * 60), breakMinutes: 0, roleId: '' });
  const [busy, setBusy] = useState(false);
  const roleName = (id?: string) => (id ? state.roles.find((r) => r.id === id)?.name ?? id : 'Any role');

  const setClock = (key: 'startMinute' | 'endMinute') => (e: ChangeEvent<HTMLInputElement>) => {
    let minute = parseClock(e.target.value);
    // A finish at or before the start runs past midnight.
    if (key === 'endMinute' && minute <= draft.startMinute) minute += 1440;
    setDraft({ ...draft, [key]: minute });
  };

  async function add() {
    setBusy(true);
    const { roleId, ...rest } = draft;
    const ok = await onAdd({ ...rest, name: draft.name.trim(), siteId: site.id, ...(roleId ? { roleId } : {}) });
    setBusy(false);
    if (ok) setDraft({ ...draft, name: '' });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Shift types" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>Shift types</h2>
            <p className="muted small">{site.name}: set each pattern up once, then pick it from the list on the rota and paste it onto people and days.</p>
          </div>
        </div>
        <div className="modal-body">
          {types.length === 0 ? (
            <p className="muted">No shift types yet. Add the patterns you use every week: an open, a close, a double.</p>
          ) : (
            <table className="type-list">
              <thead>
                <tr><th>Name</th><th>Times</th><th>Break</th><th>Role</th><th /></tr>
              </thead>
              <tbody>
                {types.map((t) => (
                  <tr key={t.id}>
                    <td className="strong">{t.name}</td>
                    <td className="tnum">{formatMinute(t.startMinute)}-{formatMinute(t.endMinute)}</td>
                    <td className="tnum">{t.breakMinutes ? `${t.breakMinutes}m` : 'None'}</td>
                    <td>{roleName(t.roleId)}</td>
                    <td><button className="link" onClick={() => void onRemove(t.id)} aria-label={`Remove ${t.name}`}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="form">
            <label>
              Name
              <input value={draft.name} maxLength={40} placeholder="Lunch, Close, Double..." onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label>
              Role
              <select value={draft.roleId} onChange={(e) => setDraft({ ...draft, roleId: e.target.value })}>
                <option value="">Any role (the person's own)</option>
                {state.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
            <label>
              Start
              <input type="time" value={formatMinute(draft.startMinute)} onChange={setClock('startMinute')} />
            </label>
            <label>
              Finish
              <input type="time" value={formatMinute(draft.endMinute)} onChange={setClock('endMinute')} />
            </label>
            <label>
              Unpaid break (mins)
              <input type="number" min={0} step={5} value={draft.breakMinutes} onChange={(e) => setDraft({ ...draft, breakMinutes: Number(e.target.value) })} />
            </label>
          </div>
        </div>
        <div className="modal-actions">
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
          <button className="primary" disabled={busy || !draft.name.trim() || draft.endMinute <= draft.startMinute} onClick={() => void add()}>Add shift type</button>
        </div>
      </div>
    </div>
  );
}
