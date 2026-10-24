import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { REQUEST_LABEL } from '../engine/requests';
import { absoluteMinute, addDays, daysBetween, formatMinute, londonParts, parseClock } from '../engine/time';
import type { RotaState, StaffRequestKind, StaffRequestStatus } from '../engine/types';
import { api } from './api';
import { money2 } from './format';
import type { Allow } from './permissions';

interface Props {
  state: RotaState;
  siteIds: string[];
  today: string;
  allow: Allow;
  /** A decision changed leave, absence, availability or the rota: re-read them. */
  onChanged: () => Promise<unknown>;
}

interface RequestView {
  id: string;
  kind: StaffRequestKind;
  status: StaffRequestStatus;
  createdAt: string;
  employeeId: string;
  employeeName: string;
  siteId: string;
  siteName: string;
  from: string | null;
  to: string | null;
  hours: number | null;
  absenceLabel: string | null;
  note: string | null;
  availability: { weekday: number; fromMinute: number; toMinute: number }[] | null;
  shift: { id: string; line: string } | null;
  returnShift: { id: string; line: string } | null;
  openShift: { id: string; line: string; status: string } | null;
  /** For an open shift claim: the wave they were offered it in, and what adding it costs, to those who see cost. */
  offer: { tier: string | null; tierLabel: string | null; shortHours: number; cost: number | null } | null;
  toName: string | null;
  takerName: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  problem: string | null;
  issues: { severity: 'block' | 'warn'; code: string; message: string; employee: string }[];
  balance: { remainingHours: number; afterHours: number; yearEnd: string } | null;
  clashes: { id: string; line: string; published: boolean }[];
  othersOff: string[];
  canDecide: boolean;
}

interface RotaSeen {
  siteId: string;
  siteName: string;
  weekStart: string;
  total: number;
  seen: number;
  notSeen: { name: string; onApp: boolean; changed: boolean }[];
}

interface LateShift {
  shiftId: string;
  employeeName: string;
  siteId: string;
  siteName: string;
  roleId: string;
  date: string;
  startMinute: number;
  endMinute: number;
  line: string;
  minutesLate: number;
}

interface OpenShiftView {
  id: string;
  siteId: string;
  line: string;
  note?: string;
  status: 'open' | 'filled' | 'withdrawn';
  filledByName: string | null;
  claims: RequestView[];
  eligible: string[];
  offer: { waves: { tier: string; label: string; count: number; released: boolean }[]; told: number; allTold: boolean; nextAt: string | null } | null;
  autoApproved: boolean;
}

interface AutoApprove {
  siteId: string;
  siteName: string;
  on: boolean;
  labourTargetPct: number;
}

/** What posting did: who was told now, and that the rest follow if nobody claims. */
function postedText(res: { told: number; offer: OpenShiftView['offer'] }) {
  const people = `${res.told} ${res.told === 1 ? 'person' : 'people'}`;
  if (!res.offer || res.offer.allTold) return `Posted. ${people} eligible ${res.told === 1 ? 'has' : 'have'} been told.`;
  const first = res.offer.waves.find((w) => w.released);
  return `Posted. Offered first to ${people}: ${first?.label.toLowerCase() ?? 'the cheapest'}. Everyone else eligible is told if nobody claims it within two hours.`;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });

const STATUS: Record<StaffRequestStatus, string> = {
  pending: 'Waiting',
  accepted: 'Colleague agreed',
  approved: 'Approved',
  declined: 'Declined',
  cancelled: 'Withdrawn',
};

/** Claims cheapest first, so the obvious choice is on top. Without cost sight, in the order they came. */
const byCost = (claims: RequestView[]) => [...claims].sort((a, b) => (a.offer?.cost ?? 0) - (b.offer?.cost ?? 0));

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const when = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const date = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const span = (from: string | null, to: string | null) => (from ? (to && to !== from ? `${date(from)} to ${date(to)}` : to ? date(from) : `${date(from)}, still off`) : '');

