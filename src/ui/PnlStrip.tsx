import { useState, type ReactNode } from 'react';
import type { TradedWeek } from '../engine/actuals';
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
  /**
   * For a week that is over: its takings and clocked labour, `null` while loading. `clocked` is false
   * when the reader may not see clocked time, so labour is said to be unknown rather than nought.
   */
  traded?: { figures: TradedWeek | null; clocked: boolean };
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
export function PnlStrip({ state, metrics, issues, canPublish, published, blocks, onPublish, showCost, publishRefused, onForecast, openSignal, traded }: Props) {
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

  const complianceFig = (
    <div className="pnl-fig">
      <span className="pnl-label">
        Compliance <Tip about="compliance">Checked against UK working time and pay law. Blocking issues stop the week being published.</Tip>
      </span>
      <span className={`pnl-value ${blocks ? 'bad-text' : review ? 'warn-text' : 'good-text'}`}>
        {blocks ? `${blocks} blocking` : review ? `${review} to review` : 'Clear'}
      </span>
    </div>
  );
  const complianceSection = (
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
  );
  const toggle = (
    <button className="pnl-toggle" aria-expanded={open} aria-controls="pnl-drawer" onClick={() => setOpen(!open)}>
      Full P&amp;L
    </button>
  );

  if (traded) return <Traded {...{ traded, metrics, showCost, open, toggle, complianceFig, complianceSection }} />;

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
        {complianceFig}
        <span className="pnl-gap" />
        {showCost && noForecast && onForecast && <button onClick={onForecast}>Forecast from past takings</button>}
        {toggle}
        {/* The heading says where the week stands, so the button shows only while there is
            something to publish and the person may publish it. */}
        {!publishRefused && !published && (
          <button
            className="primary"
            disabled={!canPublish}
            onClick={onPublish}
            title={blocks ? 'Resolve blocking issues before publishing' : 'Publishing sends the week to the team.'}
          >
            Sign off and publish
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

          {complianceSection}
        </div>
      )}
    </aside>
  );
}

interface TradedProps {
  traded: NonNullable<Props['traded']>;
  metrics: WeekMetrics;
  showCost: boolean;
  open: boolean;
  toggle: ReactNode;
  complianceFig: ReactNode;
  complianceSection: ReactNode;
}

/**
 * A week that has traded, read from what happened: takings as the till recorded them and labour as
 * people clocked it, judged against the target on those takings. Nothing to forecast or publish.
 */
function Traded({ traded, metrics, showCost, open, toggle, complianceFig, complianceSection }: TradedProps) {
  const t = traded.figures;
  const known = !!t && traded.clocked;
  const noTakings = !!t && t.sales === 0;
  const labourPct = t && t.sales > 0 ? t.labour / t.sales : 0;
  const over = !!t && t.varianceToTarget > 0;
  // Each site's target weighted by what it took, so the target and the budget agree across a group.
  const target = t && t.sales > 0 ? (t.labour - t.varianceToTarget) / t.sales : metrics.targetPct;
  const loading = <span className="pnl-value muted">Loading</span>;
  const dayMax = Math.max(target * 1.5, ...(t?.days ?? []).map((d) => (d.sales > 0 ? d.labour / d.sales : 0)));

  return (
    <aside className={`pnl-strip traded${open ? ' open' : ''}`} aria-label="Rota P&L">
      <div className="pnl-line">
        {showCost && (
          <>
            <div className="pnl-fig">
              <span className="pnl-label">
                Labour % <Tip about="actual labour %">This week has traded: clocked labour (wages, holiday, employer NI and pension) as a share of net takings.</Tip>
              </span>
              {!t ? loading : known && !noTakings ? (
                <span className={`pnl-value tnum ${over ? 'bad-text' : 'good-text'}`}>{pct(labourPct)}</span>
              ) : (
                <span className="pnl-value muted">Not known</span>
              )}
            </div>
            <div className="pnl-fig">
              <span className="pnl-label">Target</span>
              <span className="pnl-value tnum">{pct(target)}</span>
            </div>
          </>
        )}
        <div className="pnl-fig">
          <span className="pnl-label">Takings <Tip about="takings">Net sales the till recorded for the week, or the figures keyed in where there is no till.</Tip></span>
          {!t ? loading : <span className="pnl-value tnum">{noTakings ? 'None recorded' : money(t.sales)}</span>}
        </div>
        <div className="pnl-fig">
          <span className="pnl-label">{showCost ? 'Labour, clocked' : 'Hours worked'}</span>
          {!t ? loading : !traded.clocked ? (
            <span className="pnl-value muted" title="Your roles do not include reading clocked time.">Not shared</span>
          ) : (
            <span className="pnl-value tnum">{showCost ? money(t.labour) : `${t.hours.toFixed(0)}h`}</span>
          )}
        </div>
        {showCost && known && !noTakings && (
          <div className="pnl-fig">
            <span className="pnl-label">
              Budget <Tip about="the budget">What labour could have cost on these takings and still hit the target, against what it did cost.</Tip>
            </span>
            <span className={`pnl-value tnum ${over ? 'bad-text' : 'good-text'}`}>
              {money(Math.abs(t.varianceToTarget))} {over ? 'over' : 'inside'}
            </span>
          </div>
        )}
        {complianceFig}
        <span className="pnl-gap" />
        {toggle}
      </div>

      {open && (
        <div className="pnl-drawer" id="pnl-drawer">
          {showCost && t && known && (
            <table className="statement">
              <tbody>
                <tr className="lead">
                  <th>Takings, net</th>
                  <td className="tnum">{ledger(Math.round(t.sales))}</td>
                </tr>
                <tr>
                  <th>Labour, as clocked</th>
                  <td className="tnum">{ledger(-Math.round(t.labour))}</td>
                </tr>
                <tr className="memo">
                  <th>as rostered: clocked ran {money(Math.abs(t.labour - t.rotaLabour))} {t.labour > t.rotaLabour ? 'over' : 'under'}</th>
                  <td className="tnum">{ledger(-Math.round(t.rotaLabour))}</td>
                </tr>
                <tr className="total">
                  <th>Contribution after labour</th>
                  <td className="tnum">{ledger(Math.round(t.sales - t.labour))}</td>
                </tr>
              </tbody>
            </table>
          )}

          {showCost && t && known && (
            <div className="pnl-section">
              <div className="eyebrow">By day, as traded</div>
              <div className="rail-days">
                {t.days.map((d) => {
                  const dayPct = d.sales > 0 ? d.labour / d.sales : 0;
                  return (
                    <div key={d.date} className="rail-day">
                      <span>{dayLabel(d.date).short}</span>
                      <Bullet mini value={dayPct} target={target} max={dayMax} />
                      {d.sales === 0 ? (
                        <span className="muted small">No takings</span>
                      ) : (
                        <span className={`tnum ${d.labour ? (dayPct > target ? 'bad-text' : 'good-text') : 'muted'}`}>{pct(dayPct)}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {complianceSection}
        </div>
      )}
    </aside>
  );
}
