import { useCallback, useEffect, useState } from 'react';
import { dayDemand, forecastSalesForDay, type HourDemand } from '../engine/demand';
import { salesVsForecast } from '../engine/sales';
import type { HourSales, RotaState } from '../engine/types';
import { api, ApiError } from './api';
import { dayLabel, money } from './format';
import { columnPath, DEPT_COLOR, niceMax, Tip } from './viz';

const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
// Day-to-day noise runs a few percent either way; past this, the rota should be looked at.
const BELOW_PLAN = 0.05;
const weeksText = (w: number[]) => (Math.min(...w) === Math.max(...w) ? `${w[0]} weeks` : `${Math.min(...w)} to ${Math.max(...w)} weeks`);

interface Props {
  state: RotaState;
  siteId: string;
  dates: string[];
  /** Called after the week's forecast is rebuilt from till history, to reload it. */
  onForecastChanged: () => Promise<void>;
}

interface Built { sites: { days: { date: string; weeksUsed: number }[]; skipped: string[]; sales: number }[] }

export function DemandView({ state, siteId, dates, onForecastChanged }: Props) {
  const [date, setDate] = useState(dates[4]);
  const [actuals, setActuals] = useState<HourSales[]>([]);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadActuals = useCallback(() => {
    api
      .get<HourSales[]>(`/v1/sales/actuals?siteId=${encodeURIComponent(siteId)}&from=${dates[0]}&to=${dates[6]}`)
      .then(setActuals)
      .catch(() => setActuals([]));
  }, [siteId, dates[0]]);
  useEffect(loadActuals, [loadActuals]);
  useEffect(() => setNote(null), [siteId, dates[0]]);

  async function fromHistory() {
    if (!confirm('Replace this week\'s forecast with one built from the till? Days without enough history keep their current forecast.')) return;
    setBusy(true);
    try {
      const res = await api.post<Built>('/v1/forecast/from-history', { siteId, weekStart: dates[0] });
      const site = res.sites[0];
      await onForecastChanged();
      setNote({
        text: site.days.length
          ? `Forecast rebuilt for ${site.days.length} days from ${weeksText(site.days.map((d) => d.weeksUsed))} of till history: ${money(site.sales)} for the week.` +
            (site.skipped.length ? ` ${site.skipped.length} days kept as they were, with too little history.` : '')
          : 'The till does not hold enough history for this week yet. Import eight weeks on the Integrations page first.',
        bad: site.days.length === 0,
      });
    } catch (e) {
      setNote({ text: e instanceof ApiError || e instanceof Error ? e.message : String(e), bad: true });
    }
    setBusy(false);
  }

  const london = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const part = (t: string) => london.find((p) => p.type === t)?.value ?? '';
  const now = { date: `${part('year')}-${part('month')}-${part('day')}`, hour: Number(part('hour')) };
  const vs = salesVsForecast(state.forecast, actuals, siteId, dates, now);
  const traded = vs.filter((d) => d.actual !== null);
  const weekVariance = traded.reduce((s, d) => s + d.variance!, 0);
  const weekForecastTraded = traded.reduce((s, d) => s + d.forecast, 0);
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
              {(() => {
                const v = vs.find((x) => x.date === d);
                return v?.variance != null ? (
                  <small className={`tnum ${v.variance < 0 ? 'bad-text' : 'good-text'}`} title={v.throughHour !== undefined ? `Till against forecast to ${hh(v.throughHour)}` : 'Till against forecast'}>
                    {v.variance < 0 ? '-' : '+'}{money(Math.abs(v.variance))}
                  </small>
                ) : null;
              })()}
            </button>
          ))}
        </div>
        <div className="legend">
          <span><i className="sw" style={{ background: 'var(--faint)' }} />Rostered, on plan</span>
          <span><i className="sw" style={{ background: 'var(--bad)' }} />Short: service at risk</span>
          <span><i className="sw" style={{ background: 'var(--warn)' }} />Over: margin at risk</span>
          <span><i className="ln" />Needed</span>
          <span><i className="ln till" />Till, actual</span>
        </div>
      </div>

      <div className="till-bar">
        <span className="small">
          {traded.length
            ? <>Till against forecast for the {traded.length} days traded{traded.some((d) => d.throughHour !== undefined) ? `, today to ${hh(now.hour)}` : ''}: <b className={weekVariance < 0 ? 'bad-text' : 'good-text'}>{weekVariance < 0 ? '-' : '+'}{money(Math.abs(weekVariance))}</b>
                {weekForecastTraded > 0 && <span className="muted"> ({((weekVariance / weekForecastTraded) * 100).toFixed(1)}%)</span>}.
                {weekForecastTraded > 0 && weekVariance / weekForecastTraded < -BELOW_PLAN ? ' Trade is more than 5% below plan: check the rota against it before the next shifts start.' : ''}</>
            : <span className="muted">No till takings for this week yet.</span>}
        </span>
        <button disabled={busy} onClick={() => void fromHistory()}>Forecast from till history</button>
      </div>
      {note && <p className={`small ${note.bad ? 'bad-text' : 'muted'}`}>{note.text}</p>}

      <SalesChart hours={sales} date={day} actual={actuals.filter((a) => a.date === day)} />

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

function SalesChart({ hours, date, actual }: { hours: HourDemand[]; date: string; actual: HourSales[] }) {
  const till = new Map(actual.map((a) => [a.hour, a]));
  const [hover, setHover] = useState<number | null>(null);
  const open = hours.filter((h) => h.sales > 0);
  if (open.length === 0) return null;
  const W = 1040;
  const H = 160;
  const top = 18;
  const base = 130;
  const max = niceMax(Math.max(...open.map((h) => Math.max(h.sales, till.get(h.hour)?.sales ?? 0))), 2);
  const tillTotal = actual.length ? actual.reduce((s, a) => s + a.sales, 0) : null;
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
          <div className="panel-sub">Net sales that drive the headcount below. Peak at {hh(open[peak].hour)}.{tillTotal !== null ? ' The line on each bar is what the till took.' : ''}</div>
        </div>
        <div style={{ display: 'flex', gap: 20 }}>
          <div><div className="panel-sub">Sales</div><div className="panel-title tnum">{money(total)}</div></div>
          <div><div className="panel-sub">Covers</div><div className="panel-title tnum">{covers}</div></div>
          {tillTotal !== null && <div><div className="panel-sub">Till</div><div className="panel-title tnum">{money(tillTotal)}</div></div>}
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
                  {till.has(h.hour) && (
                    <line x1={cx - barW / 2 - 3} x2={cx + barW / 2 + 3} y1={y(till.get(h.hour)!.sales)} y2={y(till.get(h.hour)!.sales)} className="till-mark" />
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
              rows={[
                ['Forecast', money(hv.sales)],
                ...(till.has(hv.hour) ? ([['Till', money(till.get(hv.hour)!.sales)]] as [string, string][]) : []),
                ['Covers', String(hv.covers)],
                ['Average spend', hv.covers ? money(hv.sales / hv.covers) : '-'],
              ]}
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
