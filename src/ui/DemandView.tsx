import { useState } from 'react';
import { dayDemand, forecastSalesForDay, type HourDemand } from '../engine/demand';
import type { DayForecast } from '../engine/forecasting';
import type { RotaState } from '../engine/types';
import { dayLabel, money } from './format';
import { columnPath, DEPT_COLOR, niceMax, Tip } from './viz';

const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;

type Worked = { filled: number; days: (DayForecast & { filled: boolean })[] };

interface Props {
  state: RotaState;
  siteId: string;
  dates: string[];
  /** Offered to whoever manages demand at the site: works the week out of past takings. */
  onForecast?: (replace: boolean) => Promise<Worked | undefined>;
}

export function DemandView({ state, siteId, dates, onForecast }: Props) {
  const [date, setDate] = useState(dates[4]);
  const day = dates.includes(date) ? date : dates[0];
  const rules = state.demandRules.filter((r) => r.siteId === siteId);
  const sales = dayDemand(state, siteId, rules[0]?.roleId ?? '', day);
  const shortOn = (d: string) => rules.some((r) => dayDemand(state, siteId, r.roleId, d).some((h) => h.gap > 0));

  return (
    <div className="demand">
      <div className="demand-top">
        <div className="day-pills" role="tablist" aria-label="Day">
          {dates.map((d) => (
            <button
              key={d}
              className={`${d === day ? 'active' : ''} ${shortOn(d) ? 'has-short' : ''}`}
              onClick={() => setDate(d)}
              title={shortOn(d) ? 'Short-staffed in at least one hour' : undefined}
            >
              <span className="pill-day">{dayLabel(d).short}</span>
              <small className="tnum">{money(forecastSalesForDay(state, siteId, d))}</small>
            </button>
          ))}
        </div>
        <div className="legend">
          <span><i className="sw" style={{ background: 'var(--faint)' }} />Rostered, on plan</span>
          <span><i className="sw" style={{ background: 'var(--bad)' }} />Short: service at risk</span>
          <span><i className="sw" style={{ background: 'var(--warn)' }} />Over: margin at risk</span>
          <span><i className="ln" />Needed</span>
        </div>
      </div>

      <FromTakings state={state} siteId={siteId} dates={dates} onForecast={onForecast} />

      <SalesChart hours={sales} date={day} />

      <div className="demand-grid">
        {rules.map((rule) => {
          const role = state.roles.find((r) => r.id === rule.roleId)!;
          const rows = dayDemand(state, siteId, rule.roleId, day);
          const short = rows.reduce((s, r) => s + Math.max(0, r.gap), 0);
          const over = rows.reduce((s, r) => s + Math.max(0, -r.gap), 0);
          return (
            <div key={rule.roleId} className="panel demand-card">
              <div className="panel-head">
                <div>
                  <div className="role-name">
                    <i style={{ background: DEPT_COLOR[role.department] }} />
                    {role.name}
                  </div>
                  <div className="panel-sub">
                    {rule.salesPerLabourHour ? `One per ${money(rule.salesPerLabourHour)} sales an hour` : `One per ${rule.coversPerHour} covers an hour`}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {short > 0 && <span className="badge bad">{short} hours short</span>}
                  {over > 0 && <span className="badge warn">{over} hours over</span>}
                  {!short && !over && <span className="badge good">On plan</span>}
                </div>
              </div>
              <div className="panel-body">
                <StaffChart rows={rows} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The week's forecast worked from the site's own takings, and what each day was worked from. */
function FromTakings({ state, siteId, dates, onForecast }: Props) {
  const [worked, setWorked] = useState<Worked | null>(null);
  const [busy, setBusy] = useState(false);
  const empty = dates.filter((d) => forecastSalesForDay(state, siteId, d) === 0);
  const week = dates[0];
  // A result belongs to the week it was worked for.
  const shown = worked && worked.days[0]?.date === week ? worked : null;

  async function run(replace: boolean) {
    if (!onForecast) return;
    if (replace && !window.confirm("Replace this week's forecast with one worked from past takings?")) return;
    setBusy(true);
    const res = await onForecast(replace);
    setBusy(false);
    if (res) setWorked(res);
  }

  if (!onForecast && empty.length === 0) return null;
  return (
    <div className="panel from-takings">
      <div className="panel-body">
        {empty.length > 0 ? (
          <p>
            {empty.length === dates.length ? 'No sales forecast for this week.' : `${empty.length} ${empty.length === 1 ? 'day has' : 'days have'} no sales forecast.`}{' '}
            {onForecast
              ? 'Work it out from past takings: the same day last year, scaled by how the last four weeks compare with a year earlier, or where there is no year of history, the recent same weekdays.'
              : 'Whoever manages demand at this site can work one out from past takings.'}
          </p>
        ) : (
          !shown && <p className="muted small">This week is forecast. Reworking it from past takings replaces every day that has takings to work from.</p>
        )}
        {onForecast && (
          <div className="from-takings-actions">
            {empty.length > 0 ? (
              <button className="primary" disabled={busy} onClick={() => void run(false)}>
                {empty.length === dates.length ? 'Forecast from past takings' : 'Fill from past takings'}
              </button>
            ) : (
              <button className="ghost" disabled={busy} onClick={() => void run(true)}>Rework from past takings</button>
            )}
          </div>
        )}
        {shown && (
          <table className="from-takings-days">
            <tbody>
              {shown.days.map((d) => (
                <tr key={d.date} className={d.basis === 'none' ? 'muted' : ''}>
                  <th scope="row">{dayLabel(d.date).short}</th>
                  <td className="tnum">{d.basis === 'none' ? 'No forecast' : money(d.sales)}</td>
                  <td>{d.filled || d.basis === 'none' ? d.note : 'Already forecast: left as it was.'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SalesChart({ hours, date }: { hours: HourDemand[]; date: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const open = hours.filter((h) => h.sales > 0);
  if (open.length === 0) return null;
  const W = 1040;
  const H = 160;
  const top = 18;
  const base = 130;
  const max = niceMax(Math.max(...open.map((h) => h.sales)), 2);
  const left = 56;
  const band = (W - left) / open.length;
  const barW = Math.min(36, band * 0.55);
  const y = (v: number) => base - (v / max) * (base - top);
  const peak = open.reduce((b, h, i) => (h.sales > open[b].sales ? i : b), 0);
  const total = open.reduce((s, h) => s + h.sales, 0);
  const covers = open.reduce((s, h) => s + h.covers, 0);
  const hv = hover === null ? null : open[hover];

  return (
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-head">
        <div>
          <div className="panel-title">Forecast by hour, {dayLabel(date).short} {dayLabel(date).date}</div>
          <div className="panel-sub">Net sales that drive the headcount below. Peak at {hh(open[peak].hour)}.</div>
        </div>
        <div style={{ display: 'flex', gap: 20 }}>
          <div><div className="panel-sub">Sales</div><div className="panel-title tnum">{money(total)}</div></div>
          <div><div className="panel-sub">Covers</div><div className="panel-title tnum">{covers}</div></div>
        </div>
      </div>
      <div className="panel-body">
        <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
          <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Forecast sales by hour">
            {[0, max / 2, max].map((t) => (
              <g key={t}>
                <line x1={56} x2={W} y1={y(t)} y2={y(t)} className="gridline" />
                <text x={48} y={y(t) + 4} textAnchor="end" className="axis-text">{money(t)}</text>
              </g>
            ))}
            {open.map((h, i) => {
              const cx = left + band * i + band / 2;
              const bh = base - y(h.sales);
              return (
                <g key={h.hour} className={hover === i ? 'on' : ''} onMouseEnter={() => setHover(i)}>
                  <rect x={left + band * i + 2} y={0} width={band - 4} height={H} rx={6} className="hover-band" />
                  <path
                    d={columnPath(cx, barW, base, bh)}
                    className={i === peak ? 'col-accent' : 'col-wash'}
                    style={i === peak ? undefined : { opacity: 0.35 }}
                  />
                  {i === peak && (
                    <text x={cx} y={base - bh - 6} textAnchor="middle" className="val-text">{money(h.sales)}</text>
                  )}
                  <text x={cx} y={base + 18} textAnchor="middle" className="axis-text">{hh(h.hour)}</text>
                  <rect x={left + band * i} y={0} width={band} height={H} className="hit" />
                </g>
              );
            })}
          </svg>
          {hv && hover !== null && (
            <Tip
              x={`${((left + band * (hover + 0.5)) / W) * 100}%`}
              y={`${(y(hv.sales) / H) * 100}%`}
              title={`${hh(hv.hour)} to ${hh(hv.hour + 1)}`}
              rows={[['Sales', money(hv.sales)], ['Covers', String(hv.covers)], ['Average spend', hv.covers ? money(hv.sales / hv.covers) : '-']]}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function StaffChart({ rows }: { rows: HourDemand[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const visible = rows.filter((r) => r.required > 0 || r.scheduled > 0);
  if (visible.length === 0) return <div className="empty"><b>Closed</b>No trading hours on this day.</div>;
  const first = visible[0].hour;
  const last = visible[visible.length - 1].hour;
  const span = rows.slice(first, last + 1);
  const peak = Math.max(1, ...span.map((r) => Math.max(r.required, r.scheduled)));
  const max = Math.max(2, Math.ceil(peak / 2) * 2);
  const W = 310;
  const H = 150;
  const top = 10;
  const base = 124;
  const band = W / span.length;
  const barW = Math.min(18, band - 4);
  const y = (v: number) => base - (v / max) * (base - top);
  // Required headcount as a stepped line: flat across each hour, stepping at the boundary.
  const need = span
    .map((r, i) => `${i ? 'L' : 'M'}${band * i},${y(r.required)}H${band * (i + 1)}`)
    .join('');
  const hv = hover === null ? null : span[hover];

  return (
    <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
      <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Needed versus rostered headcount by hour">
        {Array.from({ length: max / (max > 6 ? 2 : 1) + 1 }, (_, k) => k * (max > 6 ? 2 : 1)).map((t) => (
          <g key={t}>
            <line x1={0} x2={W} y1={y(t)} y2={y(t)} className="gridline" />
            <text x={W} y={y(t) - 3} textAnchor="end" className="axis-text">{t}</text>
          </g>
        ))}
        {span.map((r, i) => {
          const cx = band * i + band / 2;
          const bh = base - y(r.scheduled);
          const tone = r.gap > 0 ? 'col-short' : r.gap < 0 ? 'col-overstaff' : 'col-ok';
          return (
            <g key={r.hour} className={hover === i ? 'on' : ''} onMouseEnter={() => setHover(i)}>
              <rect x={band * i + 1} y={0} width={band - 2} height={H} rx={4} className="hover-band" />
              {bh > 0 && (
                <path
                  d={columnPath(cx, barW, base, bh)}
                  className={tone}
                />
              )}
              {i % 2 === 0 && (
                <text x={cx} y={base + 18} textAnchor="middle" className="axis-text">{String(r.hour % 24).padStart(2, '0')}</text>
              )}
              <rect x={band * i} y={0} width={band} height={H} className="hit" />
            </g>
          );
        })}
        <path d={need} className="need-line" />
      </svg>
      {hv && hover !== null && (
        <Tip
          x={`${((hover + 0.5) / span.length) * 100}%`}
          y={`${(Math.min(y(hv.required), y(hv.scheduled)) / H) * 100}%`}
          title={`${hh(hv.hour)} to ${hh(hv.hour + 1)}`}
          rows={[
            ['Needed', String(hv.required)],
            ['Rostered', String(hv.scheduled)],
            [hv.gap > 0 ? 'Short by' : hv.gap < 0 ? 'Over by' : 'Gap', String(Math.abs(hv.gap))],
          ]}
        />
      )}
    </div>
  );
}
