import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { EventEffect } from '../engine/events';
import type { CalendarDay } from '../engine/plan';
import { addDays, formatMinute, weekStart } from '../engine/time';
import { describeEvent } from '../engine/privateEvents';
import type { PrivateEvent, RotaState, Site } from '../engine/types';
import type { WeatherEffect } from '../engine/weather';
import type { SchoolEffect } from '../engine/school';
import type { SchoolPeriod } from '../engine/types';
import { api, ApiError } from './api';
import { dayLabel } from './format';
import { inDays, type StatefulReminder } from './RemindersBanner';

interface Feed { id: string; siteId: string; kind: 'ics' | 'ticketmaster' | 'school'; label: string; url?: string; lastRefreshedAt?: string; lastError?: string }
interface CalendarResponse { days: CalendarDay[]; reminders: StatefulReminder[]; weatherEffect: WeatherEffect; eventEffects: EventEffect[]; schoolEffects: SchoolEffect[] }
interface BookingStatus { siteId: string; bookingsAhead: number; coversAhead: number; furthestAhead: string | null; historyDays: number; lastLoadedAt: string | null }
interface Imported { imported: number; from?: string; to?: string; skipped: number; notRead: string[]; problems: { line: number; reason: string }[] }
interface HeldEvent extends PrivateEvent { team: { roleId: string; people: number; standard: boolean }[] }
interface EventsImported extends Imported { ahead: number; confirmed: number }
interface Refreshed { siteId: string; weatherDays?: number; events?: number; modelled?: number; errors: string[] }

interface Props {
  state: RotaState;
  site: Site;
  today: string;
  onChanged: () => Promise<void>;
}

const problem = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const pctText = (f: number) => `${f >= 1 ? '+' : ''}${Math.round((f - 1) * 100)}%`;
const hoursText = (from?: number, to?: number) => (from === undefined && to === undefined ? '' : ` ${String(from ?? 0).padStart(2, '0')}:00 to ${String(to ?? 24).padStart(2, '0')}:00`);

/**
 * The coming weeks at a site, plotted: the trading calendar, local events and
 * the weather, what the forecast already allows for and why, and the
 * reminders that need someone to act.
 */
