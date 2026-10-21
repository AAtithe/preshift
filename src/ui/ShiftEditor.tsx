import { useMemo, useState, type ChangeEvent } from 'react';
import { checkEmployeeWeek, requiredBreakMinutes } from '../engine/compliance';
import { employeeWeekCost, shiftsInWeek } from '../engine/cost';
import { addDays, ageOn, formatMinute, parseClock, weekStart } from '../engine/time';
import type { RotaState, Shift } from '../engine/types';
import { dayLabel, money2 } from './format';

interface Props {
  state: RotaState;
  shift: Shift;
  onSave: (shift: Shift) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export function ShiftEditor({ state, shift, onSave, onDelete, onClose }: Props) {
  const [draft, setDraft] = useState<Shift>(shift);
  const isNew = !state.shifts.some((s) => s.id === shift.id);
  const employee = state.employees.find((e) => e.id === draft.employeeId)!;
  const ws = weekStart(draft.date);
  const draftSite = state.sites.find((s) => s.id === draft.siteId);
  const entityName = (id: string) => state.entities.find((e) => e.id === id)?.name ?? id;

  const others = state.shifts.filter((s) => s.id !== draft.id);
  const length = draft.endMinute - draft.startMinute;
  const neededBreak = requiredBreakMinutes(length, ageOn(employee.dateOfBirth, draft.date));

  const { marginal, issues } = useMemo(() => {
    const week = shiftsInWeek(others, ws).filter((s) => s.employeeId === employee.id);
    const without = employeeWeekCost(employee, week);
    const withShift = employeeWeekCost(employee, [...week, draft]);
    const context = others.filter((s) => s.date >= addDays(ws, -1) && s.date <= addDays(ws, 7));
    return {
      marginal: { ...withShift, total: withShift.total - without.total, ni: withShift.employerNi - without.employerNi },
      issues: checkEmployeeWeek(employee, ws, [...context, draft]).filter((i) => i.shiftId === draft.id || !i.shiftId),
    };
  }, [draft, employee, others, ws]);

  const setClock = (key: 'startMinute' | 'endMinute') => (e: ChangeEvent<HTMLInputElement>) => {
    let minute = parseClock(e.target.value);
    // An end time at or before the start means the shift runs past midnight.
    if (key === 'endMinute' && minute <= draft.startMinute) minute += 1440;
    setDraft({ ...draft, [key]: minute });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>{isNew ? 'New shift' : 'Edit shift'}</h2>
        <p className="muted">
          {employee.name} · {dayLabel(draft.date).short} {dayLabel(draft.date).date}
        </p>

        <div className="form">
          <label>
            Role
            <select value={draft.roleId} onChange={(e) => setDraft({ ...draft, roleId: e.target.value })}>
              {state.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}{employee.roleIds.includes(r.id) ? '' : ' (not trained)'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Site
            <select value={draft.siteId} onChange={(e) => setDraft({ ...draft, siteId: e.target.value })}>
              {state.entities.map((entity) => (
                <optgroup key={entity.id} label={entity.name}>
                  {state.sites.filter((s) => s.entityId === entity.id).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}{s.entityId === employee.entityId ? '' : ' (recharge)'}
                    </option>
                  ))}
                </optgroup>
              ))}
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
            <input
              type="number"
              min={0}
              step={5}
              value={draft.breakMinutes}
              onChange={(e) => setDraft({ ...draft, breakMinutes: Number(e.target.value) })}
            />
          </label>
          <div className="hint">
            {neededBreak > 0 ? `Law requires at least ${neededBreak} minutes for this shift.` : 'No statutory break needed.'}
            {draft.breakMinutes < neededBreak && (
              <button className="link" onClick={() => setDraft({ ...draft, breakMinutes: neededBreak })}>Apply</button>
            )}
          </div>
        </div>

        <div className="cost-box">
          <div>
            <div className="muted small">What this shift adds to the week</div>
            <div className="big">{money2(marginal.total)}</div>
          </div>
          <div className="muted small">
            {employee.payBasis === 'salaried'
              ? 'Salaried: no extra cost, but it uses their hours.'
              : marginal.total === 0
                ? 'Covered by guaranteed hours you already pay for.'
                : `Includes ${money2(marginal.ni)} employer NI. On-costs are worked on the whole week, so the same hours cost more for someone already over the thresholds.`}
          </div>
        </div>

        {draftSite && draftSite.entityId !== employee.entityId && (
          <p className="muted small">
            {employee.name} is employed by {entityName(employee.entityId)} and {draftSite.name} trades in{' '}
            {entityName(draftSite.entityId)}. The close will recharge this shift between the two companies.
          </p>
        )}

        {issues.length > 0 && (
          <ul className="issues">
            {issues.map((i, n) => (
              <li key={n} className={i.severity}>{i.message}</li>
            ))}
          </ul>
        )}

        <div className="modal-actions">
          {!isNew && <button className="danger" onClick={() => onDelete(draft.id)}>Delete</button>}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={length <= 0} onClick={() => onSave(draft)}>Save</button>
        </div>
      </div>
    </div>
  );
}
