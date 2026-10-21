import type { ReactNode } from 'react';
import { coverDistance } from '../engine/autoschedule';
import type { Issue } from '../engine/compliance';
import { shiftPaidHours } from '../engine/cost';
import type { ScopeMetrics, SiteWeekMetrics } from '../engine/metrics';
import type { RotaState } from '../engine/types';
import { hours, money, pct } from './format';

interface Props {
  state: RotaState;
  dates: string[];
  metrics: ScopeMetrics;
  issues: Issue[];
  onOpenSite: (siteId: string) => void;
}

/**
 * The operator's group view: every site in scope side by side, subtotalled by
 * entity, so the question "which site is costing me margin this week" is
 * answered before anyone opens a rota.
 */
export function GroupView({ state, dates, metrics, issues, onOpenSite }: Props) {
  const entities = state.entities
    .map((entity) => ({ entity, sites: metrics.sites.filter((m) => siteOf(state, m.siteId)?.entityId === entity.id) }))
    .filter((g) => g.sites.length > 0);

  const weekShifts = state.shifts.filter((s) => dates.includes(s.date) && metrics.sites.some((m) => m.siteId === s.siteId));
  // A shift's issue belongs to the site it is worked at; a week-level one to the person's home site.
  const at = (siteId: string, i: Issue) =>
    i.shiftId ? weekShifts.find((s) => s.id === i.shiftId)?.siteId === siteId : employeeSite(state, i.employeeId) === siteId;
  const blocksAt = (siteId: string) => issues.filter((i) => i.severity === 'block' && at(siteId, i)).length;
  // Rest breaches a manager chose to publish through. One every week at a site is a staffing problem, not an exception.
  const overridesAt = (siteId: string) => issues.filter((i) => i.overridden && at(siteId, i));
  const overrideCount = (sites: SiteWeekMetrics[]) => sites.reduce((n, m) => n + overridesAt(m.siteId).length, 0);
  const personName = (id: string) => state.employees.find((e) => e.id === id)?.name ?? id;

  // Who worked away from their home site, and what crossed a company line.
  const cover = weekShifts
    .map((s) => {
      const employee = state.employees.find((e) => e.id === s.employeeId);
      if (!employee || employee.siteId === s.siteId) return null;
      return { shift: s, employee, distance: coverDistance(state, employee, s.siteId), cost: metrics.cost.shifts.get(s.id)?.total ?? 0 };
    })
    .filter((c) => c !== null);
  const sisterHours = cover.filter((c) => c.distance === 1).reduce((s, c) => s + shiftPaidHours(c.shift), 0);
  const recharge = cover.filter((c) => c.distance === 2);

  return (
    <div className="group-view">
      <div className="grid-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Site</th>
              <th className="num">Forecast sales</th>
              <th className="num">Labour cost</th>
              <th className="num">Labour %</th>
              <th className="num">Target</th>
              <th className="num">Vs target</th>
              <th className="num">SPLH</th>
              <th className="num">Paid hours</th>
              <th className="num" title="Rest breaches published with a manager's reason this week">Overrides</th>
              <th>Rota</th>
            </tr>
          </thead>
          <tbody>
            {entities.map(({ entity, sites }) => (
              <EntityRows key={entity.id} label={entity.name} sites={sites} total={sum(sites)} overrides={overrideCount(sites)}>
                {sites.map((m) => {
                  const site = siteOf(state, m.siteId)!;
                  const shifts = weekShifts.filter((s) => s.siteId === m.siteId);
                  const blocks = blocksAt(m.siteId);
                  const overridden = overridesAt(m.siteId);
                  const status =
                    shifts.length === 0 ? 'Not built' : shifts.every((s) => s.published) ? 'Published' : 'Draft';
                  return (
                    <tr key={m.siteId}>
                      <td>
                        <button className="link site-link" onClick={() => onOpenSite(m.siteId)}>{site.name}</button>
                      </td>
                      <Figures m={m} />
                      <td
                        className={`num ${overridden.length ? 'warn-text' : 'muted'}`}
                        title={overridden.map((i) => `${personName(i.employeeId)}: ${i.overridden!.reason} (${i.overridden!.by})`).join('\n') || undefined}
                      >
                        {overridden.length}
                      </td>
                      <td>
                        {status}
                        {blocks > 0 && <span className="tag bad">{blocks} blocking</span>}
                      </td>
                    </tr>
                  );
                })}
              </EntityRows>
            ))}
          </tbody>
          {entities.length > 1 && (
            <tfoot>
              <tr>
                <th>Group</th>
                <Figures m={metrics} strong />
                <td className="num strong">{overrideCount(metrics.sites)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="cover-summary">
        <h3>Cross-site cover this week</h3>
        {cover.length === 0 ? (
          <p className="muted">Every shift is worked by the site's own team.</p>
        ) : (
          <>
            <p className="muted">
              {hours(cover.reduce((s, c) => s + shiftPaidHours(c.shift), 0))} worked away from home sites.{' '}
              {hours(sisterHours)} of that is within the same company and needs no paperwork.{' '}
              {recharge.length > 0
                ? `${hours(recharge.reduce((s, c) => s + shiftPaidHours(c.shift), 0))} crossed into another company, ${money(recharge.reduce((s, c) => s + c.cost, 0))} loaded, which the close posts as an intercompany recharge.`
                : 'Nothing crossed a company line, so there is nothing to recharge.'}
            </p>
            <ul className="cover-list">
              {cover.map((c) => (
                <li key={c.shift.id}>
                  {c.employee.name}: {siteOf(state, c.employee.siteId)?.name} to {siteOf(state, c.shift.siteId)?.name},{' '}
                  {hours(shiftPaidHours(c.shift))}, {money(c.cost)}
                  {c.distance === 2 && <span className="tag">Recharge</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function EntityRows({ label, sites, total, overrides, children }: { label: string; sites: SiteWeekMetrics[]; total: Totals; overrides: number; children: ReactNode }) {
  return (
    <>
      <tr className="entity-head">
        <th colSpan={10}>{label}</th>
      </tr>
      {children}
      {sites.length > 1 && (
        <tr className="subtotal">
          <td>Total {label}</td>
          <Figures m={total} />
          <td className="num">{overrides}</td>
          <td />
        </tr>
      )}
    </>
  );
}

interface Totals {
  forecastSales: number;
  labourCost: number;
  labourPct: number;
  targetPct: number;
  varianceToTarget: number;
  splh: number;
  paidHours: number;
}

function sum(sites: SiteWeekMetrics[]): Totals {
  const forecastSales = sites.reduce((s, m) => s + m.forecastSales, 0);
  const labourCost = sites.reduce((s, m) => s + m.labourCost, 0);
  const paidHours = sites.reduce((s, m) => s + m.paidHours, 0);
  const targetCost = sites.reduce((s, m) => s + m.targetCost, 0);
  const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);
  return {
    forecastSales,
    labourCost,
    paidHours,
    labourPct: ratio(labourCost, forecastSales),
    targetPct: ratio(targetCost, forecastSales),
    varianceToTarget: labourCost - targetCost,
    splh: ratio(forecastSales, paidHours),
  };
}

function Figures({ m, strong = false }: { m: Totals; strong?: boolean }) {
  const over = m.varianceToTarget > 0;
  const tone = m.labourCost === 0 ? '' : over ? 'bad-text' : 'good-text';
  const cls = (extra = '') => `num ${strong ? 'strong' : ''} ${extra}`;
  return (
    <>
      <td className={cls()}>{money(m.forecastSales)}</td>
      <td className={cls()}>{money(m.labourCost)}</td>
      <td className={cls(tone)}>{pct(m.labourPct)}</td>
      <td className={cls('muted')}>{pct(m.targetPct)}</td>
      <td className={cls(tone)}>{`${over ? '+' : ''}${money(m.varianceToTarget)}`}</td>
      <td className={cls()}>{money(m.splh)}</td>
      <td className={cls()}>{hours(m.paidHours)}</td>
    </>
  );
}

function siteOf(state: RotaState, siteId: string) {
  return state.sites.find((s) => s.id === siteId);
}

function employeeSite(state: RotaState, employeeId: string) {
  return state.employees.find((e) => e.id === employeeId)?.siteId;
}
