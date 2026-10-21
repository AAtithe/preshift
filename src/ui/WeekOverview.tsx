import { useState } from 'react';
import type { WeekMetrics } from '../engine/metrics';
import type { Department, RotaState } from '../engine/types';
import { shiftPaidHours } from '../engine/cost';
import { dayLabel, hours, money, pct } from './format';
import { columnPath, COMPONENTS, CostStack, DEPT_COLOR, Tip, type Composition } from './viz';

const DEPT_LABEL: Record<Department, string> = { MGMT: 'Management', FOH: 'Front of house', BAR: 'Bar', BOH: 'Kitchen' };

export function WeekOverview({ state, siteId, dates, metrics }: { state: RotaState; siteId: string; dates: string[]; metrics: WeekMetrics }) {
  const comp: Composition = { gross: 0, holiday: 0, employerNi: 0, pension: 0 };
  for (const c of metrics.cost.employees.values()) {
    comp.gross += c.gross;
    comp.holiday += c.holiday;
    comp.employerNi += c.employerNi;
    comp.pension += c.pension;
  }
  const total = COMPONENTS.reduce((s, c) => s + comp[c.key], 0);
  const shown = roundToTotal(COMPONENTS.map((c) => comp[c.key]));

  const deptHours = new Map<Department, number>();
  for (const s of state.shifts) {
    if (s.siteId !== siteId || !dates.includes(s.date)) continue;
    const dept = state.roles.find((r) => r.id === s.roleId)?.department ?? 'FOH';
    deptHours.set(dept, (deptHours.get(dept) ?? 0) + shiftPaidHours(s));
  }
  const maxDept = Math.max(1, ...deptHours.values());

  return (
    <section className="overview">
      <div className="panel">
        <div className="panel-head">
          <div>
            <div className="panel-title">Labour % by day</div>
            <div className="panel-sub">Loaded labour against forecast sales. The line is the site target.</div>
          </div>
          <div className="legend">
            <span><i className="sw" style={{ background: 'var(--good)' }} />Within target</span>
            <span><i className="sw" style={{ background: 'var(--bad)' }} />Over target</span>
            <span><i className="ln" />Target {pct(metrics.targetPct, 0)}</span>
          </div>
        </div>
        <div className="panel-body">
          <DayChart metrics={metrics} />
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <div>
            <div className="panel-title">Where the money goes</div>
            <div className="panel-sub">Loaded cost of the week, as payroll will see it</div>
          </div>
          <div className="panel-title tnum">{money(Math.round(total))}</div>
        </div>
        <div className="panel-body">
          <CostStack parts={comp} />
          <div className="comp-list">
            {COMPONENTS.map((c, i) => (
              <div className="comp-row" key={c.key}>
                <i className="sw" style={{ background: c.color }} />
                <span>{c.label}</span>
                <span className="tnum strong">{money(shown[i])}</span>
                <span className="pct tnum">{total ? pct(comp[c.key] / total) : '0%'}</span>
              </div>
            ))}
          </div>
          <div className="dept-rows">
            {(['FOH', 'BAR', 'BOH', 'MGMT'] as Department[])
              .filter((d) => deptHours.has(d))
              .map((d) => (
                <div className="dept-row" key={d}>
                  <span>{DEPT_LABEL[d]}</span>
                  <div className="track">
                    <div className="fill" style={{ width: `${((deptHours.get(d) ?? 0) / maxDept) * 100}%`, background: DEPT_COLOR[d] }} />
                  </div>
                  <span className="num tnum">{hours(deptHours.get(d) ?? 0)}</span>
                </div>
              ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function DayChart({ metrics }: { metrics: WeekMetrics }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 700;
  const H = 210;
  const top = 22;
  const base = 160;
  const left = 40;
  const band = (W - left) / metrics.days.length;
  const barW = 26;
  const max = Math.max(metrics.targetPct * 1.4, ...metrics.days.map((d) => d.labourPct)) || 0.4;
  const y = (v: number) => base - (v / max) * (base - top);
  const ticks = [0, metrics.targetPct / 2, metrics.targetPct, (metrics.targetPct * 3) / 2].filter((t) => t <= max);
  // Keep value labels clear of the target line: lift any label that would sit on it.
  const ty = y(metrics.targetPct);
  const labelY = (barTop: number) => {
    const at = barTop - 7;
    return Math.abs(at - 4 - ty) < 9 ? ty - 7 : at;
  };
  const hd = hover === null ? null : metrics.days[hover];

  return (
    <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
      <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Labour percentage by day against target">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={W} y1={y(t)} y2={y(t)} className="gridline" />
            <text x={left - 8} y={y(t) + 4} textAnchor="end" className="axis-text">{pct(t, 0)}</text>
          </g>
        ))}
        {metrics.days.map((d, i) => {
          const cx = left + band * i + band / 2;
          const h = Math.max(0, base - y(d.labourPct));
          const over = d.labourPct > metrics.targetPct;
          const l = dayLabel(d.date);
          return (
            <g key={d.date} className={hover === i ? 'on' : ''} onMouseEnter={() => setHover(i)}>
              <rect x={left + band * i + 4} y={top - 14} width={band - 8} height={H - top + 14} rx={8} className="hover-band" />
              {h > 0 && (
                <path
                  d={columnPath(cx, barW, base, h)}
                  className={over ? 'col-over' : 'col-good'}
                />
              )}
              {d.forecastSales > 0 && (
                <text x={cx} y={labelY(base - h)} textAnchor="middle" className="val-text">{pct(d.labourPct)}</text>
              )}
              <text x={cx} y={base + 20} textAnchor="middle" className="day-text">{l.short}</text>
              <text x={cx} y={base + 36} textAnchor="middle" className="axis-text">{money(d.forecastSales)}</text>
              <rect x={left + band * i} y={0} width={band} height={H} className="hit" />
            </g>
          );
        })}
        <line x1={left} x2={W - 4} y1={ty} y2={ty} className="target-line" />
      </svg>
      {hd && hover !== null && (
        <Tip
          x={`${((left + band * (hover + 0.5)) / W) * 100}%`}
          y={`${(Math.max(top, y(hd.labourPct)) / H) * 100}%`}
          title={`${dayLabel(hd.date).short} ${dayLabel(hd.date).date}`}
          rows={[
            ['Forecast sales', money(hd.forecastSales)],
            ['Labour cost', money(hd.labourCost)],
            ['Labour %', pct(hd.labourPct)],
            ['Paid hours', hours(hd.paidHours)],
            ['vs target', `${hd.labourCost - hd.forecastSales * metrics.targetPct > 0 ? '+' : '-'}${money(Math.abs(hd.labourCost - hd.forecastSales * metrics.targetPct))}`],
          ]}
        />
      )}
    </div>
  );
}

/** Round to whole pounds so the parts add up to the rounded total (largest remainder). */
function roundToTotal(values: number[]) {
  const floors = values.map(Math.floor);
  let short = Math.round(values.reduce((a, b) => a + b, 0)) - floors.reduce((a, b) => a + b, 0);
  const order = values.map((v, i) => [v - Math.floor(v), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (short <= 0) break;
    floors[i] += 1;
    short -= 1;
  }
  return floors;
}
