import { useState } from 'react';
import type { Decision, DecisionAction, WeekBrief } from '../engine/decisions';
import { Tip } from './Tip';

const KEY = 'preshift.decisions.folded';
const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function savedFold(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** The button that settles a decision, or none for someone whose roles cannot settle it. */
function actionLabel(action: DecisionAction, canEdit: boolean): string | null {
  switch (action.kind) {
    // The build fills every short hour in the week, not only the empty days, so the button says so.
    case 'build':
      return canEdit ? 'Build the week from the forecast' : null;
    case 'dismiss-gaps':
      return 'Dismiss';
    case 'day':
      return `Go to ${DAY[new Date(`${action.date}T00:00:00Z`).getUTCDay()]}`;
    case 'people':
      return 'See the week by person';
    case 'issues':
      return 'Show the issues';
  }
}

/**
 * The week's decisions above the rota, most urgent first, each with the one move that settles it.
 * Folds to a single line once read, and stays folded or open as each person last left it.
 */
export function DecisionsBar({ brief, canEdit, onAct }: { brief: WeekBrief; canEdit: boolean; onAct: (action: DecisionAction) => void }) {
  const [folded, setFoldedState] = useState(savedFold);
  function setFolded(next: boolean) {
    setFoldedState(next);
    try {
      localStorage.setItem(KEY, next ? '1' : '0');
    } catch {
      // Not remembered in private mode; the bar still folds.
    }
  }
  const { decisions, keep } = brief;
  if (decisions.length === 0 && !keep) return null;
  if (decisions.length === 0) {
    return (
      <section className="decisions calm" aria-label="Decisions this week">
        <p className="decisions-keep"><b>Keep doing.</b> {keep}</p>
      </section>
    );
  }
  const n = decisions.length;
  return (
    <section className={`decisions${folded ? ' folded' : ''}`} aria-label="Decisions this week">
      <div className="decisions-head">
        <button className="decisions-toggle" aria-expanded={!folded} aria-controls="decisions-list" onClick={() => setFolded(!folded)}>
          {n} {n === 1 ? 'decision' : 'decisions'} this week
        </button>
        {folded ? (
          <span className="decisions-first">{decisions[0].title}{n > 1 ? `, and ${n - 1} more` : ''}</span>
        ) : (
          <span className="muted small">
            Most urgent first{' '}
            <Tip about="the order">
              What stops the week being published comes first, then days with sales forecast and nobody on, then days over the labour target, largest overspend first, then hours paid under contract and not rostered.
            </Tip>
          </span>
        )}
      </div>
      {!folded && (
        <>
          <ol className="decisions-list" id="decisions-list">
            {decisions.map((d, i) => (
              <DecisionCard key={`${d.kind}${d.dates[0] ?? ''}`} n={i + 1} decision={d} label={actionLabel(d.action, canEdit)} onAct={() => onAct(d.action)} />
            ))}
          </ol>
          {keep && <p className="decisions-keep"><b>Keep doing.</b> {keep}</p>}
        </>
      )}
    </section>
  );
}

function DecisionCard({ n, decision, label, onAct }: { n: number; decision: Decision; label: string | null; onAct: () => void }) {
  return (
    <li className={`decision ${decision.severity}`}>
      <span className="decision-n" aria-hidden="true">{n}</span>
      <div className="decision-text">
        <b>{decision.title}</b>
        {/* Two lines at most, so the bar stays short: the whole of it on hover. */}
        <span title={decision.detail}>{decision.detail}</span>
      </div>
      {label && (
        <button className={n === 1 ? 'primary' : ''} onClick={onAct}>
          {label}
        </button>
      )}
    </li>
  );
}
