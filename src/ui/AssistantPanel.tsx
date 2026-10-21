import { useMemo, useRef, useState } from 'react';
import { createBrowserClient, describeAgentError, runRotaAgent, type RotaAgentResult } from '../ai/rotaAgent';
import { coverDistance } from '../engine/autoschedule';
import { checkWeek } from '../engine/compliance';
import { weekMetrics } from '../engine/metrics';
import { weekFingerprint } from '../engine/rotaWeek';
import { londonParts, weekDates } from '../engine/time';
import type { RotaState, Shift } from '../engine/types';
import { dayLabel, money, pct } from './format';

interface Props {
  state: RotaState;
  siteId: string;
  week: string;
  /** Saves the draft; resolves to a problem to show, or null once saved. */
  onApply: (shifts: Shift[], baseline: string, instructions: string[]) => Promise<string | null>;
  onClose: () => void;
}

const EXAMPLES = [
  'Build the week from the forecast and keep labour under target.',
  'Ben is off Saturday. Re-cover the bar without going over target.',
  'Saturday forecast is up 20% for a private party. Add cover for the evening.',
  'Give the under 18s no shifts past 21:00 and fill the gaps with adults.',
  'Fill the gaps without borrowing anyone from another company.',
];

const usd = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

export function AssistantPanel({ state, siteId, week, onApply, onClose }: Props) {
  const [instruction, setInstruction] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [steps, setSteps] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RotaAgentResult | null>(null);
  const abort = useRef<AbortController | null>(null);
  // The week as it stood when this draft began: saving is refused if anyone has changed it since.
  const baseline = useRef(weekFingerprint(state.shifts, siteId, week));

  async function run(previous?: RotaAgentResult) {
    abort.current = new AbortController();
    setRunning(true);
    setError(null);
    if (!previous) {
      setResult(null);
      setSteps([]);
      baseline.current = weekFingerprint(state.shifts, siteId, week);
    }
    try {
      const res = await runRotaAgent(
        createBrowserClient(),
        { state, siteId, weekStart: week, instruction: previous ? followUp : instruction, now: londonParts(new Date()), previous },
        (s) => setSteps((prev) => [...prev, s]),
        abort.current.signal,
      );
      setResult(res);
      setFollowUp('');
    } catch (err) {
      // A failed follow-up keeps the last good draft, so nothing already agreed is lost.
      setError(describeAgentError(err));
    } finally {
      setRunning(false);
    }
  }

  async function apply(draft: RotaAgentResult) {
    setSaving(true);
    const problem = await onApply(draft.state.shifts, baseline.current, draft.instructions);
    setSaving(false);
    if (problem) setError(`Not saved: ${problem}`);
  }

  const busy = running || saving;
  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal assistant" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Rota assistant">
        <h2>Rota assistant</h2>
        <p className="muted small">
          Tell it what you need in plain English. It drafts the week using the same costing and compliance engine as the
          rota, so it cannot roster anything illegal, and it leaves shifts that have already started alone. Nothing
          changes until you apply the draft.
        </p>

        {!result && (
          <>
            <textarea
              rows={4}
              value={instruction}
              disabled={busy}
              placeholder={EXAMPLES[0]}
              onChange={(e) => setInstruction(e.target.value)}
            />
            <div className="examples">
              {EXAMPLES.map((ex) => (
                <button key={ex} className="link small" disabled={busy} onClick={() => setInstruction(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </>
        )}

        {result && (
          <ol className="asked small">
            {result.instructions.map((text, i) => <li key={i}>{text}</li>)}
          </ol>
        )}

        {(running || steps.length > 0) && (
          <ol className="steps small">
            {steps.map((s, i) => <li key={i}>{s}</li>)}
            {running && <li className="muted">Working...</li>}
          </ol>
        )}

        {error && <p className="bad-text small">{error}</p>}
        {result && (
          <Preview before={state} after={result.state} siteId={siteId} week={week} summary={result.summary} />
        )}

        {result && (
          <form
            className="refine"
            onSubmit={(e) => { e.preventDefault(); if (followUp.trim()) void run(result); }}
          >
            <input
              value={followUp}
              disabled={busy}
              placeholder="Ask for a change to this draft, for example: give Sofia Sunday off"
              aria-label="Change to the draft"
              onChange={(e) => setFollowUp(e.target.value)}
            />
            <button type="submit" disabled={busy || !followUp.trim()}>Change draft</button>
          </form>
        )}

        <div className="modal-actions">
          {running ? (
            <button onClick={() => abort.current?.abort()}>Stop</button>
          ) : (
            <button className={result ? '' : 'primary'} disabled={saving} onClick={() => void run()}>
              {result ? 'Start again' : 'Draft rota'}
            </button>
          )}
          {result && (
            <span className="muted small" title="Approximate, at Claude Opus 5.5 list prices">
              Claude usage {usd.format(result.usage.costUsd)}
            </span>
          )}
          <span className="spacer" />
          {result && !running && (
            <button className="primary" disabled={saving} onClick={() => void apply(result)}>
              {saving ? 'Saving...' : 'Apply draft'}
            </button>
          )}
          <button disabled={busy} onClick={onClose}>{result ? 'Discard' : 'Close'}</button>
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
    // Who is borrowed, and from where: another company in the group means an intercompany recharge.
    const away = [...now.values()].map((x) => {
      const e = after.employees.find((p) => p.id === x.employeeId);
      return e ? coverDistance(after, e, siteId) : 0;
    });
    const sister = away.filter((d) => d === 1).length;
    const recharge = away.filter((d) => d === 2).length;
    const blocks = checkWeek(after, week, siteId).filter((i) => i.severity === 'block').length;
    return {
      added,
      changed,
      removed,
      blocks,
      sister,
      recharge,
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
      {(diff.sister > 0 || diff.recharge > 0) && (
        <p className="small muted">
          Cover from other sites: {diff.sister} shift{diff.sister === 1 ? '' : 's'} from sister sites
          {diff.recharge > 0 && `, ${diff.recharge} from another company (intercompany recharge)`}.
        </p>
      )}
      {summary && <p className="summary">{summary}</p>}
      <p className="muted small">Week commencing {dayLabel(week).date}. Review the grid after applying, then publish as normal.</p>
    </div>
  );
}
