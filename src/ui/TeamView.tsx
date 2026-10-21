import type { Issue } from '../engine/compliance';
import type { WeekMetrics } from '../engine/metrics';
import { ageOn } from '../engine/time';
import type { RotaState } from '../engine/types';
import { hours, money } from './format';
import { Avatar, COMPONENTS, CostStack } from './viz';

interface Props {
  state: RotaState;
  siteId: string;
  metrics: WeekMetrics;
  issues: Issue[];
}

export function TeamView({ state, siteId, metrics, issues }: Props) {
  const people = state.employees.filter((e) => e.siteId === siteId);
  const totals = { gross: 0, holiday: 0, ni: 0, pension: 0, total: 0 };
  return (
    <div className="panel grid-wrap">
      <div className="panel-head" style={{ paddingBottom: 12 }}>
        <div>
          <div className="panel-title">Team cost this week</div>
          <div className="panel-sub">Every pound payroll will charge, split by what drives it</div>
        </div>
        <div className="legend">
          {COMPONENTS.map((c) => (
            <span key={c.key}><i className="sw" style={{ background: c.color }} />{c.label}</span>
          ))}
        </div>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Roles</th>
            <th className="num">Pay</th>
            <th>Rostered vs contract</th>
            <th className="num">Gross</th>
            <th className="num">Holiday</th>
            <th className="num">Employer NI</th>
            <th className="num">Pension</th>
            <th className="num">Loaded cost</th>
            <th>Mix</th>
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
            const age = ageOn(e.dateOfBirth, new Date().toISOString().slice(0, 10));
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
                <td className="num">{e.payBasis === 'salaried' ? `${money(e.annualSalary)} pa` : `£${e.hourlyRate.toFixed(2)}`}</td>
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
                <td className="num">{money(c?.gross ?? 0)}</td>
                <td className="num">{money(c?.holiday ?? 0)}</td>
                <td className="num">{money(c?.employerNi ?? 0)}</td>
                <td className="num">{money(c?.pension ?? 0)}</td>
                <td className="num strong">{money(c?.total ?? 0)}</td>
                <td style={{ minWidth: 90 }}>
                  <CostStack thin parts={{ gross: c?.gross ?? 0, holiday: c?.holiday ?? 0, employerNi: c?.employerNi ?? 0, pension: c?.pension ?? 0 }} />
                </td>
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
        <tfoot>
          <tr>
            <th colSpan={4}>Team total, every site they work</th>
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
        </tfoot>
      </table>
    </div>
  );
}
