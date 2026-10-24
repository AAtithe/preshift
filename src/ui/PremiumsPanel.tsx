import { useState } from 'react';
import { describeRule, PREMIUM_KINDS } from '../engine/premiums';
import { formatMinute, parseClock } from '../engine/time';
import type { Entity, PremiumRule, Role } from '../engine/types';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface Props {
  entities: Entity[];
  roles: Role[];
  /** Absent when the reader cannot approve pay: the rules are then shown, not edited. */
  onSave?: (entityId: string, premiums: PremiumRule[]) => Promise<unknown>;
}

/**
 * Each company's pay premiums: the enhanced rates its contracts pay hourly staff. They change what a
 * shift costs everywhere (rota, P&L, accrual) and go to TeamPay as premium lines on top of the hours.
 */
export function PremiumsPanel({ entities, roles, onSave }: Props) {
  const [editing, setEditing] = useState<{ entityId: string; rule: PremiumRule; index: number } | null>(null);

  async function save(entity: Entity, next: PremiumRule[]) {
    if (!onSave) return;
    if (await onSave(entity.id, next)) setEditing(null);
  }

  return (
    <section className="premiums">
      <div className="people-bar">
        <h3 className="section-title">Pay premiums</h3>
      </div>
      <p className="muted small">
        Enhanced rates in each company's contracts for hourly staff. They are costed into every shift, the rota P&amp;L and the labour
        accrual, and go to TeamPay as premium lines on top of the hours, so the payslip shows them. Where two apply to the same hour,
        only the higher is paid. Salaried staff are not affected.
        {!onSave && ' Only someone who approves pay can change them.'}
      </p>
      {entities.map((entity) => {
        const rules = entity.premiums ?? [];
        return (
          <div key={entity.id} className="premium-company">
            <div className="people-bar">
              <strong>{entity.name}</strong>
              {onSave && (
                <div className="people-actions">
                  <button onClick={() => setEditing({ entityId: entity.id, index: -1, rule: { id: '', name: 'Sunday', kind: 'day', multiplier: 1.5, weekdays: [6] } })}>
                    Add a premium
                  </button>
                </div>
              )}
            </div>
            {rules.length === 0 ? (
              <p className="muted small">No premiums: every hour is paid at the normal rate.</p>
            ) : (
              <ul className="premium-list">
                {rules.map((rule, i) => (
                  <li key={rule.id}>
                    <span>
                      <strong>{rule.name}</strong>: {describeRule(rule)}
                      {rule.roleIds?.length ? <span className="muted"> ({rule.roleIds.map((id) => roles.find((r) => r.id === id)?.name ?? id).join(', ')})</span> : null}
                    </span>
                    {onSave && (
                      <span className="people-actions">
                        <button className="link" onClick={() => setEditing({ entityId: entity.id, index: i, rule })}>Edit</button>
                        <button className="link" onClick={() => void save(entity, rules.filter((_, j) => j !== i))}>Remove</button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {editing?.entityId === entity.id && (
              <RuleEditor
                rule={editing.rule}
                roles={roles}
                onCancel={() => setEditing(null)}
                onSave={(rule) =>
                  void save(entity, editing.index < 0 ? [...rules, rule] : rules.map((r, j) => (j === editing.index ? rule : r)))
                }
              />
            )}
          </div>
        );
      })}
    </section>
  );
}

function RuleEditor({ rule, roles, onSave, onCancel }: { rule: PremiumRule; roles: Role[]; onSave: (r: PremiumRule) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<PremiumRule>(rule);
  const [basis, setBasis] = useState<'multiplier' | 'perHour'>(typeof rule.perHour === 'number' ? 'perHour' : 'multiplier');
  const set = (patch: Partial<PremiumRule>) => setDraft((d) => ({ ...d, ...patch }));

  function submit() {
    const { multiplier, perHour, ...rest } = draft;
    const rate = basis === 'multiplier' ? { multiplier: multiplier ?? 1.5 } : { perHour: perHour ?? 1 };
    // Only the fields the kind uses are sent; the server rejects the rest.
    onSave({
      ...(rest.id ? { id: rest.id } : {}),
      name: rest.name,
      kind: rest.kind,
      ...rate,
      ...(rest.kind === 'day' ? { weekdays: rest.weekdays ?? [] } : {}),
      ...(rest.kind === 'night' ? { fromMinute: rest.fromMinute ?? 1320, toMinute: rest.toMinute ?? 360 } : {}),
      ...(rest.kind === 'overtime' && typeof rest.afterHours === 'number' ? { afterHours: rest.afterHours } : {}),
      ...(rest.roleIds?.length ? { roleIds: rest.roleIds } : {}),
    } as PremiumRule);
  }

  return (
    <div className="form premium-form">
      <label>
        Name
        <input value={draft.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label>
        Pays for
        <select value={draft.kind} onChange={(e) => set({ kind: e.target.value as PremiumRule['kind'] })}>
          {Object.entries(PREMIUM_KINDS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </label>
      <label>
        Rate
        <select value={basis} onChange={(e) => setBasis(e.target.value as typeof basis)}>
          <option value="multiplier">A multiple of the normal rate</option>
          <option value="perHour">A fixed amount per hour on top</option>
        </select>
      </label>
      {basis === 'multiplier' ? (
        <label>
          Multiple
          <select value={draft.multiplier ?? 1.5} onChange={(e) => set({ multiplier: Number(e.target.value) })}>
            {[1.1, 1.25, 1.33, 1.5, 1.75, 2, 2.5, 3].map((m) => <option key={m} value={m}>{m === 1.5 ? '1.5 (time and a half)' : m === 2 ? '2 (double time)' : m}</option>)}
          </select>
        </label>
      ) : (
        <label>
          £ per hour on top
          <input type="number" min={0} max={50} step={0.05} value={draft.perHour ?? 1} onChange={(e) => set({ perHour: Number(e.target.value) })} />
        </label>
      )}
      {draft.kind === 'day' && (
        <fieldset className="days">
          <legend>Days</legend>
          {DAYS.map((d, i) => (
            <label key={d} className="check">
              <input
                type="checkbox"
                checked={(draft.weekdays ?? []).includes(i)}
                onChange={(e) => set({ weekdays: e.target.checked ? [...(draft.weekdays ?? []), i] : (draft.weekdays ?? []).filter((x) => x !== i) })}
              />
              {d}
            </label>
          ))}
        </fieldset>
      )}
      {draft.kind === 'night' && (
        <>
          <label>
            From
            <input type="time" value={formatMinute(draft.fromMinute ?? 1320)} onChange={(e) => set({ fromMinute: parseClock(e.target.value) })} />
          </label>
          <label>
            Until
            <input type="time" value={formatMinute(draft.toMinute ?? 360)} onChange={(e) => set({ toMinute: parseClock(e.target.value) })} />
          </label>
        </>
      )}
      {draft.kind === 'overtime' && (
        <label>
          After weekly hours
          <input
            type="number"
            min={0}
            max={100}
            placeholder="Contracted hours"
            value={draft.afterHours ?? ''}
            onChange={(e) => set({ afterHours: e.target.value === '' ? undefined : Number(e.target.value) })}
          />
        </label>
      )}
      {draft.kind === 'bank_holiday' && <p className="hint">England and Wales bank holidays, substitute days included.</p>}
      <fieldset className="days">
        <legend>Roles (none ticked means every role)</legend>
        {roles.map((r) => (
          <label key={r.id} className="check">
            <input
              type="checkbox"
              checked={(draft.roleIds ?? []).includes(r.id)}
              onChange={(e) => set({ roleIds: e.target.checked ? [...(draft.roleIds ?? []), r.id] : (draft.roleIds ?? []).filter((x) => x !== r.id) })}
            />
            {r.name}
          </label>
        ))}
      </fieldset>
      <div className="modal-actions">
        <span className="spacer" />
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={!draft.name.trim()} onClick={submit}>Save premium</button>
      </div>
    </div>
  );
}
