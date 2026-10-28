import { useState } from 'react';
import { NOTE_KINDS } from '../engine/dayNotes';
import { addDays, formatMinute, parseClock, weekday } from '../engine/time';
import type { DayNote, DayNoteKind } from '../engine/types';
import { dayLabel } from './format';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

type Draft = Omit<DayNote, 'id' | 'updatedBy' | 'updatedAt'> & { id?: string };

interface Props {
  /** The note to change, or a new one's site and day. */
  note: DayNote | { siteId: string; date: string };
  /** The day it was opened from: for a weekly note, the week it would stop at. */
  date: string;
  onSave: (note: Draft) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  onClose: () => void;
}

/** One note on a day: what sort, when, what it says, whether the team sees it, and whether it repeats. */
export function DayNoteEditor({ note, date, onSave, onDelete, onClose }: Props) {
  const existing = 'id' in note ? note : null;
  const [draft, setDraft] = useState<Draft>(existing ? { ...existing } : { siteId: note.siteId, date: note.date, kind: 'other', text: '' });
  const [busy, setBusy] = useState(false);
  const day = WEEKDAYS[weekday(draft.date)];
  // Opened on a later week of a weekly note: it can stop before this week rather than go altogether.
  const laterWeek = existing?.weekly && date > existing.date;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    const ok = await fn();
    setBusy(false);
    if (ok) onClose();
  }

  const save = () => run(() => onSave({ ...draft, text: draft.text.trim(), ...(draft.weekly ? {} : { until: undefined }) }));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={existing ? 'Edit note' : 'New note'} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>{existing ? 'Edit note' : 'New note'}</h2>
            <p className="muted small">
              {dayLabel(draft.date).short} {dayLabel(draft.date).date}
              {existing?.weekly ? `, every ${day}. Changes apply to every week.` : ''}
            </p>
          </div>
        </div>
        <div className="modal-body">
          <div className="note-kinds" role="radiogroup" aria-label="What sort of note">
            {NOTE_KINDS.map((k) => (
              <button key={k.id} role="radio" aria-checked={draft.kind === k.id} className={`note-kind ${k.id}${draft.kind === k.id ? ' active' : ''}`} onClick={() => setDraft({ ...draft, kind: k.id as DayNoteKind })}>
                {k.label}
              </button>
            ))}
          </div>
          <div className="form">
            <label className="wide-field">
              Note
              <textarea
                autoFocus
                rows={3}
                maxLength={500}
                value={draft.text}
                placeholder="Party of 24 at 19:30, set menu. Road closed until 10:00. Bidfood delivery."
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.text.trim() && void save()}
              />
            </label>
            <label>
              Time (optional)
              <span className="note-time">
                <input
                  type="time"
                  value={draft.startMinute === undefined ? '' : formatMinute(draft.startMinute)}
                  onChange={(e) => setDraft({ ...draft, startMinute: e.target.value ? parseClock(e.target.value) % 1440 : undefined })}
                />
                {draft.startMinute !== undefined && <button className="link" onClick={() => setDraft({ ...draft, startMinute: undefined })}>All day</button>}
              </span>
            </label>
            <label className="check">
              <input type="checkbox" checked={!!draft.weekly} onChange={(e) => setDraft({ ...draft, weekly: e.target.checked })} />
              Repeat every {day}
            </label>
            {draft.weekly && (
              <label>
                Last {day} (optional)
                <input type="date" min={draft.date} value={draft.until ?? ''} onChange={(e) => setDraft({ ...draft, until: e.target.value || undefined })} />
              </label>
            )}
            <label className="check wide-field note-team">
              <input type="checkbox" checked={!!draft.team} onChange={(e) => setDraft({ ...draft, team: e.target.checked })} />
              <span>
                Tell the team
                <span className="muted small"> Shown in the staff app beside the shift of everyone working here that day, and on the site kiosk on the day. Leave off for anything only managers should read.</span>
              </span>
            </label>
          </div>
        </div>
        <div className="modal-actions">
          {existing && (laterWeek ? (
            <>
              <button className="danger" disabled={busy} onClick={() => run(() => onSave({ ...existing, until: addDays(date, -1) }))}>Stop from this week</button>
              <button className="ghost" disabled={busy} onClick={() => window.confirm('Delete this note from every week, past ones included?') && void run(() => onDelete(existing.id))}>Delete every week</button>
            </>
          ) : (
            <button className="danger" disabled={busy} onClick={() => run(() => onDelete(existing.id))}>Delete</button>
          ))}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !draft.text.trim()} onClick={() => void save()}>Save</button>
        </div>
      </div>
    </div>
  );
}
