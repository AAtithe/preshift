import { useState } from 'react';
import type { Issue } from '../engine/compliance';
import type { WeekMetrics } from '../engine/metrics';
import type { RotaState } from '../engine/types';
import { dayLabel, ledger, money, pct, roundToTotal } from './format';
import { Tip } from './Tip';
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
  /** Opens the drawer from outside, as a decision about blocking issues does. Changes each time it is asked. */
  openSignal?: number;
}

const KEY = 'preshift.pnl.open';

function saved(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The rota read as a management P&L, as one line under the heading: labour against sales and the
 * target, the money either side of the budget, compliance and publishing. The full statement (the
 * four parts of loaded labour, the contribution left, every day and every issue) opens beneath it,
 * and stays open or shut as each person last left it.
 */
export function PnlStrip({ state, metrics, issues, canPublish, published, blocks, onPublish, showCost, publishRefused, onForecast, openSignal }: Props) {
  const [open, setOpenState] = useState(saved);
  const [signal, setSignal] = useState(openSignal);
  if (openSignal !== signal) {
    setSignal(openSignal);
    if (openSignal) setOpenState(true);
  }
  function setOpen(next: boolean) {
    setOpenState(next);
    try {
      localStorage.setItem(KEY, next ? '1' : '0');
    } catch {
      // Not remembered in private mode; the drawer still opens.
    }
  }

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
  const dayMax = Math.max(metrics.targetPct * 1.5, ...metrics.days.map((d) => d.labourPct));
  const name = (id: string) => state.employees.find((e) => e.id === id)?.name.split(' ')[0] ?? '';
  const ordered = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'block' ? -1 : 1));
  const review = issues.length - blocks;

  return (
    <aside className={`pnl-strip${open ? ' open' : ''}`} aria-label="Rota P&L">
      <div className="pnl-line">
        {showCost && noForecast && (
          <div className="pnl-fig">
            <span className="pnl-label">Labour %</span>
            <span className="pnl-value muted">No forecast</span>
          </div>
        )}
        {showCost && !noForecast && (
          <>
            <div className="pnl-fig">
              <span className="pnl-label">
                Labour % <Tip about="labour %">Loaded labour (wages, holiday, employer NI and pension) as a share of net forecast sales.</Tip>
              </span>
              <span className={`pnl-value tnum ${empty ? '' : over ? 'bad-text' : 'good-text'}`}>{pct(metrics.labourPct)}</span>
            </div>
            <div className="pnl-fig">
              <span className="pnl-label">Target</span>
              <span className="pnl-value tnum">{pct(metrics.targetPct)}</span>
            </div>
          </>
        )}
        <div className="pnl-fig">
          <span className="pnl-label">Sales <Tip about="sales">Net forecast sales for the week, the figure labour is judged against.</Tip></span>
          <span className="pnl-value tnum">{noForecast ? 'None' : money(metrics.forecastSales)}</span>
        </div>
        {showCost ? (
          <div className="pnl-fig">
            <span className="pnl-label">Labour</span>
            <span className="pnl-value tnum">{money(metrics.labourCost)}</span>
          </div>
        ) : (
          <div className="pnl-fig">
            <span className="pnl-label">Rostered</span>
            <span className="pnl-value tnum">{metrics.paidHours.toFixed(0)}h</span>
          </div>
        )}
        {showCost && !noForecast && !empty && (
          <div className="pnl-fig">
            <span className="pnl-label">
              Budget <Tip about="the budget">What labour can cost this week and still hit the target, against what the rota costs now.</Tip>
            </span>
            <span className={`pnl-value tnum ${over ? 'bad-text' : 'good-text'}`}>
              {money(Math.abs(metrics.varianceToTarget))} {over ? 'over' : 'inside'}
            </span>
          </div>
        )}
        <div className="pnl-fig">
          <span className="pnl-label">
            Compliance <Tip about="compliance">Checked against UK working time and pay law. Blocking issues stop the week being published.</Tip>
          </span>
          <span className={`pnl-value ${blocks ? 'bad-text' : review ? 'warn-text' : 'good-text'}`}>
            {blocks ? `${blocks} blocking` : review ? `${review} to review` : 'Clear'}
          </span>
        </div>
        <span className="pnl-gap" />
        {showCost && noForecast && onForecast && <button onClick={onForecast}>Forecast from past takings</button>}
        <button className="pnl-toggle" aria-expanded={open} aria-controls="pnl-drawer" onClick={() => setOpen(!open)}>
          Full P&amp;L
        </button>
        {/* Someone whose roles do not publish is told where the week stands, not shown a button they cannot use. */}
        {publishRefused ? (
          <span className="muted small">{published ? 'Published: the team can see this week.' : 'Not published yet.'}</span>
        ) : (
          <button
            className="primary"
            disabled={!canPublish}
            onClick={onPublish}
            title={published ? 'The team can see this week.' : blocks ? 'Resolve blocking issues before publishing' : 'Publishing sends the week to the team.'}
          >
            {published ? 'Signed off and published' : 'Sign off and publish'}
          </button>
        )}
      </div>

      {open && (
        <div className="pnl-drawer" id="pnl-drawer">
          {showCost && (
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
          )}

          {showCost && (
            <div className="pnl-section">
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
          )}

          <div className="pnl-section">
            <div className="eyebrow">
              Compliance · {blocks} blocking, {review} to review
            </div>
            {issues.length === 0 ? (
              <p className="muted small">Nothing to review against UK working time and pay law.</p>
            ) : (
              <ul className="rail-issues">
                {ordered.slice(0, 8).map((i, n) => (
                  <li key={n} className={i.severity}>
                    <b>{name(i.employeeId)}</b> {i.message}
                  </li>
                ))}
                {issues.length > 8 && <li className="muted">and {issues.length - 8} more</li>}
              </ul>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