export function CalendarView({ state, site, today, onChanged }: Props) {
  const [cal, setCal] = useState<CalendarResponse | null>(null);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [expect, setExpect] = useState<Record<string, string>>({});
  const [feed, setFeed] = useState({ label: '', url: '' });
  const [manual, setManual] = useState({ date: addDays(today, 7), name: '', time: '' });
  const [bookingStatus, setBookingStatus] = useState<BookingStatus | null>(null);
  const [holidays, setHolidays] = useState<SchoolPeriod[]>([]);
  const [schoolFeed, setSchoolFeed] = useState('');
  const [holiday, setHoliday] = useState({ start: '', end: '', name: '' });
  const [upload, setUpload] = useState<{ source: string; usDates: boolean; file: File | null }>({ source: 'resdiary', usDates: false, file: null });
  const [lastImport, setLastImport] = useState<Imported | null>(null);
  const [privateEvents, setPrivateEvents] = useState<HeldEvent[]>([]);
  const [eventUpload, setEventUpload] = useState<{ source: string; usDates: boolean; incVat: boolean; file: File | null }>({ source: 'tripleseat', usDates: false, incVat: true, file: null });
  const [lastEventImport, setLastEventImport] = useState<EventsImported | null>(null);
  const [newEvent, setNewEvent] = useState({ date: addDays(today, 14), start: '18:00', end: '23:00', guests: '', kind: 'wedding', style: 'seated', status: 'confirmed', exclusive: false, space: '', spend: '' });
  const [where, setWhere] = useState({ lat: String(site.location?.lat ?? site.geofence?.lat ?? ''), lng: String(site.location?.lng ?? site.geofence?.lng ?? '') });
  const from = weekStart(today);

  const load = useCallback(async () => {
    try {
      const [c, f, b, sh, pe] = await Promise.all([
        api.get<CalendarResponse>(`/v1/calendar?siteId=${site.id}&from=${from}&to=${addDays(from, 83)}`),
        api.get<Feed[]>('/v1/event-feeds'),
        api.get<BookingStatus[]>('/v1/bookings/status'),
        api.get<SchoolPeriod[]>(`/v1/school-holidays?siteId=${site.id}&from=${from}&to=${addDays(from, 400)}`),
        api.get<HeldEvent[]>(`/v1/private-events?siteId=${site.id}&from=${today}`),
      ]);
      setPrivateEvents(pe);
      setHolidays(sh);
      setBookingStatus(b.find((x) => x.siteId === site.id) ?? null);
      setCal(c);
      setFeeds(f.filter((x) => x.siteId === site.id));
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  }, [site.id, from, today]);
  useEffect(() => void load(), [load]);

  async function act(fn: () => Promise<string>, reload = false) {
    setBusy(true);
    try {
      setMessage({ text: await fn() });
      if (reload) await onChanged();
      await load();
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    } finally {
      setBusy(false);
    }
  }

  const refresh = () =>
    act(async () => {
      const { sites } = await api.post<{ sites: Refreshed[] }>('/v1/outside/refresh', { siteIds: [site.id] });
      const r = sites[0];
      const done = [r.weatherDays ? `${r.weatherDays} days of weather` : null, r.events ? `${r.events} events` : null, r.modelled ? `forecast refreshed for ${r.modelled} trading hours` : null].filter(Boolean).join(', ');
      return `${done || 'Nothing to fetch yet: set the location or add a feed.'}${r.errors.length ? ` Problems: ${r.errors.join('; ')}` : ''}`;
    }, true);

  const decide = (r: StatefulReminder, action: 'done' | 'dismiss' | 'expect') =>
    act(async () => {
      const factor = action === 'expect' ? 1 + Number(expect[r.key] ?? 0) / 100 : undefined;
      if (action === 'expect' && (!expect[r.key] || !(factor! > 0))) throw new Error('Say what you expect, for example 20 for twenty per cent busier or -15 for quieter.');
      await api.post('/v1/reminders', { siteId: site.id, key: r.key, action, factor });
      return action === 'expect' ? `Set: ${r.title} ${pctText(factor!)}. Rebuild the forecast for that week to use it.` : action === 'done' ? `Done: ${r.title}.` : `Set aside: ${r.title}.`;
    }, action === 'expect');

  function addFeed(e: FormEvent) {
    e.preventDefault();
    void act(async () => {
      await api.post('/v1/event-feeds', { siteId: site.id, kind: 'ics', label: feed.label, url: feed.url });
      setFeed({ label: '', url: '' });
      return 'Feed added. Refresh to fetch its events.';
    });
  }

  function importFile(e: FormEvent) {
    e.preventDefault();
    if (!upload.file) return;
    const file = upload.file;
    void act(async () => {
      if (file.size > 12 * 1024 * 1024) throw new Error('That file is over 12 MB. Export a shorter date range.');
      const csv = await file.text();
      const r = await api.post<Imported>('/v1/bookings/import', { siteId: site.id, source: upload.source, csv, usDates: upload.usDates });
      setLastImport(r);
      return r.imported
        ? `Read ${r.imported} bookings from ${dayLabel(r.from!).date} to ${dayLabel(r.to!).date}${r.skipped ? `, skipped ${r.skipped}` : ''}. Build the forecast to use them.`
        : 'No bookings could be read from that file.';
    });
  }

  function importEvents(e: FormEvent) {
    e.preventDefault();
    if (!eventUpload.file) return;
    const file = eventUpload.file;
    void act(async () => {
      if (file.size > 12 * 1024 * 1024) throw new Error('That file is over 12 MB. Export a shorter date range.');
      const csv = await file.text();
      const r = await api.post<EventsImported>('/v1/private-events/import', { siteId: site.id, source: eventUpload.source, csv, usDates: eventUpload.usDates, spendIncludesVat: eventUpload.incVat });
      setLastEventImport(r);
      return r.imported
        ? `Read ${r.imported} events, ${r.ahead} still to come and ${r.confirmed} of those confirmed${r.skipped ? `; skipped ${r.skipped}` : ''}. Confirmed events are on the rota's demand now.`
        : 'No events could be read from that file.';
    }, true);
  }

  const minuteOf = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + (m || 0);
  };

  function addPrivateEvent(e: FormEvent) {
    e.preventDefault();
    void act(async () => {
      const startMinute = minuteOf(newEvent.start);
      let endMinute = minuteOf(newEvent.end);
      // An end at or before the start is after midnight.
      if (endMinute <= startMinute) endMinute += 1440;
      await api.post('/v1/private-events', {
        siteId: site.id,
        date: newEvent.date,
        startMinute,
        endMinute,
        guests: Number(newEvent.guests),
        kind: newEvent.kind,
        style: newEvent.style,
        status: newEvent.status,
        exclusive: newEvent.exclusive,
        space: newEvent.space || undefined,
        spend: newEvent.spend ? Number(newEvent.spend) : undefined,
      });
      setNewEvent({ ...newEvent, guests: '', space: '', spend: '' });
      return newEvent.status === 'confirmed' ? 'Event added and on the rota\'s demand.' : 'Event added. It moves the rota once it is confirmed.';
    }, true);
  }

  const setEventStatus = (ev: HeldEvent, status: PrivateEvent['status']) =>
    act(async () => {
      await api.patch(`/v1/private-events/${encodeURIComponent(ev.id)}`, { status });
      return status === 'confirmed' ? 'Confirmed: on the rota\'s demand now.' : 'Cancelled: taken off the rota\'s demand.';
    }, true);

  function addSchoolFeed(e: FormEvent) {
    e.preventDefault();
    void act(async () => {
      await api.post('/v1/event-feeds', { siteId: site.id, kind: 'school', label: 'Council term dates', url: schoolFeed });
      setSchoolFeed('');
      return 'Council feed added. Refresh to read its dates; each holiday it gives replaces the estimate for that holiday.';
    });
  }

  function addHoliday(e: FormEvent) {
    e.preventDefault();
    void act(async () => {
      await api.post('/v1/school-holidays', { siteId: site.id, ...holiday });
      setHoliday({ start: '', end: '', name: '' });
      return 'Holiday added. It replaces the estimate for that holiday; the others stay estimated until you add them.';
    }, true);
  }

  function addEvent(e: FormEvent) {
    e.preventDefault();
    void act(async () => {
      const [h, m] = manual.time.split(':').map(Number);
      await api.post('/v1/local-events', { siteId: site.id, date: manual.date, name: manual.name, startMinute: manual.time ? h * 60 + (m || 0) : undefined });
      setManual({ ...manual, name: '', time: '' });
      return 'Event added.';
    });
  }

  function saveWhere(e: FormEvent) {
    e.preventDefault();
    void act(async () => {
      await api.put(`/v1/sites/${site.id}/location`, { lat: Number(where.lat), lng: Number(where.lng) });
      return 'Location saved. Refresh to fetch its weather.';
    }, true);
  }

  const due = (cal?.reminders ?? []).filter((r) => r.status === 'open' && r.dueFrom <= today && r.date >= today);
  const later = (cal?.reminders ?? []).filter((r) => r.status === 'open' && r.dueFrom > today).slice(0, 8);
  const weeks = cal ? Array.from({ length: Math.ceil(cal.days.length / 7) }, (_, i) => cal.days.slice(i * 7, i * 7 + 7)) : [];
  const located = !!(site.location ?? site.geofence);
  const feedName = (id?: string) => feeds.find((f) => f.id === id)?.label;

  return (
    <div className="insight">
      {message && (
        <div className={`notice ${message.bad ? 'error' : ''}`}>
          {message.text} <button className="link" onClick={() => setMessage(null)}>Dismiss</button>
        </div>
      )}

      <section className="settings-card">
        <div className="insight-head">
          <div>
            <h2>Coming up at {site.name}</h2>
            <p className="muted small">
              The UK trading calendar is built in, Easter and Mothering Sunday included, for every year. Weather and local events
              are fetched every morning. Where this site's own history shows what a day does, the forecast allows for it by
              itself and says why; where it cannot, you are reminded in time to set an expectation.
            </p>
          </div>
          <button className="primary" disabled={busy} onClick={() => void refresh()}>Refresh weather and events</button>
        </div>
        {due.length === 0 ? (
          <p className="muted">Nothing needs doing right now.</p>
        ) : (
          <ul className="reminders">
            {due.map((r) => (
              <li key={r.key} className={`reminder kind-${r.kind}`}>
                <div className="move-body">
                  <div className="move-title">
                    {r.title}, {dayLabel(r.date).short} {dayLabel(r.date).date} ({inDays(today, r.date)}){hoursText(r.fromHour, r.toHour)}
                  </div>
                  <div className="muted small">{r.advice}</div>
                  {r.applied.map((a) => (
                    <div key={a.id} className="small good-text">Forecast allows {pctText(a.factor)}{hoursText(a.fromHour, a.toHour)}. {a.evidence}</div>
                  ))}
                </div>
                <div className="move-actions">
                  {r.needsInput && (
                    <>
                      <label className="expect">
                        <span className="muted small">Expect, % vs normal</span>
                        <input type="number" min={-90} max={300} value={expect[r.key] ?? ''} onChange={(e) => setExpect({ ...expect, [r.key]: e.target.value })} placeholder="e.g. 20" />
                      </label>
                      <button className="primary" disabled={busy} onClick={() => void decide(r, 'expect')}>Set</button>
                    </>
                  )}
                  {!r.needsInput && <button className="primary" disabled={busy} onClick={() => void decide(r, 'done')}>Done</button>}
                  <button className="link" disabled={busy} onClick={() => void decide(r, 'dismiss')}>Set aside</button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {later.length > 0 && (
          <p className="muted small">
            Later: {later.map((r) => `${r.title} ${dayLabel(r.date).date} (reminds from ${dayLabel(r.dueFrom).date})`).join('; ')}.
          </p>
        )}
      </section>

      <section className="settings-card">
        <h2>Next twelve weeks</h2>
        <div className="calendar">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="cal-head">{d}</div>)}
          {weeks.flat().map((d) => {
            const past = d.date < today;
            return (
              <div key={d.date} className={`cal-day ${past ? 'past' : ''} ${d.date === today ? 'today' : ''}`}>
                <div className="cal-date"><span className="cal-wd">{dayLabel(d.date).short} </span>{dayLabel(d.date).date}</div>
                {d.school && d.school.start === d.date && <div className="chip school">{d.school.name}{d.school.source === 'estimate' ? ' (est.)' : ''}</div>}
                {d.school && d.school.start !== d.date && <div className="chip school quiet">School holiday</div>}
                {d.occasions.map((o) => <div key={o.key} className={`chip occ-${o.kind}`}>{o.name}</div>)}
                {d.events.map((e) => (
                  <div key={e.id} className="chip event" title={[e.venue, feedName(e.feedId)].filter(Boolean).join(', ')}>
                    {e.startMinute !== undefined ? `${formatMinute(e.startMinute)} ` : ''}{e.name}
                  </div>
                ))}
                {d.weatherText && <div className="cal-weather small">{d.weather?.observed ? 'Was ' : ''}{d.weatherText}</div>}
                {d.bookings.filter((b) => b.booked > 0).map((b) => (
                  <div key={b.daypart} className={`chip booked ${b.usable && b.pace !== null && b.pace >= 1.25 ? 'ahead' : ''}`} title={b.pace !== null ? `${b.usualAtLead} usually on the books by now` : undefined}>
                    {b.label} {b.booked} booked{b.expected !== null && b.usable ? `, expect ${b.expected}` : ''}
                  </div>
                ))}
                {(d.privateEvents ?? []).map((pe) => (
                  <div key={pe.id} className={`chip party ${pe.status === 'confirmed' ? '' : 'quiet'}`} title={pe.status === 'confirmed' ? 'Confirmed: on the rota\'s demand' : 'Not confirmed: not on the rota\'s demand'}>
                    {formatMinute(pe.startMinute)} {describeEvent(pe)}{pe.status === 'confirmed' ? '' : ` (${pe.status})`}
                  </div>
                ))}
                {d.bookings.flatMap((b) => b.largeParties).map((p) => (
                  <div key={p.id} className="chip party">Party of {p.covers}, {formatMinute(p.startMinute)}</div>
                ))}
                {d.adjustments.map((a) => (
                  <div key={a.id} className="chip auto" title={a.evidence}>{pctText(a.factor)} {a.kind}{hoursText(a.fromHour, a.toHour)}</div>
                ))}
                {d.manual.map((a) => (
                  <div key={a.id} className="chip manual" title={a.note}>{a.factor === 0 ? 'Closed' : pctText(a.factor)} set{hoursText(a.fromHour, a.toHour)}</div>
                ))}
              </div>
            );
          })}
        </div>
        <p className="muted small">
          Green chips are what the forecast allows for by itself: hover for the evidence. Blue are what people have set, and those
          always win. Grey are covers on the books; bold when well ahead of a normal day at this point. Build the forecast on the Forecast tab to bring any change into the rota.
        </p>
      </section>

      {cal && (
        <section className="settings-card">
          <h2>What this site has learnt</h2>
          <ul className="adjustments">
            <li>
              Weather:{' '}
              {cal.weatherEffect.usable
                ? `${cal.weatherEffect.perDegree >= 0 ? '+' : ''}${(cal.weatherEffect.perDegree * 100).toFixed(1)}% per degree warmer than normal, ${pctText(1 + cal.weatherEffect.wet)} on a wet day, from ${cal.weatherEffect.days} days.`
                : located
                  ? `learning: ${cal.weatherEffect.days} of 28 days needed. Until then the weather is shown but nothing is adjusted.`
                  : 'set the location below to start.'}
            </li>
            <li>
              School holidays:{' '}
              {(() => {
                const usable = cal.schoolEffects.filter((x) => x.usable && Math.abs(x.factor - 1) >= 0.05);
                const learning = cal.schoolEffects.every((x) => !x.usable);
                if (learning) return 'learning: needs five holiday days in the till history.';
                if (usable.length === 0) return 'trade here hardly moves in the school holidays, so nothing is applied.';
                return usable.map((x) => `${x.weekend ? 'weekend' : 'weekday'} ${x.daypart} ${pctText(x.factor)}`).join(', ') + '.';
              })()}
            </li>
            {cal.eventEffects.map((e) => (
              <li key={e.feedId}>
                {feedName(e.feedId) ?? 'Feed'}: {e.usable ? `${pctText(e.factor)} around the start time, from ${e.events} past events.` : `learning: ${e.events} of 2 past events needed.`}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="settings-card">
        <h2>School holidays</h2>
        <p className="muted small">
          Until your council's dates are in, the usual England and Wales pattern is used and marked as an estimate. For anyone
          on the team still of school age, estimated holidays count as term time: the longer holiday hours apply only once the
          council's dates are in. Academies can differ from the council.
        </p>
        <div className="settings-form">
          <label>
            Nation
            <select value={site.nation ?? 'england'} disabled={busy} onChange={(e) => void act(async () => { await api.put(`/v1/sites/${site.id}/nation`, { nation: e.target.value }); return 'Saved.'; }, true)}>
              <option value="england">England</option>
              <option value="wales">Wales</option>
              <option value="scotland">Scotland</option>
              <option value="northern_ireland">Northern Ireland</option>
            </select>
          </label>
        </div>
        {holidays.length > 0 && (
          <ul className="adjustments">
            {holidays.slice(0, 8).map((h) => (
              <li key={h.id}>
                {h.name}: {dayLabel(h.start).date} to {dayLabel(h.end).date} {h.end.slice(0, 4)}{' '}
                <span className="muted small">{h.source === 'estimate' ? '(estimate)' : h.source === 'council' ? '(council feed)' : '(entered by hand)'}</span>{' '}
                {h.source === 'manual' && (
                  <button className="link danger" disabled={busy} onClick={() => void act(async () => { await api.del(`/v1/school-holidays/${h.id}`); return 'Removed.'; }, true)}>Remove</button>
                )}
              </li>
            ))}
          </ul>
        )}
        {(site.nation === 'scotland' || site.nation === 'northern_ireland') && holidays.length === 0 && (
          <p className="small bad-text">No estimate is made outside England and Wales: add the council's dates.</p>
        )}
        <form className="settings-form" onSubmit={addSchoolFeed}>
          <label>Council term dates (iCal address)<input required value={schoolFeed} onChange={(e) => setSchoolFeed(e.target.value)} placeholder="https:// or webcal://" /></label>
          <button disabled={busy}>Add council feed</button>
        </form>
        <form className="settings-form" onSubmit={addHoliday}>
          <label>Holiday<input required maxLength={80} value={holiday.name} onChange={(e) => setHoliday({ ...holiday, name: e.target.value })} placeholder="e.g. October half term" /></label>
          <label>From<input type="date" required value={holiday.start} onChange={(e) => setHoliday({ ...holiday, start: e.target.value })} /></label>
          <label>To<input type="date" required value={holiday.end} onChange={(e) => setHoliday({ ...holiday, end: e.target.value })} /></label>
          <button disabled={busy}>Add by hand</button>
        </form>
      </section>

      <section className="settings-card">
        <h2>Bookings</h2>
        <p className="muted small">
          Covers already booked beat any model. Load your booking system's export (ResDiary, SevenRooms, OpenTable or similar,
          as CSV): the next few weeks for what is on the books, and the last few months once so the site learns how its days fill
          up. Only date, time, covers, status and when each was made or cancelled are read; guest names, phone numbers, emails
          and notes are left behind and never stored.
        </p>
        {bookingStatus && (
          <p className="small">
            {bookingStatus.bookingsAhead
              ? `${bookingStatus.coversAhead} covers on the books in ${bookingStatus.bookingsAhead} bookings, to ${dayLabel(bookingStatus.furthestAhead!).date}. `
              : 'No bookings ahead loaded. '}
            {bookingStatus.historyDays >= 28
              ? `${bookingStatus.historyDays} days of booking history to learn from.`
              : `${bookingStatus.historyDays} days of booking history: load at least four weeks (twelve is better) so pickup can be learnt.`}
            {bookingStatus.lastLoadedAt ? ` Last loaded ${dayLabel(bookingStatus.lastLoadedAt.slice(0, 10)).date}.` : ''}
          </p>
        )}
        <form className="settings-form" onSubmit={importFile}>
          <label>
            From
            <select value={upload.source} onChange={(e) => setUpload({ ...upload, source: e.target.value })}>
              <option value="resdiary">ResDiary</option>
              <option value="sevenrooms">SevenRooms</option>
              <option value="opentable">OpenTable</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label>
            Export file (CSV)
            <input type="file" accept=".csv,text/csv" required onChange={(e) => setUpload({ ...upload, file: e.target.files?.[0] ?? null })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={upload.usDates} onChange={(e) => setUpload({ ...upload, usDates: e.target.checked })} /> Dates are month first
          </label>
          <button disabled={busy || !upload.file}>Import</button>
        </form>
        {lastImport && (
          <div className="small">
            {lastImport.notRead.length > 0 && <p className="muted">Not read, and not kept: {lastImport.notRead.join(', ')}.</p>}
            {lastImport.problems.length > 0 && (
              <ul className="adjustments">
                {lastImport.problems.map((p) => <li key={p.line}>Line {p.line}: {p.reason}</li>)}
                {lastImport.skipped > lastImport.problems.length && <li>and {lastImport.skipped - lastImport.problems.length} more</li>}
              </ul>
            )}
          </div>
        )}
        <p className="muted small">
          A direct connection to ResDiary, SevenRooms or OpenTable needs API access granted by each of them; once it is, bookings
          arrive through the same route (PUT /v1/bookings) every few minutes instead of by file.
        </p>
      </section>

      <section className="settings-card">
        <h2>Weddings, buyouts and functions</h2>
        <p className="muted small">
          Events are known weeks ahead, to the guest, so they are planned rather than guessed. A confirmed event adds its own team
          to the rota's demand, by guest ratio from an hour before guests arrive to half an hour after they leave, on top of normal
          trade, and its spend to the day's sales. An exclusive hire takes the public's trade out while it runs. Provisional events
          and enquiries are shown with what they would need, and move nothing until confirmed. Load the export from Tripleseat or
          SevenRooms (or any events system, as CSV): only date, times, guest count, status, type, style, room and total are read.
          The event name, the client and their contacts are left behind and never stored.
        </p>
        {privateEvents.length === 0 ? (
          <p className="small">No events ahead loaded.</p>
        ) : (
          <table className="table">
            <thead><tr><th>Date</th><th>Event</th><th>Time</th><th>Team needed</th><th>Spend (net)</th><th>Status</th><th /></tr></thead>
            <tbody>
              {privateEvents.slice(0, 30).map((ev) => (
                <tr key={ev.id}>
                  <td>{dayLabel(ev.date).short} {dayLabel(ev.date).date}</td>
                  <td>{describeEvent(ev)}</td>
                  <td className="tnum">{formatMinute(ev.startMinute)} to {formatMinute(ev.endMinute % 1440)}</td>
                  <td className="small">{ev.team.length ? ev.team.map((t) => `${t.people} ${state.roles.find((r) => r.id === t.roleId)?.name ?? t.roleId}`).join(', ') : 'No role has an event ratio'}{ev.team.some((t) => t.standard) ? ' (standard ratios)' : ''}</td>
                  <td className="tnum">{ev.spend ? `£${Math.round(ev.spend).toLocaleString('en-GB')}` : ''}</td>
                  <td>{ev.status}{ev.source !== 'manual' ? <span className="muted small"> ({ev.source})</span> : null}</td>
                  <td>
                    {ev.status !== 'confirmed' && ev.status !== 'cancelled' && <button className="link" disabled={busy} onClick={() => void setEventStatus(ev, 'confirmed')}>Confirm</button>}{' '}
                    {ev.status !== 'cancelled' && <button className="link" disabled={busy} onClick={() => void setEventStatus(ev, 'cancelled')}>Cancel</button>}{' '}
                    {ev.source === 'manual' && (
                      <button className="link danger" disabled={busy} onClick={() => void act(async () => { await api.del(`/v1/private-events/${encodeURIComponent(ev.id)}`); return 'Removed.'; }, true)}>Remove</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form className="settings-form" onSubmit={importEvents}>
          <label>
            From
            <select value={eventUpload.source} onChange={(e) => setEventUpload({ ...eventUpload, source: e.target.value })}>
              <option value="tripleseat">Tripleseat</option>
              <option value="sevenrooms">SevenRooms</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label>
            Events export (CSV)
            <input type="file" accept=".csv,text/csv" required onChange={(e) => setEventUpload({ ...eventUpload, file: e.target.files?.[0] ?? null })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={eventUpload.incVat} onChange={(e) => setEventUpload({ ...eventUpload, incVat: e.target.checked })} /> Totals include VAT
          </label>
          <label className="check">
            <input type="checkbox" checked={eventUpload.usDates} onChange={(e) => setEventUpload({ ...eventUpload, usDates: e.target.checked })} /> Dates are month first
          </label>
          <button disabled={busy || !eventUpload.file}>Import</button>
        </form>
        {lastEventImport && (
          <div className="small">
            {lastEventImport.notRead.length > 0 && <p className="muted">Not read, and not kept: {lastEventImport.notRead.join(', ')}.</p>}
            {lastEventImport.problems.length > 0 && (
              <ul className="adjustments">
                {lastEventImport.problems.map((p) => <li key={p.line}>Line {p.line}: {p.reason}</li>)}
                {lastEventImport.skipped > lastEventImport.problems.length && <li>and {lastEventImport.skipped - lastEventImport.problems.length} more</li>}
              </ul>
            )}
          </div>
        )}
        <form className="settings-form" onSubmit={addPrivateEvent}>
          <label>Date<input type="date" required value={newEvent.date} onChange={(e) => setNewEvent({ ...newEvent, date: e.target.value })} /></label>
          <label>Guests arrive<input type="time" required value={newEvent.start} onChange={(e) => setNewEvent({ ...newEvent, start: e.target.value })} /></label>
          <label>Guests leave<input type="time" required value={newEvent.end} onChange={(e) => setNewEvent({ ...newEvent, end: e.target.value })} /></label>
          <label>Guests<input type="number" min={1} max={5000} required value={newEvent.guests} onChange={(e) => setNewEvent({ ...newEvent, guests: e.target.value })} /></label>
          <label>
            What
            <select value={newEvent.kind} onChange={(e) => setNewEvent({ ...newEvent, kind: e.target.value, exclusive: e.target.value === 'private_hire' ? true : newEvent.exclusive })}>
              <option value="wedding">Wedding</option>
              <option value="private_hire">Private hire</option>
              <option value="party">Party</option>
              <option value="corporate">Corporate</option>
              <option value="other">Other function</option>
            </select>
          </label>
          <label>
            Service
            <select value={newEvent.style} onChange={(e) => setNewEvent({ ...newEvent, style: e.target.value })}>
              <option value="seated">Seated</option>
              <option value="buffet">Buffet</option>
              <option value="standing">Standing, canapés</option>
              <option value="drinks">Drinks only</option>
            </select>
          </label>
          <label>
            Status
            <select value={newEvent.status} onChange={(e) => setNewEvent({ ...newEvent, status: e.target.value })}>
              <option value="confirmed">Confirmed</option>
              <option value="provisional">Provisional</option>
              <option value="enquiry">Enquiry</option>
            </select>
          </label>
          <label>Room<input maxLength={60} value={newEvent.space} onChange={(e) => setNewEvent({ ...newEvent, space: e.target.value })} placeholder="e.g. Garden room" /></label>
          <label>Spend, net £<input type="number" min={0} step={50} value={newEvent.spend} onChange={(e) => setNewEvent({ ...newEvent, spend: e.target.value })} /></label>
          <label className="check">
            <input type="checkbox" checked={newEvent.exclusive} onChange={(e) => setNewEvent({ ...newEvent, exclusive: e.target.checked })} /> Exclusive: the public are not served
          </label>
          <button disabled={busy}>Add event</button>
        </form>
        <p className="muted small">
          A direct connection to Tripleseat or SevenRooms needs API access granted by each of them. Until then a connector (their
          webhooks through Zapier or Make, or your own) sends each event as it is booked, changed or lost to PUT /v1/private-events,
          by its own reference, and the rota moves the same day.
        </p>
      </section>

      <div className="split">
        <section className="settings-card">
          <h2>Local event feeds</h2>
          <p className="muted small">
            Paste the iCal address a stadium, arena, theatre or council publishes (often a "subscribe" or "add to calendar" link).
            Each feed is learnt on its own.
          </p>
          {feeds.some((f) => f.kind !== 'school') && (
            <ul className="adjustments">
              {feeds.filter((f) => f.kind !== 'school').map((f) => (
                <li key={f.id}>
                  {f.label}
                  <span className="muted small">{f.lastError ? ` (last refresh failed: ${f.lastError})` : f.lastRefreshedAt ? ` (refreshed ${dayLabel(f.lastRefreshedAt.slice(0, 10)).date})` : ' (not fetched yet)'}</span>{' '}
                  <button className="link danger" disabled={busy} onClick={() => void act(async () => { await api.del(`/v1/event-feeds/${f.id}`); return 'Feed removed. Its past events are kept as history.'; })}>Remove</button>
                </li>
              ))}
            </ul>
          )}
          <form className="settings-form" onSubmit={addFeed}>
            <label>Name<input required maxLength={80} value={feed.label} onChange={(e) => setFeed({ ...feed, label: e.target.value })} placeholder="e.g. Stadium fixtures" /></label>
            <label>iCal address<input required value={feed.url} onChange={(e) => setFeed({ ...feed, url: e.target.value })} placeholder="https:// or webcal://" /></label>
            <button disabled={busy}>Add feed</button>
          </form>
        </section>

        <section className="settings-card">
          <h2>Something no feed lists</h2>
          <p className="muted small">A street party, a conference, roadworks. You will be reminded ten days ahead to set an expectation.</p>
          <form className="settings-form" onSubmit={addEvent}>
            <label>Date<input type="date" required value={manual.date} onChange={(e) => setManual({ ...manual, date: e.target.value })} /></label>
            <label>What<input required maxLength={120} value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} /></label>
            <label>Starts (optional)<input type="time" value={manual.time} onChange={(e) => setManual({ ...manual, time: e.target.value })} /></label>
            <button disabled={busy}>Add event</button>
          </form>
          <h3 className="section-title">Site location</h3>
          <p className="muted small">{located ? 'Used for the weather and nearby events.' : 'Needed for the weather. The clock-in geofence centre is used if one is set.'}</p>
          <form className="settings-form" onSubmit={saveWhere}>
            <label>Latitude<input type="number" step="0.0001" min={-90} max={90} required value={where.lat} onChange={(e) => setWhere({ ...where, lat: e.target.value })} /></label>
            <label>Longitude<input type="number" step="0.0001" min={-180} max={180} required value={where.lng} onChange={(e) => setWhere({ ...where, lng: e.target.value })} /></label>
            <button disabled={busy}>Save location</button>
          </form>
        </section>
      </div>
      {state.sites.length > 1 && <p className="muted small">Feeds and events are set per site.</p>}
    </div>
  );
}
