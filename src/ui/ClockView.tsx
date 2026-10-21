import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { checkFence } from '../engine/clocking';
import { addDays, formatMinute } from '../engine/time';
import type { Employee, GeoFix, RotaState, TimeEntry } from '../engine/types';
import { api, ApiError } from './api';

interface Props {
  state: RotaState;
  siteId: string;
  today: string;
  onSetGeofence: (siteId: string, fence: { lat: number; lng: number; radiusMetres: number } | null) => Promise<unknown>;
  onSetBadge: (employeeId: string, badgeId: string | null) => Promise<unknown>;
  /** The site's clocking area is a site setting: settings.manage. */
  canSetFence: boolean;
  /** Issuing cards is the team's to manage at the site. */
  canEnrolCards: boolean;
}

interface TapResult {
  action: 'clock_in' | 'clock_out' | 'already_clocked_in' | 'already_clocked_out';
  employee: { id: string; name: string };
  entry: TimeEntry;
}

type GeoState = { status: 'off' | 'locating' | 'denied' | 'unavailable' } | { status: 'ok'; fix: GeoFix };
type Banner = { tone: 'good' | 'bad'; text: string };

const RADII = [50, 100, 150, 250, 500];

/** Web NFC, on Android Chrome: reads an RFID card's serial number with the phone itself. */
interface NdefReaderLike {
  scan(): Promise<void>;
  onreading: ((event: { serialNumber: string }) => void) | null;
}
const NdefReader = (globalThis as unknown as { NDEFReader?: new () => NdefReaderLike }).NDEFReader;

const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not reach Preshift. Check the connection and try again.');

/**
 * The shift sign-in screen. Runs on a tablet at the site's entrance: staff tap an RFID card on a
 * USB reader (which types the card number and presses Enter), or on the phone's NFC, or pick their
 * name. Signing in by name checks this device's location against the site's geofence.
 */
