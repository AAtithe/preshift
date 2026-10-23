import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { formatMinute, parseClock } from '../engine/time';
import type { Availability } from '../engine/types';
import { dayLabel } from '../ui/format';
import { pushState, turnOff, turnOn, type PushState } from './push';

/** What the overview carries for self-service. The rest of it is the clock and hours. */
export interface SelfServiceData {
  today: string;
  unread: number;
  holiday: { remainingHours: number; bookedHours: number; takenHours: number; dayHours: number; yearEnd: string; upcoming: string[] };
  availability: Availability[];
  unavailable: { date: string; note?: string }[];
  sick: { from: string } | null;
  fitNoteFor: { from: string; to: string | null; uploaded: number } | null;
  requests: OwnRequest[];
}

export interface OwnRequest {
  id: string;
  kind: 'holiday' | 'time_off' | 'sickness' | 'availability' | 'swap' | 'open_shift';
  status: 'pending' | 'accepted' | 'approved' | 'declined' | 'cancelled';
  createdAt: string;
  from: string | null;
  to: string | null;
  hours: number | null;
  absenceLabel: string | null;
  line: string | null;
  returnLine: string | null;
  withName: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  canCancel: boolean;
}

type Call = <T>(method: string, path: string, body?: unknown) => Promise<T>;
type Say = (e: unknown) => string;

const KIND: Record<OwnRequest['kind'], string> = {
  holiday: 'Holiday',
  time_off: 'Time off',
  sickness: 'Sickness',
  availability: 'Availability',
  swap: 'Swap',
  open_shift: 'Open shift',
};

const STATUS: Record<OwnRequest['status'], string> = {
  pending: 'Waiting',
  accepted: 'Agreed, waiting for your manager',
  approved: 'Approved',
  declined: 'Declined',
  cancelled: 'Withdrawn',
};

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const day = (iso: string) => {
  const d = dayLabel(iso);
  return `${d.short} ${d.date}`;
};

const span = (from: string | null, to: string | null) => (from ? (to && to !== from ? `${day(from)} to ${day(to)}` : day(from)) : '');

/** One action at a time, with its outcome shown under it. */
function useAction(say: Say, after: () => void) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  /** `work` may return its own message, to say more than `done` about how it went. */
  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const said = await work();
      setMessage({ tone: 'good', text: typeof said === 'string' ? said : done });
      after();
    } catch (e) {
      setMessage({ tone: 'bad', text: say(e) });
    } finally {
      setBusy(false);
    }
  };
  const note = message ? <p className={`staff-msg ${message.tone}`} role="status">{message.text}</p> : null;
  return { busy, run, note };
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="staff-card staff-form">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------
// Rota: who they work with, swaps, and open shifts.

interface TeamShift {
  shiftId: string;
  date: string;
  line: string;
  team: { name: string; role: string; startMinute: number; endMinute: number }[];
}

interface Board {
  openShifts: { id: string; line: string; note: string | null; claimed: boolean }[];
  offers: { id: string; from: string; line: string; returnLine: string | null; directed: boolean; note: string | null }[];
}

interface SwapOptions {
  shift: { id: string; line: string };
  people: { id: string; name: string; role: string; shifts: { id: string; line: string }[] }[];
}

