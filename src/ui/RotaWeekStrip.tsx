import { useEffect, useState } from 'react';
import { toISODate, weekday } from '../engine/time';
import type { DayNote, LocalEvent, RotaState, SchoolPeriod, Site } from '../engine/types';
import { api } from './api';
import { dayLabel } from './format';
import { keyDates } from './weekStrip';

interface Props {
  state: RotaState;
  site: Site;
  dates: string[];
  /** Absent when the person cannot edit this site's rota: notes are then read only. */
  onSaveNote?: (date: string, text: string) => Promise<unknown>;
}

/**
 * The week along the top of the rota: what is on each day (bank holidays, occasions, local
 * events, school holidays) and the site's note for it, so whoever builds the rota knows.
 */
export function RotaWeekStrip({ state, site, dates, onSaveNote }: Props) {
  const [events, setEvents] = useState<LocalEvent[]>([]);
  const [school, setSchool] = useState<SchoolPeriod[]>([]);
  const [editing, setEditing] = useState<{ date: string; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const from = dates[0];
  const to = dates[dates.length - 1];

  useEffect(() => {
    let live = true;
    const range = `siteId=${encodeURIComponent(site.id)}&from=${from}&to=${to}`;
    // A reminder only: the rota works without either.
    api.get<LocalEvent[]>(`/v1/local-events?${range}`).then((e) => live && setEvents(e)).catch(() => live && setEvents([]));
    api.get<SchoolPeriod[]>(`/v1/school-holidays?${range}`).then((s) => live && setSchool(s)).catch(() => live && setSchool([]));
    return () => {
      live = false;
    };
  }, [site.id, from, to]);

  const on = keyDates(dates, events, school);
  const noteOn = (date: string): DayNote | undefined => (state.dayNotes ?? []).find((n) => n.siteId === site.id && n.date === date);
  const today = toISODate(new Date());

  async function save() {
    if (!editing || !onSaveNote) return;
    setSaving(true);
    const ok = await onSaveNote(editing.date, editing.text);
    setSaving(false);
    if (ok) setEditing(null);
  }

  return (
    <div className="panel week-strip" aria-label="What is on this week">
      {dates.map((date) => {
        const l = dayLabel(date);
        const note = noteOn(date);
        const open = editing?.date === date;
        return (
          <div key={date} className={`ws-day${weekday(date) >= 5 ? ' weekend' : ''}${date === today ? ' today' : ''}`}>
            <div className="ws-head">
              <span className="d">{l.short}</span>
              <span className="dt">{l.date}</span>
            </div>
            {on[date].length > 0 && (
              <ul className="ws-dates">
                {on[date].map((k, i) => (
                  <li key={i} className={`ws-date ${k.kind}`} title={k.detail}>{k.label}</li>
                ))}
              </ul>
            )}
            {open ? (
              <div className="ws-edit">
                <textarea
                  autoFocus
                  rows={3}
                  maxLength={500}
                  value={editing.text}
                  placeholder="Big booking, event, road closure..."
                  aria-label={`Note for ${l.short} ${l.date}`}
                  onChange={(e) => setEditing({ date, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditing(null);
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
                  }}
                />
                <div className="ws-edit-actions">
                  <button className="ghost" onClick={() => setEditing(null)}>Cancel</button>
                  <button className="primary" disabled={saving} onClick={() => void save()}>Save</button>
                </div>
              </div>
            ) : note ? (
              <button
                className="ws-note"
                disabled={!onSaveNote}
                onClick={() => setEditing({ date, text: note.text })}
                title={note.updatedBy ? `Written by ${note.updatedBy}${onSaveNote ? '. Click to change it.' : ''}` : undefined}
              >
                {note.text}
              </button>
            ) : onSaveNote ? (
              <button className="ws-add" onClick={() => setEditing({ date, text: '' })} aria-label={`Add a note for ${l.short} ${l.date}`}>
                + Note
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
