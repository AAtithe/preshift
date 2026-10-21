import { useMemo } from 'react';
import { complianceExposure } from '../engine/exposure';
import type { RotaState } from '../engine/types';
import { UK_RATES_2026_27 } from '../engine/ukRates';
import { dayLabel, hours, money, money2 } from './format';
import { Kpi } from './KpiBar';

interface Props {
  state: RotaState;
  siteId: string;
  week: string;
  asOf: string;
}

const RTW_LABEL: Record<string, string> = {
  'rtw-student-hours': 'Student over term-time hours',
  'rtw-expired': 'Working after permission ended',
  'rtw-missing': 'No right to work check',
  'rtw-expiring': 'Permission ending soon',
  'rtw-student-buffer': 'Student rostered close to the limit',
};

export function RiskView({ state, siteId, week, asOf }: Props) {
  const r = useMemo(() => complianceExposure(state, siteId, week, asOf), [state, siteId, week, asOf]);
  const name = (id: string) => state.employees.find((e) => e.id === id)?.name ?? id;
  const salary = (id: string) => state.employees.find((e) => e.id === id)?.annualSalary ?? 0;
  const { policy, offers, earlyFinishes } = r.era;
  const weeksUsed = offers[0]?.weeksUsed ?? 0;

  return (
    <div className="risk">
      <p className="muted intro">
        Compliance priced the way a regulator or tribunal would price it. Arrears are owed to staff whether or not anyone
        notices. Penalties are ceilings, not predictions: HMRC and the Home Office reduce them for prompt disclosure,
        which is why finding the breach first is worth more than the penalty.
      </p>

      <section className="kpis">
        <Kpi label="Owed to staff now" value={money2(r.owedNow)} hint="Minimum wage arrears this week" tone={r.owedNow > 0 ? 'bad' : 'good'} />
        <Kpi label="Penalty ceiling" value={money(r.penaltyCeiling)} hint="HMRC and Home Office maximum" tone={r.penaltyCeiling > 0 ? 'bad' : 'good'} />
        <Kpi label="Arrears over a year" value={money(r.annualisedArrears)} hint="If this week's pattern holds" tone={r.annualisedArrears > 0 ? 'warn' : 'good'} />
        <Kpi
          label="Working Time breaches"
          value={String(r.workingTime.length)}
          hint="On clocked hours, claim risk"
          tone={r.workingTime.length ? 'warn' : 'good'}
        />
        <Kpi label="Hours becoming fixed" value={`${money(r.era.weeklyFixedCost)}/wk`} hint="Employment Rights Act, assumed" tone={offers.length ? 'warn' : ''} />
        <Kpi
          label="Compensation on cuts"
          value={money2(earlyFinishes.compensation)}
          hint={`${earlyFinishes.count} early finish${earlyFinishes.count === 1 ? '' : 'es'} this week, assumed`}
          tone={earlyFinishes.count ? 'warn' : ''}
        />
      </section>

      <h3 className="section">Minimum wage on hours worked</h3>
      {r.nmw.length === 0 ? (
        <p className="muted">Everyone on a salary or with deductions clears the minimum wage this week with at least two hours to spare.</p>
      ) : (
        <div className="grid-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Basis</th>
                <th className="num">Hours</th>
                <th className="num">Pay for NMW</th>
                <th className="num">Per hour</th>
                <th className="num">Band</th>
                <th className="num">Arrears</th>
                <th className="num">Penalty ceiling</th>
                <th className="num">Headroom</th>
              </tr>
            </thead>
            <tbody>
              {r.nmw.map((row) => (
                <tr key={row.employeeId}>
                  <td>
                    {name(row.employeeId)}
                    {salary(row.employeeId) > 0 && <div className="muted small">{money(salary(row.employeeId))} salary</div>}
                  </td>
                  <td>{row.basis === 'clocked' ? 'Clocked' : 'Clocked and rota'}</td>
                  <td className="num">{hours(row.hoursWorked)}</td>
                  <td className="num">{money2(row.pay)}</td>
                  <td className={`num ${row.arrears > 0 ? 'bad-text' : ''}`}>£{row.effectiveRate.toFixed(2)}</td>
                  <td className="num">£{row.bandRate.toFixed(2)}</td>
                  <td className={`num ${row.arrears > 0 ? 'bad-text strong' : ''}`}>{money2(row.arrears)}</td>
                  <td className="num">{money2(row.penalty)}</td>
                  <td className={`num ${row.headroomHours < 0 ? 'bad-text' : 'warn-text'}`}>{hours(row.headroomHours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">
        Pay for minimum wage is basic pay less deductions for the employer's benefit, such as uniform and salary
        sacrifice; holiday pay, tips and on-costs do not count. Headroom is how many more hours the person can work this
        week before pay falls below the band. Fix: cap the hours on the rota, or raise the salary to what the hours need.
      </p>

      <h3 className="section">Right to work</h3>
      {r.rightToWork.length === 0 ? (
        <p className="muted">Every person working has a valid check on file and is inside their permission.</p>
      ) : (
        <div className="grid-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Issue</th>
                <th>Where</th>
                <th>Detail</th>
                <th className="num">Penalty ceiling</th>
              </tr>
            </thead>
            <tbody>
              {r.rightToWork.map((l) => (
                <tr key={`${l.employeeId}-${l.code}`}>
                  <td>{name(l.employeeId)}</td>
                  <td>{RTW_LABEL[l.code] ?? l.code}</td>
                  <td>{l.source === 'clocked' ? <span className="bad-text">Happened</span> : 'On the rota'}</td>
                  <td className="small muted">{l.message}</td>
                  <td className="num">{l.penaltyCeiling ? money(l.penaltyCeiling) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">
        The Home Office civil penalty is per illegal worker: up to {money(UK_RATES_2026_27.illegalWorkingPenaltyFirst)} for a first breach and{' '}
        {money(UK_RATES_2026_27.illegalWorkingPenaltyRepeat)} for
        a repeat. A student working over their term-time hours is working illegally even with a valid visa. The rota blocks
        it; overruns on the clock are how it happens anyway.
      </p>

      <h3 className="section">Working Time on clocked hours</h3>
      {r.workingTime.length === 0 ? (
        <p className="muted">No breaches on clocked hours.</p>
      ) : (
        <ul className="issues">
          {r.workingTime.map((i, k) => (
            <li key={k} className={i.severity}>
              {name(i.employeeId)}
              {i.date ? `, ${dayLabel(i.date).short} ${dayLabel(i.date).date}` : ''}: {i.message}
            </li>
          ))}
        </ul>
      )}
      <p className="small muted">
        No tariff applies: a tribunal sets compensation case by case, so these are counted, not priced. They matter most as
        evidence. A pattern of missed breaks is what turns one claim into a group claim.
      </p>

      <h3 className="section">Employment Rights Act 2025</h3>
      <div className="notice small">
        The thresholds and rates below are assumptions, not the law. The Act leaves them to regulations that have not been
        made. Assumed: guaranteed hours offers for anyone contracted under {policy.lowHoursThreshold} hours, set on average
        hours over up to {policy.referenceWeeks} weeks; short-notice cuts paid at {Math.round(policy.compensationShare * 100)}%
        of lost pay. Replace these with the regulations before relying on the numbers.
      </div>
      {offers.length === 0 ? (
        <p className="muted">No clocked weeks yet to judge regular hours on.</p>
      ) : (
        <div className="grid-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">Contracted</th>
                <th className="num">Average worked</th>
                <th className="num">Would become guaranteed</th>
                <th className="num">Fixed cost a week</th>
              </tr>
            </thead>
            <tbody>
              {offers.map((o) => (
                <tr key={o.employeeId}>
                  <td>{name(o.employeeId)}</td>
                  <td className="num">{hours(o.contractedHours)}</td>
                  <td className="num">{hours(o.averageHours)}</td>
                  <td className="num">{hours(o.extraGuaranteedHours)}</td>
                  <td className="num">{money2(o.weeklyFixedCost)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={4}>Based on {weeksUsed} clocked week{weeksUsed === 1 ? '' : 's'}</th>
                <td className="num strong">{money2(r.era.weeklyFixedCost)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="small muted">
        This week the site sent people home early {earlyFinishes.count} time{earlyFinishes.count === 1 ? '' : 's'} and saved {money2(earlyFinishes.saved)}. On the
        assumptions above, {money2(earlyFinishes.compensation)} of that would be paid back as compensation. Once the Act is
        in force, flexibility on the day stops being free: the saving moves to getting the rota right before the notice
        window closes.
      </p>
    </div>
  );
}