export function ClockView({ state, siteId, today, onSetGeofence, onSetBadge, canSetFence, canEnrolCards }: Props) {
  const site = state.sites.find((s) => s.id === siteId)!;
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [geo, setGeo] = useState<GeoState>({ status: 'off' });
  const [banner, setBanner] = useState<Banner | null>(null);
  const [enrolFor, setEnrolFor] = useState<Employee | null>(null);
  const [card, setCard] = useState('');
  const [busy, setBusy] = useState(false);
  const [radius, setRadius] = useState(site.geofence?.radiusMetres ?? 100);
  const [nfcOn, setNfcOn] = useState(false);
  const cardInput = useRef<HTMLInputElement>(null);
  const bannerTimer = useRef<ReturnType<typeof setTimeout>>();

  const refresh = useCallback(async () => {
    // From yesterday, so someone still in after midnight shows as in.
    const list = await api.get<TimeEntry[]>(`/v1/time-entries?siteId=${siteId}&from=${addDays(today, -1)}&to=${today}`);
    setEntries(list.filter((t) => t.date === today || t.status === 'open'));
  }, [siteId, today]);

  useEffect(() => {
    void refresh().catch(() => undefined);
    setRadius(site.geofence?.radiusMetres ?? 100);
  }, [refresh, site.geofence?.radiusMetres]);

  // Watch the device position for as long as the screen is open.
  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setGeo({ status: 'unavailable' });
      return;
    }
    setGeo({ status: 'locating' });
    const id = navigator.geolocation.watchPosition(
      (p) => setGeo({ status: 'ok', fix: { lat: p.coords.latitude, lng: p.coords.longitude, accuracyMetres: Math.round(p.coords.accuracy) } }),
      (err) => setGeo({ status: err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  const show = (b: Banner) => {
    setBanner(b);
    clearTimeout(bannerTimer.current);
    bannerTimer.current = setTimeout(() => setBanner(null), 8000);
  };
  const fix = geo.status === 'ok' ? geo.fix : undefined;
  const fence = site.geofence && fix ? checkFence(site.geofence, fix) : null;

  async function run(fn: () => Promise<Banner>) {
    setBusy(true);
    try {
      show(await fn());
      await refresh();
    } catch (e) {
      show({ tone: 'bad', text: message(e) });
    } finally {
      setBusy(false);
      cardInput.current?.focus();
    }
  }

  function readCard(raw: string) {
    const reading = raw.trim();
    if (!reading) return;
    if (enrolFor) {
      const person = enrolFor;
      setEnrolFor(null);
      return run(async () => {
        await onSetBadge(person.id, reading);
        return { tone: 'good', text: `Card enrolled for ${person.name}. They can tap it to clock in from now on.` };
      });
    }
    return run(async () => {
      const res = await api.post<TapResult>('/v1/time-entries/tap', { badgeId: reading, siteId, ...(fix ? { location: fix } : {}) });
      return { tone: 'good', text: tapText(res) };
    });
  }

  function submitCard(e: FormEvent) {
    e.preventDefault();
    const value = card;
    setCard('');
    void readCard(value);
  }

  async function startNfc() {
    if (!NdefReader) return;
    try {
      const reader = new NdefReader();
      await reader.scan();
      reader.onreading = (event) => void readCard(event.serialNumber);
      setNfcOn(true);
    } catch {
      show({ tone: 'bad', text: 'NFC was not allowed. Turn on NFC in the phone settings and try again.' });
    }
  }

  const open = (id: string) => entries.find((t) => t.employeeId === id && t.status === 'open');
  const shiftsToday = state.shifts.filter((s) => s.siteId === siteId && s.date === today).sort((a, b) => a.startMinute - b.startMinute);
  const onRota = new Set(shiftsToday.map((s) => s.employeeId));
  const people = [
    ...shiftsToday.map((s) => s.employeeId).filter((id, i, all) => all.indexOf(id) === i),
    // Anyone clocked in here who is not on today's rota still shows, so they can clock out.
    ...entries.filter((t) => t.status === 'open' && !onRota.has(t.employeeId)).map((t) => t.employeeId),
  ]
    .map((id) => state.employees.find((e) => e.id === id))
    .filter((e): e is Employee => Boolean(e));
  const team = state.employees.filter((e) => e.siteId === siteId && e.status !== 'leaver');
  const canSignInByName = !site.geofence || Boolean(fence?.ok);

  const signIn = (person: Employee) =>
    run(async () => {
      const entry = await api.post<TimeEntry>('/v1/time-entries/clock-in', { employeeId: person.id, siteId, ...(fix ? { location: fix } : {}) });
      return { tone: 'good', text: `${person.name} clocked in at ${formatMinute(entry.clockIn)}.` };
    });
  const signOut = (person: Employee, entry: TimeEntry) =>
    run(async () => {
      const done = await api.post<TimeEntry>(`/v1/time-entries/${entry.id}/clock-out`, fix ? { location: fix } : {});
      return { tone: 'good', text: `${person.name} clocked out at ${formatMinute(done.clockOut!)}.` };
    });

  return (
    <div className="clock">
      <section className="clock-card">
        <form onSubmit={submitCard} className="clock-reader">
          <label htmlFor="card-reading" className="clock-title">
            {enrolFor ? `Tap the card to enrol for ${enrolFor.name}` : `Tap your card to clock in or out at ${site.name}`}
          </label>
          <input
            id="card-reading"
            ref={cardInput}
            value={card}
            onChange={(e) => setCard(e.target.value)}
            autoFocus
            autoComplete="off"
            inputMode="none"
            placeholder="Waiting for a card"
            aria-describedby="reader-hint"
            disabled={busy}
          />
          <p id="reader-hint" className="muted small">
            A USB card reader types the card number here. If nothing happens, click this box and tap again.
            {NdefReader && !nfcOn && (
              <>
                {' '}
                <button type="button" className="link" onClick={() => void startNfc()}>Use this phone's NFC instead</button>
              </>
            )}
            {nfcOn && ' NFC is on: hold a card to the back of this phone.'}
            {enrolFor && (
              <>
                {' '}
                <button type="button" className="link" onClick={() => setEnrolFor(null)}>Cancel enrolling</button>
              </>
            )}
          </p>
        </form>
        {banner && (
          <div className={`clock-banner ${banner.tone}`} role="status">
            {banner.text}
          </div>
        )}
      </section>

      <section className="clock-card">
        <div className="clock-head">
          <h2>On the rota today</h2>
          <LocationStatus geo={geo} fence={fence} siteName={site.name} hasFence={Boolean(site.geofence)} />
        </div>
        <div className="grid-wrap">
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Shift</th><th>Status</th><th className="num">Sign in by name</th></tr>
            </thead>
            <tbody>
              {people.length === 0 && (
                <tr><td colSpan={4} className="muted">Nobody is on the rota here today and nobody is clocked in.</td></tr>
              )}
              {people.map((person) => {
                const shift = shiftsToday.find((s) => s.employeeId === person.id);
                const entry = open(person.id);
                const done = entries.filter((t) => t.employeeId === person.id && t.status !== 'open' && t.date === today);
                return (
                  <tr key={person.id}>
                    <td>{person.name}{!shift && <span className="tag">Not on rota</span>}</td>
                    <td className="nowrap">{shift ? `${formatMinute(shift.startMinute)} to ${formatMinute(shift.endMinute)}` : 'None'}</td>
                    <td>
                      {entry ? (
                        <span className="good-text">In since {formatMinute(entry.clockIn)}{entry.method === 'card' ? ' (card)' : ''}</span>
                      ) : done.length ? (
                        <span className="muted">Clocked out {formatMinute(done[done.length - 1].clockOut!)}</span>
                      ) : (
                        <span className="muted">Not in yet</span>
                      )}
                    </td>
                    <td className="num">
                      {entry ? (
                        <button disabled={busy || !canSignInByName} onClick={() => void signOut(person, entry)}>Clock out</button>
                      ) : (
                        <button className="primary" disabled={busy || !canSignInByName} onClick={() => void signIn(person)}>Clock in</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!canSignInByName && (
          <p className="muted small">Signing in by name needs this device inside the site's clocking area. Card taps still work.</p>
        )}
      </section>

      {(canSetFence || canEnrolCards) && (
      <details className="clock-card">
        <summary className="strong">Clock-in setup for {site.name}</summary>

        {canSetFence && (<>
        <h3>Site location</h3>
        <p className="muted small">
          Staff signing in by name on a phone or tablet must be inside this circle. Stand at the entrance to set it.
          Card taps are not location checked: the reader is fixed on site.
        </p>
        <div className="clock-setup-row">
          <span>
            {site.geofence
              ? `Set: ${site.geofence.radiusMetres} m round ${site.geofence.lat.toFixed(5)}, ${site.geofence.lng.toFixed(5)}`
              : 'Not set. Anyone signed in to Preshift can clock staff in by name from anywhere.'}
          </span>
          <label className="small muted">
            Radius{' '}
            <select value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
              {RADII.map((r) => <option key={r} value={r}>{r} m</option>)}
            </select>
          </label>
          <button
            disabled={busy || !fix}
            title={fix ? undefined : 'Waiting for this device location'}
            onClick={() =>
              void run(async () => {
                await onSetGeofence(siteId, { lat: fix!.lat, lng: fix!.lng, radiusMetres: radius });
                return {
                  tone: 'good',
                  text:
                    fix!.accuracyMetres > 50
                      ? `Location set, but this device was only accurate to ${fix!.accuracyMetres} m. Set it again from a phone near the door for a tighter fix.`
                      : `Location set to within ${fix!.accuracyMetres} m, with a ${radius} m clocking area.`,
                };
              })
            }
          >
            {site.geofence ? 'Move to this device location' : 'Use this device location'}
          </button>
          {site.geofence && (
            <>
              <button disabled={busy || radius === site.geofence.radiusMetres} onClick={() => void run(async () => {
                await onSetGeofence(siteId, { ...site.geofence!, radiusMetres: radius });
                return { tone: 'good', text: `Clocking area is now ${radius} m.` };
              })}>Save radius</button>
              <button className="danger" disabled={busy} onClick={() => void run(async () => {
                await onSetGeofence(siteId, null);
                return { tone: 'good', text: 'Location check turned off.' };
              })}>Turn off</button>
            </>
          )}
        </div>

        </>)}
        {canEnrolCards && (<>
        <h3>RFID cards</h3>
        <p className="muted small">
          Choose Enrol card, then tap the person's card on this screen's reader. Enrol on the same kind of reader the site uses for
          clocking, as some readers report the same card differently.
        </p>
        <div className="grid-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Card</th><th className="num" /></tr></thead>
            <tbody>
              {team.map((person) => (
                <tr key={person.id}>
                  <td>{person.name}</td>
                  <td>{person.badgeId ? `Ending ${person.badgeId.slice(-4)}` : <span className="muted">No card</span>}</td>
                  <td className="num">
                    <button disabled={busy} onClick={() => { setEnrolFor(person); cardInput.current?.focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                      {person.badgeId ? 'Replace card' : 'Enrol card'}
                    </button>{' '}
                    {person.badgeId && (
                      <button className="danger" disabled={busy} onClick={() => void run(async () => {
                        await onSetBadge(person.id, null);
                        return { tone: 'good', text: `Card removed from ${person.name}.` };
                      })}>Remove</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>)}
      </details>
      )}
    </div>
  );
}

function tapText({ action, employee, entry }: TapResult): string {
  switch (action) {
    case 'clock_in':
      return `Welcome, ${employee.name}. Clocked in at ${formatMinute(entry.clockIn)}.`;
    case 'clock_out':
      return `Thanks, ${employee.name}. Clocked out at ${formatMinute(entry.clockOut!)}.`;
    case 'already_clocked_in':
      return `${employee.name}, you are already clocked in from ${formatMinute(entry.clockIn)}.`;
    case 'already_clocked_out':
      return `${employee.name}, you clocked out at ${formatMinute(entry.clockOut!)}.`;
  }
}

function LocationStatus({ geo, fence, siteName, hasFence }: { geo: GeoState; fence: ReturnType<typeof checkFence> | null; siteName: string; hasFence: boolean }) {
  if (geo.status === 'locating') return <span className="muted small">Finding this device location</span>;
  if (geo.status === 'denied') {
    return <span className={`small ${hasFence ? 'bad-text' : 'muted'}`}>Location is blocked for this site in the browser settings{hasFence ? ', so only card taps work' : ''}.</span>;
  }
  if (geo.status !== 'ok') return <span className={`small ${hasFence ? 'bad-text' : 'muted'}`}>This device cannot report its location.</span>;
  if (!hasFence || !fence) return <span className="muted small">Location check is off for {siteName}.</span>;
  return fence.ok ? (
    <span className="good-text small">On site: {fence.distanceMetres} m from {siteName}</span>
  ) : (
    <span className="bad-text small">
      {fence.reason === 'too_imprecise' ? 'Location too vague to confirm' : `${fence.distanceMetres} m from ${siteName}, outside the clocking area`}
    </span>
  );
}
