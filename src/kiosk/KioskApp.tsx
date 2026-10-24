import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { formatMinute } from '../engine/time';

type Status = 'not_in' | 'in' | 'break' | 'out' | 'elsewhere';
type Action = 'in' | 'out' | 'break_start' | 'break_end';

interface Person {
  id: string;
  name: string;
  role: string | null;
  shift: { start: number; end: number } | null;
  status: Status;
  since: number | null;
  hasPin: boolean;
}

interface Board {
  kiosk: { name: string };
  site: { id: string; name: string };
  today: string;
  /** Signing in by name needs the person's PIN at this site. */
  pinRequired: boolean;
  people: Person[];
}

interface Result {
  action: string;
  name: string;
  entry: { clockIn: number; clockOut?: number; breaks?: { start: number; end?: number }[] };
  board: Board;
}

type Banner = { tone: 'good' | 'bad'; text: string };

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

const say = (e: unknown) => (e instanceof Problem ? e.message : 'Cannot reach Preshift. Check the wifi, then try again.');

/** Web NFC, on Android Chrome: reads a card with the tablet itself. iPads have no web NFC. */
interface NdefReaderLike {
  scan(): Promise<void>;
  onreading: ((event: { serialNumber: string }) => void) | null;
}
const NdefReader = (globalThis as unknown as { NDEFReader?: new () => NdefReaderLike }).NDEFReader;

const STATUS_TEXT: Record<Status, (p: Person) => string> = {
  not_in: () => 'Not in yet',
  in: (p) => `In since ${formatMinute(p.since ?? 0)}`,
  break: (p) => `On break since ${formatMinute(p.since ?? 0)}`,
  out: (p) => `Clocked out ${formatMinute(p.since ?? 0)}`,
  elsewhere: () => 'Clocked in at another site',
};

const ACTIONS: Record<Status, { action: Action; label: string; primary?: boolean }[]> = {
  not_in: [{ action: 'in', label: 'Clock in', primary: true }],
  out: [{ action: 'in', label: 'Clock in again', primary: true }],
  in: [{ action: 'break_start', label: 'Start break' }, { action: 'out', label: 'Clock out', primary: true }],
  break: [{ action: 'break_end', label: 'End break', primary: true }, { action: 'out', label: 'Clock out' }],
  elsewhere: [{ action: 'out', label: 'Clock out there', primary: true }],
};

function resultText(r: Result): string {
  const last = r.entry.breaks?.at(-1);
  switch (r.action) {
    case 'in':
    case 'clock_in':
      return `Welcome, ${r.name}. Clocked in at ${formatMinute(r.entry.clockIn)}.`;
    case 'out':
    case 'clock_out':
      return `Thanks, ${r.name}. Clocked out at ${formatMinute(r.entry.clockOut ?? 0)}.`;
    case 'break_start':
      return `Enjoy your break, ${r.name}. Started at ${formatMinute(last?.start ?? 0)}.`;
    case 'break_end':
      return `Welcome back, ${r.name}. Break was ${(last?.end ?? 0) - (last?.start ?? 0)} minutes.`;
    case 'already_clocked_in':
      return `${r.name}, you are already clocked in from ${formatMinute(r.entry.clockIn)}.`;
    case 'already_clocked_out':
      return `${r.name}, you clocked out at ${formatMinute(r.entry.clockOut ?? 0)}.`;
    default:
      return 'Done.';
  }
}

/**
 * The kiosk for a shared iPad at the staff entrance. It can clock people in and out and do
 * nothing else: there is no way from here into the rota, pay or anyone's records.
 */
