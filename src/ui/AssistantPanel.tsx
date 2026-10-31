import { useEffect, useMemo, useRef, useState } from 'react';
import { createBrowserClient, describeAgentError, runRotaAgent, type RotaAgentResult } from '../ai/rotaAgent';
import { coverDistance } from '../engine/autoschedule';
import { checkWeek } from '../engine/compliance';
import { peopleInsights, type PersonInsight } from '../engine/insights';
import { weekMetrics } from '../engine/metrics';
import { weekFingerprint } from '../engine/rotaWeek';
import { londonParts, weekDates } from '../engine/time';
import type { RotaState, Shift, TimeEntry } from '../engine/types';
import { api } from './api';
import { dayLabel, money, pct } from './format';

interface Props {
  state: RotaState;
  /** The sites in view: the assistant plans them together. */
  siteIds: string[];
  week: string;
  /** A request handed over from Shifty, ready to draft. */
  initialInstruction?: string;
  /** Saves the draft; resolves to a problem to show, or null once saved. */
  onApply: (shifts: Shift[], baselines: Record<string, string>, instructions: string[]) => Promise<string | null>;
  onClose: () => void;
}

const SITE_EXAMPLES = [
  'Build the week from the forecast and keep labour under target.',
  'Ben is off Saturday. Re-cover the bar without going over target.',
  'Saturday forecast is up 20% for a private party. Add cover for the evening.',
  'Give the under 18s no shifts past 21:00 and fill the gaps with adults.',
  'Fill the gaps without borrowing anyone from another company.',
];
const GROUP_EXAMPLES = [
  'Build every site from the forecast, sharing staff between sites before anyone goes over target.',
  'Fill the gaps at each site, borrowing only within the same company.',
  'Rebalance weekends so nobody works every Saturday, across all sites.',
];

const usd = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

const fingerprints = (state: RotaState, siteIds: string[], week: string) =>
  Object.fromEntries(siteIds.map((id) => [id, weekFingerprint(state.shifts, id, week)]));

export function AssistantPanel({ state, siteIds, week, initialInstruction = '', onApply, onClose }: Props) {
  const [instruction, setInstruction] = useState(initialInstruction);
  const [followUp, setFollowUp] = useState('');
  const [steps, setSteps] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RotaAgentResult | null>(null);
  const [insights, setInsights] = useState<Record<string, PersonInsight> | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);
  // Each site's week as it stood when this draft began: saving is refused if anyone has changed it since.
  const baselines = useRef(fingerprints(state, siteIds, week));
  const group = siteIds.length > 1;
  const examples = group ? GROUP_EXAMPLES : SITE_EXAMPLES;
  const names = siteIds.map((id) => state.sites.find((s) => s.id === id)?.name ?? id);

  // History makes the draft fairer, but the assistant still works without it.
  useEffect(() => {
    let live = true;
    api
      .get<TimeEntry[]>('/v1/time-entries')
      .then((entries) => {
        if (!live) return;
        const today = londonParts(new Date()).date;
        setInsights(peopleInsights(state, state.employees, entries, week, today));
      })
      .catch(() => live && setInsights(undefined));
    return () => {
      live = false;
    };
  }, [state, week]);

  async function run(previous?: RotaAgentResult) {
    abort.current = new AbortController();
    setRunning(true);
    setError(null);
    if (!previous) {
      setResult(null);
      setSteps([]);
      baselines.current = fingerprints(state, siteIds, week);
    }
    try {
      const res = await runRotaAgent(
        createBrowserClient(),
        { state, siteIds, weekStart: week, instruction: previous ? followUp : instruction, now: londonParts(new Date()), insights, previous },
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
    const problem = await onApply(draft.state.shifts, baselines.current, draft.instructions);
    setSaving(false);
    if (problem) setError(`Not saved: ${problem}`);
  }

  const busy = running || saving;
  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal assistant" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Rota assistant">
        <h2>Rota assistant{group ? `: ${names.length} sites` : `: ${names[0]}`}</h2>
        <p className="muted small">
          Tell it what you need in plain English. It drafts the week using the same costing and compliance engine as the
          rota, so it cannot roster anything illegal, and it leaves shifts that have already started alone.
          {group && ` It plans ${names.join(', ')} together, sharing staff between them.`} Nothing changes until you apply the
          draft.
        </p>

        {!result && (
          <>
            <textarea
              rows={4}
              value={instruction}
              disabled={busy}
              placeholder={examples[0]}
              onChange={(e) => setInstruction(e.target.value)}
            />
            <div className="examples">
              {examples.map((ex) => (
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
        {result && <Preview before={state} after={result.state} siteIds={siteIds} week={week} summary={result.summary} />}

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

function Preview({ before, after, siteIds, week, summary }: { before: RotaState; after: RotaState; siteIds: string[]; week: string; summary: string }) {
  const rows = useMemo(() => {
    const dates = new Set(weekDates(week));
    return siteIds.map((siteId) => {
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
      // Who is borrowed, and from where: another company in the group means an intercompany recharge.
      const away = [...now.values()].map((x) => {
        const e = after.employees.find((p) => p.id === x.employeeId);
        return e ? coverDistance(after, e, siteId) : 0;
      });
      return {
        siteId,
        name: after.sites.find((s) => s.id === siteId)?.name ?? siteId,
        added,
        changed,
        removed: [...was.keys()].filter((id) => !now.has(id)).length,
        sister: away.filter((d) => d === 1).length,
        recharge: away.filter((d) => d === 2).length,
        was: weekMetrics(before, siteId, week),
        now: weekMetrics(after, siteId, week),
      };
    });
  }, [before, after, siteIds, week]);
  const blocks = useMemo(() => checkWeek(after, week, siteIds).filter((i) => i.severity === 'block').length, [after, week, siteIds]);

  const sister = rows.reduce((n, r) => n + r.sister, 0);
  const recharge = rows.reduce((n, r) => n + r.recharge, 0);
  const borrowed = sister > 0 || recharge > 0;
  return (
    <div className="preview">
      <table className="table preview-table">
        <thead>
          <tr>
            <th>{rows.length > 1 ? 'Site' : ''}</th>
            <th className="num">Labour %</th>
            <th className="num">Target</th>
            <th className="num">Labour cost</th>
            <th className="num">Changes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const over = r.now.varianceToTarget > 0;
            return (
              <tr key={r.siteId}>
                <td>{r.name}</td>
                <td className={`num strong ${over ? 'bad-text' : ''}`}>{pct(r.was.labourPct)} to {pct(r.now.labourPct)}</td>
                <td className="num muted">{pct(r.now.targetPct, 0)}</td>
                <td className="num">{money(r.now.labourCost)} <span className="muted small">({over ? '+' : ''}{money(r.now.varianceToTarget)})</span></td>
                <td className="num">{r.added} added, {r.changed} changed, {r.removed} removed</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className={`small ${blocks ? 'bad-text' : 'muted'}`}>
        {blocks ? `${blocks} blocking issues to resolve before publishing.` : 'Clear to publish.'}
        {borrowed && ` Cover from other sites: ${sister} shift${sister === 1 ? '' : 's'} from sister sites`}
        {recharge > 0 && `, ${recharge} from another company (intercompany recharge)`}
        {borrowed && '.'}
      </p>
      {summary && <p className="summary">{summary}</p>}
      <p className="muted small">Week commencing {dayLabel(week).date}. Review the grid after applying, then publish as normal.</p>
    </div>
  );
}
