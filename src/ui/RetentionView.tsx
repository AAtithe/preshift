import { useMemo } from 'react';
import { RETENTION_ASSUMPTIONS, retentionScores, SIGNALS, type RetentionScore } from '../engine/retention';
import type { RotaState } from '../engine/types';
import { hours, money, pct } from './format';
import { Kpi } from './KpiBar';

interface Props {
  state: RotaState;
  siteId: string;
  asOf: string;
}

const BAND_TONE = { high: 'bad', medium: 'warn', low: 'good' } as const;
const BAND_LABEL = { high: 'High', medium: 'Medium', low: 'Low' } as const;

export function RetentionView({ state, siteId, asOf }: Props) {
  const r = useMemo(() => retentionScores(state, siteId, asOf), [state, siteId, asOf]);
  const employee = (id: string) => state.employees.find((e) => e.id === id);
  const roleName = (id: string) => state.roles.find((x) => x.id === employee(id)?.roleIds[0])?.name ?? '';
  const flagged = r.scores.filter((s) => s.band !== 'low');
  const top = r.drivers[0];
  const a = RETENTION_ASSUMPTIONS;

  if (r.weeksRead === 0) return <p className="muted">No clocked weeks yet. Scores start once a full week has traded.</p>;

  return (
    <div className="retention">
      <p className="muted intro">
        Who is likely to leave, why, and what it would cost to replace them, read from what the system already holds:
        clocked hours, early finishes, breaks and rest, the closes people get, tenure and pay. Every point has a reason and a
        fix. Based on {r.weeksRead} week{r.weeksRead > 1 ? 's' : ''} of clocked hours.
      </p>

      <section className="kpis">
        <Kpi label="High risk" value={String(r.high)} hint="Score 40 or more" tone={r.high ? 'bad' : 'good'} />
        <Kpi label="Medium risk" value={String(r.medium)} hint="Score 20 to 39" tone={r.medium ? 'warn' : 'good'} />
        <Kpi label="Replacement cost at risk" value={money(r.costAtRisk)} hint="If the high-risk people leave" tone={r.costAtRisk ? 'bad' : 'good'} />
        <Kpi label="Driven by the rota" value={pct(r.rotaShare, 0)} hint="Of all risk points" tone={r.rotaShare > 0.5 ? 'warn' : ''} />
        <Kpi label="Biggest driver" value={top ? SIGNALS[top.id].label : 'None'} hint={top ? `${top.people} people` : ''} tone={top ? 'warn' : 'good'} />
        <Kpi label="People scored" value={String(r.scores.length)} hint={`${r.scores.length - flagged.length} low risk`} />
      </section>

      <div className="grid-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="score-head">Score</th>
              <th>Why</th>
              <th className="num">Average hours</th>
              <th className="num">Cost to replace</th>
              <th>Do this first</th>
            </tr>
          </thead>
          <tbody>
            {flagged.map((s) => (
              <Row key={s.employeeId} s={s} name={employee(s.employeeId)?.name ?? ''} role={roleName(s.employeeId)} />
            ))}
          </tbody>
        </table>
      </div>
      {flagged.length < r.scores.length && (
        <p className="small muted">{r.scores.length - flagged.length} more people score under 20 and are not listed.</p>
      )}

      <div className="bench-grid">
        <div className="panel">
          <h3>What is driving it</h3>
          <div className="grid-wrap flat">
            <table className="table">
              <thead>
                <tr>
                  <th>Signal</th>
                  <th className="num">People</th>
                  <th className="num">Share of risk</th>
                  <th>Who controls it</th>
                </tr>
              </thead>
              <tbody>
                {r.drivers.map((d) => {
                  const total = r.drivers.reduce((s, x) => s + x.points, 0);
                  return (
                    <tr key={d.id}>
                      <td>
                        {SIGNALS[d.id].label}
                        <div className="muted small">{SIGNALS[d.id].action}</div>
                      </td>
                      <td className="num">{d.people}</td>
                      <td className="num">{pct(d.points / total, 0)}</td>
                      <td>{SIGNALS[d.id].rota ? 'The rota' : 'Pay and onboarding'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <h3>How replacement cost is worked</h3>
          <p className="small">
            Recruitment, plus paid shadow shifts for the new starter and the person training them, plus{' '}
            {Math.round(a.rampLoss * 100)}% of the starter's output lost for {a.rampWeeks} weeks while they get up to speed,
            all at the person's loaded hourly cost.
          </p>
          <dl className="facts">
            {(['FOH', 'BAR', 'BOH', 'MGMT'] as const).map((d) => (
              <FactRow key={d} label={d} value={`${money(a.recruitment[d])} recruitment, ${a.shadowHours[d]}h shadowing`} />
            ))}
          </dl>
          <p className="small muted">
            These are planning assumptions. Replace them with the client's own agency fees, advert spend and training plan
            before the figure goes into a decision.
          </p>
          <h4>How this may be used</h4>
          <p className="small muted">
            For support conversations only: more hours, steadier shifts, a pay step, a check-in. Never for discipline,
            dismissal or selection. The score reads no age, nationality, visa status or other protected characteristic.
            Tell staff it exists and what it reads, and complete a data protection impact assessment before it runs on live
            data.
          </p>
        </div>
      </div>
    </div>
  );
}

function Row({ s, name, role }: { s: RetentionScore; name: string; role: string }) {
  return (
    <tr>
      <td>
        {name}
        <div className="muted small">{role}</div>
      </td>
      <td>
        <div className="score">
          <span className={`score-bar ${BAND_TONE[s.band]}`} style={{ width: `${s.score}%` }} />
        </div>
        <span className={`small ${BAND_TONE[s.band]}-text`}>
          {s.score} {BAND_LABEL[s.band]}
        </span>
      </td>
      <td>
        <ul className="reasons">
          {s.signals.map((g) => (
            <li key={g.id}>
              <span className="strong">{SIGNALS[g.id].label}</span> <span className="muted">+{g.points}</span>
              <div className="small muted">{g.detail}</div>
            </li>
          ))}
        </ul>
      </td>
      <td className="num">{hours(s.averageWeeklyHours)}</td>
      <td className="num strong">{money(s.replacementCost)}</td>
      <td className="small">{SIGNALS[s.signals[0].id].action}</td>
    </tr>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