export function KioskApp() {
  const [board, setBoard] = useState<Board | null>(null);
  const [view, setView] = useState<'loading' | 'unpaired' | 'ready' | 'offline'>('loading');
  const [banner, setBanner] = useState<Banner | null>(null);
  const [picked, setPicked] = useState<Person | null>(null);
  // With a PIN required, the chosen action waits here for the PIN pad.
  const [pending, setPending] = useState<{ action: Action; label: string } | null>(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [card, setCard] = useState('');
  const [now, setNow] = useState(new Date());
  const [nfcOn, setNfcOn] = useState(false);
  const cardInput = useRef<HTMLInputElement>(null);
  const timers = useRef<{ banner?: ReturnType<typeof setTimeout>; sheet?: ReturnType<typeof setTimeout> }>({});

  const load = useCallback(async () => {
    try {
      setBoard(await call<Board>('GET', '/v1/kiosk/board'));
      setView('ready');
    } catch (e) {
      if (e instanceof Problem && e.status === 401) setView('unpaired');
      else setView((v) => (v === 'ready' ? 'ready' : 'offline'));
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = setInterval(() => void load(), 60_000);
    const tick = setInterval(() => setNow(new Date()), 10_000);
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(refresh);
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  // Keep the screen awake where the browser allows it, so the kiosk is always ready.
  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<unknown> } };
    const ask = () => void nav.wakeLock?.request('screen').catch(() => undefined);
    ask();
    document.addEventListener('visibilitychange', ask);
    return () => document.removeEventListener('visibilitychange', ask);
  }, []);

  // The card field takes the reader's typing, so it is kept ready whenever nothing else is open.
  useEffect(() => {
    if (!picked && !busy) cardInput.current?.focus();
  }, [picked, busy, view]);

  const show = (b: Banner) => {
    setBanner(b);
    clearTimeout(timers.current.banner);
    timers.current.banner = setTimeout(() => setBanner(null), 7000);
  };

  const closeSheet = () => {
    setPicked(null);
    setPending(null);
    setPin('');
    setPinError(null);
  };

  async function run(fn: () => Promise<Result>) {
    setBusy(true);
    try {
      const res = await fn();
      setBoard(res.board);
      show({ tone: 'good', text: resultText(res) });
      closeSheet();
    } catch (e) {
      // A wrong PIN keeps the pad open for another go; anything else closes the sheet and says why.
      if (e instanceof Problem && (e.code === 'wrong_pin' || e.code === 'pin_required')) {
        setPin('');
        setPinError(e.message);
      } else {
        if (e instanceof Problem && e.code === 'not_paired') setView('unpaired');
        show({ tone: 'bad', text: say(e) });
        closeSheet();
      }
    } finally {
      setBusy(false);
    }
  }

  const clockByName = (person: Person, action: Action, withPin?: string) =>
    run(() => call<Result>('POST', '/v1/kiosk/clock', { employeeId: person.id, action, ...(withPin ? { pin: withPin } : {}) }));

  function choose(person: Person, a: { action: Action; label: string }) {
    if (!board?.pinRequired) return void clockByName(person, a.action);
    setPending(a);
    setPin('');
    setPinError(null);
    pick(person);
  }

  function press(key: string) {
    if (!picked || !pending || busy) return;
    // Each key restarts the walk-away timer, so a slow typist is not cut off.
    pick(picked);
    if (key === 'back') return setPin((p) => p.slice(0, -1));
    if (key === 'ok') return pin.length >= 4 ? void clockByName(picked, pending.action, pin) : undefined;
    setPin((p) => (p.length < 6 ? p + key : p));
  }

  const tap = (raw: string) => {
    const badgeId = raw.trim();
    if (badgeId) void run(() => call<Result>('POST', '/v1/kiosk/tap', { badgeId }));
  };

  function submitCard(e: FormEvent) {
    e.preventDefault();
    const value = card;
    setCard('');
    tap(value);
  }

  function pick(person: Person) {
    setPicked(person);
    clearTimeout(timers.current.sheet);
    // Walked away mid-choice: the sheet closes itself so the next person starts clean.
    timers.current.sheet = setTimeout(closeSheet, 20_000);
  }

  async function startNfc() {
    if (!NdefReader) return;
    try {
      const reader = new NdefReader();
      await reader.scan();
      reader.onreading = (event) => tap(event.serialNumber);
      setNfcOn(true);
    } catch {
      show({ tone: 'bad', text: 'NFC was not allowed. Turn on NFC in the tablet settings and try again.' });
    }
  }

  if (view === 'loading') return <div className="kiosk kiosk-center"><p className="muted">Loading</p></div>;
  if (view === 'unpaired') {
    return (
      <div className="kiosk kiosk-center">
        <div className="kiosk-card kiosk-setup">
          <span className="brand-mark" aria-hidden>P</span>
          <h1>This iPad is not set up as a kiosk</h1>
          <p>A manager sets it up once, on this iPad:</p>
          <ol>
            <li>Sign in to Preshift here.</li>
            <li>Choose the site, then Clock in, then Clock-in setup.</li>
            <li>Under Kiosks, press Turn this device into a kiosk.</li>
          </ol>
          <p className="muted">You are signed out as part of the set-up, so the iPad never stays signed in as a manager.</p>
          <a className="kiosk-button primary" href="/login?next=/app/">Sign in to set up</a>
        </div>
      </div>
    );
  }
  if (!board) {
    return (
      <div className="kiosk kiosk-center">
        <div className="kiosk-card kiosk-setup">
          <h1>Cannot reach Preshift</h1>
          <p>Check the wifi. The kiosk will try again every minute.</p>
          <button className="kiosk-button primary" onClick={() => void load()}>Try again now</button>
        </div>
      </div>
    );
  }

  return (
    <div className="kiosk">
      <header className="kiosk-top">
        <div>
          <div className="kiosk-site">{board.site.name}</div>
          <div className="kiosk-date">{now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' })}</div>
        </div>
        <div className="kiosk-time tnum">{now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })}</div>
      </header>

      <form className="kiosk-card kiosk-reader" onSubmit={submitCard}>
        <label htmlFor="kiosk-card">Tap your card</label>
        <input
          id="kiosk-card"
          ref={cardInput}
          value={card}
          onChange={(e) => setCard(e.target.value)}
          onBlur={() => setTimeout(() => !picked && cardInput.current?.focus(), 300)}
          autoComplete="off"
          inputMode="none"
          placeholder="Hold your card to the reader"
          disabled={busy}
        />
        <p className="muted">
          No card? Find your name below.
          {NdefReader && !nfcOn && <> <button type="button" className="link" onClick={() => void startNfc()}>Read cards with this tablet</button></>}
        </p>
      </form>

      {banner && <div className={`kiosk-banner ${banner.tone}`} role="status">{banner.text}</div>}

      <section className="kiosk-people" aria-label="Today's rota">
        {board.people.length === 0 && <p className="muted kiosk-empty">Nobody is on today's rota here yet. Tap your card, or ask a manager to add your shift.</p>}
        {board.people.map((p) => (
          <button key={p.id} className={`kiosk-person status-${p.status}`} onClick={() => pick(p)} disabled={busy}>
            <span className="kiosk-name">{p.name}</span>
            <span className="kiosk-shift">
              {p.shift ? `${formatMinute(p.shift.start)} to ${formatMinute(p.shift.end)}` : 'Not on the rota'}
              {p.role ? `, ${p.role}` : ''}
            </span>
            <span className="kiosk-status">{STATUS_TEXT[p.status](p)}</span>
          </button>
        ))}
      </section>

      <footer className="kiosk-foot muted">Kiosk: {board.kiosk.name}</footer>

      {picked && (
        <div className="kiosk-sheet-backdrop" onClick={(e) => e.target === e.currentTarget && closeSheet()}>
          <div className="kiosk-sheet" role="dialog" aria-modal="true" aria-label={picked.name}>
            <h2>{picked.name}</h2>
            {pending ? (
              <>
                <p className="muted">{pending.label}: enter your PIN</p>
                <div className="kiosk-pin-dots" aria-live="polite" aria-label={`${pin.length} digits entered`}>
                  {Array.from({ length: Math.max(4, pin.length) }, (_, i) => <span key={i} className={i < pin.length ? 'on' : ''} />)}
                </div>
                {pinError && <p className="kiosk-pin-error" role="alert">{pinError}</p>}
                <div className="kiosk-pad">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'ok'].map((k) => (
                    <button
                      key={k}
                      className={`kiosk-key ${k === 'ok' ? 'primary' : ''}`}
                      disabled={busy || (k === 'ok' && pin.length < 4)}
                      onClick={() => press(k)}
                      aria-label={k === 'back' ? 'Delete' : k === 'ok' ? 'Done' : k}
                    >
                      {k === 'back' ? 'Delete' : k === 'ok' ? 'Done' : k}
                    </button>
                  ))}
                </div>
                <button className="kiosk-button ghost" onClick={closeSheet}>Cancel</button>
              </>
            ) : (
              <>
                <p className="muted">{STATUS_TEXT[picked.status](picked)}</p>
                {board.pinRequired && !picked.hasPin && (
                  <p className="kiosk-pin-error">You need a PIN to sign in by name here. Set one in the staff app, ask a manager, or use your card.</p>
                )}
                <div className="kiosk-sheet-actions">
                  {ACTIONS[picked.status].map((a) => (
                    <button
                      key={a.action}
                      className={`kiosk-button ${a.primary ? 'primary' : ''}`}
                      disabled={busy || (board.pinRequired && !picked.hasPin)}
                      onClick={() => choose(picked, a)}
                    >
                      {a.label}
                    </button>
                  ))}
                  <button className="kiosk-button ghost" onClick={closeSheet}>Not me</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
