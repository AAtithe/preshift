import { useCallback, useEffect, useState } from 'react';
import { REQUEST_LABEL } from '../engine/requests';
import { absoluteMinute, addDays, daysBetween, formatMinute, londonParts } from '../engine/time';
import type { RotaState, StaffRequestKind, StaffRequestStatus } from '../engine/types';
import { api } from './api';
import type { Allow } from './permissions';
import { CoverPanel } from './CoverPanel';

interface Props {
  state: RotaState;
  siteIds: string[];
  today: string;
  allow: Allow;
  /** A decision changed leave, absence, availability or the rota: re-read them. */
  onChanged: () => Promise<unknown>;
  /** A shift sent from the rota's shift editor to put out, staying with its person until taken. */
  coverShiftId?: string;
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
  status: 'open' | 'filled' | 'withdrawn' | 'expired';
  filledByName: string | null;
  claims: RequestView[];
  eligible: string[];
  fill: 'claim' | 'first_yes';
  urgent?: boolean;
  heldByName: string | null;
  asked: { employeeId: string; name: string; round: number; asked: boolean; skipped: string | null; declined: boolean; refused: string | null }[] | null;
  rounds: { size: number; everyMinutes: number } | null;
  round: number;
  nextRoundAt: string | null;
  waiting: number;
}

const STATUS: Record<StaffRequestStatus, string> = {
  pending: 'Waiting',
  accepted: 'Colleague agreed',
  approved: 'Approved',
  declined: 'Declined',
  cancelled: 'Withdrawn',
};

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
export function RequestsView({ state, siteIds, today, allow, onChanged, coverShiftId }: Props) {
  const [requests, setRequests] = useState<RequestView[] | null>(null);
  const [openShifts, setOpenShifts] = useState<OpenShiftView[]>([]);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  // Putting a shift out: from the editor, sickness to cover, or the button. Keep is whether it stays with its person.
  const [posting, setPosting] = useState<{ shiftId?: string; keep: boolean } | null>(coverShiftId ? { shiftId: coverShiftId, keep: true } : null);
  const [digest, setDigest] = useState<{ on: boolean; email: string; count: number } | null>(null);
  const [late, setLate] = useState<LateShift[]>([]);

  const load = useCallback(async () => {
    try {
      const [r, o, l] = await Promise.all([
        api.get<RequestView[]>('/v1/requests?status=all'),
        api.get<OpenShiftView[]>('/v1/open-shifts'),
        api.get<LateShift[]>('/v1/requests/late').catch(() => []),
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
      const res = await api.post<{ told: number }>('/v1/open-shifts', {
        siteId: l.siteId, roleId: l.roleId, date: nextDay ? addDays(l.date, 1) : l.date,
        startMinute: nextDay ? from - 1440 : from, endMinute: nextDay ? l.endMinute - 1440 : l.endMinute, breakMinutes: 0,
        note: `Cover needed now: ${l.employeeName} has not arrived.`,
        // Someone has not turned up: it reaches people through their quiet hours.
        urgent: true,
      });
      setMessage({ text: `Posted. ${res.told} eligible ${res.told === 1 ? 'person has' : 'people have'} been told.` });
      await load();
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
  }

  // Sickness to cover: put the shift out from here, taken off the person since they cannot work it.
  const release = (shiftId: string) => setPosting({ shiftId, keep: false });

  async function next(o: OpenShiftView, everyone: boolean) {
    try {
      await api.post(`/v1/open-shifts/${o.id}/next`, { everyone });
      setMessage({ text: everyone ? 'Asked everyone left.' : 'Asked the next round.' });
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
        not trained for is refused. The person is told the moment you decide, in the app and by email, or by WhatsApp or text if they chose that.
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
                            <button className="link" onClick={() => release(c.id)}>Put out for cover</button>
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
        {publishable.length > 0 && <button onClick={() => setPosting(posting ? null : { keep: false })}>{posting ? 'Close' : 'Put a shift out'}</button>}
      </div>
      {posting && publishable.length > 0 && (() => {
        const now = londonParts(new Date());
        return (
          <CoverPanel
            key={`${posting.shiftId ?? 'new'}-${posting.keep}`}
            state={state}
            siteIds={publishable}
            today={now.date}
            nowMinute={now.minute}
            shiftId={posting.shiftId}
            keepDefault={posting.keep}
            onPosted={() => {
              setPosting(null);
              void onChanged();
              void load();
            }}
          />
        );
      })()}
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
                  {o.status === 'filled' ? `Filled by ${o.filledByName}` : o.status === 'withdrawn' ? 'Withdrawn' : o.status === 'expired' ? 'Started, not filled' : 'Open'}
                  <div className="muted small">
                    {o.fill === 'first_yes' ? 'First legal yes gets it' : 'You approve who gets it'}
                    {o.heldByName && o.status === 'open' ? `; ${o.heldByName} keeps it until then` : ''}
                    {o.urgent ? '; urgent' : ''}
                  </div>
                  {o.status === 'open' && !o.asked && <div className="muted small">{o.eligible.length} eligible told</div>}
                  {o.asked && (
                    <div className="muted small">
                      {o.asked.filter((a) => a.asked).length} asked{o.rounds ? `, round ${o.round} of ${Math.max(...o.asked.map((a) => a.round))}` : ''}
                      {o.asked.some((a) => a.declined) ? `, ${o.asked.filter((a) => a.declined).length} said no` : ''}
                      {o.status === 'open' && o.waiting ? `; ${o.waiting} still to ask${o.nextRoundAt ? ` from ${new Date(o.nextRoundAt).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' })}` : ''}` : ''}
                      {o.asked.some((a) => a.skipped) && <div>Passed over: {o.asked.filter((a) => a.skipped).map((a) => `${a.name} (${a.skipped})`).join('; ')}</div>}
                      {o.asked.some((a) => a.refused) && <div className="warn-text">Said yes but could not be given it: {o.asked.filter((a) => a.refused).map((a) => `${a.name} (${a.refused})`).join('; ')}</div>}
                    </div>
                  )}
                </td>
                <td className="small">
                  {o.claims.length === 0 ? <span className="muted">No claims yet</span> : o.claims.map((c) => (
                    <div key={c.id}>
                      {c.employeeName} <span className="muted">{STATUS[c.status]}</span>{' '}
                      {c.canDecide && <button className="link" disabled={Boolean(c.problem)} title={c.problem ?? undefined} onClick={() => void decide(c, 'approve')}>Give it to them</button>}
                    </div>
                  ))}
                </td>
                <td className="nowrap">
                  {o.status === 'open' && allow('rota.publish', o.siteId) && (
                    <>
                      {o.waiting > 0 && <button className="link" onClick={() => void next(o, false)}>Next round now</button>}{' '}
                      {o.waiting > 0 && <button className="link" onClick={() => void next(o, true)}>Ask everyone</button>}{' '}
                      <button className="link" onClick={() => void withdraw(o)}>Withdraw</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
