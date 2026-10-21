import { useEffect, useState } from 'react';
import {
  ALL_PERMISSIONS, AUDIENCE_LABEL, can, checkAuthority, conflictsIn, heldPermissions, PERMISSIONS, roleOf, sitesWith, type Attention, type User,
} from '../../engine/access';
import type { RotaState } from '../../engine/types';
import { api, ApiError } from '../api';
import {
  actorOf, byArea, describeEvent, endingSoon, lastSeen, reach, shortDate, signInText, siteName, STATUS_LABEL, today, type AuditRow, type Me,
} from './model';

interface Props {
  state: RotaState;
  me: Me;
  user: User;
  users: User[];
  attention: Attention[];
  canReadTrail: boolean;
  onGrant: () => void;
  onChanged: (message?: string) => Promise<void>;
  onClose: () => void;
}

export function PersonPanel({ state, me, user, users, attention, canReadTrail, onGrant, onChanged, onClose }: Props) {
  const [trail, setTrail] = useState<AuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [extending, setExtending] = useState<{ id: string; ends: string } | null>(null);
  const isMe = me.user?.id === user.id;
  const actor = actorOf(me);
  const authority = checkAuthority(actor, user, users, today());
  const mine = attention.filter((a) => a.userId === user.id);
  const held = heldPermissions(user, today());
  const employee = state.employees.find((e) => e.id === user.employeeId);
  const sign = signInText(user);

  useEffect(() => {
    if (!canReadTrail) return;
    void api.get<AuditRow[]>(`/v1/access/audit?userId=${user.id}`).then(setTrail).catch(() => setTrail([]));
  }, [user, canReadTrail]);

  async function act(label: string, fn: () => Promise<unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setError(null);
    try {
      const res = (await fn()) as { inviteUrl?: string } | undefined;
      await onChanged(res?.inviteUrl ? `${label}. Send them this link, which works once: ${location.origin}${res.inviteUrl}` : label);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `${label} failed`);
    }
  }

  const reachOf = (p: (typeof ALL_PERMISSIONS)[number]) => {
    const s = sitesWith(user, p, today());
    return s === 'all' ? 'Every site' : s.map((id) => siteName(state, id)).join(', ');
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label={user.name} onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <h2>{user.name}</h2>
            <div className="muted">{user.email}{user.jobTitle ? `, ${user.jobTitle}` : ''}</div>
            <div className="chips">
              <span className={`pill status-${user.status}`}>{STATUS_LABEL[user.status]}</span>
              <span className="pill">{AUDIENCE_LABEL[user.audience]}</span>
              <span className={`pill tone-${sign.tone}`}>{sign.text}</span>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close">Close</button>
        </header>

        {isMe && <div className="notice">This is you. Somebody else changes your own access, so nobody can widen their own rights and the organisation is never locked out by accident.</div>}
        {!isMe && authority && <div className="notice">{authority}</div>}
        {error && <div className="notice error">{error}</div>}

        <dl className="facts">
          <div><dt>Last seen</dt><dd>{lastSeen(user)}</dd></div>
          <div><dt>Joined</dt><dd>{user.activatedAt ? shortDate(user.activatedAt) : 'Not yet'}</dd></div>
          <div><dt>Invited by</dt><dd>{user.invitedBy ?? 'Set-up'}</dd></div>
          <div><dt>On the rota</dt><dd>{employee ? `${employee.name}, ${siteName(state, employee.siteId)}` : 'No'}</dd></div>
        </dl>

        {mine.length > 0 && (
          <ul className="issues">
            {mine.map((a, i) => <li key={i} className={a.severity === 'info' ? '' : a.severity}>{a.message}</li>)}
          </ul>
        )}

        <h3>Roles</h3>
        <table className="table">
          <thead>
            <tr><th>Role</th><th>Reaches</th><th>From</th><th>Until</th><th>Granted</th><th /></tr>
          </thead>
          <tbody>
            {user.memberships.filter((m) => m.active).map((m) => {
              const role = roleOf(m.roleId);
              const changeable = !isMe && !checkAuthority(actor, user, users, today(), { membershipId: m.id });
              return (
                <tr key={m.id}>
                  <td>
                    <strong>{role?.name ?? m.roleId}</strong>
                    {role?.mfa && <div className="muted small">Authenticator required</div>}
                    {m.note && <div className="warn-text small">{m.note}</div>}
                  </td>
                  <td>{reach(state, m.siteIds)}</td>
                  <td>{shortDate(m.starts)}</td>
                  <td>
                    {extending?.id === m.id ? (
                      <span className="inline-edit">
                        <input type="date" value={extending.ends} min={today()} onChange={(e) => setExtending({ id: m.id, ends: e.target.value })} />
                        <button className="primary" onClick={() => void act('End date changed', () => api.patch(`/v1/users/${user.id}/grants/${m.id}`, { ends: extending.ends })).then(() => setExtending(null))}>Save</button>
                      </span>
                    ) : (
                      <>
                        {m.ends ? shortDate(m.ends) : 'Open'}
                        {m.ends && m.ends < today() && <span className="tag bad">Ended</span>}
                        {endingSoon(m.ends) && <span className="tag">Ends soon</span>}
                      </>
                    )}
                  </td>
                  <td className="muted small">{m.grantedBy}<br />{shortDate(m.grantedAt)}</td>
                  <td className="row-actions">
                    {changeable && <button className="link" onClick={() => setExtending({ id: m.id, ends: m.ends ?? today() })}>{m.ends ? 'Change end' : 'Set end'}</button>}
                    {changeable && (
                      <button
                        className="link danger"
                        onClick={() => void act(`${role?.name} removed`, () => api.del(`/v1/users/${user.id}/grants/${m.id}`), `Remove ${user.name}'s ${role?.name} (${reach(state, m.siteIds)})? It takes effect now.`)}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {user.memberships.every((m) => !m.active) && (
              <tr><td colSpan={6} className="muted">No roles. A person with no role can see nothing.</td></tr>
            )}
          </tbody>
        </table>

        {!isMe && (
          <div className="panel-actions">
            {user.status !== 'suspended' && <button className="primary" onClick={onGrant}>Grant another role</button>}
            {user.status === 'invited' && (
              <>
                <button onClick={() => void act('Invitation sent again', () => api.post(`/v1/users/${user.id}/resend-invite`))}>Resend invitation</button>
                <button className="danger" onClick={() => void act('Invitation withdrawn', () => api.del(`/v1/users/${user.id}/invite`).then(onClose), `Withdraw ${user.name}'s invitation? Their account is removed.`)}>Withdraw invitation</button>
              </>
            )}
            {user.mfaEnrolled && (
              <button onClick={() => void act('Authenticator reset', () => api.post(`/v1/users/${user.id}/reset-authenticator`), `Reset ${user.name}'s authenticator? Their strong rights stop until they enrol again. Only do this once you have confirmed who they are by phone or in person.`)}>
                Reset authenticator
              </button>
            )}
            {user.status === 'suspended' ? (
              <button onClick={() => void act(`${user.name} reactivated`, () => api.post(`/v1/users/${user.id}/reactivate`))}>Reactivate</button>
            ) : (
              <button className="danger" onClick={() => void act(`${user.name} suspended`, () => api.post(`/v1/users/${user.id}/suspend`), `Suspend ${user.name}? They lose all access now. Their roles are kept, so reactivating restores them.`)}>
                Suspend
              </button>
            )}
            {user.audience === 'operator' && (
              <label className="inline-select">
                Rota record
                <select
                  value={user.employeeId ?? ''}
                  onChange={(e) => void act('Rota link changed', () => api.patch(`/v1/users/${user.id}`, { employeeId: e.target.value || null }))}
                >
                  <option value="">Not linked</option>
                  {state.employees.filter((x) => x.status !== 'leaver').map((x) => <option key={x.id} value={x.id}>{x.name}, {siteName(state, x.siteId)}</option>)}
                </select>
              </label>
            )}
          </div>
        )}

        <h3>What they can do</h3>
        {held.size === 0 ? (
          <p className="muted">Nothing.</p>
        ) : (
          <div className="can-grid">
            {byArea(ALL_PERMISSIONS.filter((p) => held.has(p))).map(([area, perms]) => (
              <div key={area} className="can-area">
                <div className="can-area-name">{area}</div>
                <ul>
                  {perms.map((p) => {
                    const on = can(user, p, today());
                    return (
                      <li key={p} className={on ? '' : 'off'}>
                        {PERMISSIONS[p].label}
                        <span className="muted small"> {on ? reachOf(p) : user.status !== 'active' ? `(off while ${user.status})` : '(off until they set up an authenticator)'}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
        {conflictsIn(held).length > 0 && <p className="warn-text small">Holds paired duties. See the notes on their roles and the Paired duties page.</p>}

        {canReadTrail && (
          <>
            <h3>History</h3>
            {trail.length === 0 ? (
              <p className="muted small">Nothing recorded since the API started. Set-up grants predate the trail.</p>
            ) : (
              <ul className="timeline">
                {trail.map((e, i) => {
                  const d = describeEvent(e, users, state);
                  return (
                    <li key={i}>
                      <span className="muted small">{new Date(e.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                      <span><strong>{d.what}</strong> by {e.actor}{d.detail ? `: ${d.detail}` : ''}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
