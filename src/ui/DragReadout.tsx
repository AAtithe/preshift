import type { Issue } from '../engine/compliance';
import { formatMinute } from '../engine/time';
import type { Shift } from '../engine/types';
import { dayLabel, hours, money, pct } from './format';

interface ReadoutProps {
  x: number;
  y: number;
  shift: Shift;
  name: string;
  shiftCost: number;
  delta: number;
  labourPct: number;
  over: boolean;
  flags: Issue[];
  blocked: string | null;
  resizing: boolean;
  touch: boolean;
}

/** Follows the pointer during a drag: where the shift lands and what it does to the week. */
export function DragReadout({ x, y, shift, name, shiftCost, delta, labourPct, over, flags, blocked, resizing, touch }: ReadoutProps) {
  const l = dayLabel(shift.date);
  const blocking = flags.some((f) => f.severity === 'block');
  const sign = delta > 0.5 ? '+' : delta < -0.5 ? '-' : '';
  // Keep clear of the finger on touch, and inside the window near the edges.
  const width = 250;
  const left = Math.max(8, Math.min(x + 16, window.innerWidth - width - 8));
  const top = touch ? (y - 190 > 8 ? y - 190 : y + 48) : Math.min(y + 18, window.innerHeight - 190);
  return (
    <div className="drag-readout" style={{ left, top, width }} role="status">
      {blocked && (
        <div className="drag-stop">
          {resizing ? 'Held at the limit. ' : 'Cannot drop here. '}
          {blocked}
        </div>
      )}
      <div className="tip-title">
        {name} · {l.short} {l.date}
      </div>
      <div className="tip-row">
        <span>Hours</span>
        <span>
          {formatMinute(shift.startMinute)}-{formatMinute(shift.endMinute)} · {hours((shift.endMinute - shift.startMinute - shift.breakMinutes) / 60)}
        </span>
      </div>
      <div className="tip-row">
        <span>This shift</span>
        <span>{money(shiftCost)}</span>
      </div>
      <div className="tip-row">
        <span>Week labour</span>
        <span className={sign === '+' ? 'up' : sign === '-' ? 'down' : ''}>
          {sign}
          {money(Math.abs(delta))}
        </span>
      </div>
      <div className="tip-row">
        <span>Labour %</span>
        <span className={over ? 'up' : 'down'}>{pct(labourPct)}</span>
      </div>
      {flags.length > 0 && (
        <div className={`drag-flag ${blocking ? 'block' : 'warn'}`}>{flags[0].message}{flags.length > 1 ? ` (+${flags.length - 1} more)` : ''}</div>
      )}
    </div>
  );
}
