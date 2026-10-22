import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { roleOf } from '../engine/access';
import { api, ApiError } from './api';

// Clients, for Williams, Stanley & Co.: every client organisation this person holds a WS role in,
// how far each is through onboarding, and what needs attention; and, for a client partner, adding a
// new client. A new client is an organisation of its own with an owner invited by email. From then
// on the client runs its own access: WS never appoints inside a client business.

interface ClientStep { code: string; label: string; done: boolean }

export interface ClientSummary {
  orgId: string;
  name: string;
  current: boolean;
  roles: string[];
  stage: 'invited' | 'setting-up' | 'live';
  owner: { name: string; status: 'active' | 'invited' | 'expired' } | null;
  companies: number;
  sites: number;
  people: number;
  starters: number;
  notInPayroll: number;
  accounts: { active: number; invited: number };
  emailReady: boolean;
  lastActivity: string | null;
  steps: ClientStep[];
  attention: string[];
  /** Nobody at the client has signed in yet, and nothing is set up: a client partner may remove it. */
  removable: boolean;
}

const STAGE: Record<ClientSummary['stage'], { label: string; tone: string }> = {
  invited: { label: 'Owner invited', tone: 'warn' },
  'setting-up': { label: 'Setting up', tone: 'warn' },
  live: { label: 'Live', tone: 'good' },
};

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Never');

