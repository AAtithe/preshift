import { useEffect, useMemo, useState } from 'react';
import { labourByRole, labourTrend, rotaVsActual, type CostLine } from '../engine/reports';
import { addDays } from '../engine/time';
import type { Department, RotaState, TimeEntry } from '../engine/types';
import { api } from './api';
import { dayLabel, download, hours, money, pct } from './format';

type Report = 'trend' | 'roles' | 'actual';

const REPORTS: { id: Report; label: string; intro: string }[] = [
  {
    id: 'trend',
    label: 'Labour trend',
    intro: 'Labour against target week by week, from the rota. One bad week is noise; three in a row at the same site is a staffing model that needs changing.',
  },
  {
    id: 'roles',
    label: 'Cost by role',
    intro: 'Where the week’s labour goes, by department and role, with every on-cost shown. Wages tie to the role nominals in the accrual journal.',
  },
  {
    id: 'actual',
    label: 'Rota vs actual',
    intro: 'The week as planned against the week as it now stands: clocked time for days worked, the rota for days left, priced as payroll will price it. The variance is what drift on the floor has cost so far.',
  },
];

const DEPARTMENTS: Record<Department, string> = { FOH: 'Front of house', BAR: 'Bar', BOH: 'Kitchen', MGMT: 'Management' };

