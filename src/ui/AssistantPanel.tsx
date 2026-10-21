import { useMemo, useRef, useState } from 'react';
import { createBrowserClient, describeAgentError, runRotaAgent, type RotaAgentResult } from '../ai/rotaAgent';
import { checkWeek } from '../engine/compliance';
import { weekMetrics } from '../engine/metrics';
import { toISODate, weekDates } from '../engine/time';
import type { RotaState, Shift } from '../engine/types';
import { dayLabel, money, pct } from './format';

interface Props {
  state: RotaState;
  siteId: string;
  week: string;
  onApply: (shifts: Shift[]) => void;
  onClose: () => void;
}

const EXAMPLES = [
  'Build the week from the forecast and keep labour under target.',
  'Ben is off Saturday. Re-cover the bar without going over target.',
  'Saturday forecast is up 20% for a private party. Add cover for the evening.',
  'Give the under 18s no shifts past 21:00 and fill the gaps with adults.',
];

export function AssistantPanel({ state, siteId, week, onApply, onClose }: Props) {
  const [instruction, setInstruction] = useState('');
  const [steps, setSteps] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RotaAgentResult | null>(null);
  const abort = useRef<AbortController | null>(null);

  async function run() {
    abort.current = new AbortController();
    setRunning(true);
    setError(null);
    setResult(null);
    setSteps([]);
    try {
      const res = await runRotaAgent(
        createBrowserClient(),
        { state, siteId, weekStart: week, instruction, today: toISODate(new Date()) },
        (s) => setSteps((prev) => [...prev, s]),
        abort.current.signal,
      );
      setResult(res);
    } catch (err) {
      setError(describeAgentError(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={running ? undefined : onClose}>
      <div className="modal assistant" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Rota assistant">
        <h2>Rota assistant</h2>
        <p className="muted small">
          Tell it what you need in plain English. It drafts the week using the same costing and compliance engine as the
          rota, so it cannot roster anything illegal. Nothing changes until you apply the draft.
        </p>

        <textarea
          rows={4}
          value={instruction}
          disabled={running}
          placeholder={EXAMPLES[0]}
          onChange={(e) => setInstruction(e.target.value)}
        />
        <div className="examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="link small" disabled={running} onClick={() => setInstruction(ex)}>
              {ex}
            </button>
          ))}
        </div>

        {(running || steps.length > 0) && (
          <ol className="steps small">
            {steps.map((s, i) => <li key={i}>{s}</li>)}
            {running && <li className="muted">Working...</li>}
          </ol>
        )}

        {error && <p className="bad-text small">{error}</p>}
        {result && <Preview before={state} after={result.state} siteId={siteId} week={week} summary={result.summary} />}

        <div className="modal-actions">
          {running ? (
            <button onClick={() => abort.current?.abort()}>Stop</button>
          ) : (
            <button className={result ? '' : 'primary'} onClick={run}>{result ? 'Draft again' : 'Draft rota'}</button>
          )}
          <span className="spacer" />
          {result && !running && (
            <button className="primary" onClick={() => onApply(result.state.shifts)}>Apply draft</button>
          )}
          <button disabled={running} onClick={onClose}>{result ? 'Discard' : 'Close'}</button>
        </div>
      </div>
    </div>
  );
}

function Preview({ before, after, siteId, week, summary }: { before: RotaState; after: RotaState; siteId: string; week: string; summary: string }) {
  const diff = useMemo(() => {
    const dates = new Set(weekDates(week));
    const scope = (s: RotaState) => s.shifts.filter((x) => x.siteId === siteId && dates.has(x.date));
    const was = new Map(scope(before).map((s) => [s.id, s]));
    const now = new Map(scope(after).map((s) => [s.id, s]));
    let added = 0;
    let changed = 0;
    for (const [id, s] of now) {
      const old = was.get(id);
      if (!old) added++;
      else if (old.employeeId !== s.employeeId || old.startMinute !== s.startMinute || old.endMinute !== s.endMinute) changed++;
    }
    const removed = [...was.keys()].filter((id) => !now.has(id)).length;
    const blocks = checkWeek(after, week, siteId).filter((i) => i.severity === 'block').length;
    return {
      added,
      changed,
      removed,
      blocks,
      was: weekMetrics(before, siteId, week),
      now: weekMetrics(after, siteId, week),
    };
  }, [before, after, siteId, week]);

  const over = diff.now.varianceToTarget > 0;
  return (
    <div className="preview">
      <div className="preview-kpis">
        <div>
          <div className="muted small">Labour %</div>
          <div className={`strong ${over ? 'bad-text' : ''}`}>
            {pct(diff.was.labourPct)} to {pct(diff.now.labourPct)}
          </div>
          <div className="muted small">Target {pct(diff.now.targetPct, 0)}</div>
        </div>
        <div>
          <div className="muted small">Labour cost</div>
          <div className="strong">{money(diff.now.labourCost)}</div>
          <div className="muted small">{over ? '+' : ''}{money(diff.now.varianceToTarget)} vs target</div>
        </div>
        <div>
          <div className="muted small">Changes</div>
          <div className="strong">{diff.added} added, {diff.changed} changed, {diff.removed} removed</div>
          <div className={`small ${diff.blocks ? 'bad-text' : 'muted'}`}>
            {diff.blocks ? `${diff.blocks} blocking issues to resolve before publishing` : 'Clear to publish'}
          </div>
        </div>
      </div>
      {summary && <p className="summary">{summary}</p>}
      <p className="muted small">Week commencing {dayLabel(week).date}. Review the grid after applying, then publish as normal.</p>
    </div>
  );
}
