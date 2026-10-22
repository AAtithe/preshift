import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { checkFence } from '../engine/clocking';
import { formatMinute } from '../engine/time';
import type { GeoFence, GeoFix } from '../engine/types';
import { dayLabel } from '../ui/format';

interface Entry {
  id: string;
  date: string;
  siteId: string;
  siteName: string;
  clockIn: number;
  clockOut: number | null;
  breakMinutes: number;
  status: 'open' | 'submitted' | 'approved' | 'rejected';
  method: string | null;
  breaks: { start: number; end?: number }[];
  onBreak: boolean;
}

interface Overview {
  employee: { id: string; name: string };
  email?: string;
  today: string;
  sites: { id: string; name: string; geofence: GeoFence | null }[];
  open: Entry | null;
  shifts: { id: string; date: string; startMinute: number; endMinute: number; breakMinutes: number; siteName: string; roleName: string }[];
  recent: Entry[];
  /** The legal minimum break for the shift they are on, when there is one. */
  breakEntitlement: { minutes: number; planned: number; under18: boolean } | null;
  /** Their own contact details, which they keep up to date. */
  details: Details;
}

interface Details {
  phone: string;
  address: string;
  postcode: string;
  emergencyContact: { name: string; relationship?: string; phone: string } | null;
}

type GeoState = { status: 'locating' | 'denied' | 'unavailable' } | { status: 'ok'; fix: GeoFix };

class Problem extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Problem(res.status, data.error ?? 'http_error', data.message ?? 'Something went wrong. Try again.');
  return data as T;
}

const say = (e: unknown) => (e instanceof Problem ? e.message : 'Could not reach Preshift. Check your signal and try again.');

/**
 * The invite in the link, read once. Links carry it after #, which never reaches a server; links
 * sent before that carry it in the query. Either way the address bar is cleared straight away, so
 * the token is not left in history or shared by accident.
 */
function readInvite() {
  const fromHash = new URLSearchParams(window.location.hash.slice(1));
  const params = fromHash.get('invite') ? fromHash : new URLSearchParams(window.location.search);
  if (!params.get('invite')) return null;
  window.history.replaceState(null, '', '/staff/');
  return { org: params.get('org') ?? '', person: params.get('person') ?? '', invite: params.get('invite') ?? '' };
}

/** Read when the app loads, once, before anything can render twice. */
const INVITE = readInvite();

