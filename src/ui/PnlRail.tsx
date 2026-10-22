import type { Issue } from '../engine/compliance';
import type { WeekMetrics } from '../engine/metrics';
import type { RotaState } from '../engine/types';
import { dayLabel, ledger, money, pct, roundToTotal } from './format';
import { Bullet } from './viz';

interface Props {
  state: RotaState;
  metrics: WeekMetrics;
  issues: Issue[];
  canPublish: boolean;
  published: boolean;
  blocks: number;
  onPublish: () => void;
  /** Pay is withheld from those who do not see cost, so the statement would read as nought: shown only to them. */
  showCost: boolean;
  /** Why publishing is not offered, when it is for want of the right rather than the rota. */
  publishRefused?: string;
  /** Offered to whoever manages demand at every site in view, when the week has no forecast. */
  onForecast?: () => void;
}

/**
 * The rota read as a management P&L: forecast sales, the four parts of loaded labour, the
 * contribution left after labour, and the verdict against target. Sits beside every screen.
 */
export function PnlRail({ state, metrics, issues, canPublish, published, blocks, onPublish, showCost, publishRefused, onForecast }: Props) {
  // Site-scoped parts: anyone borrowed brings only the share of their week worked here.
  const { gross, holiday, employerNi: ni, pension } = metrics.cost.parts;
  // Tie the statement to the labour cost the rest of the page and the journal use.
  const [rGross, rHoliday, rNi, rPension] = roundToTotal([gross, holiday, ni, pension], metrics.labourCost);
  const labour = rGross + rHoliday + rNi + rPension;
  const sales = Math.round(metrics.forecastSales);
  const over = metrics.varianceToTarget > 0;
  const empty = metrics.labourCost === 0;
  // No sales forecast: labour % and the budget have nothing to be judged against.
  const noForecast = metrics.forecastSales === 0;
  const scaleMax = Math.max(metrics.targetPct * 1.5, metrics.labourPct * 1.05);
  const dayMax = Math.max(metrics.targetPct * 1.5, ...metrics.days.map((d) => d.labourPct));
  const name = (id: string) => state.employees.find((e) => e.id === id)?.name.split(' ')[0] ?? '';
  const ordered = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'block' ? -1 : 1));

  return (
    <aside className="rail" aria-label="Rota P&L">
      {!showCost && (
        <div className="rail-section">
          <div className="eyebrow">Rota · forecast</div>
          <div className="rail-verdict">
            <span className="rail-pct tnum">{metrics.paidHours.toFixed(0)}h</span>
            <span className="muted">rostered</span>
          </div>
          <p className="muted small">Forecast sales {money(metrics.forecastSales)}. Labour cost is shown to those who see pay.</p>
        </div>
      )}
      {showCost && (<>
      {noForecast ? (
      <div className="rail-section">
        <div className="eyebrow">Rota P&amp;L · forecast</div>
        <div className="rail-verdict">
          <span className="rail-pct muted">No forecast</span>
        </div>
        <p className="muted small">
          There is no sales forecast for this week, so labour % and the budget cannot be judged. Target {pct(metrics.targetPct, 0)}.
          {!empty && ` Labour rostered so far: ${money(metrics.labourCost)}.`}
        </p>
        {onForecast && <button className="primary" onClick={onForecast}>Forecast from past takings</button>}
      </div>
      ) : (
      <div className="rail-section">
        <div className="eyebrow">Rota P&amp;L · forecast</div>
        <div className="rail-verdict">
          <span className={`rail-pct tnum ${empty ? '' : over ? 'bad-text' : 'good-text'}`}>{pct(metrics.labourPct)}</span>
          <span className="muted">labour to sales</span>
        </div>
        <Bullet value={metrics.labourPct} target={metrics.targetPct} max={scaleMax} />
        <div className="bullet-scale">
          <span>0%</span>
          <span>Target {pct(metrics.targetPct, 0)}</span>
          <span>{pct(scaleMax, 0)}</span>
        </div>
        {!empty && (
          <p className={`rail-call ${over ? 'bad' : 'good'}`}>
            {over
              ? `${money(metrics.varianceToTarget)} over the labour budget. Trim the red days first.`
              : `${money(-metrics.varianceToTarget)} inside the labour budget.`}
          </p>
        )}
      </div>
      )}

      <table className="statement">
        <tbody>
          <tr className="lead">
            <th>Forecast sales, net</th>
            <td className="tnum">{ledger(sales)}</td>
          </tr>
          <tr>
            <th>Wages</th>
            <td className="tnum">{ledger(-rGross)}</td>
          </tr>
          {metrics.cost.travel.cost >= 0.5 && (
            <tr className="memo">
              <th>of which paid travel between sites ({metrics.cost.travel.hours.toFixed(1)}h)</th>
              <td className="tnum">{ledger(-Math.round(metrics.cost.travel.cost))}</td>
            </tr>
          )}
          {metrics.cost.travel.unpriced > 0 && (
            <tr className="memo warn-memo">
              <th colSpan={2}>
                {metrics.cost.travel.unpriced} move{metrics.cost.travel.unpriced === 1 ? '' : 's'} between sites not costed: a site has no
                postcode, so the journey is unknown. Set it on the Sites overview.
              </th>
            </tr>
          )}
          <tr>
            <th>Holiday accrual</th>
            <td className="tnum">{ledger(-rHoliday)}</td>
          </tr>
          <tr>
            <th>Employer NI</th>
            <td className="tnum">{ledger(-rNi)}</td>
          </tr>
          <tr>
            <th>Pension</th>
            <td className="tnum">{ledger(-rPension)}</td>
          </tr>
          <tr className="sub">
            <th>Labour cost</th>
            <td className="tnum">{ledger(-labour)}</td>
          </tr>
          <tr className="total">
            <th>Contribution after labour</th>
            <td className="tnum">{ledger(sales - labour)}</td>
          </tr>
        </tbody>
      </table>

      <div className="rail-section">
        <div className="eyebrow">By day</div>
        <div className="rail-days">
          {metrics.days.map((d) => (
            <div key={d.date} className="rail-day">
              <span>{dayLabel(d.date).short}</span>
              <Bullet mini value={d.labourPct} target={metrics.targetPct} max={dayMax} />
              {d.forecastSales === 0 ? (
                <span className="muted small">No forecast</span>
              ) : (
                <span className={`tnum ${d.labourCost ? (d.labourPct > metrics.targetPct ? 'bad-text' : 'good-text') : 'muted'}`}>{pct(d.labourPct)}</span>
              )}
            </div>
          ))}
        </div>
      </div>
      </>)}

      <div className="rail-section">
        <div className="eyebrow">
          Compliance · {blocks} blocking, {issues.length - blocks} to review
        </div>
        {issues.length === 0 ? (
          <p className="muted small">Nothing to review against UK working time and pay law.</p>
        ) : (
          <ul className="rail-issues">
            {ordered.slice(0, 4).map((i, n) => (
              <li key={n} className={i.severity}>
                <b>{name(i.employeeId)}</b> {i.message}
              </li>
            ))}
            {issues.length > 4 && <li className="muted">and {issues.length - 4} more</li>}
          </ul>
        )}
      </div>

      <div className="rail-sign">
        <button className="primary" disabled={!canPublish || !!publishRefused} onClick={onPublish} title={publishRefused ?? (blocks ? 'Resolve blocking issues before publishing' : undefined)}>
          {published ? 'Signed off and published' : 'Sign off and publish'}
        </button>
        <span className="muted small">
          {published ? 'The team can see this week.' : blocks ? 'Blocking issues must be cleared first.' : 'Publishing sends the week to the team.'}
        </span>
      </div>
    </aside>
  );
}
