import type { Issue } from '../engine/compliance';
import { isEmployedOn } from '../engine/employees';
import type { WeekMetrics } from '../engine/metrics';
import { ageOn } from '../engine/time';
import type { RotaState } from '../engine/types';
import { hours, money } from './format';

interface Props {
  state: RotaState;
  siteId: string;
  metrics: WeekMetrics;
  issues: Issue[];
  dates: string[];
}

export function TeamView({ state, siteId, metrics, issues, dates }: Props) {
  const people = state.employees.filter(
    (e) => e.siteId === siteId && (dates.some((d) => isEmployedOn(e, d)) || metrics.cost.employees.has(e.id)),
  );
  const totals = { gross: 0, holiday: 0, ni: 0, pension: 0, total: 0 };
  return (
    <div className="grid-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Roles</th>
            <th className="num">Pay</th>
            <th className="num">Contract</th>
            <th className="num">Rostered</th>
            <th className="num">Gross</th>
            <th className="num">Holiday</th>
            <th className="num">Employer NI</th>
            <th className="num">Pension</th>
            <th className="num">Loaded cost</th>
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
                  {e.name}
                  {age < 18 && <span className="tag">Under 18</span>}
                </td>
                <td className="muted">{e.roleIds.map((r) => state.roles.find((x) => x.id === r)?.name).join(', ')}</td>
                <td className="num">{e.payBasis === 'salaried' ? `${money(e.annualSalary)} pa` : `£${e.hourlyRate.toFixed(2)}`}</td>
                <td className="num">{e.contractedHours ? hours(e.contractedHours) : 'Flexible'}</td>
                <td className="num">{hours(c?.paidHours ?? 0)}</td>
                <td className="num">{money(c?.gross ?? 0)}</td>
                <td className="num">{money(c?.holiday ?? 0)}</td>
                <td className="num">{money(c?.employerNi ?? 0)}</td>
                <td className="num">{money(c?.pension ?? 0)}</td>
                <td className="num strong">{money(c?.total ?? 0)}</td>
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
            <th colSpan={5}>Site total</th>
            <td className="num">{money(totals.gross)}</td>
            <td className="num">{money(totals.holiday)}</td>
            <td className="num">{money(totals.ni)}</td>
            <td className="num">{money(totals.pension)}</td>
            <td className="num strong">{money(totals.total)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