/** What the request asks for, in one line. */
function asked(r: RequestView): string {
  switch (r.kind) {
    case 'holiday': return `${span(r.from, r.to)}${r.hours ? `, ${r.hours} h` : ''}`;
    case 'time_off': return `${r.absenceLabel}: ${span(r.from, r.to)}`;
    case 'sickness': return `Off sick from ${span(r.from, r.to)}`;
    case 'availability': return r.availability?.length ? r.availability.map((a) => `${DAYS[a.weekday]} ${formatMinute(a.fromMinute)}-${formatMinute(a.toMinute)}`).join(', ') : 'Not available at all';
    case 'swap': return `${r.shift?.line ?? 'Shift'} to ${r.takerName ?? r.toName ?? 'anyone who can'}${r.returnShift ? `, taking ${r.returnShift.line} back` : ''}`;
    case 'open_shift': return r.openShift?.line ?? 'Open shift';
  }
}

/**
 * What staff ask for in the staff app: holiday, time off, sickness, availability, swaps and open
 * shift claims, each shown with what it would do now. Approving carries it out through the same
 * checks as the manager's own screens, and the person is told either way.
 */
export function RequestsView({ state, siteIds, today, allow, onChanged }: Props) {
  const [requests, setRequests] = useState<RequestView[] | null>(null);
  const [openShifts, setOpenShifts] = useState<OpenShiftView[]>([]);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const [posting, setPosting] = useState(false);
  const [digest, setDigest] = useState<{ on: boolean; email: string; count: number } | null>(null);
  const [late, setLate] = useState<LateShift[]>([]);
  const [seen, setSeen] = useState<RotaSeen[]>([]);
  const [auto, setAuto] = useState<AutoApprove[]>([]);

  const load = useCallback(async () => {
    try {
      const [r, o, l] = await Promise.all([
        api.get<RequestView[]>('/v1/requests?status=all'),
        api.get<OpenShiftView[]>('/v1/open-shifts'),
        api.get<LateShift[]>('/v1/requests/late').catch(() => []),
        api.get<RotaSeen[]>('/v1/requests/rota-seen').catch(() => []).then(setSeen),
        api.get<AutoApprove[]>('/v1/open-shifts/auto-approve').catch(() => []).then(setAuto),
      ]);
      setRequests(r);
      setOpenShifts(o);
      setLate(l);
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
      setRequests([]);
    }
  }, []);
  useEffect(() => void load(), [load]);
  // People only: an API key has no morning email.
  useEffect(() => void api.get<{ on: boolean; email: string; count: number }>('/v1/requests/digest').then(setDigest).catch(() => setDigest(null)), []);

  async function setAutoOn(siteId: string, on: boolean) {
    try {
      await api.put('/v1/open-shifts/auto-approve', { siteId, on });
      setAuto((list) => list.map((a) => (a.siteId === siteId ? { ...a, on } : a)));
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
  }

  async function offerAll(o: OpenShiftView) {
    if (!confirm(`Tell everyone eligible about ${o.line} now, without waiting for the cheaper waves?`)) return;
    try {
      const res = await api.post<{ told: number; offer: OpenShiftView['offer'] }>(`/v1/open-shifts/${o.id}/offer-all`, {});
      setMessage({ text: `${res.told} more ${res.told === 1 ? 'person has' : 'people have'} been told.` });
      await load();
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
  }

  async function setDigestOn(on: boolean) {
    try {
      await api.put('/v1/requests/digest', { on });
      setDigest((d) => (d ? { ...d, on } : d));
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
  }

  const inScope = (requests ?? []).filter((r) => siteIds.includes(r.siteId));
  const waiting = inScope.filter((r) => r.status === 'pending' || r.status === 'accepted');
  const decided = inScope.filter((r) => !(r.status === 'pending' || r.status === 'accepted')).slice(0, 40);
  const shifts = openShifts.filter((o) => siteIds.includes(o.siteId));
  const sick = waiting.filter((r) => r.kind === 'sickness');
  const oldest = waiting.length ? Math.max(...waiting.map((r) => daysBetween(r.createdAt.slice(0, 10), today))) : 0;
  const publishable = siteIds.filter((id) => allow('rota.publish', id));

  async function decide(r: RequestView, verdict: 'approve' | 'decline') {
    const note = prompt(
      verdict === 'decline' ? `Why is ${r.employeeName}'s ${REQUEST_LABEL[r.kind].toLowerCase()} declined? They will read this.` : `Approve for ${r.employeeName}? Add a note for them if you want one.`,
      '',
    );
    if (note === null || (verdict === 'decline' && !note.trim())) return;
    try {
      await api.post(`/v1/requests/${r.id}/${verdict}`, note.trim() ? { note: note.trim() } : {});
      const covered = verdict === 'approve' && r.clashes.length && (r.kind === 'holiday' || r.kind === 'time_off')
        ? ` ${r.clashes.length} shift${r.clashes.length === 1 ? ' is' : 's are'} now blocked on the rota: re-cover or put out as open shifts.`
        : '';
      setMessage({ text: `${verdict === 'approve' ? 'Approved' : 'Declined'}. ${r.employeeName} has been told.${covered}` });
      await onChanged();
      await load();
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
  }

  /**
   * Cover for the rest of a shift nobody turned up for: an open shift from the next quarter hour to the
   * end. The original stays on the rota as the no-show it was.
   */
  async function coverRest(l: LateShift) {
    const now = londonParts(new Date());
    // Minutes on the shift's own day, so a shift that began yesterday evening still works.
    const from = Math.max(l.startMinute, Math.ceil(absoluteMinute(l.date, now.date, now.minute) / 15) * 15);
    if (from >= l.endMinute - 30) return setMessage({ text: 'Less than half an hour of this shift is left, so there is nothing worth posting.', bad: true });
    if (!confirm(`Post ${formatMinute(from)} to ${formatMinute(l.endMinute)} as an open shift, to cover ${l.employeeName}?`)) return;
    try {
      // Past midnight it is tomorrow's open shift, so it is not refused as a day gone.
      const nextDay = from >= 1440;
      const res = await api.post<{ told: number; offer: OpenShiftView['offer'] }>('/v1/open-shifts', {
        siteId: l.siteId, roleId: l.roleId, date: nextDay ? addDays(l.date, 1) : l.date,
        startMinute: nextDay ? from - 1440 : from, endMinute: nextDay ? l.endMinute - 1440 : l.endMinute, breakMinutes: 0,
        note: `Cover needed now: ${l.employeeName} has not arrived.`,
        everyone: true,
      });
      setMessage({ text: postedText(res) });
      await load();
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
  }

  async function release(shiftId: string, name: string) {
    if (!confirm(`Take this shift off ${name} and post it for anyone eligible to claim?`)) return;
    try {
      const res = await api.post<{ told: number; offer: OpenShiftView['offer'] }>('/v1/open-shifts', { fromShiftId: shiftId });
      setMessage({ text: postedText(res) });
      await onChanged();
      await load();
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
  }

  async function withdraw(o: OpenShiftView) {
    if (!confirm(`Withdraw ${o.line}? Anyone who asked for it is told.`)) return;
    try {
      await api.del(`/v1/open-shifts/${o.id}`);
      await load();
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
  }

  async function post(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const start = parseClock(String(f.get('start')));
    let end = parseClock(String(f.get('end')));
    if (end <= start) end += 1440;
    try {
      const res = await api.post<{ told: number; offer: OpenShiftView['offer'] }>('/v1/open-shifts', {
        siteId: f.get('siteId'), roleId: f.get('roleId'), date: f.get('date'), startMinute: start, endMinute: end,
        breakMinutes: Number(f.get('break') || 0), ...(f.get('note') ? { note: f.get('note') } : {}),
        everyone: f.get('everyone') === 'on',
      });
      setMessage({ text: postedText(res) });
      setPosting(false);
      await load();
    } catch (err) {
      setMessage({ text: (err as Error).message, bad: true });
    }
  }

  return (
    <div>
      <div className="kpis people-kpis">
        <div className={`kpi ${waiting.length ? 'warn' : 'good'}`}>
          <div className="kpi-label">Waiting for you</div>
          <div className="kpi-value">{waiting.length}</div>
          <div className="kpi-hint">{waiting.length ? `Oldest ${oldest} day${oldest === 1 ? '' : 's'}` : 'Nothing to decide'}</div>
        </div>
        <div className={`kpi ${sick.length ? 'bad' : 'good'}`}>
          <div className="kpi-label">Sickness to cover</div>
          <div className="kpi-value">{sick.length}</div>
          <div className="kpi-hint">Reported in the staff app</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Open shifts</div>
          <div className="kpi-value">{shifts.filter((o) => o.status === 'open').length}</div>
          <div className="kpi-hint">{shifts.filter((o) => o.status === 'open').reduce((n, o) => n + o.claims.filter((c) => c.status === 'pending').length, 0)} claims to decide</div>
        </div>
      </div>

      <p className="muted small">
        Staff ask in the staff app and you decide here. Every request is checked again when you approve it, by the same rules as
        the rota: a swap or claim that would break the Working Time Regulations, double book someone or put them on a role they are
        not trained for is refused. The person is told the moment you decide, in the app and by email.
      </p>
      {digest && (
        <label className="muted small requests-digest">
          <input type="checkbox" checked={digest.on} onChange={(e) => void setDigestOn(e.target.checked)} /> Email me at {digest.email} each morning with what is waiting for me, and at once when someone has not clocked in
          {digest.on ? ` (today it would list ${digest.count})` : ''}. Sent only when something is waiting; names and dates only, never a reason for absence.
        </label>
      )}
      {message && <p className={`notice${message.bad ? ' error' : ''}`}>{message.text}</p>}
      {requests === null && <p className="muted">Loading</p>}

      {late.filter((l) => siteIds.includes(l.siteId)).length > 0 && (
        <>
          <h3 className="section-title bad-text">Not clocked in</h3>
          <div className="grid-wrap">
            <table className="table people">
              <tbody>
                {late.filter((l) => siteIds.includes(l.siteId)).map((l) => (
                  <tr key={l.shiftId}>
                    <td><span className="strong">{l.employeeName}</span><div className="muted small">{l.siteName}</div></td>
                    <td>{l.line}<div className="bad-text small">{l.minutesLate} minutes late, nothing clocked. They have been nudged.</div></td>
                    <td className="nowrap">
                      {allow('rota.publish', l.siteId) && <button className="primary" onClick={() => void coverRest(l)}>Find cover for the rest</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {seen.filter((w) => siteIds.includes(w.siteId)).length > 0 && (
        <>
          <h3 className="section-title">Rota seen</h3>
          <div className="grid-wrap">
            <table className="table people">
              <tbody>
                {seen.filter((w) => siteIds.includes(w.siteId)).map((w) => (
                  <tr key={`${w.siteId}${w.weekStart}`}>
                    <td><span className="strong">{w.siteName}</span><div className="muted small">Week of {date(w.weekStart)}</div></td>
                    <td className={`num ${w.seen === w.total ? 'good-text' : 'warn-text'}`}>{w.seen} of {w.total} seen</td>
                    <td className="small">
                      {w.notSeen.length === 0 ? <span className="good-text">Everyone has confirmed this week as it stands.</span> : w.notSeen.map((p) => (
                        <span key={p.name} className="tag" title={p.onApp ? (p.changed ? 'Saw an earlier version; something changed since' : 'Has the app, not confirmed yet') : 'No staff app: tell them yourself'}>
                          {p.name}{p.changed ? ', changed since' : ''}{p.onApp ? '' : ', no app'}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="people-bar">
        <h3 className="section-title">Waiting</h3>
      </div>
      <div className="grid-wrap">
        <table className="table people">
          <thead>
            <tr>
              <th>Person</th>
              <th>Asking for</th>
              <th>What it means</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {waiting.length === 0 && <tr><td colSpan={4} className="muted">Nothing waiting.</td></tr>}
            {waiting.map((r) => (
              <tr key={r.id}>
                <td>
                  <span className="strong">{r.employeeName}</span>
                  <div className="muted small">{r.siteName}, {when(r.createdAt)}</div>
                  {/* Two days without an answer and it is in the area manager's morning email too. */}
                  {!(r.kind === 'swap' && r.status === 'pending') && Date.now() - Date.parse(r.createdAt) >= 48 * 3_600_000 && (
                    <div className="bad-text small">Overdue: now with your area manager too</div>
                  )}
                </td>
                <td>
                  <span className="strong">{REQUEST_LABEL[r.kind]}</span>
                  <div>{asked(r)}</div>
                  {r.note && <div className="muted small">"{r.note}"</div>}
                </td>
                <td className="small">
                  {r.kind === 'swap' && r.status === 'pending' && <div className="muted">Waiting for {r.toName ?? 'a colleague'} to agree.</div>}
                  {r.problem && <div className="bad-text">{r.problem}</div>}
                  {r.issues.map((i, n) => <div key={n} className={i.severity === 'block' ? 'bad-text' : 'warn-text'}>{i.employee}: {i.message}</div>)}
                  {r.balance && (
                    <div className={r.balance.afterHours < 0 ? 'bad-text' : ''}>
                      {r.balance.remainingHours} h left, {r.balance.afterHours} h after this, to {date(r.balance.yearEnd)}.
                    </div>
                  )}
                  {r.othersOff.length > 0 && <div className="warn-text">Also off then: {r.othersOff.join(', ')}.</div>}
                  {r.clashes.length > 0 && (
                    <div>
                      {r.kind === 'sickness' ? 'Shifts to cover:' : 'Already rostered:'}
                      {r.clashes.map((c) => (
                        <div key={c.id}>
                          {c.line}{' '}
                          {r.kind !== 'availability' && allow('rota.publish', r.siteId) && (
                            <button className="link" onClick={() => void release(c.id, r.employeeName)}>Put out as open shift</button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {!r.problem && r.issues.length === 0 && r.clashes.length === 0 && r.othersOff.length === 0 && !(r.kind === 'swap' && r.status === 'pending') && (
                    <div className="good-text">No clashes and no rule broken.</div>
                  )}
                </td>
                <td className="nowrap">
                  {r.canDecide ? (
                    <>
                      <button className="primary" disabled={Boolean(r.problem) || r.issues.some((i) => i.severity === 'block')} onClick={() => void decide(r, 'approve')}>
                        {r.kind === 'sickness' ? 'Seen, cover arranged' : 'Approve'}
                      </button>{' '}
                      {r.kind !== 'sickness' && <button onClick={() => void decide(r, 'decline')}>Decline</button>}
                    </>
                  ) : (
                    <span className="muted small">{r.kind === 'swap' && r.status === 'pending' ? 'Not agreed yet' : 'Not yours to decide'}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="people-bar">
        <h3 className="section-title">Open shifts</h3>
        {publishable.length > 0 && <button onClick={() => setPosting(!posting)}>{posting ? 'Close' : 'Post an open shift'}</button>}
      </div>
      {posting && (
        <form className="card requests-post" onSubmit={(e) => void post(e)}>
          <label>Site
            <select name="siteId" defaultValue={publishable[0]}>{publishable.map((id) => <option key={id} value={id}>{state.sites.find((s) => s.id === id)?.name ?? id}</option>)}</select>
          </label>
          <label>Role
            <select name="roleId">{state.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          </label>
          <label>Day <input type="date" name="date" min={today} required /></label>
          <label>From <input type="time" name="start" defaultValue="17:00" required /></label>
          <label>To <input type="time" name="end" defaultValue="23:00" required /></label>
          <label>Break, minutes <input type="number" name="break" min={0} max={240} defaultValue={0} /></label>
          <label>Note for staff <input name="note" maxLength={300} placeholder="Private party, 40 covers" /></label>
          <label className="check"><input type="checkbox" name="everyone" /> Tell everyone eligible now</label>
          <div><button className="primary">Post and offer it</button></div>
          <p className="muted small">
            Only people trained for the role, set up for the site, free and legal to work it are told or can claim. It goes first to
            anyone short of their contracted hours that week, then to the three cheapest to add, then to everyone, two hours apart
            while nobody claims. Inside a day of the start everyone is told at once. You confirm who gets it; the break is raised to
            what the person is owed.
          </p>
        </form>
      )}
      <div className="grid-wrap">
        <table className="table people">
          <thead>
            <tr><th>Shift</th><th>Status</th><th>Claims</th><th /></tr>
          </thead>
          <tbody>
            {shifts.length === 0 && <tr><td colSpan={4} className="muted">No open shifts.</td></tr>}
            {shifts.map((o) => (
              <tr key={o.id}>
                <td><span className="strong">{o.line}</span>{o.note && <div className="muted small">{o.note}</div>}</td>
                <td>
                  {o.status === 'filled' ? `Filled by ${o.filledByName}${o.autoApproved ? ', approved automatically' : ''}` : o.status === 'withdrawn' ? 'Withdrawn' : 'Open'}
                  {o.status === 'open' && <div className="muted small">{o.eligible.length} eligible</div>}
                  {o.status === 'open' && o.offer && (
                    <div className="muted small">
                      {o.offer.allTold
                        ? `All eligible told`
                        : `Told so far: ${o.offer.waves.filter((w) => w.released).map((w) => `${w.label.toLowerCase()} (${w.count})`).join(', ')}.${o.offer.nextAt ? ` Next wave at ${clock(o.offer.nextAt)} if nobody claims.` : ''}`}
                      {!o.offer.allTold && allow('rota.publish', o.siteId) && <> <button className="link" onClick={() => void offerAll(o)}>Tell everyone now</button></>}
                    </div>
                  )}
                </td>
                <td className="small">
                  {o.claims.length === 0 ? <span className="muted">No claims yet</span> : byCost(o.claims).map((c) => (
                    <div key={c.id}>
                      {c.employeeName} <span className="muted">{STATUS[c.status]}</span>{' '}
                      {c.offer?.tierLabel && <span className="tag">{c.offer.tierLabel}</span>}{' '}
                      {c.offer?.cost != null && <span className="muted">adds {money2(c.offer.cost)}</span>}{' '}
                      {c.canDecide && <button className="link" disabled={Boolean(c.problem)} title={c.problem ?? undefined} onClick={() => void decide(c, 'approve')}>Give it to them</button>}
                    </div>
                  ))}
                </td>
                <td>{o.status === 'open' && allow('rota.publish', o.siteId) && <button className="link" onClick={() => void withdraw(o)}>Withdraw</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {auto.length > 0 && (
        <div className="card requests-auto">
          <h4>Approve claims automatically</h4>
          <p className="muted small">
            A claim is approved the moment it is made only when it breaks no rule, raises nothing to review, and the site's labour that
            week stays at or under its target with the shift added. Anything else waits for you.
          </p>
          {auto.map((a) => (
            <label key={a.siteId} className="check">
              <input type="checkbox" checked={a.on} onChange={(e) => void setAutoOn(a.siteId, e.target.checked)} /> {a.siteName}
              <span className="muted small"> (labour target {Math.round(a.labourTargetPct * 1000) / 10}%)</span>
            </label>
          ))}
        </div>
      )}

      <h3 className="section-title">Decided in the last 30 days</h3>
      <div className="grid-wrap">
        <table className="table people">
          <thead>
            <tr><th>Person</th><th>Request</th><th>Outcome</th></tr>
          </thead>
          <tbody>
            {decided.length === 0 && <tr><td colSpan={3} className="muted">Nothing decided yet.</td></tr>}
            {decided.map((r) => (
              <tr key={r.id}>
                <td>{r.employeeName}<div className="muted small">{r.siteName}</div></td>
                <td>{REQUEST_LABEL[r.kind]}<div className="muted small">{asked(r)}</div></td>
                <td>
                  <span className={r.status === 'approved' ? 'good-text' : r.status === 'declined' ? 'bad-text' : 'muted'}>{r.kind === 'sickness' && r.status === 'approved' ? 'Acknowledged' : STATUS[r.status]}</span>
                  {r.decidedBy && <span className="muted small"> by {r.decidedBy}{r.decidedAt ? `, ${when(r.decidedAt)}` : ''}</span>}
                  {r.decisionNote && <div className="muted small">{r.decisionNote}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
