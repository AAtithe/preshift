import type { Issue } from '../engine/compliance';
import type { WeekMetrics } from '../engine/metrics';
import { money, pct } from './format';

export function KpiBar({ metrics, issues }: { metrics: WeekMetrics; issues: Issue[] }) {
  const blocks = issues.filter((i) => i.severity === 'block').length;
  const warns = issues.length - blocks;
  const over = metrics.varianceToTarget > 0;
  const status = metrics.labourCost === 0 ? '' : over ? 'bad' : 'good';
  return (
    <section className="kpis">
      <Kpi label="Forecast sales" value={money(metrics.forecastSales)} hint="Net of VAT" />
      <Kpi label="Labour cost" value={money(metrics.labourCost)} hint="Loaded: holiday, NI, pension" />
      <Kpi
        label="Labour %"
        value={pct(metrics.labourPct)}
        hint={`Target ${pct(metrics.targetPct, 0)}`}
        tone={status}
      />
      <Kpi
        label="Vs target"
        value={`${over ? '+' : ''}${money(metrics.varianceToTarget)}`}
        hint={over ? 'Over budget' : 'Headroom'}
        tone={status}
      />
      <Kpi label="Sales per labour hour" value={money(metrics.splh)} hint={`${metrics.paidHours.toFixed(0)} paid hours`} />
      <Kpi
        label="Compliance"
        value={blocks ? `${blocks} blocking` : warns ? `${warns} to review` : 'Clear'}
        hint={blocks ? 'Cannot publish' : `${warns} warnings`}
        tone={blocks ? 'bad' : warns ? 'warn' : 'good'}
      />
    </section>
  );
}

export function Kpi({ label, value, hint, tone = '' }: { label: string; value: string; hint: string; tone?: string }) {
  return (
    <div className={`kpi ${tone}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-hint">{hint}</div>
    </div>
  );
}
