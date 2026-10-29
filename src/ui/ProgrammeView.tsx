import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Benchmark, BenchmarkMetric } from '../engine/benchmark';
import { PHASES, PROGRAMME_WEEKS, type Programme, type ProgrammeStatus } from '../engine/programme';
import type { Maturity, Scorecard } from '../engine/scorecard';
import type { RotaState } from '../engine/types';
import { addDays, weekStart } from '../engine/time';
import { api, ApiError } from './api';
import { money, pct } from './format';

interface Entry {
  programme: Programme;
  status: ProgrammeStatus;
  maturity: Maturity;
  summary: Scorecard['summary'];
}

interface Benchmarks {
  optedIn: boolean;
  benchmark: Benchmark | null;
  sites: ({ siteId: string; position: Partial<Record<BenchmarkMetric, string>> } & Record<BenchmarkMetric, number | null>)[];
}

interface Props {
  state: RotaState;
  siteIds: string[];
  today: string;
  /** Holds the client partner's sign-off: only then are the lead's actions offered. */
  lead: boolean;
  /** Whether this person may opt the organisation in to sharing: a settings change. */
  canShare: boolean;
  onOpenSite: (siteId: string) => void;
}

const problem = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const METRIC_LABELS: Record<BenchmarkMetric, string> = {
  labourPct: 'Labour %',
  splh: 'Sales per labour hour',
  overstaffedShare: 'Hours over demand',
  forecastWape: 'Forecast error',
};
const formatMetric = (m: BenchmarkMetric, v: number) => (m === 'splh' ? money(v) : pct(v));

/**
 * The labour programme across the sites in scope: where each is in its twelve
 * weeks, which milestones are proved, the targets, and the saving, marked
 * verified only once it is signed off in the management accounts.
 */
