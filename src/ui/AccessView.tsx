import { useEffect, useState, type FormEvent } from 'react';
import type { RotaState } from '../engine/types';
import { api, type Role } from './api';

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, every site. Cannot edit the tronc scheme.',
  finance: 'Sees everything, approves clockings, pays tips. Cannot change the rota.',
  gm: 'Runs the rota, the clock and the cut call for their sites.',
  troncmaster: 'Sets the tronc points and allocation for their site, and nothing else.',
  staff: 'Their own published shifts and clocking in.',
};

/** Who has access, and invites for new people. Owners only. */
export function AccessView({ state }: { state: RotaState }) {
  const [members, setMembers] = useState<Awaited<ReturnType<typeof api.members>>['members']>([]);
  const [form, setForm] = useState({ email: '', role: 'gm' as Role, siteIds: [] as string[], employeeId: '' });
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.members().then((r) => setMembers(r.members), (e: Error) => setError(e.message));
  }, [link]);

  const needsEmployee = form.role === 'staff' || form.role === 'troncmaster';
  const allSites = form.role === 'owner' || form.role === 'finance';

  async function invite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const { token } = await api.invite(form.email, form.role, allSites ? null : form.siteIds, needsEmployee ? form.employeeId : null);
      setLink(`${location.origin}${location.pathname}#invite=${token}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const siteName = (id: string) => state.sites.find((s) => s.id === id)?.name ?? id;

  return (
    <div className="bench-grid">
      <div className="panel">
        <h3>Who has access</h3>
        <div className="grid-wrap flat">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Sites</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.email}>
                  <td>
                    {m.name}
                    <div className="muted small">{m.email}</div>
                  </td>
                  <td>{m.role}</td>
                  <td>{m.siteIds ? m.siteIds.map(siteName).join(', ') : 'All'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <form className="panel" onSubmit={invite}>
        <h3>Invite someone</h3>
        <div className="form one">
          <label>
            Email
            <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label>
            Role
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {(Object.keys(ROLE_HELP) as Role[]).map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </label>
          <div className="hint">{ROLE_HELP[form.role]}</div>
          {!allSites && (
            <fieldset className="sites">
              <legend>Sites</legend>
              {state.sites.map((s) => (
                <label key={s.id} className="inline">
                  <input
                    type="checkbox"
                    checked={form.siteIds.includes(s.id)}
                    onChange={(e) =>
                      setForm({ ...form, siteIds: e.target.checked ? [...form.siteIds, s.id] : form.siteIds.filter((x) => x !== s.id) })
                    }
                  />
                  {s.name}
                </label>
              ))}
            </fieldset>
          )}
          {needsEmployee && (
            <label>
              Their employee record
              <select required value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
                <option value="">Choose</option>
                {state.employees
                  .filter((e) => form.siteIds.length === 0 || form.siteIds.includes(e.siteId))
                  .map((e) => (
                    <option key={e.id} value={e.id}>{e.name}</option>
                  ))}
              </select>
            </label>
          )}
        </div>
        {error && <div className="notice bad small">{error}</div>}
        {link && (
          <div className="notice small">
            Send this link to them. It works once and expires in seven days.
            <input readOnly value={link} onFocus={(e) => e.target.select()} className="link-box" />
          </div>
        )}
        <div className="modal-actions">
          <span className="spacer" />
          <button className="primary" disabled={!allSites && form.siteIds.length === 0}>Create invite</button>
        </div>
      </form>
    </div>
  );
}