/** The staff app: a person's own login on their own phone, to clock in and out and see their shifts. */
export function StaffApp() {
  const invite = INVITE;
  const [view, setView] = useState<'loading' | 'login' | 'join' | 'home'>('loading');
  const [data, setData] = useState<Overview | null>(null);
  const [joining, setJoining] = useState<{ name: string; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const show = (overview: Overview) => {
    setData(overview);
    setView('home');
    setError(null);
  };

  useEffect(() => {
    if (invite) {
      call<{ name: string; email: string }>('POST', '/v1/staff/invite', invite)
        .then((info) => { setJoining(info); setView('join'); })
        .catch((e) => { setError(say(e)); setView('login'); });
      return;
    }
    call<Overview>('GET', '/v1/staff/me').then(show).catch(() => setView('login'));
    // Only on first load: the invite is read once from the link.
  }, []);

  return (
    <div className="staff">
      <header className="staff-top">
        <span className="brand-mark" aria-hidden>P</span>
        <div className="staff-top-text">
          <div className="brand-name">Preshift</div>
          {data && view === 'home' ? <div className="brand-sub">{data.employee.name}</div> : <div className="brand-sub">For staff</div>}
        </div>
        {view === 'home' && (
          <button className="link" onClick={() => void call('POST', '/v1/staff/logout').then(() => { setData(null); setView('login'); })}>Sign out</button>
        )}
      </header>
      {error && <p className="staff-msg bad" role="alert">{error}</p>}
      {view === 'loading' && <p className="muted">Loading</p>}
      {view === 'login' && <Login onDone={show} />}
      {view === 'join' && joining && invite && (
        <Join
          info={joining}
          onSubmit={async (email, password) => {
            show(await call<Overview>('POST', '/v1/staff/join', { ...invite, email, password }));
          }}
        />
      )}
      {view === 'home' && data && <Home data={data} onChange={setData} onSignedOut={() => setView('login')} />}
    </div>
  );
}

function Login({ onDone }: { onDone: (o: Overview) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      onDone(await call<Overview>('POST', '/v1/staff/login', { email: form.get('email'), password: form.get('password') }));
    } catch (err) {
      setError(say(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="staff-card staff-form" onSubmit={submit}>
      <h1>Sign in</h1>
      {error && <p className="staff-msg bad" role="alert">{error}</p>}
      <label>Email <input type="email" name="email" autoComplete="username" required /></label>
      <label>Password <input type="password" name="password" autoComplete="current-password" required /></label>
      <button className="primary staff-big" disabled={busy}>{busy ? 'Signing in' : 'Sign in'}</button>
      <p className="muted small">No login yet, or forgotten your password? Ask your manager to send you an invite link.</p>
    </form>
  );
}

function Join({ info, onSubmit }: { info: { name: string; email: string }; onSubmit: (email: string, password: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get('password'));
    if (password !== form.get('confirm')) return setError('The two passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      await onSubmit(String(form.get('email')), password);
    } catch (err) {
      setError(say(err));
      setBusy(false);
    }
  }
  return (
    <form className="staff-card staff-form" onSubmit={submit}>
      <h1>Welcome, {info.name.split(' ')[0]}</h1>
      <p className="muted">Set up your login to clock in and out on this phone and see your shifts.</p>
      {error && <p className="staff-msg bad" role="alert">{error}</p>}
      <label>Your email <input type="email" name="email" defaultValue={info.email} autoComplete="username" required /></label>
      <label>Choose a password, at least 12 characters <input type="password" name="password" autoComplete="new-password" minLength={12} required /></label>
      <label>Password again <input type="password" name="confirm" autoComplete="new-password" minLength={12} required /></label>
      <button className="primary staff-big" disabled={busy}>{busy ? 'Setting up' : 'Set up my login'}</button>
    </form>
  );
}

function Home({ data, onChange, onSignedOut }: { data: Overview; onChange: (o: Overview) => void; onSignedOut: () => void }) {
  const [geo, setGeo] = useState<GeoState>({ status: 'locating' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    if (!('geolocation' in navigator)) return setGeo({ status: 'unavailable' });
    const id = navigator.geolocation.watchPosition(
      (p) => setGeo({ status: 'ok', fix: { lat: p.coords.latitude, lng: p.coords.longitude, accuracyMetres: Math.round(p.coords.accuracy) } }),
      (err) => setGeo({ status: err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  // Back on screen after a while: the shift or clock may have changed.
  const refresh = useCallback(async () => {
    try {
      onChange(await call<Overview>('GET', '/v1/staff/me'));
    } catch (e) {
      if (e instanceof Problem && e.status === 401) onSignedOut();
    }
  }, [onChange, onSignedOut]);
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const fix = geo.status === 'ok' ? geo.fix : undefined;
  const fenced = data.sites.filter((s) => s.geofence);
  const target = data.open
    ? data.sites.find((s) => s.id === data.open!.siteId)
    : (fix && fenced.find((s) => checkFence(s.geofence!, fix).ok)) || fenced[0];
  const check = target?.geofence && fix ? checkFence(target.geofence, fix) : null;
  const todays = data.shifts.filter((s) => s.date === data.today);

  const taken = data.open
    ? data.open.breaks.reduce((sum, b) => sum + (b.end !== undefined ? b.end - b.start : 0), 0)
    : 0;

  // Not location checked: a break only lowers the hours paid, and people often take it off site.
  async function breakAction(kind: 'start' | 'end') {
    setBusy(true);
    setMessage(null);
    try {
      const next = await call<Overview>('POST', `/v1/staff/break-${kind}`);
      onChange(next);
      const last = next.open?.breaks[next.open.breaks.length - 1];
      setMessage(
        kind === 'start'
          ? { tone: 'good', text: `Break started at ${formatMinute(last?.start ?? 0)}. Enjoy it.` }
          : { tone: 'good', text: `Break ended at ${formatMinute(last?.end ?? 0)}, ${(last?.end ?? 0) - (last?.start ?? 0)} minutes.` },
      );
    } catch (e) {
      if (e instanceof Problem && e.status === 401) return onSignedOut();
      setMessage({ tone: 'bad', text: say(e) });
    } finally {
      setBusy(false);
    }
  }

  async function clock() {
    setBusy(true);
    setMessage(null);
    try {
      const next = data.open
        ? await call<Overview>('POST', '/v1/staff/clock-out', { location: fix })
        : await call<Overview>('POST', '/v1/staff/clock-in', { siteId: target?.id, location: fix });
      onChange(next);
      setMessage(
        data.open
          ? { tone: 'good', text: `Clocked out at ${formatMinute(next.recent[0]?.clockOut ?? 0)}. Thanks for today.` }
          : { tone: 'good', text: `Clocked in at ${formatMinute(next.open?.clockIn ?? 0)} at ${next.open?.siteName}. Have a good shift.` },
      );
    } catch (e) {
      if (e instanceof Problem && e.status === 401) return onSignedOut();
      setMessage({ tone: 'bad', text: say(e) });
    } finally {
      setBusy(false);
    }
  }

  let where: { tone: 'good' | 'bad' | 'muted'; text: string };
  if (!target?.geofence) where = { tone: 'bad', text: 'Your site has not set up phone clocking yet. Use the tablet or card reader at work.' };
  else if (geo.status === 'locating') where = { tone: 'muted', text: 'Finding your location' };
  else if (geo.status === 'denied') where = { tone: 'bad', text: 'Location is blocked for Preshift. Allow it in your phone settings to clock in.' };
  else if (geo.status !== 'ok' || !check) where = { tone: 'bad', text: 'Your phone cannot find its location right now.' };
  else if (check.ok) where = { tone: 'good', text: `You are at ${target.name}` };
  else if (check.reason === 'too_imprecise') where = { tone: 'bad', text: 'Your location is too rough to confirm. Turn on precise location, or step outside for a moment.' };
  else where = { tone: 'bad', text: `You are ${distance(check.distanceMetres)} from ${target.name}. ${data.open ? 'Come back on site to clock out.' : 'Clock in when you arrive.'}` };

  return (
    <>
      <section className="staff-card staff-clock">
        <div className="staff-status">
          {data.open?.onBreak ? (
            <>
              <div className="staff-state warn-text">On break</div>
              <div className="muted">Since {formatMinute(data.open.breaks[data.open.breaks.length - 1].start)}. Clocked in at {formatMinute(data.open.clockIn)}, {data.open.siteName}</div>
            </>
          ) : data.open ? (
            <>
              <div className="staff-state good-text">Clocked in</div>
              <div className="muted">Since {formatMinute(data.open.clockIn)} at {data.open.siteName}</div>
            </>
          ) : (
            <>
              <div className="staff-state">Not clocked in</div>
              <div className="muted">
                {todays.length
                  ? `Today ${todays.map((s) => `${formatMinute(s.startMinute)} to ${formatMinute(s.endMinute)}, ${s.roleName} at ${s.siteName}`).join('; ')}`
                  : 'No published shift today'}
              </div>
            </>
          )}
        </div>
        {data.open && (
          <div className="staff-breaks">
            {data.open.onBreak ? (
              <button className="staff-big primary" disabled={busy} onClick={() => void breakAction('end')}>
                {busy ? 'Saving' : 'End break'}
              </button>
            ) : (
              <button className="staff-big" disabled={busy} onClick={() => void breakAction('start')}>
                {busy ? 'Saving' : 'Start break'}
              </button>
            )}
            <p className="muted small">
              {taken ? `Breaks so far: ${taken} min. ` : ''}
              {data.breakEntitlement
                ? `This shift gives you at least ${data.breakEntitlement.minutes} minutes' break${data.breakEntitlement.under18 ? ' (under 18)' : ''}${data.breakEntitlement.planned ? `; the rota plans ${data.breakEntitlement.planned}` : ''}. `
                : ''}
              Breaks are unpaid.
            </p>
          </div>
        )}
        <p className={`staff-where ${where.tone === 'good' ? 'good-text' : where.tone === 'bad' ? 'bad-text' : 'muted'}`}>{where.text}</p>
        <button
          className={`staff-big ${data.open ? '' : 'primary'}`}
          disabled={busy || !check?.ok}
          onClick={() => void clock()}
        >
          {busy ? 'Saving' : data.open ? (data.open.onBreak ? 'End break and clock out' : 'Clock out') : 'Clock in'}
        </button>
        {message && <p className={`staff-msg ${message.tone}`} role="status">{message.text}</p>}
      </section>

      <section className="staff-card">
        <h2>My shifts</h2>
        {data.shifts.length === 0 ? (
          <p className="muted">No published shifts in the next two weeks.</p>
        ) : (
          <ul className="staff-list">
            {data.shifts.map((s) => {
              const d = dayLabel(s.date);
              return (
                <li key={s.id}>
                  <span className="staff-day">{s.date === data.today ? 'Today' : `${d.short} ${d.date}`}</span>
                  <span>
                    <span className="strong">{formatMinute(s.startMinute)} to {formatMinute(s.endMinute)}</span>
                    <span className="muted small"> {s.roleName}, {s.siteName}{s.breakMinutes ? `, ${s.breakMinutes} min break` : ''}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="staff-card">
        <h2>My hours</h2>
        {data.recent.length === 0 ? (
          <p className="muted">No clocked hours in the last two weeks.</p>
        ) : (
          <ul className="staff-list">
            {data.recent.map((t) => {
              const d = dayLabel(t.date);
              const worked = t.clockOut !== null ? (t.clockOut - t.clockIn - t.breakMinutes) / 60 : 0;
              return (
                <li key={t.id}>
                  <span className="staff-day">{d.short} {d.date}</span>
                  <span>
                    <span className="strong">{formatMinute(t.clockIn)} to {t.clockOut !== null ? formatMinute(t.clockOut) : 'now'}</span>
                    <span className="muted small"> {worked.toFixed(2)} h{t.breakMinutes ? `, ${t.breakMinutes} min break` : ''}, {t.status === 'approved' ? 'approved' : 'waiting for approval'}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="muted small">Your manager checks hours and breaks, and corrects them if needed, before approval.</p>
      </section>

      <MyDetails details={data.details} onSaved={onChange} />
    </>
  );
}

/** Their phone, address and emergency contact, kept up to date by them rather than chased by the manager. */
function MyDetails({ details, onSaved }: { details: Details; onSaved: (o: Overview) => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const missing = !details.phone || !details.address || !details.emergencyContact;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const body: Record<string, unknown> = {};
    for (const k of ['phone', 'address', 'postcode']) if (text(k)) body[k] = text(k);
    if (text('ecName') || text('ecPhone')) {
      if (!text('ecName') || !text('ecPhone')) return setMessage({ tone: 'bad', text: 'Give your emergency contact a name and a phone number.' });
      body.emergencyContact = { name: text('ecName'), relationship: text('ecRelationship') || undefined, phone: text('ecPhone') };
    }
    setBusy(true);
    setMessage(null);
    try {
      onSaved(await call<Overview>('PUT', '/v1/staff/details', body));
      setMessage({ tone: 'good', text: 'Saved. Your manager sees the change on your record.' });
    } catch (err) {
      setMessage({ tone: 'bad', text: say(err) });
    } finally {
      setBusy(false);
    }
  }

  const ec = details.emergencyContact;
  return (
    <form className="staff-card staff-form" onSubmit={submit}>
      <h2>My details</h2>
      <p className="muted small">
        {missing
          ? 'Some of your details are missing. Your manager needs a phone number, your address and someone to call in an emergency.'
          : 'Keep these up to date so your manager can reach you, and someone you choose if you are taken ill at work.'}
      </p>
      <label>Mobile <input type="tel" name="phone" autoComplete="tel" defaultValue={details.phone} maxLength={30} /></label>
      <label>Address <input name="address" autoComplete="street-address" defaultValue={details.address} maxLength={500} /></label>
      <label>Postcode <input name="postcode" autoComplete="postal-code" defaultValue={details.postcode} maxLength={10} /></label>
      <h2>Emergency contact</h2>
      <label>Name <input name="ecName" defaultValue={ec?.name ?? ''} maxLength={120} /></label>
      <label>Relationship to you <input name="ecRelationship" defaultValue={ec?.relationship ?? ''} maxLength={60} placeholder="For example, partner or parent" /></label>
      <label>Their phone <input type="tel" name="ecPhone" defaultValue={ec?.phone ?? ''} maxLength={30} /></label>
      <button className="staff-big" disabled={busy}>{busy ? 'Saving' : 'Save my details'}</button>
      {message && <p className={`staff-msg ${message.tone}`} role="status">{message.text}</p>}
      <p className="muted small">Your NI number and pay are changed by your manager, so a mistake cannot reach payroll.</p>
    </form>
  );
}

const distance = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);
