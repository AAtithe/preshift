import { useState } from 'react';
import { dayDemand, type HourDemand } from '../engine/demand';
import type { RotaState } from '../engine/types';
import { dayLabel, money } from './format';

export function DemandView({ state, siteId, dates }: { state: RotaState; siteId: string; dates: string[] }) {
  const [date, setDate] = useState(dates[4]);
  const day = dates.includes(date) ? date : dates[0];
  const rules = state.demandRules.filter((r) => r.siteId === siteId);
  const sales = dayDemand(state, siteId, rules[0]?.roleId ?? '', day);

  return (
    <div className="demand">
      <div className="day-pills">
        {dates.map((d) => (
          <button key={d} className={d === day ? 'active' : ''} onClick={() => setDate(d)}>
            {dayLabel(d).short}
          </button>
        ))}
      </div>
      <p className="muted">
        Headcount needed each hour, worked out from forecast sales and covers, against who is rostered.
        Red is short (service at risk), amber is over (margin at risk).
      </p>
      <SalesStrip hours={sales} />
      <div className="demand-grid">
        {rules.map((rule) => {
          const role = state.roles.find((r) => r.id === rule.roleId)!;
          const rows = dayDemand(state, siteId, rule.roleId, day);
          const short = rows.reduce((s, r) => s + Math.max(0, r.gap), 0);
          const over = rows.reduce((s, r) => s + Math.max(0, -r.gap), 0);
          return (
            <div key={rule.roleId} className="demand-card">
              <div className="demand-head">
                <strong>{role.name}</strong>
                <span className="muted small">
                  {rule.salesPerLabourHour ? `${money(rule.salesPerLabourHour)} sales per hour` : `${rule.coversPerHour} covers per hour`}
                  {' · '}
                  {short ? <span className="bad-text">{short} hours short</span> : null}
                  {short && over ? ', ' : ''}
                  {over ? <span className="warn-text">{over} hours over</span> : null}
                  {!short && !over ? 'On plan' : ''}
                </span>
              </div>
              <Chart rows={rows} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SalesStrip({ hours }: { hours: HourDemand[] }) {
  const open = hours.filter((h) => h.sales > 0);
  if (open.length === 0) return null;
  const max = Math.max(...open.map((h) => h.sales));
  return (
    <div className="sales-strip">
      {open.map((h) => (
        <div key={h.hour} className="sales-col" title={`${h.covers} covers`}>
          <div className="sales-bar" style={{ height: `${(h.sales / max) * 48}px` }} />
          <div className="small">{money(h.sales)}</div>
          <div className="muted small">{String(h.hour).padStart(2, '0')}</div>
        </div>
      ))}
    </div>
  );
}

function Chart({ rows }: { rows: HourDemand[] }) {
  const visible = rows.filter((r) => r.required > 0 || r.scheduled > 0);
  if (visible.length === 0) return <div className="muted small">Closed</div>;
  const first = visible[0].hour;
  const last = visible[visible.length - 1].hour;
  const span = rows.slice(first, last + 1);
  const max = Math.max(1, ...span.map((r) => Math.max(r.required, r.scheduled)));
  const w = 22;
  const h = 70;
  return (
    <svg viewBox={`0 0 ${span.length * w} ${h + 16}`} className="chart" role="img" aria-label="Required versus scheduled headcount">
      {span.map((r, i) => {
        const x = i * w;
        const sh = (r.scheduled / max) * h;
        const rq = (r.required / max) * h;
        const tone = r.gap > 0 ? 'short' : r.gap < 0 ? 'over' : 'ok';
        return (
          <g key={r.hour}>
            <title>{`${String(r.hour).padStart(2, '0')}:00 need ${r.required}, have ${r.scheduled}`}</title>
            <rect x={x + 3} y={h - sh} width={w - 6} height={sh} className={`bar ${tone}`} rx={2} />
            <line x1={x + 1} x2={x + w - 1} y1={h - rq} y2={h - rq} className="need" />
            <text x={x + w / 2} y={h + 12} className="axis" textAnchor="middle">
              {r.hour % 24}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