export function RotaTab({ call, say, today, requests, refresh }: { call: Call; say: Say; today: string; requests: OwnRequest[]; refresh: () => void }) {
  const [team, setTeam] = useState<TeamShift[] | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [swapping, setSwapping] = useState<string | null>(null);
  const load = useCallback(() => {
    void call<TeamShift[]>('GET', '/v1/staff/team').then(setTeam).catch(() => setTeam([]));
    void call<Board>('GET', '/v1/staff/board').then(setBoard).catch(() => setBoard({ openShifts: [], offers: [] }));
  }, [call]);
  useEffect(load, [load]);
  const after = () => { load(); refresh(); };
  const { busy, run, note } = useAction(say, after);
  const offered = new Set(requests.filter((r) => r.kind === 'swap' && (r.status === 'pending' || r.status === 'accepted')).map((r) => r.line));

  return (
    <>
      {board && (board.offers.length > 0 || board.openShifts.length > 0) && (
        <Card title="Shifts you could pick up">
          {note}
          <ul className="staff-list staff-actions">
            {board.offers.map((o) => (
              <li key={o.id}>
                <span className="staff-day">{o.directed ? 'Asked you' : 'Swap'}</span>
                <span>
                  <span className="strong">{o.line}</span>
                  <span className="muted small"> from {o.from}{o.returnLine ? `, for your ${o.returnLine}` : ''}{o.note ? `. ${o.note}` : ''}</span>
                  <span className="staff-buttons">
                    <button className="primary" disabled={busy} onClick={() => void run(() => call('POST', `/v1/staff/swaps/${o.id}/accept`), 'Agreed. Your manager will confirm, and until then the shift stays with them.')}>Take it</button>
                    {o.directed && <button disabled={busy} onClick={() => void run(() => call('POST', `/v1/staff/swaps/${o.id}/decline`), 'Turned down. They have been told.')}>Not this time</button>}
                  </span>
                </span>
              </li>
            ))}
            {board.openShifts.map((o) => (
              <li key={o.id}>
                <span className="staff-day">Open shift</span>
                <span>
                  <span className="strong">{o.line}</span>
                  {o.note && <span className="muted small"> {o.note}</span>}
                  <span className="staff-buttons">
                    {o.claimed ? (
                      <span className="muted small">You asked for this. Waiting for your manager.</span>
                    ) : (
                      <button className="primary" disabled={busy} onClick={() => void run(() => call('POST', `/v1/staff/open-shifts/${o.id}/claim`), 'Asked for. Your manager confirms who gets it.')}>I can do it</button>
                    )}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="My rota and who I am working with">
        {team === null ? (
          <p className="muted">Loading</p>
        ) : team.length === 0 ? (
          <p className="muted">No published shifts in the next two weeks.</p>
        ) : (
          <ul className="staff-list">
            {team.map((s) => (
              <li key={s.shiftId}>
                <span className="staff-day">{s.date === today ? 'Today' : day(s.date)}</span>
                <span>
                  <span className="strong">{s.line.replace(/^\S+ \d+ \S+ /, '')}</span>
                  <span className="muted small">
                    {' '}
                    {s.team.length ? `With ${s.team.map((t) => `${t.name} (${t.role}, ${formatMinute(t.startMinute)}-${formatMinute(t.endMinute)})`).join(', ')}` : 'Nobody else on yet'}
                  </span>
                  <span className="staff-buttons">
                    {offered.has(s.line) ? (
                      <span className="muted small">Up for a swap</span>
                    ) : (
                      <button disabled={busy} onClick={() => setSwapping(swapping === s.shiftId ? null : s.shiftId)}>{swapping === s.shiftId ? 'Close' : 'Swap or give away'}</button>
                    )}
                  </span>
                  {swapping === s.shiftId && <SwapForm call={call} say={say} shiftId={s.shiftId} onDone={() => { setSwapping(null); after(); }} />}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function SwapForm({ call, say, shiftId, onDone }: { call: Call; say: Say; shiftId: string; onDone: () => void }) {
  const [options, setOptions] = useState<SwapOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [to, setTo] = useState('');
  const [back, setBack] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call<SwapOptions>('GET', `/v1/staff/shifts/${shiftId}/swap-options`).then(setOptions).catch((e) => setError(say(e)));
  }, [call, say, shiftId]);
  const person = options?.people.find((p) => p.id === to);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await call('POST', '/v1/staff/swaps', { shiftId, ...(to ? { toEmployeeId: to } : {}), ...(back ? { returnShiftId: back } : {}), ...(form.get('note') ? { note: form.get('note') } : {}) });
      onDone();
    } catch (err) {
      setError(say(err));
      setBusy(false);
    }
  }
  if (error && !options) return <p className="staff-msg bad">{error}</p>;
  if (!options) return <p className="muted small">Finding who could take it</p>;
  return (
    <form className="staff-form staff-inset" onSubmit={submit}>
      <p className="muted small">Only people trained for the role, free and within the rules are listed. Your manager approves every swap.</p>
      <label>
        Who
        <select value={to} onChange={(e) => { setTo(e.target.value); setBack(''); }}>
          <option value="">Anyone who can ({options.people.length})</option>
          {options.people.map((p) => <option key={p.id} value={p.id}>{p.name}, {p.role}</option>)}
        </select>
      </label>
      {person && person.shifts.length > 0 && (
        <label>
          In return
          <select value={back} onChange={(e) => setBack(e.target.value)}>
            <option value="">Nothing, I am giving it away</option>
            {person.shifts.map((s) => <option key={s.id} value={s.id}>Their {s.line}</option>)}
          </select>
        </label>
      )}
      <label>Message (optional) <input name="note" maxLength={300} /></label>
      {error && <p className="staff-msg bad">{error}</p>}
      <button className="primary" disabled={busy || options.people.length === 0}>{busy ? 'Sending' : to ? 'Ask them' : 'Offer it to the team'}</button>
    </form>
  );
}

// ------------------------------------------------------------------------------------------------
// Requests: holiday, time off, sickness, availability.

export function RequestsTab({ call, say, data, refresh }: { call: Call; say: Say; data: SelfServiceData; refresh: () => void }) {
  const { busy, run, note } = useAction(say, refresh);
  const h = data.holiday;
  const days = (hours: number) => (h.dayHours > 0 ? ` (about ${(hours / h.dayHours).toFixed(1)} days)` : '');

  function form(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const target = e.currentTarget;
    return { get: (k: string) => String(f.get(k) ?? '').trim(), reset: () => target.reset() };
  }

  return (
    <>
      {note}
      <Card title="Holiday">
        <p className="staff-figure"><span className="strong">{h.remainingHours} hours left</span><span className="muted small">{days(h.remainingHours)} to {day(h.yearEnd)}</span></p>
        <p className="muted small">Taken {h.takenHours} h, booked {h.bookedHours} h.{h.upcoming.length ? ` Booked: ${h.upcoming.map(day).join(', ')}.` : ''}</p>
        <form
          className="staff-form"
          onSubmit={(e) => {
            const f = form(e);
            void run(() => call('POST', '/v1/staff/requests/holiday', { from: f.get('from'), to: f.get('to') || f.get('from'), ...(f.get('note') ? { note: f.get('note') } : {}) }).then(f.reset), 'Holiday asked for. You will hear when your manager decides.');
          }}
        >
          <div className="staff-pair">
            <label>First day <input type="date" name="from" min={data.today} required /></label>
            <label>Last day <input type="date" name="to" min={data.today} /></label>
          </div>
          <label>Note (optional) <input name="note" maxLength={300} /></label>
          <button className="primary" disabled={busy}>Ask for holiday</button>
        </form>
      </Card>

      <Card title={data.sick ? 'Off sick' : 'Sick or other time off'}>
        {data.sick ? (
          <form
            className="staff-form"
            onSubmit={(e) => {
              const f = form(e);
              void run(() => call('POST', '/v1/staff/sick/back', { lastDayOff: f.get('lastDayOff') }), 'Thanks. Welcome back; your manager will check in with you.');
            }}
          >
            <p className="muted small">Off since {day(data.sick.from)}. Get well soon. Tell us when you are back.</p>
            <label>Last day off <input type="date" name="lastDayOff" min={data.sick.from} required /></label>
            <button className="primary" disabled={busy}>I am back</button>
          </form>
        ) : (
          <form
            className="staff-form"
            onSubmit={(e) => {
              const f = form(e);
              void run(() => call('POST', '/v1/staff/sick', { from: f.get('from') || data.today, ...(f.get('note') ? { note: f.get('note') } : {}) }).then(f.reset), 'Recorded. Your manager has been told and will cover your shifts. Rest up.');
            }}
          >
            <p className="muted small">Report it before your shift if you can. Your manager will arrange cover. Only people who keep personnel files see what you write here.</p>
            <label>From <input type="date" name="from" defaultValue={data.today} required /></label>
            <label>What is wrong (optional) <input name="note" maxLength={500} /></label>
            <button className="primary" disabled={busy}>Report sick</button>
          </form>
        )}
        {data.fitNoteFor && <FitNote say={say} fitNote={data.fitNoteFor} onDone={refresh} />}
        <details>
          <summary>Other time off</summary>
          <form
            className="staff-form"
            onSubmit={(e) => {
              const f = form(e);
              void run(() => call('POST', '/v1/staff/requests/time-off', { absenceType: f.get('type'), from: f.get('from'), to: f.get('to') || f.get('from'), ...(f.get('note') ? { note: f.get('note') } : {}) }).then(f.reset), 'Asked for. Your manager will be in touch.');
            }}
          >
            <label>
              Kind
              <select name="type" defaultValue="compassionate">
                <option value="compassionate">Compassionate (bereavement)</option>
                <option value="dependants">Emergency for a dependant</option>
                <option value="family">Maternity, paternity or adoption</option>
                <option value="unpaid">Unpaid leave</option>
                <option value="other">Something else</option>
              </select>
            </label>
            <div className="staff-pair">
              <label>First day <input type="date" name="from" required /></label>
              <label>Last day <input type="date" name="to" /></label>
            </div>
            <label>Note (optional, private to HR) <input name="note" maxLength={500} /></label>
            <button disabled={busy}>Ask for time off</button>
          </form>
        </details>
      </Card>

      <AvailabilityCard call={call} say={say} data={data} refresh={refresh} />

      <Card title="My requests">
        {data.requests.length === 0 ? (
          <p className="muted">Nothing asked for in the last month.</p>
        ) : (
          <ul className="staff-list">
            {data.requests.map((r) => (
              <li key={r.id}>
                <span className="staff-day">{KIND[r.kind]}</span>
                <span>
                  <span className="strong">{r.line ?? (r.kind === 'availability' ? 'New weekly availability' : span(r.from, r.to))}</span>
                  <span className="muted small">
                    {' '}{r.absenceLabel ? `${r.absenceLabel}. ` : ''}{r.hours ? `${r.hours} h. ` : ''}{r.withName ? `With ${r.withName}. ` : ''}
                    {r.returnLine ? `For their ${r.returnLine}. ` : ''}
                    <span className={r.status === 'approved' ? 'good-text' : r.status === 'declined' ? 'bad-text' : ''}>{r.kind === 'sickness' && r.status === 'approved' ? 'Seen by your manager' : STATUS[r.status]}</span>
                    {r.decidedBy && r.status !== 'cancelled' ? ` by ${r.decidedBy}` : ''}{r.decisionNote ? `: ${r.decisionNote}` : ''}
                  </span>
                  {r.canCancel && (
                    <span className="staff-buttons">
                      <button disabled={busy} onClick={() => void run(() => call('POST', `/v1/staff/requests/${r.id}/cancel`), 'Withdrawn.')}>Withdraw</button>
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function FitNote({ say, fitNote, onDone }: { say: Say; fitNote: NonNullable<SelfServiceData['fitNoteFor']>; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  async function upload(file: File) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/v1/staff/fit-note?fileName=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(body.message ?? 'Upload failed.'), { status: res.status });
      setMessage({ tone: 'good', text: 'Fit note sent. Keep the original safe.' });
      onDone();
    } catch (e) {
      setMessage({ tone: 'bad', text: e instanceof Error ? e.message : say(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="staff-inset staff-form">
      <p className="muted small">
        Fit note for your sickness from {day(fitNote.from)}{fitNote.to ? ` to ${day(fitNote.to)}` : ''}. Needed after seven days off.
        {fitNote.uploaded ? ` ${fitNote.uploaded} on file.` : ''}
      </p>
      <label className="staff-upload">
        {busy ? 'Sending' : 'Photograph or upload fit note'}
        <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
      </label>
      {message && <p className={`staff-msg ${message.tone}`}>{message.text}</p>}
    </div>
  );
}

function AvailabilityCard({ call, say, data, refresh }: { call: Call; say: Say; data: SelfServiceData; refresh: () => void }) {
  const { busy, run, note } = useAction(say, refresh);
  const pending = data.requests.some((r) => r.kind === 'availability' && r.status === 'pending');
  // One row per weekday: on or off, and the hours.
  const [rows, setRows] = useState(() =>
    WEEKDAYS.map((_, weekday) => {
      const a = data.availability.find((x) => x.weekday === weekday);
      return { on: data.availability.length === 0 || Boolean(a), from: formatMinute(a?.fromMinute ?? 9 * 60), to: formatMinute(a?.toMinute ?? 23 * 60) };
    }),
  );
  const [dates, setDates] = useState(data.unavailable);
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  function pattern(): Availability[] {
    return rows.flatMap((r, weekday) => {
      if (!r.on) return [];
      const from = parseClock(r.from);
      let to = parseClock(r.to);
      // Finishing after midnight runs into the next day.
      if (to <= from) to += 1440;
      return [{ weekday, fromMinute: from, toMinute: to }];
    });
  }

  return (
    <Card title="When I can work">
      {note}
      <p className="muted small">
        {data.availability.length === 0 ? 'Your manager has you down as available any time.' : `Now: ${data.availability.map((a) => `${WEEKDAYS[a.weekday].slice(0, 3)} ${formatMinute(a.fromMinute)}-${formatMinute(a.toMinute)}`).join(', ')}.`}
        {pending ? ' A change is waiting for your manager.' : ''}
      </p>
      <details>
        <summary>Change my usual week</summary>
        <div className="staff-form">
          {rows.map((r, i) => (
            <div className="staff-avail" key={WEEKDAYS[i]}>
              <label className="staff-check"><input type="checkbox" checked={r.on} onChange={(e) => set(i, { on: e.target.checked })} /> {WEEKDAYS[i]}</label>
              <input type="time" value={r.from} disabled={!r.on} onChange={(e) => set(i, { from: e.target.value })} aria-label={`${WEEKDAYS[i]} from`} />
              <input type="time" value={r.to} disabled={!r.on} onChange={(e) => set(i, { to: e.target.value })} aria-label={`${WEEKDAYS[i]} until`} />
            </div>
          ))}
          <button className="primary" disabled={busy} onClick={() => void run(() => call('POST', '/v1/staff/requests/availability', { availability: pattern() }), 'Sent to your manager to approve.')}>Send to my manager</button>
        </div>
      </details>
      <details>
        <summary>Days I cannot work{dates.length ? ` (${dates.length})` : ''}</summary>
        <form
          className="staff-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const next = [...dates.filter((d) => d.date !== f.get('date')), { date: String(f.get('date')), ...(f.get('note') ? { note: String(f.get('note')) } : {}) }].sort((a, b) => a.date.localeCompare(b.date));
            const target = e.currentTarget;
            void run(async () => {
              const res = await call<{ unavailable: typeof dates; rostered: string[] }>('PUT', '/v1/staff/unavailable', { dates: next });
              setDates(res.unavailable);
              target.reset();
              return res.rostered.length ? `Saved, but you are already on ${res.rostered.join('; ')}. Swap it or ask for time off.` : undefined;
            }, 'Saved. The rota will steer round it.');
          }}
        >
          <ul className="staff-list">
            {dates.map((d) => (
              <li key={d.date}>
                <span className="staff-day">{day(d.date)}</span>
                <span>
                  {d.note ?? ''}
                  <span className="staff-buttons">
                    <button type="button" disabled={busy} onClick={() => void run(async () => { const res = await call<{ unavailable: typeof dates }>('PUT', '/v1/staff/unavailable', { dates: dates.filter((x) => x.date !== d.date) }); setDates(res.unavailable); }, 'Removed.')}>Remove</button>
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <div className="staff-pair">
            <label>Day <input type="date" name="date" min={data.today} required /></label>
            <label>Why (optional) <input name="note" maxLength={120} /></label>
          </div>
          <button disabled={busy}>Add day</button>
        </form>
      </details>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------
// Inbox.

interface Notice {
  id: string;
  kind: string;
  at: string;
  title: string;
  body: string;
  read: boolean;
}

/** Notifications on this phone: why they cannot be, or a switch, and a test once on. */
function PushCard({ call, say }: { call: Call; say: Say }) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [others, setOthers] = useState(0);
  const check = useCallback(async () => {
    try {
      const info = await call<{ devices: { endpoint: string }[] }>('GET', '/v1/staff/push');
      const now = await pushState(info.devices.map((d) => d.endpoint));
      setState(now);
      setOthers(info.devices.filter((d) => now.kind !== 'on' || d.endpoint !== now.endpoint).length);
    } catch {
      setState({ kind: 'unsupported' });
    }
  }, [call]);
  useEffect(() => void check(), [check]);

  async function act(work: () => Promise<string | null | void>, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      const problem = await work();
      setMessage(problem ? { tone: 'bad', text: problem } : { tone: 'good', text: done });
      await check();
    } catch (e) {
      setMessage({ tone: 'bad', text: say(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;
  return (
    <section className="staff-card staff-form">
      <h2>Notifications on this phone</h2>
      {state.kind === 'unsupported' && <p className="muted small">This browser cannot show notifications from Preshift. Messages still arrive here and by email.</p>}
      {state.kind === 'install-first' && (
        <p className="muted small">
          On an iPhone, add Preshift to your home screen first: tap the Share button, then Add to Home Screen. Open Preshift from the new icon,
          come back here, and turn notifications on.
        </p>
      )}
      {state.kind === 'blocked' && <p className="muted small">Notifications are blocked for Preshift. Allow them in your phone settings, then come back here.</p>}
      {state.kind === 'off' && (
        <>
          <p className="muted small">Get told on your phone when your rota is out, a shift changes, a shift you could pick up is posted, or a request is decided.</p>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void act(async () => {
              const { publicKey } = await call<{ publicKey: string }>('GET', '/v1/staff/push');
              return turnOn(publicKey, (body) => call('POST', '/v1/staff/push/subscribe', body));
            }, 'Notifications are on for this phone.')}
          >
            {busy ? 'Turning on' : 'Turn on notifications'}
          </button>
        </>
      )}
      {state.kind === 'on' && (
        <>
          <p className="good-text small">On for this phone.{others ? ` Also on for ${others} other phone${others === 1 ? '' : 's'} or browser${others === 1 ? '' : 's'}.` : ''}</p>
          <div className="staff-buttons">
            <button disabled={busy} onClick={() => void act(async () => {
              const r = await call<{ sent: number }>('POST', '/v1/staff/push/test');
              return r.sent ? null : 'The test did not reach your phone. Turn notifications off and on again.';
            }, 'Sent. It should appear in a few seconds.')}>Send a test</button>
            <button disabled={busy} onClick={() => void act(() => turnOff((body) => call('POST', '/v1/staff/push/unsubscribe', body)), 'Notifications are off for this phone.')}>Turn off</button>
          </div>
        </>
      )}
      {message && <p className={`staff-msg ${message.tone}`} role="status">{message.text}</p>}
    </section>
  );
}

export function InboxTab({ call, say, refresh }: { call: Call; say: Say; refresh: () => void }) {
  const [list, setList] = useState<Notice[] | null>(null);
  useEffect(() => {
    call<Notice[]>('GET', '/v1/staff/notifications')
      .then((items) => {
        setList(items);
        // Seen once opened.
        if (items.some((n) => !n.read)) void call('POST', '/v1/staff/notifications/read', {}).then(refresh);
      })
      .catch(() => setList([]));
  }, [call, refresh]);
  return (
    <>
    <PushCard call={call} say={say} />
    <section className="staff-card">
      <h2>Messages</h2>
      {list === null ? (
        <p className="muted">Loading</p>
      ) : list.length === 0 ? (
        <p className="muted">Nothing yet. When your rota is published or something changes, it shows here.</p>
      ) : (
        <ul className="staff-list staff-inbox">
          {list.map((n) => (
            <li key={n.id} className={n.read ? '' : 'unread'}>
              <span className="staff-day">{day(n.at.slice(0, 10))}</span>
              <span>
                <span className="strong">{n.title}</span>
                <span className="muted small"> {n.body}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
    </>
  );
}
