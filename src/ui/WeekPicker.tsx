import { useEffect, useRef, useState } from 'react';
import { addDays, daysBetween, toISODate, weekStart } from '../engine/time';
import { isoWeek } from './format';

const short = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');

/** Where a week sits against today's, in the words a manager uses on the floor. */
export function relativeWeek(week: string, current: string) {
  const n = Math.round(daysBetween(current, week) / 7);
  if (n === 0) return 'This week';
  if (n === 1) return 'Next week';
  if (n === -1) return 'Last week';
  return n > 0 ? `In ${n} weeks` : `${-n} weeks ago`;
}

/** Monday to Sunday, with the month on both ends so a week across a month end reads correctly. */
export const weekRange = (week: string) => `${day(week)} to ${day(addDays(week, 6))}`;

// The list opens on a few weeks either side of the one in view: back to check, mostly forward to plan.
const BEFORE = 4;
const AFTER = 8;

export function WeekPicker({ week, onChange }: { week: string; onChange: (week: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const current = weekStart(toISODate(new Date()));
  const onCurrent = week === current;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const go = (w: string) => { onChange(w); setOpen(false); };
  const weeks = Array.from({ length: BEFORE + AFTER + 1 }, (_, i) => addDays(week, (i - BEFORE) * 7));

  return (
    <div className="weekpicker" ref={box}>
      <button className="wp-step" onClick={() => onChange(addDays(week, -7))} aria-label="Previous week" title="Previous week">&larr;</button>
      <button className="wp-current" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open} aria-label="Choose week">
        <span className="wp-when">{relativeWeek(week, current)}</span>
        <span className="wp-range tnum">Wk {isoWeek(week)} · {weekRange(week)}</span>
      </button>
      <button className="wp-step" onClick={() => onChange(addDays(week, 7))} aria-label="Next week" title="Next week">&rarr;</button>
      {!onCurrent && <button className="ghost wp-today" onClick={() => onChange(current)}>Back to this week</button>}
      {open && (
        <div className="wp-menu" role="listbox" aria-label="Weeks">
          {weeks.map((w) => (
            <button
              key={w}
              role="option"
              aria-selected={w === week}
              className={`wp-option${w === week ? ' selected' : ''}${w === current ? ' now' : ''}`}
              onClick={() => go(w)}
            >
              <span className="wp-when">{relativeWeek(w, current)}</span>
              <span className="wp-range tnum">Wk {isoWeek(w)} · {short(w)} to {short(addDays(w, 6))}</span>
            </button>
          ))}
          <label className="wp-jump">
            <span className="eyebrow">Jump to the week of</span>
            <input type="date" value={week} onChange={(e) => e.target.value && go(weekStart(e.target.value))} />
          </label>
        </div>
      )}
    </div>
  );
}
