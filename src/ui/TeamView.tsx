import type { Issue } from '../engine/compliance';
import { isEmployedOn, ruleAge } from '../engine/employees';
import type { WeekMetrics } from '../engine/metrics';
import type { RotaState } from '../engine/types';
import { hours, money } from './format';
import { Avatar, COMPONENTS, CostStack } from './viz';

interface Props {
  state: RotaState;
  siteIds: string[];
  metrics: WeekMetrics;
  issues: Issue[];
  dates: string[];
  /** Pay and labour cost columns, for those who may see pay across the scope. */
  showCost: boolean;
}

export function TeamView({ state, siteIds, metrics, issues, dates, showCost }: Props) {
  // Everyone based in scope and on the books this week, then anyone borrowed in from outside it.
  const people = [
    ...state.employees.filter(
      (e) => siteIds.includes(e.siteId) && (dates.some((d) => isEmployedOn(e, d)) || metrics.cost.employees.has(e.id)),
    ),
    ...state.employees.filter((e) => !siteIds.includes(e.siteId) && metrics.cost.employees.has(e.id)),
  ];
  const siteName = (id: string) => state.sites.find((s) => s.id === id)?.name ?? id;
  const entityName = (id: string) => state.entities.find((x) => x.id === id)?.name ?? id;
  const totals = { gross: 0, holiday: 0, ni: 0, pension: 0, total: 0 };
  return (
    <div className="panel grid-wrap">
      <div className="panel-head" style={{ paddingBottom: 12 }}>
        <div>
          <div className="panel-title">{showCost ? 'Team cost this week' : 'Team this week'}</div>
          <div className="panel-sub">{showCost ? 'Every pound payroll will charge, split by what drives it' : 'Rostered hours against contract. Pay is shown to those who see it.'}</div>
        </div>
        {showCost && <div className="legend">
          {COMPONENTS.map((c) => (
            <span key={c.key}><i className="sw" style={{ background: c.color }} />{c.label}</span>
          ))}
        </div>}
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Roles</th>
            <th>Base</th>
            <th>Employer</th>
            {showCost && <th className="num">Pay</th>}
            <th>Rostered vs contract</th>
            {showCost && (<>
            <th className="num">Gross</th>
            <th className="num">Holiday</th>
            <th className="num">Employer NI</th>
            <th className="num">Pension</th>
            <th className="num">Loaded cost</th>
            <th>Mix</th>
            </>)}
            <th>Flags</th>
          </tr>
        </thead>
        <tbody>
          {people.map((e) => {
            const c = metrics.cost.employees.get(e.id);
            const flags = issues.filter((i) => i.employeeId === e.id);
            if (c) {
              totals.gross += c.gross;
              totals.holiday += c.holiday;
              totals.ni += c.employerNi;
              totals.pension += c.pension;
              totals.total += c.total;
            }
            const age = ruleAge(e, new Date().toISOString().slice(0, 10));
            return (
              <tr key={e.id}>
                <td>
                  <div className="person">
                    <Avatar small name={e.name} dept={state.roles.find((r) => r.id === e.roleIds[0])?.department ?? 'FOH'} />
                    <span className="strong">{e.name}</span>
                    {age < 18 && <span className="tag">Under 18</span>}
                  </div>
                </td>
                <td className="muted">{e.roleIds.map((r) => state.roles.find((x) => x.id === r)?.name).join(', ')}</td>
                <td>
                  {siteName(e.siteId)}
                  {e.coverSiteIds.length > 0 && (
                    <div className="muted small">Covers {e.coverSiteIds.map(siteName).join(', ')}</div>
                  )}
                </td>
                <td className="muted">{entityName(e.entityId)}</td>
                {showCost && <td className="num">{e.payBasis === 'salaried' ? `${money(e.annualSalary)} pa` : `£${e.hourlyRate.toFixed(2)}`}</td>}
                <td style={{ minWidth: 150 }}>
                  <div className="tnum small" style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span className="strong">{hours(c?.paidHours ?? 0)}</span>
                    <span className="muted">{e.contractedHours ? `of ${e.contractedHours}h` : e.payBasis === 'salaried' ? 'Salaried' : 'Flexible'}</span>
                  </div>
                  <div className="util" style={{ width: '100%', margin: '5px 0 0' }}>
                    <div
                      className={e.contractedHours && (c?.paidHours ?? 0) < e.contractedHours ? 'under' : ''}
                      style={{ width: `${Math.min(100, ((c?.paidHours ?? 0) / (e.contractedHours || e.maxWeeklyHours || 40)) * 100)}%` }}
                    />
                  </div>
                </td>
                {showCost && (<>
                <td className="num">{money(c?.gross ?? 0)}</td>
                <td className="num">{money(c?.holiday ?? 0)}</td>
                <td className="num">{money(c?.employerNi ?? 0)}</td>
                <td className="num">{money(c?.pension ?? 0)}</td>
                <td className="num strong">{money(c?.total ?? 0)}</td>
                <td style={{ minWidth: 90 }}>
                  <CostStack thin parts={{ gross: c?.gross ?? 0, holiday: c?.holiday ?? 0, employerNi: c?.employerNi ?? 0, pension: c?.pension ?? 0 }} />
                </td>
                </>)}
                <td>
                  {flags.length === 0 ? (
                    <span className="muted">None</span>
                  ) : (
                    <ul className="issues compact">
                      {flags.slice(0, 3).map((i, n) => <li key={n} className={i.severity}>{i.message}</li>)}
                      {flags.length > 3 && <li className="muted">and {flags.length - 3} more</li>}
                    </ul>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        {showCost && <tfoot>
          <tr>
            <th colSpan={6}>{siteIds.length === 1 ? 'Team total' : 'Total'}, every site they work</th>
            <td className="num">{money(totals.gross)}</td>
            <td className="num">{money(totals.holiday)}</td>
            <td className="num">{money(totals.ni)}</td>
            <td className="num">{money(totals.pension)}</td>
            <td className="num strong">{money(totals.total)}</td>
            <td>
              <CostStack thin parts={{ gross: totals.gross, holiday: totals.holiday, employerNi: totals.ni, pension: totals.pension }} />
            </td>
            <td />
          </tr>
        </tfoot>}
      </table>
    </div>
  );
}
