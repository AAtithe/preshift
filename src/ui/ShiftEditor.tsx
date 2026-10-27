import { useMemo, useState, type ChangeEvent } from 'react';
import { roleArea } from '../engine/areas';
import { breakFor, checkEmployeeWeek, complianceOptions } from '../engine/compliance';
import { employeeWeekCost, shiftsInWeek } from '../engine/cost';
import { employedShare } from '../engine/employees';
import { addDays, formatMinute, parseClock, weekStart } from '../engine/time';
import type { RotaState, Shift, ShiftType } from '../engine/types';
import { templateOf, type ShiftTemplate } from './drag';
import { dayLabel, money2 } from './format';
import { Avatar, COMPONENTS, CostStack } from './viz';
import { travelIssues } from '../engine/travel';
import { assessShortNotice, snapshot, type ShortNoticeAssessment } from '../engine/employmentRights';

interface Props {
  state: RotaState;
  shift: Shift;
  /** The marginal cost is pay, shown only to those who may see it. */
  showCost: boolean;
  onSave: (shift: Shift) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  /** Offers the shift to the people who could legally work it instead. Absent for those who may not. */
  onAskCover?: (shiftId: string) => void;
  /** Holds the shift to paste onto other people and days. Absent where the view cannot paste. */
  onCopy?: (template: ShiftTemplate) => void;
  /** Saves the times, break and role as one of the site's shift types. */
  onSaveType?: (type: Omit<ShiftType, 'id'>) => Promise<unknown>;
}

