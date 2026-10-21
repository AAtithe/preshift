import type { Issue } from '../engine/compliance';
import type { WeekMetrics } from '../engine/metrics';
import { money, pct } from './format';
import { Bullet, Sparkline } from './viz';

export function KpiBar({ metrics, issues }: { metrics: WeekMetrics; issues: Issue[] }) {
  const blocks = issues.filter((i) => i.severity === 'block').length;
  const warns = issues.length - blocks;
  const over = metrics.varianceToTarget > 0;
  const empty = metrics.labourCost === 0;
  const tone = empty ? '' : over ? 'tone-bad' : 'tone-good';
  // Scale the gauge so the target sits at two thirds of the track.
  const scaleMax = Math.max(metrics.targetPct * 1.5, metrics.labourPct * 1.05);
  const peak = metrics.days.reduce((best, d, i, all) => (d.forecastSales > all[best].forecastSales ? i : best), 0);

  return (
    <section className="kpis">
      <div className="kpi hero">
        <div className="kpi-label">
          Labour % of sales
          {!empty && <span className={`badge ${over ? 'bad' : 'good'}`}>{over ? 'Over target' : 'On target'}</span>}
        </div>
        <div className={`kpi-value ${tone}`}>{pct(metrics.labourPct)}</div>
        <Bullet value={metrics.labourPct} target={metrics.targetPct} max={scaleMax} />
        <div className="bullet-scale">
          <span>0%</span>
          <span>Target {pct(metrics.targetPct, 0)}</span>
          <span>{pct(scaleMax, 0)}</span>
        </div>
      </div>

      <div className="kpi">
        <div className="kpi-label">Forecast sales</div>
        <div className="kpi-value">{money(metrics.forecastSales)}</div>
        <div className="kpi-hint">Net of VAT</div>
        <div className="spark">
          <Sparkline values={metrics.days.map((d) => d.forecastSales)} highlight={peak} />
        </div>
      </div>

      <div className="kpi">
        <div className="kpi-label">Labour cost</div>
        <div className="kpi-value">{money(metrics.labourCost)}</div>
        <div className="kpi-hint">Loaded: holiday, NI, pension</div>
        <div className="spark">
          <Sparkline values={metrics.days.map((d) => d.labourCost)} highlight={peak} />
        </div>
      </div>

      <div className="kpi">
        <div className="kpi-label">Vs target</div>
        <div className={`kpi-value ${tone}`}>
          {over ? '+' : '-'}
          {money(Math.abs(metrics.varianceToTarget))}
        </div>
        <div className="kpi-hint">{over ? 'Over the labour budget' : 'Headroom left in budget'}</div>
        <Bullet value={metrics.labourCost} target={metrics.targetCost} max={Math.max(metrics.targetCost, metrics.labourCost) * 1.15 || 1} />
        <div className="bullet-scale">
          <span>Budget {money(metrics.targetCost)}</span>
        </div>
      </div>

      <div className="kpi">
        <div className="kpi-label">Sales per labour hour</div>
        <div className="kpi-value">{money(metrics.splh)}</div>
        <div className="kpi-hint">{metrics.paidHours.toFixed(0)} paid hours</div>
        <div className="spark">
          <Sparkline values={metrics.days.map((d) => d.splh)} highlight={peak} />
        </div>
      </div>

      <div className="kpi">
        <div className="kpi-label">Compliance</div>
        <div className={`kpi-value ${blocks ? 'tone-bad' : warns ? 'tone-warn' : 'tone-good'}`}>
          {blocks ? `${blocks} blocking` : warns ? `${warns} to review` : 'Clear'}
        </div>
        <div className="kpi-hint">{blocks ? 'Cannot publish until resolved' : 'UK working time and pay law'}</div>
        <div className="compliance-dots">
          <span><i style={{ background: 'var(--bad)' }} />{blocks} blocking</span>
          <span><i style={{ background: 'var(--warn)' }} />{warns} warnings</span>
        </div>
      </div>
    </section>
  );
}