/** Moves the session to the client, then starts the app there, as the switcher in the header does. */
async function openClient(orgId: string) {
  const res = await fetch('/auth/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId }) });
  if (res.ok) location.assign('/app/');
  else throw new Error((await res.json().catch(() => null))?.message ?? 'Could not open that client.');
}

export function ClientsView() {
  const [clients, setClients] = useState<ClientSummary[] | null>(null);
  const [canAdd, setCanAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', ownerName: '', ownerEmail: '' });
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const body = await api.get<{ clients: ClientSummary[]; canAdd: boolean }>('/v1/clients');
      setClients(body.clients);
      setCanAdd(body.canAdd);
    } catch (e) {
      setClients([]);
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function add(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      const res = await api.post<{ client: ClientSummary; emailed: boolean; emailProblem?: string; expiresAt: string }>('/v1/clients', form);
      setNotice(
        res.emailed
          ? `${res.client.name} is set up. ${form.ownerName} has been emailed an invitation to become its owner, valid until ${day(res.expiresAt)}.`
          : `${res.client.name} is set up, but the invitation did not go. ${res.emailProblem ?? ''}`,
      );
      setForm({ name: '', ownerName: '', ownerEmail: '' });
      setAdding(false);
      await refresh();
    });
  }

  function resend(c: ClientSummary) {
    void run(async () => {
      const res = await api.post<{ emailed: boolean; emailProblem?: string; expiresAt: string }>(`/v1/clients/${encodeURIComponent(c.orgId)}/owner-invite`);
      setNotice(res.emailed ? `A new invitation has gone to ${c.owner?.name}, valid until ${day(res.expiresAt)}.` : res.emailProblem ?? 'The email did not go.');
      await refresh();
    });
  }

  function remove(c: ClientSummary) {
    if (!confirm(`Remove ${c.name}? ${c.owner ? `${c.owner.name}'s invitation stops working and ` : ''}it leaves your list. Its record and audit trail are kept.`)) return;
    void run(async () => {
      await api.del(`/v1/clients/${encodeURIComponent(c.orgId)}`);
      setOpen(null);
      setNotice(`${c.name} has been removed.`);
      await refresh();
    });
  }

  const list = clients ?? [];
  const visible = list.filter((c) => !query || c.name.toLowerCase().includes(query.toLowerCase()));
  const live = list.filter((c) => c.stage === 'live').length;
  const onboarding = list.filter((c) => c.stage !== 'live').length;
  const attention = list.filter((c) => c.attention.length > 0).length;
  const starters = list.reduce((n, c) => n + c.starters, 0);

  return (
    <div className="clients">
      <p className="muted small">
        Every client you hold a Williams, Stanley & Co. role in. Each client is a separate organisation: what you see here is counts and
        progress only, and nobody at a client can see this list or learn who else you work for.
      </p>
      <div className="kpis people-kpis">
        <div className="kpi">
          <div className="kpi-label">Clients</div>
          <div className="kpi-value">{list.length}</div>
          <div className="kpi-hint">{live} live</div>
        </div>
        <div className={`kpi ${onboarding ? 'warn' : 'good'}`}>
          <div className="kpi-label">Onboarding</div>
          <div className="kpi-value">{onboarding}</div>
          <div className="kpi-hint">Owner invited or still setting up</div>
        </div>
        <div className={`kpi ${attention ? 'bad' : 'good'}`}>
          <div className="kpi-label">Need attention</div>
          <div className="kpi-value">{attention}</div>
          <div className="kpi-hint">Expired invitations, payroll gaps, gone quiet</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">New starters</div>
          <div className="kpi-value">{starters}</div>
          <div className="kpi-hint">Across every client, next 60 days and last 90</div>
        </div>
      </div>

      {error && <p className="bad-text small" role="alert">{error}</p>}
      {notice && <p className="good-text small" role="status">{notice}</p>}

      {canAdd && (
        <section className="panel client-add">
          <div className="panel-head">
            <div>
              <div className="panel-title">Add a client</div>
              <div className="panel-sub">A new organisation with you as its client partner, and its owner invited by email.</div>
            </div>
            {!adding && <button className="primary" onClick={() => setAdding(true)}>Add a client</button>}
          </div>
          {adding && (
            <form className="panel-body form" onSubmit={add}>
              <label className="span2">
                Client's trading company
                <input required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Harbour Kitchens Ltd" />
              </label>
              <label>
                Owner's name
                <input required maxLength={120} value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} />
              </label>
              <label>
                Owner's email
                <input required type="email" maxLength={254} value={form.ownerEmail} onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })} />
              </label>
              <div className="span2 muted small">
                What happens: the client is created with you as its WS client partner. The owner is emailed a link, valid seven days, to
                choose their own password; nobody at WS ever sees or holds it. Once they accept, the owner runs set-up (companies, sites,
                roles, trading week, team) and invites their own people, including the rest of the WS team. Needs email set up under Settings.
              </div>
              <div className="span2 row-actions">
                <button type="submit" className="primary" disabled={busy}>Create client and invite owner</button>
                <button type="button" onClick={() => setAdding(false)} disabled={busy}>Cancel</button>
              </div>
            </form>
          )}
        </section>
      )}

      <div className="people-bar">
        <h3 className="section-title">Your clients</h3>
        <div className="people-actions">
          <input type="search" placeholder="Search clients" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search clients" />
        </div>
      </div>

      {clients === null ? (
        <p className="muted small">Loading clients.</p>
      ) : visible.length === 0 ? (
        <p className="muted">{list.length === 0 ? 'You hold no Williams, Stanley & Co. role in a client yet.' : 'No client matches.'}</p>
      ) : (
        <div className="grid-wrap">
          <table className="table people clients-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Stage</th>
                <th>Onboarding</th>
                <th className="num">Sites</th>
                <th className="num">People</th>
                <th className="num">Starters</th>
                <th>Last change</th>
                <th>Attention</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => {
                const done = c.steps.filter((s) => s.done).length;
                const expanded = open === c.orgId;
                const toggle = () => setOpen(expanded ? null : c.orgId);
                return [
                  <tr key={c.orgId} className="clickable" tabIndex={0} aria-expanded={expanded} onClick={toggle} onKeyDown={(ev) => { if (ev.key === 'Enter') toggle(); }}>
                    <td>
                      <span className="strong">{c.name}</span>
                      <div className="muted small">{c.roles.map((r) => roleOf(r)?.name ?? r).join(', ')}{c.current ? ' (open now)' : ''}</div>
                    </td>
                    <td><span className={`badge ${STAGE[c.stage].tone}`}>{STAGE[c.stage].label}</span></td>
                    <td>
                      <div className="onboarding-progress" aria-label={`${done} of ${c.steps.length} steps done`}>
                        <span style={{ width: `${(done / c.steps.length) * 100}%` }} className={done === c.steps.length ? 'good' : 'warn'} />
                      </div>
                      <div className="muted small">{done} of {c.steps.length}</div>
                    </td>
                    <td className="num">{c.sites}</td>
                    <td className="num">{c.people}</td>
                    <td className="num">{c.starters || '-'}</td>
                    <td className="muted">{day(c.lastActivity)}</td>
                    <td className={c.attention.length ? 'bad-text' : 'muted'}>{c.attention[0] ?? 'None'}{c.attention.length > 1 ? ` and ${c.attention.length - 1} more` : ''}</td>
                  </tr>,
                  expanded && (
                    <tr key={`${c.orgId}-detail`} className="onboarding-detail">
                      <td colSpan={8}>
                        <div className="client-detail">
                          <ol className="onboarding-steps">
                            {c.steps.map((s) => (
                              <li key={s.code} className={s.done ? 'done' : 'todo'}>
                                <span className={`badge ${s.done ? 'good' : 'warn'}`}>{s.done ? 'Done' : 'To do'}</span>
                                <span className="strong">{s.label}</span>
                              </li>
                            ))}
                          </ol>
                          <dl className="facts">
                            <dt>Owner</dt>
                            <dd>{c.owner ? `${c.owner.name}, ${c.owner.status === 'active' ? 'signed in' : c.owner.status === 'expired' ? 'invitation expired' : 'invitation waiting'}` : 'None on record'}</dd>
                            <dt>Companies</dt>
                            <dd>{c.companies}</dd>
                            <dt>Accounts</dt>
                            <dd>{c.accounts.active} active, {c.accounts.invited} invited</dd>
                            <dt>Not in payroll</dt>
                            <dd className={c.notInPayroll ? 'warn-text' : undefined}>{c.notInPayroll}</dd>
                            <dt>Email</dt>
                            <dd>{c.emailReady ? 'Set up' : 'Not set up'}</dd>
                          </dl>
                          {c.attention.length > 0 && (
                            <ul className="issues">
                              {c.attention.map((a) => <li key={a} className="warn">{a}</li>)}
                            </ul>
                          )}
                          <div className="row-actions">
                            {!c.current && <button className="primary" disabled={busy} onClick={() => void run(() => openClient(c.orgId))}>Open {c.name}</button>}
                            {canAdd && c.owner && c.owner.status !== 'active' && c.roles.includes('ws_partner') && (
                              <button disabled={busy} onClick={() => resend(c)}>Send the owner a new invitation</button>
                            )}
                            {canAdd && c.removable && c.roles.includes('ws_partner') && !c.current && (
                              <button className="danger" disabled={busy} onClick={() => remove(c)}>Remove client</button>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