export function ProgrammeView({ state, siteIds, today, lead, canShare, onOpenSite }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [bench, setBench] = useState<Benchmarks | null>(null);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const single = siteIds.length === 1 ? siteIds[0] : null;

  const [benchOpen, setBenchOpen] = useState(false);
  const load = useCallback(async () => {
    try {
      setEntries(await api.get<Entry[]>('/v1/programmes'));
      // Benchmarks scan every operator who shares, so they load only once asked for.
      if (benchOpen) setBench(await api.get<Benchmarks>('/v1/benchmarks'));
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  }, [benchOpen]);
  useEffect(() => void load(), [load]);

  async function act(done: string, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      setMessage({ text: done });
      await load();
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    } finally {
      setBusy(false);
    }
  }

  const siteName = (id: string) => state.sites.find((s) => s.id === id)?.name ?? id;
  const inScope = entries.filter((e) => siteIds.includes(e.programme.siteId));
  const notOn = siteIds.filter((id) => !entries.some((e) => e.programme.siteId === id));
  const detail = single ? entries.find((e) => e.programme.siteId === single) : undefined;

  return (
    <div className="insight">
      {message && (
        <div className={`notice ${message.bad ? 'error' : ''}`}>
          {message.text} <button className="link" onClick={() => setMessage(null)}>Dismiss</button>
        </div>
      )}

      <section className="settings-card">
        <h2>Labour programme</h2>
        <p className="muted small">
          Twelve weeks with your accounting partner: {PHASES.map((p) => `${p.label} (weeks ${p.fromWeek} to ${p.toWeek})`).join(', ')}. Milestones are proved
          by the site's own figures where they can be, and signed off by the client partner where they cannot. The saving counts only once it
          is in the management accounts.
        </p>
        {inScope.length === 0 ? (
          <p className="muted">No site in scope is on the programme yet.</p>
        ) : (
          <div className="grid-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Site</th>
                  <th>Week</th>
                  <th>Phase</th>
                  <th className="num">Milestones</th>
                  <th>Ladder</th>
                  <th className="num">On time</th>
                  <th className="num">On target</th>
                  <th className="num">Moves taken</th>
                  <th className="num">Clock vs rota</th>
                  <th className="num">Labour: before, now</th>
                  <th className="num">Annual saving</th>
                </tr>
              </thead>
              <tbody>
                {inScope.map(({ programme: p, status: s, maturity: m, summary }) => (
                  <tr key={p.siteId}>
                    <td><button className="link site-link" onClick={() => onOpenSite(p.siteId)}>{siteName(p.siteId)}</button></td>
                    <td>{s.week === 0 ? 'Not started' : s.week > PROGRAMME_WEEKS ? 'Finished' : `${s.week} of ${PROGRAMME_WEEKS}`}</td>
                    <td>{s.phase?.label ?? ''}</td>
                    <td className="num">{Math.round(s.progress * 100)}%</td>
                    <td>Rung {m.level}<div className="muted small">{m.label}</div></td>
                    <td className="num">{pct(summary.onTimeRate, 0)}</td>
                    <td className="num">{pct(summary.onTargetRate, 0)}</td>
                    <td className="num">{summary.movesTakenRate === null ? 'None offered' : pct(summary.movesTakenRate, 0)}</td>
                    <td className="num">{summary.averageVariance === null ? 'Pending' : pct(summary.averageVariance, 2)}</td>
                    <td className="num">
                      {s.saving.baselinePct === null ? 'No baseline' : pct(s.saving.baselinePct)}
                      {s.saving.currentPct !== null && `, ${pct(s.saving.currentPct)}`}
                    </td>
                    <td className="num">
                      {s.saving.annualSaving === null ? '' : money(s.saving.annualSaving)}
                      {s.saving.annualSaving !== null && <span className={`tag ${s.saving.verified ? 'verified' : ''}`}>{s.saving.verified ? 'Verified' : 'Estimate'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {lead && notOn.length > 0 && (
          <StartForm key={notOn.join()} sites={notOn.map((id) => ({ id, name: siteName(id) }))} today={today} busy={busy}
            onStart={(siteId, startWeek, gainSharePct) => act(`${siteName(siteId)} is on the programme from w/c ${startWeek}.`, () => api.put(`/v1/programmes/${siteId}`, { startWeek, gainSharePct }))} />
        )}
        {!lead && notOn.length > 0 && <p className="muted small">The client partner puts sites on the programme.</p>}
      </section>

      {detail && <SiteDetail key={detail.programme.siteId} entry={detail} lead={lead} busy={busy} act={act} />}

      {!benchOpen && (
        <section className="settings-card">
          <div className="insight-head">
            <div>
              <h2>Benchmarks</h2>
              <p className="muted small">How your sites compare with other operators your accounting partner works with, anonymised.</p>
            </div>
            <button onClick={() => setBenchOpen(true)}>Show benchmarks</button>
          </div>
        </section>
      )}
      {benchOpen && !bench && <p className="muted">Loading benchmarks</p>}
      {benchOpen && bench && <BenchmarkPanel bench={bench} siteIds={siteIds} siteName={siteName} admin={canShare} busy={busy}
        onToggle={(on) => act(on ? 'Sharing anonymised figures. You will see the cohort once it is large enough to stay anonymous.' : 'No longer sharing.', () => api.put('/v1/settings/benchmarking', { benchmarking: on }))} />}
    </div>
  );
}

function StartForm({ sites, today, busy, onStart }: { sites: { id: string; name: string }[]; today: string; busy: boolean; onStart: (siteId: string, startWeek: string, gainSharePct?: number) => void }) {
  const [form, setForm] = useState({ siteId: sites[0].id, startWeek: addDays(weekStart(today), 7), gainShare: '' });
  return (
    <form className="settings-form programme-start" onSubmit={(e) => { e.preventDefault(); onStart(form.siteId, form.startWeek, form.gainShare ? Number(form.gainShare) / 100 : undefined); }}>
      <label>
        Site
        <select value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}>
          {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <label>
        Week 1 starts
        <input type="date" value={form.startWeek} onChange={(e) => setForm({ ...form, startWeek: e.target.value })} />
      </label>
      <label>
        Gain share % (optional)
        <input type="number" min={0} max={100} value={form.gainShare} onChange={(e) => setForm({ ...form, gainShare: e.target.value })} />
      </label>
      <button disabled={busy}>Start programme</button>
    </form>
  );
}

function SiteDetail({ entry, lead, busy, act }: { entry: Entry; lead: boolean; busy: boolean; act: (done: string, fn: () => Promise<unknown>) => Promise<void> }) {
  const { programme: p, status: s } = entry;
  const [baseline, setBaseline] = useState({ from: '', to: '', source: 'management_accounts' as 'management_accounts' | 'till_and_payroll', sales: '', labourCost: '' });
  const [verify, setVerify] = useState({ from: '', to: '', sales: '', labourCost: '', note: '' });
  const locked = s.saving.verified;

  function saveBaseline(e: FormEvent) {
    e.preventDefault();
    void act('Baseline recorded.', () =>
      api.put(`/v1/programmes/${p.siteId}/baseline`, {
        from: baseline.from,
        to: baseline.to,
        source: baseline.source,
        ...(baseline.source === 'management_accounts' ? { sales: Number(baseline.sales), labourCost: Number(baseline.labourCost) } : {}),
      }),
    );
  }

  function saveVerification(e: FormEvent) {
    e.preventDefault();
    void act('Signed off from the management accounts.', () =>
      api.post(`/v1/programmes/${p.siteId}/verifications`, { from: verify.from, to: verify.to, sales: Number(verify.sales), labourCost: Number(verify.labourCost), note: verify.note || undefined }),
    );
  }

  return (
    <>
      <section className="settings-card">
        <h2>Milestones</h2>
        {PHASES.map((phase) => (
          <div key={phase.id} className={`phase ${s.phase?.id === phase.id ? 'current' : ''}`}>
            <h3>{phase.label}, weeks {phase.fromWeek} to {phase.toWeek}</h3>
            <p className="muted small">{phase.purpose}</p>
            <ul className="milestones">
              {s.milestones.filter((m) => m.phase === phase.id).map((m) => (
                <li key={m.id} className={m.done ? 'done' : ''}>
                  <span className="step-n">{m.done ? 'Y' : ''}</span>
                  <div>
                    <div>{m.label}</div>
                    <div className="muted small">{m.evidence}</div>
                  </div>
                  {lead && m.proof === 'signoff' && (
                    m.done
                      ? <button className="link" disabled={busy} onClick={() => void act('Sign-off removed.', () => api.del(`/v1/programmes/${p.siteId}/signoffs/${m.id}`))}>Undo</button>
                      : <button disabled={busy} onClick={() => void act('Signed off.', () => api.post(`/v1/programmes/${p.siteId}/signoffs`, { milestoneId: m.id }))}>Sign off</button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="settings-card">
        <h2>Targets and saving</h2>
        <table className="table">
          <tbody>
            {s.targets.map((t) => (
              <tr key={t.label}>
                <td>{t.label}</td>
                <td className="num">{t.value === null ? 'Not measured' : pct(t.value, t.unit === 'pct' ? 2 : 0)}</td>
                <td className="num muted">{t.unit === 'pct' ? `under ${pct(t.target, 0)}` : `${pct(t.target, 0)} or more`}</td>
                <td>{t.met === null ? '' : t.met ? <span className="good-text">Met</span> : <span className="bad-text">Not yet</span>}</td>
              </tr>
            ))}
            <tr>
              <td>Labour points taken out</td>
              <td className="num">{s.saving.points === null ? 'Needs a baseline' : `${(s.saving.points * 100).toFixed(1)} points`}</td>
              <td className="num">{s.saving.annualSaving === null ? '' : `${money(s.saving.annualSaving)} a year`}</td>
              <td>{s.saving.verified ? <span className="good-text">Verified in the accounts</span> : 'Estimate from the rota'}</td>
            </tr>
            {s.saving.gainShareFee !== null && (
              <tr>
                <td>Gain share at {pct(p.gainSharePct ?? 0, 0)}</td>
                <td className="num">{money(s.saving.gainShareFee)}</td>
                <td colSpan={2} className="muted small">On the verified saving only.</td>
              </tr>
            )}
          </tbody>
        </table>
        {p.baseline && (
          <p className="muted small">
            Baseline {p.baseline.from} to {p.baseline.to}: {money(p.baseline.sales)} sales, {money(p.baseline.labourCost)} labour, from{' '}
            {p.baseline.source === 'management_accounts' ? 'the management accounts' : 'till and payroll'}, recorded by {p.baseline.recordedBy}.
          </p>
        )}
        {lead && !locked && (
          <form className="settings-form" onSubmit={saveBaseline}>
            <label>
              Baseline from
              <select value={baseline.source} onChange={(e) => setBaseline({ ...baseline, source: e.target.value as typeof baseline.source })}>
                <option value="management_accounts">Management accounts</option>
                <option value="till_and_payroll">Till and payroll (whole weeks)</option>
              </select>
            </label>
            <label>From<input type="date" required value={baseline.from} onChange={(e) => setBaseline({ ...baseline, from: e.target.value })} /></label>
            <label>To<input type="date" required value={baseline.to} onChange={(e) => setBaseline({ ...baseline, to: e.target.value })} /></label>
            {baseline.source === 'management_accounts' && (
              <>
                <label>Net sales<input type="number" min={0} required value={baseline.sales} onChange={(e) => setBaseline({ ...baseline, sales: e.target.value })} /></label>
                <label>Loaded labour<input type="number" min={0} required value={baseline.labourCost} onChange={(e) => setBaseline({ ...baseline, labourCost: e.target.value })} /></label>
              </>
            )}
            <button disabled={busy}>{p.baseline ? 'Replace baseline' : 'Record baseline'}</button>
          </form>
        )}
        {lead && !p.baseline && <p className="muted small">Record the baseline first; a saving is signed off against it.</p>}
        {lead && p.baseline && (
          <form className="settings-form" onSubmit={saveVerification}>
            <label>Verified period from<input type="date" required value={verify.from} onChange={(e) => setVerify({ ...verify, from: e.target.value })} /></label>
            <label>To<input type="date" required value={verify.to} onChange={(e) => setVerify({ ...verify, to: e.target.value })} /></label>
            <label>Net sales<input type="number" min={1} required value={verify.sales} onChange={(e) => setVerify({ ...verify, sales: e.target.value })} /></label>
            <label>Loaded labour<input type="number" min={0} required value={verify.labourCost} onChange={(e) => setVerify({ ...verify, labourCost: e.target.value })} /></label>
            <label>Note<input value={verify.note} maxLength={300} onChange={(e) => setVerify({ ...verify, note: e.target.value })} placeholder="e.g. October management accounts" /></label>
            <button disabled={busy}>Sign off from the accounts</button>
          </form>
        )}
      </section>
    </>
  );
}

function BenchmarkPanel({ bench, siteIds, siteName, admin, busy, onToggle }: { bench: Benchmarks; siteIds: string[]; siteName: (id: string) => string; admin: boolean; busy: boolean; onToggle: (on: boolean) => void }) {
  const metrics = (Object.keys(METRIC_LABELS) as BenchmarkMetric[]).filter((m) => bench.benchmark?.metrics[m]);
  return (
    <section className="settings-card">
      <div className="insight-head">
        <div>
          <h2>Benchmarks</h2>
          <p className="muted small">
            How your sites compare with other operators your accounting partner works with, over the last four finished weeks. Only operators who share
            see the figures, only quartiles ever leave the cohort, and nothing is shown until it is large and broad enough that no
            operator can be picked out.
          </p>
        </div>
        {admin && (
          <button disabled={busy} onClick={() => onToggle(!bench.optedIn)}>{bench.optedIn ? 'Stop sharing' : 'Share anonymised figures'}</button>
        )}
      </div>
      {!bench.optedIn ? (
        <p className="muted">Not sharing. An admin can turn this on.</p>
      ) : !bench.benchmark?.available ? (
        <p className="muted">{bench.benchmark?.reason}</p>
      ) : (
        <div className="grid-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Site</th>
                {metrics.map((m) => <th key={m} className="num">{METRIC_LABELS[m]}</th>)}
              </tr>
            </thead>
            <tbody>
              <tr className="subtotal">
                <td>Cohort median ({bench.benchmark.sites} sites, {bench.benchmark.operators} operators)</td>
                {metrics.map((m) => {
                  const d = bench.benchmark!.metrics[m]!;
                  return <td key={m} className="num">{formatMetric(m, d.median)}<div className="muted small">{formatMetric(m, d.p25)} to {formatMetric(m, d.p75)}</div></td>;
                })}
              </tr>
              {bench.sites.filter((s) => siteIds.includes(s.siteId)).map((s) => (
                <tr key={s.siteId}>
                  <td>{siteName(s.siteId)}</td>
                  {metrics.map((m) => (
                    <td key={m} className="num">
                      {s[m] === null ? 'None' : formatMetric(m, s[m] as number)}
                      {s.position[m] && <div className="muted small">{s.position[m]}</div>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
