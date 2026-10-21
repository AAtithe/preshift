import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AUDIENCE_LABEL, can, canOrgWide, CONFLICTS, conflictsIn, heldPermissions, holders, live, ORG_DUTIES, PERMISSIONS, roleOf, ROLES,
  SITE_DUTIES, type AccessReview, type AttentionKind, type Audience, type User,
} from '../../engine/access';
import type { RotaState } from '../../engine/types';
import { api, ApiError } from '../api';
import { download } from '../format';
import { GrantDialog } from './GrantDialog';
import {
  byArea, csvOfAccess, describeEvent, endingSoon, healthOf, lastSeen, reach, shortDate, signInState, signInText, STATUS_LABEL, today,
  deliveryText, fullLink, type AuditRow, type Delivery, type Me,
} from './model';
import { PersonPanel } from './PersonPanel';

type Page = 'overview' | 'people' | 'roles' | 'coverage' | 'duties' | 'trail' | 'reviews';

const NAV: { group: string; pages: { id: Page; label: string }[] }[] = [
  { group: 'Health', pages: [{ id: 'overview', label: 'Overview' }, { id: 'coverage', label: 'Site coverage' }] },
  { group: 'Directory', pages: [{ id: 'people', label: 'People' }, { id: 'roles', label: 'Roles' }] },
  { group: 'Controls', pages: [{ id: 'duties', label: 'Paired duties' }, { id: 'reviews', label: 'Access reviews' }, { id: 'trail', label: 'Audit trail' }] },
];

type Filter = 'all' | 'active' | 'invited' | 'suspended' | AttentionKind | 'ending';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Everybody' },
  { id: 'active', label: 'Active' },
  { id: 'invited', label: 'Invited' },
  { id: 'suspended', label: 'Suspended' },
  { id: 'must_enrol', label: 'Must enrol' },
  { id: 'ending', label: 'Ending soon' },
  { id: 'paired_warn', label: 'Paired duties' },
  { id: 'self_approval', label: 'Approve own hours' },
  { id: 'dormant', label: 'Dormant' },
];

type Sort = 'name' | 'seen' | 'status' | 'attention';

interface Props {
  state: RotaState;
}

