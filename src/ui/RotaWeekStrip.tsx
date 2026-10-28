import { useEffect, useState } from 'react';
import { noteKindLabel, notesOn } from '../engine/dayNotes';
import { formatMinute, toISODate, weekday } from '../engine/time';
import type { DayNote, LocalEvent, RotaState, SchoolPeriod, Site } from '../engine/types';
import { api } from './api';
import { DayNoteEditor } from './DayNoteEditor';
import { dayLabel } from './format';
import { keyDates } from './weekStrip';

type NoteDraft = Omit<DayNote, 'id' | 'updatedBy' | 'updatedAt'> & { id?: string };

interface Props {
  state: RotaState;
  site: Site;
  dates: string[];
  /** Absent when the person cannot edit this site's rota: notes are then read only. */
  onSaveNote?: (note: NoteDraft) => Promise<unknown>;
  onDeleteNote?: (id: string) => Promise<unknown>;
}

/**
 * The week along the top of the rota: what is on each day (bank holidays, occasions, local
 * events, weddings and functions, school holidays) and the site's notes on it, so whoever builds the rota knows.
 */
export function RotaWeekStrip({ state, site, dates, onSaveNote, onDeleteNote }: Props) {
  const [events, setEvents] = useState<LocalEvent[]>([]);
  const [school, setSchool] = useState<SchoolPeriod[]>([]);
  // The note open in the editor, or a new one's site and day, with the day it was opened from.
  const [editing, setEditing] = useState<{ note: DayNote | { siteId: string; date: string }; date: string } | null>(null);
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

  const on = keyDates(dates, events, school, (state.privateEvents ?? []).filter((e) => e.siteId === site.id));
  const today = toISODate(new Date());
  const canEdit = !!onSaveNote && !!onDeleteNote;

  return (
    <div className="panel week-strip" aria-label="What is on this week">
      {dates.map((date) => {
        const l = dayLabel(date);
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
            {notesOn(state.dayNotes ?? [], site.id, date).map((n) => (
              <button
                key={n.id}
                className={`ws-note ${n.kind}`}
                disabled={!canEdit}
                onClick={() => setEditing({ note: n, date })}
                title={[n.updatedBy && `Written by ${n.updatedBy}.`, n.team ? 'The team sees this.' : 'Managers only.', canEdit && 'Click to change it.'].filter(Boolean).join(' ')}
              >
                <span className="ws-note-head">
                  <span className="ws-note-kind">{noteKindLabel(n.kind)}{n.startMinute !== undefined ? ` ${formatMinute(n.startMinute)}` : ''}</span>
                  {n.weekly && <span className="ws-note-tag">Weekly</span>}
                  {n.team && <span className="ws-note-tag team">Team</span>}
                </span>
                <span className="ws-note-text">{n.text}</span>
              </button>
            ))}
            {canEdit && (
              <button className="ws-add" onClick={() => setEditing({ note: { siteId: site.id, date }, date })} aria-label={`Add a note for ${l.short} ${l.date}`}>
                + Note
              </button>
            )}
          </div>
        );
      })}
      {editing && canEdit && <DayNoteEditor note={editing.note} date={editing.date} onSave={onSaveNote!} onDelete={onDeleteNote!} onClose={() => setEditing(null)} />}
    </div>
  );
}
