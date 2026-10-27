import { useState } from 'react';
import type { DecisionAction } from '../engine/decisions';
import type { RotaHint } from '../engine/rotaHints';
import { Tip } from './Tip';

const KEY = 'preshift.hints.folded';
const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TONE: Record<RotaHint['tone'], string> = { repeat: 'Again', tip: 'Tip', keep: 'Keep doing' };

function savedFold(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Coaching while a draft is written: what the last four weeks at the site say about this one. Mistakes
 * made before and made again come first, then tips for the draft, then habits worth keeping. Folds to
 * a line, and stays as each person last left it.
 */
export function RotaHints({ hints, onAct }: { hints: RotaHint[]; onAct: (action: DecisionAction) => void }) {
  const [folded, setFoldedState] = useState(savedFold);
  function setFolded(next: boolean) {
    setFoldedState(next);
    try {
      localStorage.setItem(KEY, next ? '1' : '0');
    } catch {
      // Not remembered in private mode; the panel still folds.
    }
  }
  if (hints.length === 0) return null;
  const repeats = hints.filter((h) => h.tone === 'repeat').length;
  return (
    <section className={`decisions hints${folded ? ' folded' : ''}`} aria-label="Coaching for this draft">
      <div className="decisions-head">
        <button className="decisions-toggle" aria-expanded={!folded} aria-controls="hints-list" onClick={() => setFolded(!folded)}>
          Coaching for this draft
        </button>
        {folded ? (
          <span className="decisions-first">{hints[0].title}{hints.length > 1 ? `, and ${hints.length - 1} more` : ''}</span>
        ) : (
          <span className="muted small">
            {repeats > 0 ? `${repeats} ${repeats === 1 ? 'thing' : 'things'} you have done before` : 'From your last four weeks'}{' '}
            <Tip about="the coaching">
              Read from the last four weeks at this site: the rotas you ran, what each day took against its sales forecast, and the pace in sales per labour hour. Mistakes repeated from earlier weeks come first, then tips for this draft, then what to keep doing. Shown until the week is published.
            </Tip>
          </span>
        )}
      </div>
      {!folded && (
        <ol className="decisions-list" id="hints-list">
          {hints.map((h) => (
            <li key={`${h.kind}${h.dates[0] ?? ''}${h.title}`} className={`decision hint hint-${h.tone}`}>
              <span className="hint-tone">{TONE[h.tone]}</span>
              <div className="decision-text">
                <b>{h.title}</b>
                <span>{h.detail}</span>
              </div>
              {h.action?.kind === 'day' && (
                <button onClick={() => onAct(h.action!)}>Go to {DAY[new Date(`${h.action.date}T00:00:00Z`).getUTCDay()]}</button>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
