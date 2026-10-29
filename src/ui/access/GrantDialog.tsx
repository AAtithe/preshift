import { useMemo, useState } from 'react';
import {
  AUDIENCE_LABEL, authorityErrors, checkGrant, PERMISSIONS, ROLES, type Audience, type User,
} from '../../engine/access';
import type { RotaState } from '../../engine/types';
import { api, ApiError } from '../api';
import { actorOf, today, type Delivery, type Me } from './model';

interface Props {
  state: RotaState;
  me: Me;
  users: User[];
  /** Grant to this person; without one, the dialog invites somebody new. */
  target?: User;
  onDone: (result: { user: User; expiresAt?: string } & Delivery) => void;
  onClose: () => void;
}

export function GrantDialog({ state, me, users, target, onDone, onClose }: Props) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [audience, setAudience] = useState<Audience>(target?.audience ?? (me.user?.audience === 'ws' ? 'ws' : 'operator'));
  const [employeeId, setEmployeeId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [starts, setStarts] = useState(today());
  const [ends, setEnds] = useState('');
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const actor = actorOf(me);
  const side = target?.audience ?? audience;
  const role = ROLES.find((r) => r.id === roleId);
  const person: User = target ?? {
    id: 'new', email, name: name || 'This person', audience: side, status: 'invited', mfaEnrolled: false, createdAt: today(), memberships: [],
  };
  const existing = !target && email.trim() ? users.find((u) => u.email === email.trim().toLowerCase()) : undefined;

  // Roles this actor could give this person somewhere, so the list only offers real choices.
  const offered = useMemo(
    () =>
      ROLES.filter((r) => r.audience === side).map((r) => ({
        role: r,
        blocked: authorityErrors(actor, person, r, { roleId: r.id, siteIds: r.scope === 'sites' ? mySites(me, state) : null, starts: today() }, today())[0],
      })),
    [side, me, target?.id],
  );

  const check = role
    ? checkGrant(actor, person, { roleId, siteIds: role.scope === 'sites' ? siteIds : null, starts, ends: ends || undefined }, today(), state.sites.map((s) => s.id))
    : null;
  const detailsMissing = !target && (!name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()));
  const ready = !!check && check.errors.length === 0 && (check.warnings.length === 0 || accept) && !detailsMissing && !existing;

  async function submit() {
    if (!role) return;
    setBusy(true);
    setError(null);
    const grant = { roleId, siteIds: role.scope === 'sites' ? siteIds : null, starts, ends: ends || undefined, acceptWarnings: accept || undefined };
    try {
      if (target) {
        await api.post(`/v1/users/${target.id}/grants`, grant);
        onDone({ user: await api.get<User>(`/v1/users/${target.id}`) });
      } else {
        const res = await api.post<{ user: User; expiresAt: string } & Delivery>('/v1/users', {
          email: email.trim(), name: name.trim(), jobTitle: jobTitle.trim() || undefined, audience, employeeId: employeeId || undefined, ...grant,
        });
        onDone(res);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" role="dialog" aria-label={target ? `Grant a role to ${target.name}` : 'Invite a person'} onClick={(e) => e.stopPropagation()}>
        <h2>{target ? `Grant ${target.name} a role` : 'Invite a person'}</h2>
        <p className="muted small">
          You can grant up to what you hold yourself, never to yourself. Every grant is checked for paired duties and recorded in the audit trail.
        </p>

        <div className="grant-steps">
          <section className="card">
            <h3>1. Who</h3>
            {target ? (
              <p>
                <strong>{target.name}</strong> <span className="muted">{target.email}, {AUDIENCE_LABEL[target.audience]}</span>
              </p>
            ) : (
              <div className="form">
                <label>Name<input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
                <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
                <label>Job title<input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="Optional" /></label>
                <label>
                  Works for
                  <select value={audience} onChange={(e) => { setAudience(e.target.value as Audience); setRoleId(''); }}>
                    <option value="operator">The operator</option>
                    <option value="ws">Accounting partner</option>
                    <option value="external">Outside (auditor, investor)</option>
                  </select>
                </label>
                {audience === 'operator' && (
                  <label className="span2">
                    Their record on the rota
                    <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                      <option value="">Does not work shifts</option>
                      {state.sites.map((s) => (
                        <optgroup key={s.id} label={s.name}>
                          {state.employees.filter((x) => x.siteId === s.id && x.status !== 'leaver').map((x) => (
                            <option key={x.id} value={x.id}>{x.name}</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <span className="hint">Linking it lets Preshift stop them approving their own hours.</span>
                  </label>
                )}
                {existing && <p className="bad-text span2">There is already an account for this email: {existing.name}. Open them and grant a role instead.</p>}
              </div>
            )}
          </section>

          <section className="card">
            <h3>2. What</h3>
            <div className="form">
              <label className="span2">
                Role
                <select value={roleId} onChange={(e) => { setRoleId(e.target.value); setAccept(false); }}>
                  <option value="">Choose a role</option>
                  {offered.map(({ role: r, blocked }) => (
                    <option key={r.id} value={r.id} disabled={!!blocked} title={blocked}>
                      {r.name}{r.scope === 'sites' ? ' (per site)' : ''}{blocked ? ' (not yours to grant)' : ''}
                    </option>
                  ))}
                </select>
                {role && <span className="hint">{role.about}</span>}
              </label>
              {role?.scope === 'sites' && (
                <fieldset className="span2 site-picks">
                  <legend>Sites</legend>
                  {state.sites.map((s) => (
                    <label key={s.id} className="check">
                      <input
                        type="checkbox"
                        checked={siteIds.includes(s.id)}
                        onChange={(e) => setSiteIds(e.target.checked ? [...siteIds, s.id] : siteIds.filter((x) => x !== s.id))}
                      />
                      {s.name}
                    </label>
                  ))}
                </fieldset>
              )}
              <label>From<input type="date" value={starts} min={today()} onChange={(e) => setStarts(e.target.value)} /></label>
              <label>
                Until{role?.requiresEnd ? ' (required)' : ''}
                <input type="date" value={ends} min={starts} onChange={(e) => setEnds(e.target.value)} />
              </label>
            </div>
          </section>

          <section className="card">
            <h3>3. What the checks say</h3>
            {!check && <p className="muted">Choose a role to see what it gives and whether it passes.</p>}
            {check && (
              <>
                {check.errors.length === 0 && check.warnings.length === 0 && <p className="good-text">Passes every check.</p>}
                <ul className="issues">
                  {check.errors.map((e) => <li key={e} className="block">{e}</li>)}
                  {check.warnings.map((w) => <li key={w} className="warn">{w}</li>)}
                </ul>
                {check.warnings.length > 0 && check.errors.length === 0 && (
                  <label className="check accept">
                    <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
                    I accept this pairing. The reason is kept with the grant and shown in every access review.
                  </label>
                )}
                {check.gains.length > 0 && (
                  <>
                    <div className="muted small gain-head">{person.name} would gain</div>
                    <div className="chips">{check.gains.map((p) => <span key={p} className="chip-tag">{PERMISSIONS[p].label}</span>)}</div>
                  </>
                )}
                {role?.mfa && <p className="muted small">This role needs an authenticator. Its payroll, pay and access rights stay off until they set one up.</p>}
              </>
            )}
          </section>
        </div>

        {error && <div className="notice error">{error}</div>}
        <div className="modal-actions">
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!ready || busy} onClick={() => void submit()}>
            {target ? 'Grant' : 'Invite and grant'}
          </button>
        </div>
      </div>
    </div>
  );
}

function mySites(me: Me, state: RotaState): string[] {
  if (!me.user) return state.sites.map((s) => s.id);
  const mine = new Set<string>();
  for (const m of me.user.memberships) if (m.active) (m.siteIds ?? state.sites.map((s) => s.id)).forEach((s) => mine.add(s));
  return mine.size ? [...mine] : state.sites.map((s) => s.id);
}