interface Props {
  state: RotaState;
  siteIds: string[];
  week: string;
  today: string;
  /** Names the scope in export file names. */
  scopeName: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const csv = (rows: (string | number)[][]) =>
  rows.map((r) => r.map((v) => (typeof v === 'number' ? v.toFixed(2) : `"${v.replace(/"/g, '""')}"`)).join(',')).join('\n');
const signed = (n: number, f: (n: number) => string) => `${n > 0 ? '+' : ''}${f(n)}`;

export function ReportsView({ state, siteIds, week, today, scopeName }: Props) {
  const [report, setReport] = useState<Report>('trend');
  const current = REPORTS.find((r) => r.id === report)!;
  return (
    <div className="reports">
      <div className="close-intro">
        <div className="day-pills" role="tablist" aria-label="Report">
          {REPORTS.map((r) => (
            <button key={r.id} role="tab" aria-selected={report === r.id} className={report === r.id ? 'active' : ''} onClick={() => setReport(r.id)}>
              {r.label}
            </button>
          ))}
        </div>
        <p className="muted">{current.intro}</p>
      </div>
      {report === 'trend' && <Trend state={state} siteIds={siteIds} week={week} scopeName={scopeName} />}
      {report === 'roles' && <ByRole state={state} siteIds={siteIds} week={week} scopeName={scopeName} />}
      {report === 'actual' && <VsActual state={state} siteIds={siteIds} week={week} today={today} scopeName={scopeName} />}
    </div>
  );
}

function Trend({ state, siteIds, week, scopeName }: Omit<Props, 'today'>) {
  const [weeks, setWeeks] = useState(4);
  const trend = useMemo(() => labourTrend(state, siteIds, week, weeks), [state, siteIds, week, weeks]);
  const siteName = (id: string) => state.sites.find((s) => s.id === id)?.name ?? id;
  // A week with no shifts carries only salaried pay, which would read as a very good week. It is not one.
  const counts = (m: { forecastSales: number; paidHours: number }) => m.forecastSales > 0 && m.paidHours > 0;
  const tone = (m: { forecastSales: number; paidHours: number; varianceToTarget: number }) => (!counts(m) ? '' : m.varianceToTarget > 0 ? 'bad-text' : 'good-text');
  const overWeeks = (siteId: string) =>
    trend.filter((w) => {
      const m = w.metrics.sites.find((s) => s.siteId === siteId)!;
      return counts(m) && m.varianceToTarget > 0;
    }).length;

  function exportCsv() {
    const header = ['Week commencing', 'Site', 'Forecast sales', 'Labour cost', 'Labour %', 'Target %', 'Vs target', 'SPLH', 'Paid hours'];
    const rows = trend.flatMap((w) =>
      w.metrics.sites.map((m) => [w.weekStart, siteName(m.siteId), m.forecastSales, m.labourCost, m.labourPct * 100, m.targetPct * 100, m.varianceToTarget, m.splh, m.paidHours]),
    );
    download(`preshift-labour-trend-${slug(scopeName)}-${week}.csv`, csv([header, ...rows]));
  }

  return (
    <>
      <div className="close-actions report-actions">
        <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} aria-label="Weeks">
          <option value={4}>Last 4 weeks</option>
          <option value={8}>Last 8 weeks</option>
          <option value={13}>Last 13 weeks (a quarter)</option>
        </select>
        <button onClick={exportCsv}>Download CSV</button>
      </div>
      <div className="grid-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Week commencing</th>
              <th className="num">Forecast sales</th>
              <th className="num">Labour cost</th>
              <th className="num">Labour %</th>
              <th className="num">Target</th>
              <th className="num">Vs target</th>
              <th className="num">SPLH</th>
              <th className="num">Paid hours</th>
            </tr>
          </thead>
          <tbody>
            {trend.map(({ weekStart, metrics: m }) => (
              <tr key={weekStart}>
                <td>{dayLabel(weekStart).date}</td>
                <td className="num">{m.forecastSales ? money(m.forecastSales) : <span className="muted">No forecast</span>}</td>
                <td className="num">{m.paidHours ? money(m.labourCost) : <span className="muted">No rota</span>}</td>
                <td className={`num ${tone(m)}`}>{counts(m) ? pct(m.labourPct) : ''}</td>
                <td className="num muted">{m.forecastSales ? pct(m.targetPct) : ''}</td>
                <td className={`num ${tone(m)}`}>{counts(m) ? signed(m.varianceToTarget, money) : ''}</td>
                <td className="num">{m.paidHours ? money(m.splh) : ''}</td>
                <td className="num">{hours(m.paidHours)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {siteIds.length > 1 && (
        <div className="grid-wrap report-block">
          <div className="entity-journal-head">
            <h3>Labour % by site</h3>
            <span className="muted small">Red is over the site's own target. The last column counts weeks over target.</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Site</th>
                {trend.map((w) => <th key={w.weekStart} className="num">{dayLabel(w.weekStart).date}</th>)}
                <th className="num">Weeks over</th>
              </tr>
            </thead>
            <tbody>
              {siteIds.map((siteId) => (
                <tr key={siteId}>
                  <td>{siteName(siteId)}</td>
                  {trend.map((w) => {
                    const m = w.metrics.sites.find((s) => s.siteId === siteId)!;
                    return (
                      <td key={w.weekStart} className={`num ${tone(m)}`}>
                        {counts(m) ? pct(m.labourPct) : <span className="muted">-</span>}
                      </td>
                    );
                  })}
                  <td className={`num strong ${overWeeks(siteId) > 1 ? 'bad-text' : ''}`}>{overWeeks(siteId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ByRole({ state, siteIds, week, scopeName }: Omit<Props, 'today'>) {
  const report = useMemo(() => labourByRole(state, siteIds, week), [state, siteIds, week]);
  const roleName = (id: string) => state.roles.find((r) => r.id === id)?.name ?? id;
  const ofSales = (n: number) => (report.forecastSales ? pct(n / report.forecastSales) : '');
  const share = (n: number) => (report.total ? pct(n / report.total) : '');

  function exportCsv() {
    const header = ['Department', 'Role', 'Paid hours', 'Gross pay', 'Holiday accrual', "Employer's NI", 'Employer pension', 'Total', 'Paid not rostered', 'Share of labour %', '% of forecast sales'];
    const rows = report.departments.flatMap((d) =>
      d.roles.map((r) => [DEPARTMENTS[d.department], roleName(r.roleId), r.paidHours, r.gross, r.holiday, r.employerNi, r.pension, r.total, r.unrostered, report.total ? (r.total / report.total) * 100 : 0, report.forecastSales ? (r.total / report.forecastSales) * 100 : 0]),
    );
    download(`preshift-labour-by-role-${slug(scopeName)}-${week}.csv`, csv([header, ...rows]));
  }

  if (report.departments.length === 0) return <p className="muted">No labour for this week yet. Build the rota first.</p>;

  const Cells = ({ c, strong = false }: { c: CostLine; strong?: boolean }) => {
    const cls = `num ${strong ? 'strong' : ''}`;
    return (
      <>
        <td className={cls}>{hours(c.paidHours)}</td>
        <td className={cls}>{money(c.gross)}</td>
        <td className={cls}>{money(c.holiday)}</td>
        <td className={cls}>{money(c.employerNi)}</td>
        <td className={cls}>{money(c.pension)}</td>
        <td className={cls}>{money(c.total)}</td>
        <td className={`${cls} muted`}>{share(c.total)}</td>
        <td className={cls}>{ofSales(c.total)}</td>
      </>
    );
  };
  const onCost = report.holiday + report.employerNi + report.pension;

  return (
    <>
      <div className="close-actions report-actions">
        <span className="muted small">
          On-costs add {report.gross ? pct(onCost / report.gross) : '0%'} to gross pay this week ({money(onCost)}). Quote that number
          to anyone who costs a shift at the headline rate.
        </span>
        <button onClick={exportCsv}>Download CSV</button>
      </div>
      <div className="grid-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Role</th>
              <th className="num">Paid hours</th>
              <th className="num">Gross pay</th>
              <th className="num">Holiday</th>
              <th className="num">Employer NI</th>
              <th className="num">Pension</th>
              <th className="num">Loaded cost</th>
              <th className="num">Share</th>
              <th className="num">% of sales</th>
            </tr>
          </thead>
          <tbody>
            {report.departments.map((d) => (
              <DepartmentRows key={d.department} label={DEPARTMENTS[d.department]} many={d.roles.length > 1} total={<Cells c={d} />}>
                {d.roles.map((r) => (
                  <tr key={r.roleId}>
                    <td>
                      {roleName(r.roleId)}
                      {r.unrostered > 0 && <span className="tag" title="Paid but not rostered this week: salaried or guaranteed hours">{money(r.unrostered)} not rostered</span>}
                    </td>
                    <Cells c={r} />
                  </tr>
                ))}
              </DepartmentRows>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th>Total</th>
              <Cells c={report} strong />
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

function DepartmentRows({ label, many, total, children }: { label: string; many: boolean; total: JSX.Element; children: JSX.Element[] }) {
  return (
    <>
      <tr className="entity-head">
        <th colSpan={9}>{label}</th>
      </tr>
      {children}
      {many && (
        <tr className="subtotal">
          <td>Total {label.toLowerCase()}</td>
          {total}
        </tr>
      )}
    </>
  );
}

function VsActual({ state, siteIds, week, today, scopeName }: Props) {
  const [entries, setEntries] = useState<TimeEntry[] | null>(null);
  const end = addDays(week, 6);

  useEffect(() => {
    let live = true;
    setEntries(null);
    api
      .get<TimeEntry[]>(`/v1/time-entries?from=${week}&to=${end}`)
      .then((list) => live && setEntries(list))
      .catch(() => live && setEntries([]));
    return () => { live = false; };
  }, [week, end]);

  const report = useMemo(() => (entries ? rotaVsActual(state, entries, siteIds, week, today) : null), [state, entries, siteIds, week, today]);
  const siteName = (id: string) => state.sites.find((s) => s.id === id)?.name ?? id;
  const personName = (id: string) => state.employees.find((e) => e.id === id)?.name ?? id;
  const tone = (n: number) => (Math.abs(n) < 0.5 ? '' : n > 0 ? 'bad-text' : 'good-text');

  if (week > today) return <p className="muted">This week has not started, so there is nothing worked to compare yet.</p>;
  if (!report) return <p className="muted">Loading</p>;

  const people = report.people.filter((p) => p.rosteredHours || p.clockedHours || p.costVariance || p.noShows || p.unrostered);
  const nothingClocked = people.every((p) => p.clockedHours === 0);
  const to = dayLabel(report.workedTo);

  function exportCsv() {
    const header = ['Name', 'Rostered hours to date', 'Clocked hours to date', 'Hours variance', 'Cost variance on the week', 'Not clocked', 'Unrostered days'];
    const rows = people.map((p) => [personName(p.employeeId), p.rosteredHours, p.clockedHours, p.hoursVariance, p.costVariance, p.noShows, p.unrostered]);
    download(`preshift-rota-vs-actual-${slug(scopeName)}-${week}.csv`, csv([header, ...rows]));
  }

  return (
    <>
      <div className="close-actions report-actions">
        <span className="muted small">
          Worked to {to.short} {to.date}{report.workedTo < end ? ', the rota after that' : ''}.
          {report.awaitingApproval > 0 && ` ${report.awaitingApproval} entries are waiting for approval and are included.`}
          {report.stillOpen > 0 && ` ${report.stillOpen} people are still clocked in, so their rota stands for now.`}
        </span>
        <button onClick={exportCsv} disabled={people.length === 0}>Download CSV</button>
      </div>

      {nothingClocked && (
        <div className="notice">Nothing has been clocked for this week yet, so any rostered shift on a day already past shows as not worked. Clock in on the Clock in tab, or simulate clocking on the Payroll tab in the demo.</div>
      )}

      <div className="grid-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Site</th>
              <th className="num">Forecast sales</th>
              <th className="num">Rota cost</th>
              <th className="num">Latest estimate</th>
              <th className="num">Variance</th>
              <th className="num">Rota %</th>
              <th className="num">Estimate %</th>
            </tr>
          </thead>
          <tbody>
            {report.sites.map((s) => (
              <tr key={s.siteId}>
                <td>{siteName(s.siteId)}</td>
                <td className="num">{money(s.forecastSales)}</td>
                <td className="num">{money(s.rotaCost)}</td>
                <td className="num">{money(s.estimateCost)}</td>
                <td className={`num ${tone(s.costVariance)}`}>{signed(s.costVariance, money)}</td>
                <td className="num">{pct(s.rotaPct)}</td>
                <td className={`num ${tone(s.costVariance)}`}>{pct(s.estimatePct)}</td>
              </tr>
            ))}
          </tbody>
          {report.sites.length > 1 && (
            <tfoot>
              <tr>
                <th>Total</th>
                <td className="num strong">{money(report.forecastSales)}</td>
                <td className="num strong">{money(report.rotaCost)}</td>
                <td className="num strong">{money(report.estimateCost)}</td>
                <td className={`num strong ${tone(report.costVariance)}`}>{signed(report.costVariance, money)}</td>
                <td className="num strong">{pct(report.rotaPct)}</td>
                <td className="num strong">{pct(report.estimatePct)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="grid-wrap report-block">
        <div className="entity-journal-head">
          <h3>By person</h3>
          <span className="muted small">Hours to date. Largest cost variance first: that is where the conversation with the GM starts.</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="num">Rostered</th>
              <th className="num">Clocked</th>
              <th className="num">Hours</th>
              <th className="num">Cost variance</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.employeeId}>
                <td>{personName(p.employeeId)}</td>
                <td className="num">{hours(p.rosteredHours)}</td>
                <td className="num">{hours(p.clockedHours)}</td>
                <td className={`num ${tone(p.hoursVariance)}`}>{signed(p.hoursVariance, hours)}</td>
                <td className={`num ${tone(p.costVariance)}`}>{Math.abs(p.costVariance) < 0.5 ? money(0) : signed(p.costVariance, money)}</td>
                <td>
                  {p.noShows > 0 && <span className="tag bad">{p.noShows} not clocked</span>}
                  {p.unrostered > 0 && <span className="tag">{p.unrostered} unrostered</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