export function ShiftEditor({ state, shift, showCost, onSave, onDelete, onClose, onAskCover, onCopy, onSaveType }: Props) {
  const [draft, setDraft] = useState<Shift>(shift);
  // The name for a new shift type while it is being typed; null when not saving one.
  const [typeName, setTypeName] = useState<string | null>(null);
  const types = (state.shiftTypes ?? []).filter((t) => t.siteId === draft.siteId);
  const isNew = !state.shifts.some((s) => s.id === shift.id);
  const employee = state.employees.find((e) => e.id === draft.employeeId)!;
  const ws = weekStart(draft.date);
  const draftSite = state.sites.find((s) => s.id === draft.siteId);
  const entityName = (id: string) => state.entities.find((e) => e.id === id)?.name ?? id;

  const others = state.shifts.filter((s) => s.id !== draft.id);
  // A published shift changed now, inside the notice window, owes the worker under the Employment Rights Act.
  const told = state.shifts.find((s) => s.id === shift.id && s.published);
  const toldTo = told && state.employees.find((e) => e.id === told.employeeId);
  const shortNotice = (after: Shift | null) => (told && toldTo ? assessShortNotice(snapshot(told), after ? snapshot(after) : null, toldTo, new Date(), state.employmentRights) : null);
  const onSaveNotice = shortNotice(draft);
  const noticeText = (a: ShortNoticeAssessment, action: string) => {
    const who = toldTo!.name.split(' ')[0];
    const hours = (a.minutesLost / 60).toFixed(1);
    const pay = showCost ? ` ${money2(a.amount)}` : ' short notice pay';
    return `${action} takes ${hours}h from ${who} with ${Math.floor(a.noticeHours)} hours' notice. ` +
      (a.owed ? `It owes${pay} under the Employment Rights Act, paid with their next pay.` : `Once short notice pay starts under the Employment Rights Act, it would owe${pay}.`);
  };
  const length = draft.endMinute - draft.startMinute;
  const site = state.sites.find((x) => x.id === draft.siteId)!;
  const options = useMemo(() => complianceOptions(state, employee), [state, employee]);
  const neededBreak = breakFor(employee, draft.date, length, options.nation);

  const { marginal, issues } = useMemo(() => {
    const week = shiftsInWeek(others, ws).filter((s) => s.employeeId === employee.id);
    const share = employedShare(employee, ws);
    const without = employeeWeekCost(employee, week, undefined, share, state.sites, state.entities);
    const withShift = employeeWeekCost(employee, [...week, draft], undefined, share, state.sites, state.entities);
    const context = others.filter((s) => s.date >= addDays(ws, -1) && s.date <= addDays(ws, 7));
    return {
      marginal: {
        travelHours: withShift.travelHours - without.travelHours,
        total: withShift.total - without.total,
        ni: withShift.employerNi - without.employerNi,
        premium: withShift.premium - without.premium,
        parts: {
          gross: Math.max(0, withShift.gross - without.gross),
          holiday: Math.max(0, withShift.holiday - without.holiday),
          employerNi: Math.max(0, withShift.employerNi - without.employerNi),
          pension: Math.max(0, withShift.pension - without.pension),
        },
      },
      issues: [...checkEmployeeWeek(employee, ws, [...context, draft], state.restOverrides, undefined, options), ...travelIssues(employee, [...context, draft], state.sites)].filter(
        (i) => i.shiftId === draft.id || !i.shiftId,
      ),
    };
  }, [draft, employee, others, ws, state.restOverrides, options]);

  const setClock = (key: 'startMinute' | 'endMinute') => (e: ChangeEvent<HTMLInputElement>) => {
    let minute = parseClock(e.target.value);
    // An end time at or before the start means the shift runs past midnight.
    if (key === 'endMinute' && minute <= draft.startMinute) minute += 1440;
    setDraft({ ...draft, [key]: minute });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <Avatar name={employee.name} dept={state.roles.find((r) => r.id === employee.roleIds[0])?.department ?? 'FOH'} />
          <div>
            <h2>{isNew ? 'New shift' : 'Edit shift'}</h2>
            <p className="muted small">
              {employee.name} · {dayLabel(draft.date).short} {dayLabel(draft.date).date}
            </p>
          </div>
        </div>

        <div className="modal-body">
        <div className="form">
          {types.length > 0 && (
            <label>
              Shift type
              {/* A starting point: the shift keeps the times it is given, not a link to the type. */}
              <select
                value={types.find((t) => t.startMinute === draft.startMinute && t.endMinute === draft.endMinute && t.breakMinutes === draft.breakMinutes && (!t.roleId || t.roleId === draft.roleId))?.id ?? ''}
                onChange={(e) => {
                  const t = types.find((x) => x.id === e.target.value);
                  if (t) setDraft({ ...draft, startMinute: t.startMinute, endMinute: t.endMinute, breakMinutes: t.breakMinutes, ...(t.roleId ? { roleId: t.roleId, areaId: '' } : {}) });
                }}
              >
                <option value="">Custom times</option>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>{t.name} · {formatMinute(t.startMinute)}-{formatMinute(t.endMinute)}</option>
                ))}
              </select>
            </label>
          )}
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
            {/* An area belongs to its site: a shift moved to another site works in its role's area there. */}
            <select value={draft.siteId} onChange={(e) => setDraft({ ...draft, siteId: e.target.value, areaId: '' })}>
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
          {!!site.areas?.length && (
            <label>
              Area
              {/* Empty is the role's own area here, so a change of role carries the shift with it. */}
              <select value={site.areas.some((a) => a.id === draft.areaId) ? draft.areaId : ''} onChange={(e) => setDraft({ ...draft, areaId: e.target.value })}>
                <option value="">{roleArea(site, draft.roleId)?.name ?? 'No area'} (the role's area)</option>
                {site.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          )}
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
          {onSaveType && (typeName === null ? (
            <div className="hint">
              <button className="link" onClick={() => setTypeName('')}>Save these times as a shift type</button>
            </div>
          ) : (
            <div className="save-type">
              <input autoFocus value={typeName} maxLength={40} placeholder="Name it: Lunch, Close..." aria-label="Shift type name" onChange={(e) => setTypeName(e.target.value)} />
              <button
                disabled={!typeName.trim() || length <= 0}
                onClick={async () => {
                  const { siteId, startMinute, endMinute, breakMinutes, roleId } = draft;
                  if (await onSaveType({ siteId, name: typeName.trim(), startMinute, endMinute, breakMinutes, roleId })) setTypeName(null);
                }}
              >
                Save type
              </button>
              <button className="ghost" onClick={() => setTypeName(null)}>Cancel</button>
            </div>
          ))}
        </div>

        <DayLine site={site} start={draft.startMinute} end={draft.endMinute} />

        {showCost && <div className="cost-box">
          <div>
            <div className="muted small">What this shift adds to the week</div>
            <div className="big">{money2(marginal.total)}</div>
            {marginal.total > 0 && (
              <div title={COMPONENTS.map((c) => `${c.label} ${money2(marginal.parts[c.key])}`).join(', ')}>
                <CostStack parts={marginal.parts} thin />
              </div>
            )}
          </div>
          <div className="muted small">
            {employee.payBasis === 'salaried'
              ? 'Salaried: no extra cost, but it uses their hours.'
              : marginal.total === 0
                ? 'Covered by guaranteed hours you already pay for.'
                : `Includes ${marginal.premium > 0.005 ? `${money2(marginal.premium)} in pay premiums and ` : ''}${money2(marginal.ni)} employer NI. On-costs are worked on the whole week, so the same hours cost more for someone already over the thresholds.`}
            {marginal.travelHours > 0.005 &&
              ` It also pays ${Math.round(marginal.travelHours * 60)} minutes of travel from another site that day, which is working time.`}
          </div>
        </div>}

        {draftSite && draftSite.entityId !== employee.entityId && (
          <p className="muted small">
            {employee.name} is employed by {entityName(employee.entityId)} and {draftSite.name} trades in{' '}
            {entityName(draftSite.entityId)}. The close will recharge this shift between the two companies.
          </p>
        )}

        {onSaveNotice && <p className={`notice${onSaveNotice.owed ? ' error' : ''}`}>{noticeText(onSaveNotice, 'This change')}</p>}

        {issues.length > 0 && (
          <ul className="issues">
            {issues.map((i, n) => (
              <li key={n} className={i.severity}>{i.message}</li>
            ))}
          </ul>
        )}

        </div>

        <div className="modal-actions">
          {!isNew && (
            <button
              className="danger"
              onClick={() => {
                const onDelete_ = shortNotice(null);
                if (onDelete_ && !window.confirm(`${noticeText(onDelete_, 'Cancelling this shift')} Cancel it anyway?`)) return;
                onDelete(draft.id);
              }}
            >
              Delete
            </button>
          )}
          {!isNew && onAskCover && <button onClick={() => onAskCover(shift.id)}>Ask for cover</button>}
          {onCopy && length > 0 && (
            <button title="Hold these times to paste onto other people and days" onClick={() => onCopy(templateOf(draft, state.roles.find((r) => r.id === draft.roleId)?.name ?? 'Shift'))}>
              Copy
            </button>
          )}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={length <= 0} onClick={() => onSave(draft)}>Save</button>
        </div>
      </div>
    </div>
  );
}

/** The shift drawn on a 24 hour line, with the site's trading hours shaded. */
function DayLine({ site, start, end }: { site: { openMinute: number; closeMinute: number }; start: number; end: number }) {
  const from = Math.min(6 * 60, start);
  const to = Math.max(26 * 60, end);
  const at = (m: number) => `${((m - from) / (to - from)) * 100}%`;
  const width = (a: number, b: number) => `${((b - a) / (to - from)) * 100}%`;
  const marks = [from, from + (to - from) / 4, from + (to - from) / 2, from + ((to - from) * 3) / 4, to];
  return (
    <div className="day-line" aria-hidden>
      <div className="day-line-track">
        <div className="day-line-open" style={{ left: at(site.openMinute), width: width(site.openMinute, site.closeMinute) }} />
        {end > start && (
          <div className="day-line-shift" style={{ left: at(start), width: width(start, end) }}>
            {((end - start) / 60).toFixed(1)}h
          </div>
        )}
      </div>
      <div className="day-line-scale">
        {marks.map((m) => (
          <span key={m}>{formatMinute(Math.round(m / 60) * 60)}</span>
        ))}
      </div>
    </div>
  );
}