export function AccessView({ state }: Props) {
  const [me, setMe] = useState<Me | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [reviews, setReviews] = useState<AccessReview[]>([]);
  const [trail, setTrail] = useState<AuditRow[]>([]);
  const [page, setPage] = useState<Page>('overview');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [siteFilter, setSiteFilter] = useState('');
  const [sideFilter, setSideFilter] = useState<'' | Audience>('');
  const [sort, setSort] = useState<Sort>('attention');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [granting, setGranting] = useState<{ target?: User } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [unrecorded, setUnrecorded] = useState<string[]>([]);

  const auditor = !!me && (!me.user || can(me.user, 'audit.view', today()) || canOrgWide(me.user, 'users.manage', today()));

  const refresh = useCallback(async () => {
    try {
      const who = await api.get<Me>('/v1/me');
      setMe(who);
      setUsers(await api.get<User[]>('/v1/users'));
      setUnrecorded((await api.get<{ signInsWithoutRecord: string[] }>('/v1/access/health')).signInsWithoutRecord ?? []);
      const audits = !who.user || who.permissions.includes('audit.view') || who.permissions.includes('users.manage');
      if (audits) {
        const [rv, tr] = await Promise.all([api.get<AccessReview[]>('/v1/access/reviews'), api.get<AuditRow[]>('/v1/access/audit')]);
        setReviews(rv);
        setTrail(tr);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Cannot load access');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const attention = useMemo(() => healthOf(users, state, reviews), [users, state, reviews]);
  const flagged = (kind: AttentionKind) => new Set(attention.filter((a) => a.kind === kind).map((a) => a.userId));

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const has = (kind: AttentionKind | AttentionKind[]) => {
      const kinds = Array.isArray(kind) ? kind : [kind];
      return new Set(attention.filter((a) => kinds.includes(a.kind)).map((a) => a.userId));
    };
    const pick: Partial<Record<Filter, (u: User) => boolean>> = {
      all: () => true,
      active: (u) => u.status === 'active',
      invited: (u) => u.status === 'invited',
      suspended: (u) => u.status === 'suspended',
      ending: (u) => u.memberships.some((m) => m.active && endingSoon(m.ends)),
      paired_warn: (u) => has(['paired_warn', 'paired_block']).has(u.id),
    };
    const test = pick[filter] ?? ((u: User) => has(filter as AttentionKind).has(u.id));
    const weight = (u: User) => attention.filter((a) => a.userId === u.id && a.severity !== 'info').length;
    return users
      .filter(test)
      .filter((u) => !sideFilter || u.audience === sideFilter)
      .filter((u) => !roleFilter || u.memberships.some((m) => m.active && m.roleId === roleFilter))
      .filter((u) => !siteFilter || u.memberships.some((m) => m.active && (!m.siteIds || m.siteIds.includes(siteFilter))))
      .filter((u) => {
        if (!q) return true;
        const roles = u.memberships.filter((m) => m.active).map((m) => `${roleOf(m.roleId)?.name} ${reach(state, m.siteIds)}`).join(' ');
        return `${u.name} ${u.email} ${u.jobTitle ?? ''} ${roles}`.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        if (sort === 'seen') return (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '');
        if (sort === 'status') return a.status.localeCompare(b.status) || a.name.localeCompare(b.name);
        if (sort === 'attention') return weight(b) - weight(a) || a.name.localeCompare(b.name);
        return a.name.localeCompare(b.name);
      });
  }, [users, attention, filter, query, roleFilter, siteFilter, sideFilter, sort, state]);

  if (error && !me) return <div className="notice error">{error}</div>;
  if (!me) return <p className="muted">Loading access</p>;

  const blocks = attention.filter((a) => a.severity === 'block').length;
  const warns = attention.filter((a) => a.severity === 'warn').length;
  const open = users.find((u) => u.id === openId);
  const lastReview = reviews[0];
  const reviewAge = lastReview ? Math.round((Date.parse(today()) - Date.parse(lastReview.at.slice(0, 10))) / 86_400_000) : null;
  const canInvite = !me.user || me.permissions.includes('users.manage') || me.permissions.includes('users.sites');

  function go(f: Filter) {
    setFilter(f);
    setPage('people');
  }

  async function bulk(action: 'suspend' | 'reactivate' | 'reset-authenticator' | 'resend-invite', verb: string) {
    const ids = [...selected];
    if (action !== 'resend-invite' && !window.confirm(`${verb} ${ids.length} ${ids.length === 1 ? 'person' : 'people'}? Each is checked on its own.`)) return;
    try {
      const res = await api.post<{ done: number; failed: number; results: ({ userId: string; ok: boolean; error?: string } & Delivery)[] }>('/v1/users/bulk', { action, userIds: ids });
      const nameOf = (id: string) => users.find((u) => u.id === id)?.name;
      const why = res.results.filter((r) => !r.ok).map((r) => `${nameOf(r.userId)}: ${r.error}`);
      const emailed = res.results.filter((r) => r.emailed).length;
      // Links that could not be emailed are shown this once, to hand over.
      const toHand = res.results.filter((r) => r.inviteUrl).map((r) => `${nameOf(r.userId)}: ${fullLink(r.inviteUrl!)}`);
      setMessage(
        `${verb}: ${res.done} done${res.failed ? `, ${res.failed} refused. ${why.join(' ')}` : '.'}` +
          (emailed ? ` ${emailed} emailed.` : '') +
          (toHand.length ? ` Send these links yourself; each works once and is not shown again. ${toHand.join(' ')}` : ''),
      );
      setSelected(new Set());
      await refresh();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : `${verb} failed`);
    }
  }

  async function recordReview() {
    try {
      await api.post('/v1/access/reviews', { note: note.trim() || undefined });
      setNote('');
      setMessage('Access review recorded.');
      await refresh();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Could not record the review');
    }
  }

  const counts: Partial<Record<Filter, number>> = {
    all: users.length,
    active: users.filter((u) => u.status === 'active').length,
    invited: users.filter((u) => u.status === 'invited').length,
    suspended: users.filter((u) => u.status === 'suspended').length,
    must_enrol: flagged('must_enrol').size,
    ending: users.filter((u) => u.memberships.some((m) => m.active && endingSoon(m.ends))).length,
    paired_warn: new Set(attention.filter((a) => a.kind === 'paired_warn' || a.kind === 'paired_block').map((a) => a.userId)).size,
    self_approval: flagged('self_approval').size,
    dormant: flagged('dormant').size,
  };

  return (
    <div className="access">
      <div className={`status-bar ${blocks ? 'bad' : warns ? 'warn' : 'good'}`}>
        <strong>{blocks + warns === 0 ? 'All clear' : `${blocks + warns} things need attention`}</strong>
        <span className="muted">
          {counts.active} active, {counts.invited} invited, {counts.suspended} suspended.
          {me.user ? ` Signed in as ${me.user.name}.` : ` Using the ${me.key} key.`}
        </span>
        {canInvite && <button className="primary" onClick={() => setGranting({})}>Invite a person</button>}
      </div>

      {me.withoutRecord && (
        <div className="notice">
          You are signed in without an access record, so you have full access, as everyone did before roles. Invite yourself
          here with the role you need. From then on your roles decide what you can do, and only someone else can change them.
        </div>
      )}
      {message && <div className="notice">{message} <button className="link" onClick={() => setMessage(null)}>Dismiss</button></div>}
      {error && <div className="notice error">{error}</div>}

      <div className="access-layout">
        <nav className="side-nav" aria-label="Access">
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="side-group">{g.group}</div>
              {g.pages.filter((p) => auditor || !['trail', 'reviews'].includes(p.id)).map((p) => (
                <button key={p.id} className={page === p.id ? 'active' : ''} onClick={() => setPage(p.id)}>
                  {p.label}
                  {p.id === 'overview' && blocks + warns > 0 && <span className={`badge ${blocks ? 'bad' : 'warn'}`}>{blocks + warns}</span>}
                  {p.id === 'coverage' && attention.some((a) => a.kind === 'no_coverage') && <span className="badge warn">{attention.filter((a) => a.kind === 'no_coverage').length}</span>}
                  {p.id === 'reviews' && attention.some((a) => a.kind === 'review_due') && <span className="badge warn">Due</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <section className="access-main">
          {page === 'overview' && (
            <>
              <div className="tiles">
                <Tile label="People with access" value={counts.active ?? 0} hint={sideSplit(users)} onClick={() => go('active')} />
                <Tile label="Must enrol" value={counts.must_enrol ?? 0} hint="Strong rights off until they do" tone={counts.must_enrol ? 'bad' : 'good'} onClick={() => go('must_enrol')} />
                <Tile label="Invitations open" value={counts.invited ?? 0} hint={`${flagged('invite_expired').size} expired`} tone={flagged('invite_expired').size ? 'warn' : undefined} onClick={() => go('invited')} />
                <Tile label="Ending in 30 days" value={counts.ending ?? 0} hint="Extend or let lapse" tone={counts.ending ? 'warn' : undefined} onClick={() => go('ending')} />
                <Tile label="Paired duties" value={counts.paired_warn ?? 0} hint="Accepted, kept under review" tone={counts.paired_warn ? 'warn' : 'good'} onClick={() => go('paired_warn')} />
                <Tile label="Last access review" value={reviewAge === null ? 'Never' : `${reviewAge}d`} hint={lastReview ? `by ${lastReview.by}` : 'Quarterly is the standard'} tone={reviewAge === null || reviewAge > 90 ? 'warn' : 'good'} onClick={() => setPage('reviews')} />
              </div>

              <h3>Needs attention</h3>
              {unrecorded.length > 0 && (
                <ul className="attention">
                  <li className="block">
                    <span className="sev">Fix now</span>
                    <span>
                      {unrecorded.length} {unrecorded.length === 1 ? 'person signs' : 'people sign'} in with full access and no access record: {unrecorded.join(', ')}.
                      No role, no site limit, no paired-duty check. Invite each of them here with the role they need.
                    </span>
                    <span />
                  </li>
                </ul>
              )}
              {attention.length === 0 ? (
                <p className="muted">Nothing. Every duty is covered, nobody holds paired duties, and access has been reviewed.</p>
              ) : (
                <ul className="attention">
                  {attention.map((a, i) => (
                    <li key={i} className={a.severity}>
                      <span className="sev">{a.severity === 'block' ? 'Fix now' : a.severity === 'warn' ? 'Review' : 'Note'}</span>
                      <span>{a.message}</span>
                      {a.userId && <button className="link" onClick={() => setOpenId(a.userId!)}>Open</button>}
                      {!a.userId && a.kind === 'review_due' && <button className="link" onClick={() => setPage('reviews')}>Review</button>}
                      {!a.userId && a.kind === 'no_coverage' && <button className="link" onClick={() => setPage('coverage')}>Coverage</button>}
                    </li>
                  ))}
                </ul>
              )}

              <h3>Who holds which role</h3>
              <div className="grid-wrap">
                <table className="table">
                  <thead><tr><th>Role</th><th>Side</th><th className="num">Held by</th><th>People</th></tr></thead>
                  <tbody>
                    {ROLES.map((r) => {
                      const who = users.filter((u) => u.status === 'active' && u.memberships.some((m) => live(m, today()) && m.roleId === r.id));
                      if (who.length === 0) return null;
                      return (
                        <tr key={r.id}>
                          <td>{r.name}</td>
                          <td className="muted">{AUDIENCE_LABEL[r.audience]}</td>
                          <td className="num">{who.length}</td>
                          <td>{who.map((u) => <button key={u.id} className="link" onClick={() => setOpenId(u.id)}>{u.name}</button>)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {page === 'people' && (
            <>
              <div className="filter-chips">
                {FILTERS.map((f) => (
                  <button key={f.id} className={filter === f.id ? 'active' : ''} onClick={() => setFilter(f.id)}>
                    {f.label} <span className="count">{counts[f.id] ?? 0}</span>
                  </button>
                ))}
              </div>
              <div className="toolbar">
                <input className="search" placeholder="Find by name, email, title, role or site" value={query} onChange={(e) => setQuery(e.target.value)} />
                <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} aria-label="Role">
                  <option value="">Every role</option>
                  {ROLES.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
                <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)} aria-label="Site">
                  <option value="">Every site</option>
                  {state.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <select value={sideFilter} onChange={(e) => setSideFilter(e.target.value as '' | Audience)} aria-label="Side">
                  <option value="">Operator, WS and outside</option>
                  <option value="operator">Operator</option>
                  <option value="ws">Williams, Stanley &amp; Co.</option>
                  <option value="external">Outside</option>
                </select>
                <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
                  <option value="attention">Most attention first</option>
                  <option value="name">Name</option>
                  <option value="seen">Last seen</option>
                  <option value="status">Status</option>
                </select>
                <button onClick={() => { setQuery(''); setRoleFilter(''); setSiteFilter(''); setSideFilter(''); setFilter('all'); }}>Clear</button>
                <button onClick={() => download(`access-${today()}.csv`, csvOfAccess(visible, state))}>Export CSV</button>
              </div>

              {selected.size > 0 && (
                <div className="bulk-bar">
                  <strong>{selected.size} selected</strong>
                  <button onClick={() => void bulk('resend-invite', 'Resend invitations')}>Resend invitations</button>
                  <button onClick={() => void bulk('reset-authenticator', 'Reset authenticators')}>Reset authenticators</button>
                  <button onClick={() => void bulk('reactivate', 'Reactivate')}>Reactivate</button>
                  <button className="danger" onClick={() => void bulk('suspend', 'Suspend')}>Suspend</button>
                  <button className="link" onClick={() => setSelected(new Set())}>Clear selection</button>
                </div>
              )}

              <div className="grid-wrap">
                <table className="table people">
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          aria-label="Select all"
                          checked={visible.length > 0 && visible.every((u) => selected.has(u.id))}
                          onChange={(e) => setSelected(e.target.checked ? new Set(visible.filter((u) => u.id !== me.user?.id).map((u) => u.id)) : new Set())}
                        />
                      </th>
                      <th>Name</th>
                      <th>Side</th>
                      <th>Roles here</th>
                      <th>Sign-in</th>
                      <th>Status</th>
                      <th>Last seen</th>
                      <th>Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((u) => {
                      const flags = attention.filter((a) => a.userId === u.id && a.severity !== 'info');
                      const sign = signInText(u);
                      const isMe = u.id === me.user?.id;
                      return (
                        <tr key={u.id} className={u.status === 'suspended' ? 'dim' : ''}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Select ${u.name}`}
                              disabled={isMe}
                              checked={selected.has(u.id)}
                              onChange={(e) => {
                                const next = new Set(selected);
                                if (e.target.checked) next.add(u.id); else next.delete(u.id);
                                setSelected(next);
                              }}
                            />
                          </td>
                          <td>
                            <button className="name-link" onClick={() => setOpenId(u.id)}>{u.name}</button>
                            {isMe && <span className="tag">You</span>}
                            <div className="muted small">{u.jobTitle ? `${u.jobTitle}, ` : ''}{u.email}</div>
                          </td>
                          <td className="muted">{AUDIENCE_LABEL[u.audience]}</td>
                          <td>
                            <div className="chips">
                              {u.memberships.filter((m) => m.active).map((m) => (
                                <span key={m.id} className={`role-chip ${m.ends && m.ends < today() ? 'ended' : ''}`} title={m.note}>
                                  {roleOf(m.roleId)?.name}
                                  <span className="muted"> {reach(state, m.siteIds)}</span>
                                  {m.ends && <span className={endingSoon(m.ends) ? 'warn-text' : 'muted'}> until {shortDate(m.ends)}</span>}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className={`tone-${sign.tone}`}>{sign.text}</td>
                          <td>
                            <span className={`pill status-${u.status}`}>{STATUS_LABEL[u.status]}</span>
                            {signInState(u).tone !== 'good' && <div className={`small tone-${signInState(u).tone}`}>{signInState(u).text}</div>}
                          </td>
                          <td className="muted">{lastSeen(u)}</td>
                          <td>
                            {flags.length === 0 ? <span className="muted">None</span> : (
                              <span className={`badge ${flags.some((f) => f.severity === 'block') ? 'bad' : 'warn'}`} title={flags.map((f) => f.message).join('\n')}>
                                {flags.length}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {visible.length === 0 && (
                      <tr><td colSpan={8} className="muted">Nobody matches. Change the filters above.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {page === 'roles' && <RolesPage users={users} onOpen={setOpenId} />}

          {page === 'coverage' && (
            <>
              <p className="muted lead">
                Every site needs someone live who can publish the rota, approve hours, manage the team and give site roles. If the only person is on holiday,
                hours go unapproved and payroll slips. Two names per duty is the standard.
              </p>
              <div className="grid-wrap">
                <table className="table coverage">
                  <thead>
                    <tr><th>Site</th>{SITE_DUTIES.map((p) => <th key={p}>{PERMISSIONS[p].label}</th>)}</tr>
                  </thead>
                  <tbody>
                    {state.sites.map((s) => (
                      <tr key={s.id}>
                        <th>{s.name}</th>
                        {SITE_DUTIES.map((p) => <CoverCell key={p} who={holders(users, p, today(), s.id)} onOpen={setOpenId} />)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3>Across the organisation</h3>
              <div className="grid-wrap">
                <table className="table coverage">
                  <thead><tr>{ORG_DUTIES.map((p) => <th key={p}>{PERMISSIONS[p].label}</th>)}</tr></thead>
                  <tbody>
                    <tr>{ORG_DUTIES.map((p) => <CoverCell key={p} who={holders(users, p, today()).filter((u) => p !== 'users.manage' || canOrgWide(u, p, today()))} onOpen={setOpenId} />)}</tr>
                  </tbody>
                </table>
              </div>
              <p className="muted small">Counts only people who can use the right today: active, within their dates, and with an authenticator where the role needs one.</p>
            </>
          )}

          {page === 'duties' && (
            <>
              <p className="muted lead">
                Some duties should never sit with one person, because together they let someone pay themselves or someone who does not exist. Preshift
                refuses the worst pairing outright and asks for an accepted reason on the rest. Checks run across every role a person holds.
              </p>
              <div className="grid-wrap">
                <table className="table">
                  <thead><tr><th>One</th><th>With</th><th>Rule</th><th>Why</th><th>Held here by</th></tr></thead>
                  <tbody>
                    {CONFLICTS.map((c) => {
                      const who = users.filter((u) => u.status !== 'suspended' && conflictsIn(heldPermissions(u, today())).includes(c));
                      return (
                        <tr key={`${c.a}${c.b}`}>
                          <td>{PERMISSIONS[c.a].label}</td>
                          <td>{PERMISSIONS[c.b].label}</td>
                          <td><span className={`pill ${c.effect === 'block' ? 'tone-bad' : 'tone-warn'}`}>{c.effect === 'block' ? 'Refused' : 'Allowed with a reason'}</span></td>
                          <td className="muted">{c.why}</td>
                          <td>{who.length === 0 ? <span className="muted">Nobody</span> : who.map((u) => <button key={u.id} className="link" onClick={() => setOpenId(u.id)}>{u.name}</button>)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {page === 'reviews' && auditor && (
            <>
              <p className="muted lead">
                Once a quarter, someone who does not run payroll should read down the People list, confirm every person still needs what they hold, and record it
                here. Auditors ask for this evidence. Export the CSV from People as the record of what was reviewed.
              </p>
              <div className="card review-form">
                <div>
                  <strong>{attention.filter((a) => a.severity !== 'info' && a.kind !== 'review_due').length} points open right now</strong>
                  <span className="muted"> across {users.filter((u) => u.status !== 'suspended').length} people. They are recorded with the review.</span>
                </div>
                <textarea placeholder="What you checked and what you changed" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
                <button className="primary" onClick={() => void recordReview()}>Record access review</button>
              </div>
              <div className="grid-wrap">
                <table className="table">
                  <thead><tr><th>When</th><th>By</th><th className="num">People</th><th className="num">Open points</th><th>Note</th></tr></thead>
                  <tbody>
                    {reviews.map((r) => (
                      <tr key={r.id}><td>{shortDate(r.at)}</td><td>{r.by}</td><td className="num">{r.people}</td><td className="num">{r.attention}</td><td className="muted">{r.note}</td></tr>
                    ))}
                    {reviews.length === 0 && <tr><td colSpan={5} className="muted">No reviews recorded.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {page === 'trail' && auditor && (
            <div className="grid-wrap">
              <table className="table">
                <thead><tr><th>When</th><th>Who</th><th>What</th><th>Whom</th><th>Detail</th></tr></thead>
                <tbody>
                  {trail.map((e, i) => {
                    const d = describeEvent(e, users, state);
                    return (
                      <tr key={i}>
                        <td className="muted">{new Date(e.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</td>
                        <td>{e.actor}</td>
                        <td>{d.what}</td>
                        <td>{d.whom}</td>
                        <td className="muted">{d.detail}</td>
                      </tr>
                    );
                  })}
                  {trail.length === 0 && <tr><td colSpan={5} className="muted">No access changes since the API started. Every invitation, grant, removal and reset will appear here, and cannot be edited.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {open && (
        <PersonPanel
          state={state}
          me={me}
          user={open}
          users={users}
          attention={attention}
          canReadTrail={auditor}
          onGrant={() => setGranting({ target: open })}
          onChanged={async (m) => { if (m) setMessage(m); await refresh(); }}
          onClose={() => setOpenId(null)}
        />
      )}

      {granting && (
        <GrantDialog
          state={state}
          me={me}
          users={users}
          target={granting.target}
          onClose={() => setGranting(null)}
          onDone={async (res) => {
            setGranting(null);
            setMessage(
              res.expiresAt
                ? deliveryText(`${res.user.name} invited, until ${shortDate(res.expiresAt)}`, res.user.email, res)
                : `Role granted to ${res.user.name}.`,
            );
            await refresh();
            setOpenId(res.user.id);
          }}
        />
      )}
    </div>
  );
}

function Tile({ label, value, hint, tone, onClick }: { label: string; value: number | string; hint: string; tone?: 'good' | 'warn' | 'bad'; onClick: () => void }) {
  return (
    <button className={`kpi tile ${tone ?? ''}`} onClick={onClick}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-hint">{hint}</div>
    </button>
  );
}

function CoverCell({ who, onOpen }: { who: User[]; onOpen: (id: string) => void }) {
  const tone = who.length === 0 ? 'bad' : who.length === 1 ? 'warn' : 'good';
  return (
    <td className={`cover ${tone}`}>
      {who.length === 0 ? <strong>Nobody</strong> : who.map((u) => <button key={u.id} className="link" onClick={() => onOpen(u.id)}>{u.name}</button>)}
      {who.length === 1 && <div className="small">Only one</div>}
    </td>
  );
}

function sideSplit(users: User[]) {
  const active = users.filter((u) => u.status === 'active');
  const n = (a: Audience) => active.filter((u) => u.audience === a).length;
  return `${n('operator')} operator, ${n('ws')} WS, ${n('external')} outside`;
}

function RolesPage({ users, onOpen }: { users: User[]; onOpen: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [side, setSide] = useState<Audience | ''>('');
  const [heldOnly, setHeldOnly] = useState(false);
  const term = q.trim().toLowerCase();
  const roles = ROLES.filter((r) => !side || r.audience === side)
    .filter((r) => !term || `${r.name} ${r.about} ${r.permissions.map((p) => PERMISSIONS[p].label).join(' ')}`.toLowerCase().includes(term))
    .map((r) => ({ r, who: users.filter((u) => u.status === 'active' && u.memberships.some((m) => live(m, today()) && m.roleId === r.id)) }))
    .filter(({ who }) => !heldOnly || who.length > 0);
  return (
    <>
      <div className="toolbar">
        <input className="search" placeholder="Find a role, or what it can do" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="segmented">
          {(['', 'operator', 'ws', 'external'] as const).map((a) => (
            <button key={a} className={side === a ? 'active' : ''} onClick={() => setSide(a)}>{a ? AUDIENCE_LABEL[a] : 'All'}</button>
          ))}
        </div>
        <label className="check"><input type="checkbox" checked={heldOnly} onChange={(e) => setHeldOnly(e.target.checked)} /> Only roles held here</label>
      </div>
      <div className="role-grid">
        {roles.map(({ r, who }) => (
          <div key={r.id} className="card role-card">
            <div className="role-head">
              <strong>{r.name}</strong>
              <span className="muted small">{AUDIENCE_LABEL[r.audience]}</span>
            </div>
            <div className="chips">
              {r.mfa && <span className="chip-tag">Authenticator required</span>}
              {r.scope === 'sites' && <span className="chip-tag">Granted per site</span>}
              {r.requiresEnd && <span className="chip-tag">Needs an end date</span>}
              {r.appoints && <span className="chip-tag">Appoints {r.appoints.map((a) => AUDIENCE_LABEL[a].toLowerCase()).join(' and ')} roles</span>}
            </div>
            <p className="muted small">{r.about}</p>
            {byArea(r.permissions).map(([area, perms]) => (
              <div key={area} className="small"><span className="can-area-name">{area}</span> {perms.map((p) => PERMISSIONS[p].label).join('; ')}</div>
            ))}
            <div className="small role-held">
              Held by {who.length === 0 ? <span className="muted">nobody</span> : who.map((u) => <button key={u.id} className="link" onClick={() => onOpen(u.id)}>{u.name}</button>)}
            </div>
          </div>
        ))}
        {roles.length === 0 && <p className="muted">No role matches.</p>}
      </div>
    </>
  );
}
