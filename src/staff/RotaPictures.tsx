import { useState } from 'react';
import type { Fortnight } from '../engine/rotaViews';
import { addDays, formatMinute } from '../engine/time';
import { dayLabel, money } from '../ui/format';

// The staff rota drawn rather than listed: the next fortnight as a strip, and each shift beside
// the people on with them. The three questions people ask: when am I in, when am I free, and
// what will I earn, and then who am I working with.

const H = 60;
const span = (m: number) => `${Math.floor(m / H)}h${m % H ? ` ${m % H}m` : ''}`;

export interface OwnShift {
  id: string;
  date: string;
  startMinute: number;
  endMinute: number;
  breakMinutes: number;
  siteName: string;
  roleName: string;
}

/** Window drawn for each day: 06:00 to 02:00 the next morning, where nearly every hospitality shift sits. */
const FROM = 6 * H;
const TO = 26 * H;
const y = (m: number) => `${((Math.max(FROM, Math.min(TO, m)) - FROM) / (TO - FROM)) * 100}%`;

export function FortnightStrip({ today, shifts, summary }: { today: string; shifts: OwnShift[]; summary: Fortnight }) {
  const days = Array.from({ length: 14 }, (_, i) => addDays(today, i));
  const facts = [
    `${summary.paidHours} ${summary.paidHours === 1 ? 'hour' : 'hours'}`,
    summary.estimatedPay !== null ? `about ${money(summary.estimatedPay)} before tax` : null,
    summary.shortestRest !== null ? `shortest rest ${span(summary.shortestRest)}` : null,
    `${summary.daysOff} ${summary.daysOff === 1 ? 'day' : 'days'} off`,
  ].filter(Boolean);
  return (
    <section className="staff-card">
      <h2>Your next two weeks</h2>
      <p className="fn-summary">{facts.join(', ')}.</p>
      <div className="fn-strip" role="list">
        {days.map((d, i) => {
          const mine = shifts.filter((s) => s.date === d);
          const label = dayLabel(d);
          return (
            <div key={d} role="listitem" className={`fn-day${mine.length ? ' on' : ' off'}${d === today ? ' today' : ''}${i === 7 ? ' week2' : ''}`}>
              <span className="fn-name">{d === today ? 'Today' : label.short}</span>
              <span className="fn-date">{Number(d.slice(8))}</span>
              <span className="fn-bar" aria-hidden>
                {mine.map((s) => <span key={s.id} className="fn-shift" style={{ top: y(s.startMinute), height: `calc(${y(s.endMinute)} - ${y(s.startMinute)})` }} />)}
              </span>
              {mine.length ? (
                mine.map((s) => {
                  const rest = summary.restBefore[s.id];
                  return (
                    <span key={s.id} className="fn-times">
                      {formatMinute(s.startMinute)}
                      <br />
                      {formatMinute(s.endMinute)}
                      {rest?.judged && rest.level !== 'ok' && <span className={`fn-rest ${rest.level}`}>{span(rest.minutes)} rest</span>}
                    </span>
                  );
                })
              ) : (
                <span className="fn-times muted">Off</span>
              )}
            </div>
          );
        })}
      </div>
      <p className="muted small">
        Rest between days is at least {summary.minRest / H} hours by law. A coral rest is under it and your manager has signed it off; amber is legal but close.
        {summary.estimatedPay !== null ? ' Pay is hours times your rate, before tax, NI and pension, and leaves out holiday pay.' : ''}
      </p>
    </section>
  );
}

export interface Crew {
  startMinute: number;
  endMinute: number;
  role: string;
  team: { name: string; role: string; startMinute: number; endMinute: number }[];
}

/** People shown before "show everyone": enough for a section, short enough for a phone. */
const CREW_SHOWN = 5;
const names = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** One shift drawn beside the people on with them: who hands over, who closes with you. Your own role first. */
export function CrewLine({ shift }: { shift: Crew }) {
  const [all, setAll] = useState(false);
  const from = Math.min(shift.startMinute, ...shift.team.map((t) => t.startMinute));
  const to = Math.max(shift.endMinute, ...shift.team.map((t) => t.endMinute));
  const x = (m: number) => `${((m - from) / Math.max(1, to - from)) * 100}%`;
  const w = (a: number, b: number) => `${((b - a) / Math.max(1, to - from)) * 100}%`;
  const overlap = (t: Crew['team'][number]) => Math.min(t.endMinute, shift.endMinute) - Math.max(t.startMinute, shift.startMinute);
  const team = [...shift.team].sort((a, b) => Number(b.role === shift.role) - Number(a.role === shift.role) || overlap(b) - overlap(a));
  const shown = all ? team : team.slice(0, CREW_SHOWN);
  const closing = shift.team.filter((t) => t.endMinute >= shift.endMinute).map((t) => t.name.split(' ')[0]);
  const rows = [{ name: 'You', role: shift.role, startMinute: shift.startMinute, endMinute: shift.endMinute, you: true }, ...shown.map((t) => ({ ...t, you: false }))];
  return (
    <div className="crew">
      <div className="crew-rows">
        {rows.map((r, i) => (
          <div key={i} className={`crew-row${r.you ? ' you' : ''}`}>
            <span className="crew-name">
              {r.you ? 'You' : r.name.split(' ')[0]} <span className="muted">{r.role}</span>
              <span className="crew-time">{formatMinute(r.startMinute)}-{formatMinute(r.endMinute)}</span>
            </span>
            <span className="crew-track" aria-hidden>
              <span className="crew-you-band" style={{ left: x(shift.startMinute), width: w(shift.startMinute, shift.endMinute) }} />
              <span className="crew-bar" style={{ left: x(r.startMinute), width: w(r.startMinute, r.endMinute) }} />
            </span>
          </div>
        ))}
      </div>
      {team.length > CREW_SHOWN && (
        <button className="link small crew-more" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show everyone on (${team.length})`}
        </button>
      )}
      <p className="muted small">
        {shift.team.length === 0
          ? 'Nobody else on yet.'
          : closing.length
            ? `You close with ${names(closing)}.`
            : 'You finish last.'}
      </p>
    </div>
  );
}

export interface ShiftEffect {
  weekHours: number;
  shortestRest: number | null;
  minRest: number;
  warnings: string[];
}

/** What picking a shift up does to the person, before they ask for it. */
export function EffectLine({ effect }: { effect: ShiftEffect }) {
  const tight = effect.shortestRest !== null && effect.shortestRest < effect.minRest + 2 * H;
  return (
    <span className="staff-effect small">
      Takes you to {effect.weekHours} hours that week
      {effect.shortestRest !== null ? (
        <>
          , and at least <span className={tight ? 'warn-text' : ''}>{span(effect.shortestRest)} rest</span> either side
        </>
      ) : null}
      .{effect.warnings.map((w) => <span key={w} className="warn-text"> {w}</span>)}
    </span>
  );
}
