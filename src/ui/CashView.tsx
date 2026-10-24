import { useCallback, useEffect, useState } from 'react';
import { CASH_LABEL, type CashBasis, type CashCalendar, type CashItem } from '../engine/cashflow';
import type { PaySchedule } from '../engine/types';
import { api } from './api';
import { dayLabel, download, ledger, money } from './format';

// Labour cash: what each company pays out for its people, and when. Net pay on each pay day, PAYE and
// NI to HMRC by the 22nd, pensions by the 22nd of the month after deduction. The accrual says what
// labour cost; this says when the bank account feels it. The figures are worked in src/engine/cashflow.ts.

interface Calendar extends CashCalendar {
  entities: { id: string; name: string; paySchedule: PaySchedule; scheduleSet: boolean }[];
}

const BASIS_LABEL: Record<CashBasis, string> = { worked: 'Worked', rota: 'Rota', salary: 'Salary', 'run-rate': 'Run rate' };
const FREQUENCY_LABEL: Record<PaySchedule['frequency'], string> = { weekly: 'Weekly', fortnightly: 'Fortnightly', 'four-weekly': 'Four-weekly', monthly: 'Monthly' };

const day = (iso: string) => {
  const d = dayLabel(iso);
  return `${d.short} ${d.date}`;
};
const span = (i: CashItem) => (i.kind === 'net-pay' ? `${day(i.covers.from)} to ${day(i.covers.to)}` : i.kind === 'hmrc' ? `Tax month ${day(i.covers.from)} to ${day(i.covers.to)}` : `Deducted in ${new Date(`${i.covers.from}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })}`);

export function CashView({ canSettings }: { canSettings: boolean }) {
  const [data, setData] = useState<Calendar | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entityId, setEntityId] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(await api.get<Calendar>(`/v1/finance/cash-calendar?weeks=13${entityId ? `&entityIds=${entityId}` : ''}`));
  }, [entityId]);
  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [load]);

  if (error) return <p className="bad-text">{error}</p>;
  if (!data) return <p className="muted">Loading</p>;

  const name = (id: string) => data.entities.find((e) => e.id === id)?.name ?? id;
  // The next date each kind of payment falls on, with everything due that day added together.
  const next = (kind: CashItem['kind']) => {
    const first = data.items.find((i) => i.kind === kind);
    if (!first) return undefined;
    const same = data.items.filter((i) => i.kind === kind && i.date === first.date);
    return { date: first.date, amount: same.reduce((n, i) => n + i.amount, 0), companies: new Set(same.map((i) => i.entityId)) };
  };
  const who = (n: { companies: Set<string> }) => (n.companies.size > 1 ? `, ${n.companies.size} companies` : many ? `, ${name([...n.companies][0])}` : '');
  const nextPay = next('net-pay');
  const nextHmrc = next('hmrc');
  const nextPension = next('pension');
  const peak = data.weeks.reduce((best, w) => (w.total > best.total ? w : best), data.weeks[0]);
  const many = !entityId && data.entities.length > 1;

  async function exportCsv() {
    const csv = await api.get<string>(`/v1/finance/cash-calendar.csv?weeks=13${entityId ? `&entityIds=${entityId}` : ''}`);
    download(`labour-cash-${data!.from}.csv`, csv);
  }

  return (
    <div className="cash">
      <p className="muted small">
        What each company pays out for its people over the next 13 weeks, and when. Net pay leaves on pay day; PAYE and NI go to HMRC by
        the 22nd of the month after the tax month; pension contributions reach the provider by the 22nd of the month after they were
        deducted. A strong week on the rota is a larger HMRC bill about six weeks later.
      </p>

      {data.entities.length > 1 && (
        <div className="segmented cash-entities" role="group" aria-label="Company">
          <button className={entityId === '' ? 'active' : ''} onClick={() => setEntityId('')}>All companies</button>
          {data.entities.map((e) => (
            <button key={e.id} className={entityId === e.id ? 'active' : ''} onClick={() => setEntityId(e.id)}>{e.name}</button>
          ))}
        </div>
      )}

      <div className="kpis people-kpis">
        <div className="kpi">
          <div className="kpi-label">Next 13 weeks</div>
          <div className="kpi-value">{money(data.totals.total)}</div>
          <div className="kpi-hint">Net pay {money(data.totals['net-pay'])}, HMRC {money(data.totals.hmrc)}, pensions {money(data.totals.pension)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Next pay day</div>
          <div className="kpi-value">{nextPay ? money(nextPay.amount) : 'None'}</div>
          <div className="kpi-hint">{nextPay ? `${day(nextPay.date)}${who(nextPay)}` : 'No pay due in the window'}</div>
        </div>
        <div className="kpi warn">
          <div className="kpi-label">Next HMRC payment</div>
          <div className="kpi-value">{nextHmrc ? money(nextHmrc.amount) : 'None'}</div>
          <div className="kpi-hint">{nextHmrc ? `By ${day(nextHmrc.date)}${who(nextHmrc)}` : 'Nothing due in the window'}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Heaviest week</div>
          <div className="kpi-value">{money(peak.total)}</div>
          <div className="kpi-hint">Week of {day(peak.weekStart)}{nextPension ? `. Next pension ${money(nextPension.amount)} by ${day(nextPension.date)}` : ''}</div>
        </div>
      </div>

      <div className="people-bar">
        <h3 className="section-title">Week by week</h3>
        <div className="people-actions">
          <button onClick={() => void exportCsv()} disabled={data.items.length === 0}>Cash CSV</button>
        </div>
      </div>
      <div className="grid-wrap">
        <table className="table ledger-table cash-weeks">
          <thead>
            <tr><th>Week of</th><th className="num">Net pay</th><th className="num">HMRC</th><th className="num">Pensions</th><th className="num">Total</th><th className="num">Running total</th></tr>
          </thead>
          <tbody>
            {data.weeks.map((w) => (
              <tr key={w.weekStart}>
                <td>{day(w.weekStart)}</td>
                <td className="num">{w.byKind['net-pay'] ? ledger(w.byKind['net-pay']) : ''}</td>
                <td className="num">{w.byKind.hmrc ? ledger(w.byKind.hmrc) : ''}</td>
                <td className="num">{w.byKind.pension ? ledger(w.byKind.pension) : ''}</td>
                <td className="num strong">{w.total ? ledger(w.total) : ''}</td>
                <td className="num muted">{ledger(w.cumulative)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="total">
              <td>13 weeks</td>
              <td className="num">{ledger(data.totals['net-pay'])}</td>
              <td className="num">{ledger(data.totals.hmrc)}</td>
              <td className="num">{ledger(data.totals.pension)}</td>
              <td className="num">{ledger(data.totals.total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <h3 className="section-title">Payments</h3>
      <div className="grid-wrap">
        <table className="table cash-items">
          <thead>
            <tr><th>Date</th>{many && <th>Company</th>}<th>Payment</th><th>Covers</th><th>Basis</th><th className="num">Amount</th></tr>
          </thead>
          <tbody>
            {data.items.map((i) => {
              const expanded = open === i.id;
              return [
                <tr key={i.id} className={i.parts ? 'clickable' : undefined} tabIndex={i.parts ? 0 : undefined} aria-expanded={i.parts ? expanded : undefined}
                  onClick={() => i.parts && setOpen(expanded ? null : i.id)} onKeyDown={(ev) => { if (i.parts && ev.key === 'Enter') setOpen(expanded ? null : i.id); }}>
                  <td>{day(i.date)}</td>
                  {many && <td className="muted">{name(i.entityId)}</td>}
                  <td className={i.kind === 'hmrc' ? 'strong' : undefined}>{CASH_LABEL[i.kind]}</td>
                  <td className="small">{span(i)}<span className="muted">, {i.people} {i.people === 1 ? 'person' : 'people'}</span></td>
                  <td>{i.bases.map((b) => <span key={b} className={`badge ${b === 'run-rate' ? 'warn' : b === 'worked' ? 'good' : ''}`}>{BASIS_LABEL[b]}</span>)}</td>
                  <td className="num">{ledger(i.amount)}</td>
                </tr>,
                expanded && i.parts && (
                  <tr key={`${i.id}-parts`} className="onboarding-detail">
                    <td colSpan={many ? 6 : 5}>
                      <dl className="facts cash-parts">
                        <dt>Income tax</dt><dd>{ledger(i.parts.tax)}</dd>
                        <dt>Employee NI</dt><dd>{ledger(i.parts.employeeNi)}</dd>
                        <dt>Employer NI</dt><dd>{ledger(i.parts.employerNi)}</dd>
                        {i.parts.allowance > 0 && (<><dt>Employment Allowance</dt><dd>({ledger(i.parts.allowance).replace(/[()]/g, '')})</dd></>)}
                        <dt className="strong">Due to HMRC</dt><dd className="strong">{ledger(i.amount)}</dd>
                      </dl>
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>

      <h3 className="section-title">How it is worked</h3>
      <ul className="muted small cash-notes">
        {data.notes.map((n) => <li key={n}>{n}</li>)}
        <li>Pay is costed as the labour accrual costs it: approved clocked time for weeks gone where there is any, the rota otherwise, and each person's last four weeks for weeks not yet rostered. Holiday pay is taken as paid when earned.</li>
        <li>Deductions use the standard 1257L code at rest of UK rates, worked period by period. Scottish and Welsh rates, other tax codes, student loans and salary sacrifice move the real figure; the pay run is the record.</li>
        <li>Pensions assume relief at source: employer 3% and employee 4% of qualifying earnings reach the provider. HMRC payments are due by the 22nd for electronic payment, moved to the working day before at a weekend or bank holiday. Quarterly payers pay less often.</li>
      </ul>

      {canSettings && <PaySchedules entities={data.entities} onSaved={load} />}
    </div>
  );
}

function PaySchedules({ entities, onSaved }: { entities: Calendar['entities']; onSaved: () => Promise<void> }) {
  const [drafts, setDrafts] = useState<Record<string, PaySchedule>>(() => Object.fromEntries(entities.map((e) => [e.id, e.paySchedule])));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const set = (id: string, patch: Partial<PaySchedule>) => setDrafts({ ...drafts, [id]: { ...drafts[id], ...patch } });

  async function save(id: string) {
    setBusy(true);
    setMessage(null);
    try {
      const d = drafts[id];
      const body: PaySchedule = d.frequency === 'monthly'
        ? { frequency: 'monthly', monthlyPayDay: d.monthlyPayDay ?? 'last-working' }
        : { frequency: d.frequency, payLagDays: d.payLagDays ?? 5, ...(d.frequency !== 'weekly' && d.anchor ? { anchor: d.anchor } : {}) };
      await api.put(`/v1/entities/${id}/pay-schedule`, body);
      await onSaved();
      setMessage({ text: `Saved. Pay days for ${entities.find((e) => e.id === id)?.name} are worked from it now.` });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), bad: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-card cash-schedules">
      <h2>Pay schedules</h2>
      <p className="muted small">When each company pays. Each PAYE scheme can pay on its own timetable.</p>
      {entities.map((e) => {
        const d = drafts[e.id];
        return (
          <form key={e.id} className="settings-form" onSubmit={(ev) => { ev.preventDefault(); void save(e.id); }}>
            <label className="strong">{e.name}{!e.scheduleSet && <span className="badge warn">Not set</span>}</label>
            <label>
              Paid
              <select value={d.frequency} onChange={(ev) => set(e.id, { frequency: ev.target.value as PaySchedule['frequency'] })}>
                {Object.entries(FREQUENCY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            {d.frequency === 'monthly' ? (
              <label>
                Pay day
                <select value={String(d.monthlyPayDay ?? 'last-working')} onChange={(ev) => set(e.id, { monthlyPayDay: ev.target.value === 'last-working' ? 'last-working' : Number(ev.target.value) })}>
                  <option value="last-working">Last working day</option>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            ) : (
              <>
                <label>
                  Days after the period ends
                  <input type="number" min={0} max={31} value={d.payLagDays ?? 5} onChange={(ev) => set(e.id, { payLagDays: Number(ev.target.value) })} />
                </label>
                {d.frequency !== 'weekly' && (
                  <label>
                    A Monday a period starts
                    <input type="date" value={d.anchor ?? '2026-04-06'} onChange={(ev) => set(e.id, { anchor: ev.target.value })} />
                  </label>
                )}
              </>
            )}
            <button type="submit" disabled={busy}>Save</button>
          </form>
        );
      })}
      <p className="muted small">Five days after a Monday to Sunday week is the Friday after it. A pay day at a weekend or bank holiday moves to the working day before. A new schedule applies to every period, so in the month you change it, check the first pay day against what the last pay run already covered.</p>
      {message && <p className={`small ${message.bad ? 'bad-text' : 'good-text'}`}>{message.text}</p>}
    </section>
  );
}
