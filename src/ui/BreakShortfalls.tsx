import { useState } from 'react';
import type { BreakShortfall } from '../engine/breaks';
import { formatMinute } from '../engine/time';
import type { TimeEntry } from '../engine/types';
import { dayLabel } from './format';

interface Props {
  shortfalls: BreakShortfall[];
  entries: TimeEntry[];
  name: (employeeId: string) => string;
  busy: boolean;
  /** Saves the break actually taken; the entry goes back to waiting for approval. */
  onCorrect: (entryId: string, breakMinutes: number) => void;
}

const hm = (minutes: number) => `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`;

/**
 * Shifts this week with less rest break than the law gives. Shown, never fixed for the manager:
 * setting a break that was not taken would cut the person's pay and falsify the record.
 */
export function BreakShortfalls({ shortfalls, entries, name, busy, onCorrect }: Props) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  if (shortfalls.length === 0) return null;
  return (
    <div className="notice">
      <strong>
        {shortfalls.length} {shortfalls.length === 1 ? 'shift' : 'shifts'} below the legal minimum break this week.
      </strong>{' '}
      The Working Time Regulations give 20 minutes in one block over 6 hours of work, and 30 minutes over 4.5 hours for under 18s.
      If a break was taken but not recorded, enter it. If it was not taken, leave the record as it is: the time was worked and
      is owed. Approving is still allowed, and is recorded against these shifts.
      <div className="grid-wrap" style={{ marginTop: 8 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th><th>Day</th><th>Clocked</th><th className="num">Worked</th><th className="num">Break</th><th>Issue</th><th className="num">Break actually taken</th>
            </tr>
          </thead>
          <tbody>
            {shortfalls.map((b) => {
              const entry = entries.find((t) => t.id === b.entryId);
              const d = dayLabel(b.date);
              const value = draft[b.entryId] ?? String(b.takenMinutes);
              const minutes = Number(value);
              return (
                <tr key={b.entryId}>
                  <td>{name(b.employeeId)}{b.under18 && <span className="tag">Under 18</span>}</td>
                  <td>{d.short} {d.date}</td>
                  <td>{entry ? `${formatMinute(entry.clockIn)} to ${formatMinute(entry.clockOut!)}` : ''}</td>
                  <td className="num">{hm(b.workedMinutes)}</td>
                  <td className="num">{b.takenMinutes} min</td>
                  <td className="warn-text">
                    {b.code === 'short'
                      ? b.takenMinutes === 0
                        ? `No break, needs ${b.requiredMinutes} min`
                        : `${b.requiredMinutes - b.takenMinutes} min short, needs ${b.requiredMinutes}`
                      : `Split: longest ${b.longestMinutes} min, needs ${b.requiredMinutes} in one`}
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      min={0}
                      style={{ width: 70 }}
                      value={value}
                      onChange={(e) => setDraft((x) => ({ ...x, [b.entryId]: e.target.value }))}
                      aria-label={`Break actually taken by ${name(b.employeeId)} on ${d.short} ${d.date}, minutes`}
                    />{' '}
                    <button
                      disabled={busy || !Number.isInteger(minutes) || minutes < 0 || minutes === b.takenMinutes}
                      onClick={() => onCorrect(b.entryId, minutes)}
                    >
                      Save
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
