import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { dayDemand } from '../engine/demand';
import { formatMinute, parseClock } from '../engine/time';
import type { RotaState, Shift } from '../engine/types';
import { candidates, type Opening } from './assign';
import { dayLabel, hours, money } from './format';
import { Avatar } from './viz';

interface Props {
  state: RotaState;
  opening: Opening;
  onPreview: (shift: Shift | null) => void;
  onAdd: (shift: Shift) => void;
  onClose: () => void;
}

/**
 * Who should work this? Lists the site's team for a drawn or gap-filling opening, cheapest legal
 * person first, with why anyone else cannot. Hovering a name previews them across the whole page.
 */
export function AssignPanel({ state, opening: initial, onPreview, onAdd, onClose }: Props) {
  const [opening, setOpening] = useState(initial);
  const [id] = useState(() => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  const list = useMemo(() => candidates(state, opening, id), [state, opening, id]);
  const role = state.roles.find((r) => r.id === opening.roleId);
  const length = opening.endMinute - opening.startMinute;
  const short = dayDemand(state, opening.siteId, opening.roleId, opening.date)
    .filter((h) => h.hour * 60 >= opening.startMinute && h.hour * 60 < opening.endMinute)
    .reduce((sum, h) => sum + Math.max(0, h.gap), 0);
  const day = dayLabel(opening.date);
  // The tap that opens the picker on a tablet is followed by a click at the same spot, which
  // would otherwise land on a name and add them. Ignore clicks until the picker has settled.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), 400);
    return () => clearTimeout(t);
  }, []);
  const pressedBackdrop = useRef(false);

  useEffect(() => () => onPreview(null), [onPreview]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const setClock = (key: 'startMinute' | 'endMinute') => (e: ChangeEvent<HTMLInputElement>) => {
    let minute = parseClock(e.target.value);
    // A finish at or before the start runs past midnight.
    if (key === 'endMinute' && minute <= opening.startMinute) minute += 1440;
    setOpening({ ...opening, [key]: minute });
  };

  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => (pressedBackdrop.current = e.target === e.currentTarget)}
      onClick={(e) => armed && e.target === e.currentTarget && pressedBackdrop.current && onClose()}
    >
      <div className="modal assign" role="dialog" aria-modal="true" aria-label="Add a shift">
        <div className="modal-head">
          <div>
            <div className="eyebrow">New shift · {day.short} {day.date}</div>
            <h2>Who should work this?</h2>
          </div>
        </div>
        <div className="modal-body">
          <div className="form assign-form">
            <label>
              Role
              <select value={opening.roleId} onChange={(e) => setOpening({ ...opening, roleId: e.target.value })}>
                {state.roles.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </label>
            <label>
              Start
              <input type="time" step={900} value={formatMinute(opening.startMinute)} onChange={setClock('startMinute')} />
            </label>
            <label>
              Finish
              <input type="time" step={900} value={formatMinute(opening.endMinute)} onChange={setClock('endMinute')} />
            </label>
          </div>
          <p className={`assign-need ${short ? 'bad' : ''}`}>
            {short
              ? `${role?.name} is ${short} person-hour${short === 1 ? '' : 's'} short in this window. ${hours(length / 60)} shift.`
              : `${role?.name} is covered in this window, so this adds cost without fixing a gap. ${hours(length / 60)} shift.`}
          </p>

          <ul className="assign-list">
            {list.map((c) => {
              const disabled = !!c.blocker || length <= 0;
              const status = c.blocker ?? (!c.trained ? `Not signed off as ${role?.name}` : c.warnings[0]?.message ?? 'Available');
              const tone = c.blocker ? 'bad' : !c.trained || c.warnings.length ? 'warn' : 'good';
              const dept = state.roles.find((r) => r.id === c.employee.roleIds[0])?.department ?? 'FOH';
              return (
                <li key={c.employee.id}>
                  <button
                    className={`assign-row ${tone}`}
                    disabled={disabled}
                    onMouseEnter={() => !disabled && onPreview(c.shift)}
                    onFocus={() => !disabled && onPreview(c.shift)}
                    onMouseLeave={() => onPreview(null)}
                    onClick={() => armed && onAdd(c.shift)}
                  >
                    <Avatar small name={c.employee.name} dept={dept} />
                    <span className="assign-who">
                      <span className="strong">{c.employee.name}</span>
                      <span className="muted small">
                        {c.employee.roleIds.map((r) => state.roles.find((x) => x.id === r)?.name).join(', ')}
                        {c.employee.payBasis === 'salaried' ? ' · salaried' : ` · £${c.employee.hourlyRate.toFixed(2)}`}
                      </span>
                    </span>
                    <span className={`assign-status ${tone}`}>{status}</span>
                    <span className="assign-cost tnum">
                      {c.blocker ? '' : c.marginal < 0.5 ? '£0' : `+${money(c.marginal)}`}
                      {!c.blocker && c.marginal < 0.5 && (
                        <span className="muted small">{c.employee.payBasis === 'salaried' ? 'salaried' : 'contracted hours'}</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="muted small">
            Cost is what the shift adds to that person's loaded week: holiday, employer NI and pension included, and nothing for
            hours you already guarantee. Hover a name to see it across the rota.
          </p>
        </div>
        <div className="modal-actions">
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
