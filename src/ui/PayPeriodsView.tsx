import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FREQUENCY_LABEL, SCHEDULE_PRESETS, type PayFrequency, type PayPeriod, type PaySchedule, type TimeCard } from '../engine/payPeriods';
import type { RotaState } from '../engine/types';
import { api, ApiError } from './api';
import { hours } from './format';
import { NOT_YOURS, type Allow } from './permissions';

interface Pass { at: string; by: string; version: number; late: boolean; hours: number; entries: number; reason?: string }
interface Summary {
  id: string;
  entityId: string;
  entityName: string;
  scheduleId: string;
  scheduleName: string;
  frequency: PayFrequency;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  cutoffAt: string;
  status: 'open' | 'rota_locked' | 'ready' | 'passed' | 'changed';
  overdue: boolean;
  ended: boolean;
  rotaLock?: { at: string; by: string };
  lastPass?: Pass;
  people: number;
  cards: { total: number; approved: number; waiting: number; clockedIn: number; noTime: number };
  hours: { rostered: number; clocked: number; approved: number };
}
interface Detail extends Summary {
  timeCards: TimeCard[];
  history: { at: string; by: string; action: string; detail?: Record<string, unknown> }[];
}
type Schedule = PaySchedule & { people: number; upcoming: PayPeriod[] };
interface CompanySchedules { entityId: string; name: string; custom: boolean; schedules: Schedule[] }

interface Props {
  state: RotaState;
  today: string;
  allow: Allow;
  onChanged: () => Promise<void>;
}

const STATUS: Record<Summary['status'], { label: string; tone: string }> = {
  open: { label: 'Rota open', tone: 'warn' },
  rota_locked: { label: 'Rota locked, cards waiting', tone: 'warn' },
  ready: { label: 'Ready to pass', tone: 'good' },
  passed: { label: 'Passed to payroll', tone: 'good' },
  changed: { label: 'Changed since passed', tone: 'bad' },
};

const CARD: Record<TimeCard['status'], { label: string; tone: string }> = {
  no_time: { label: 'No time', tone: 'warn' },
  clocked_in: { label: 'Still clocked in', tone: 'bad' },
  waiting: { label: 'Waiting', tone: 'warn' },
  approved: { label: 'Approved', tone: 'good' },
};

const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const instant = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
const payrollKey = (p: { entityId: string; scheduleId: string }) => `${p.entityId}~${p.scheduleId}`;

/**
 * The pay period close, payroll by payroll: lock the rota, approve each person's time card against it,
 * then pass the hours to payroll by the cutoff. Below it, each company's pay calendars.
 */
export function PayPeriodsView({ state, today, allow, onChanged }: Props) {
  const [periods, setPeriods] = useState<Summary[] | null>(null);
  const [payroll, setPayroll] = useState<string>('');
  const [periodId, setPeriodId] = useState<string>('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');

  const loadPeriods = useCallback(async () => {
    const list = await api.get<Summary[]>(`/v1/pay-periods?date=${today}&previous=6`);
    setPeriods(list);
    return list;
  }, [today]);

  useEffect(() => {
    void loadPeriods().then((list) => {
      // Open on the most pressing period: the latest finished one not yet passed, otherwise the current one.
      const pressing = list.find((p) => p.ended && p.status !== 'passed') ?? list[0];
      if (pressing) {
        setPayroll(payrollKey(pressing));
        setPeriodId(pressing.id);
      }
    });
  }, [loadPeriods]);

  const selected = periods?.find((p) => p.id === periodId);
  const path = selected ? `/v1/pay-periods/${selected.entityId}/${selected.scheduleId}/${selected.periodStart}` : '';
  const loadDetail = useCallback(async () => {
    setDetail(path ? await api.get<Detail>(path) : null);
  }, [path]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const payrolls = useMemo(() => {
    const seen = new Map<string, Summary>();
    for (const p of periods ?? []) if (!seen.has(payrollKey(p))) seen.set(payrollKey(p), p);
    return [...seen.values()];
  }, [periods]);
  const periodsOf = (periods ?? []).filter((p) => payrollKey(p) === payroll);

  async function step(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      setMessage({ text: `${label}: done` });
      setReason('');
    } catch (e) {
      setMessage({ text: e instanceof ApiError ? `${label}: ${e.message}` : `${label} failed`, bad: true });
    }
    await loadPeriods();
    await loadDetail();
    await onChanged();
    setBusy(false);
  }

  const name = (id: string) => state.employees.find((e) => e.id === id)?.name ?? id;
  const base = path;
  const locks = allow('time.lock');
  const approves = allow('time.approve');
  const sends = allow('payroll.send');
  const d = detail && detail.id === selected?.id ? detail : null;
  const passed = !!d?.lastPass;

  return (
    <div className="payroll pay-periods">
      <div className="period-bar">
        <label>
          Payroll
          <select
            value={payroll}
            onChange={(e) => {
              setPayroll(e.target.value);
              setPeriodId((periods ?? []).find((p) => payrollKey(p) === e.target.value)?.id ?? '');
            }}
          >
            {payrolls.map((p) => (
              <option key={payrollKey(p)} value={payrollKey(p)}>
                {payrolls.filter((x) => x.entityId === p.entityId).length > 1 || new Set(payrolls.map((x) => x.entityId)).size > 1 ? `${p.entityName}: ` : ''}
                {p.scheduleName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Period
          <select value={periodId} onChange={(e) => setPeriodId(e.target.value)}>
            {periodsOf.map((p) => (
              <option key={p.id} value={p.id}>
                {day(p.periodStart)} to {day(p.periodEnd)} · {STATUS[p.status].label}
                {p.overdue ? ' · overdue' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      {periods && periods.length === 0 && <p className="muted">No payrolls you can see.</p>}

      {selected && (
        <>
          <p className="period-dates">
            <strong>{FREQUENCY_LABEL[selected.frequency]}</strong>: hours {day(selected.periodStart)} to {day(selected.periodEnd)}. Rota locked,
            cards approved and hours passed by <strong>{instant(selected.cutoffAt)}</strong>. Payday <strong>{day(selected.payDate)}</strong>.{' '}
            <span className={`badge ${STATUS[selected.status].tone}`}>{STATUS[selected.status].label}</span>{' '}
            {selected.overdue && <span className="badge bad">Past cutoff</span>}
          </p>

          <section className="pipeline three">
            <Step n={1} title="Lock the rota" done={!!selected.rotaLock}>
              <div>
                {selected.rotaLock
                  ? `Locked by ${selected.rotaLock.by}, ${instant(selected.rotaLock.at)}`
                  : `${selected.people} people on this payroll. Locking freezes their shifts in the period.`}
              </div>
              {!selected.rotaLock ? (
                <button disabled={busy || !locks} title={locks ? undefined : NOT_YOURS} onClick={() => step('Lock rota', () => api.post(`${base}/lock-rota`))}>
                  Lock rota
                </button>
              ) : (
                !passed && (
                  <button
                    disabled={busy || !locks || reason.trim().length < 5}
                    title={!locks ? NOT_YOURS : reason.trim().length < 5 ? 'Give a reason below first' : undefined}
                    onClick={() => step('Unlock rota', () => api.post(`${base}/unlock-rota`, { reason: reason.trim() }))}
                  >
                    Unlock (with reason)
                  </button>
                )
              )}
            </Step>
            <Step n={2} title="Approve time cards" done={selected.cards.total > 0 && selected.cards.approved === selected.cards.total - selected.cards.noTime}>
              <div>
                {selected.cards.approved} of {selected.cards.total} approved
                {selected.cards.waiting ? `, ${selected.cards.waiting} waiting` : ''}
                {selected.cards.clockedIn ? `, ${selected.cards.clockedIn} still clocked in` : ''}
              </div>
              <div className="muted small">
                Rostered {hours(selected.hours.rostered)}, clocked {hours(selected.hours.clocked)}
              </div>
              <button
                disabled={busy || !approves || !selected.rotaLock || selected.cards.waiting === 0}
                title={!approves ? NOT_YOURS : !selected.rotaLock ? 'Lock the rota first' : 'Your own hours are left for someone else'}
                onClick={() => step('Approve time cards', () => api.post(`${base}/approve`, {}))}
              >
                Approve all waiting
              </button>
            </Step>
            <Step n={3} title="Pass to payroll" done={selected.status === 'passed'}>
              <div>
                {selected.lastPass
                  ? `v${selected.lastPass.version} passed by ${selected.lastPass.by}, ${instant(selected.lastPass.at)}, ${hours(selected.lastPass.hours)}${selected.lastPass.late ? ' (late)' : ''}`
                  : selected.ended
                    ? 'Not passed'
                    : `Can be passed from ${day(addDay(selected.periodEnd))}`}
              </div>
              <button
                className="primary"
                disabled={busy || !sends || !selected.ended || selected.status === 'open' || selected.status === 'rota_locked' || selected.status === 'passed' || (passed && reason.trim().length < 5)}
                title={!sends ? NOT_YOURS : passed ? 'A correction needs a reason below' : undefined}
                onClick={() => step(passed ? 'Pass correction' : 'Pass to payroll', () => api.post(`${base}/pass`, passed ? { reason: reason.trim() } : {}))}
              >
                {passed ? 'Pass correction' : 'Pass to payroll'}
              </button>
            </Step>
          </section>

          {(selected.rotaLock && !passed) || selected.status === 'changed' ? (
            <label className="reason">
              Reason, for an unlock or a correction (kept on the period)
              <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="For example: sickness cover added for Thursday" />
            </label>
          ) : null}
          {message && <div className={`notice ${message.bad ? 'error' : ''}`}>{message.text}</div>}

          <div className="grid-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Time card</th>
                  <th className="num">Rostered</th>
                  <th className="num">Clocked</th>
                  <th className="num">Difference</th>
                  <th className="num">Approved</th>
                  <th>Check</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {!d && <tr><td colSpan={8} className="muted">Loading...</td></tr>}
                {d && d.timeCards.length === 0 && <tr><td colSpan={8} className="muted">Nobody rostered or clocked in this period.</td></tr>}
                {d?.timeCards.map((c) => (
                  <tr key={c.employeeId}>
                    <td>{name(c.employeeId)}{c.salaried && <span className="muted small"> salaried</span>}</td>
                    <td className="num">{hours(c.rosteredHours)}</td>
                    <td className="num">{hours(c.clockedHours)}</td>
                    <td className={`num ${Math.abs(c.variance) > 0.25 ? 'bad-text' : ''}`}>{c.variance > 0 ? '+' : ''}{hours(c.variance)}</td>
                    <td className="num">{hours(c.approvedHours)}</td>
                    <td className="small">
                      {[c.notClocked ? `${c.notClocked} shift${c.notClocked > 1 ? 's' : ''} not clocked` : '', c.unrostered ? `${c.unrostered} unrostered` : '']
                        .filter(Boolean)
                        .join(', ') || <span className="muted">Clear</span>}
                    </td>
                    <td><span className={`badge ${CARD[c.status].tone}`}>{CARD[c.status].label}</span></td>
                    <td>
                      {c.status === 'waiting' && (
                        <button
                          className="link"
                          disabled={busy || !approves || !selected.rotaLock}
                          onClick={() => step(`Approve ${name(c.employeeId)}`, () => api.post(`${base}/approve`, { employeeIds: [c.employeeId] }))}
                        >
                          Approve
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {d && d.history.length > 0 && (
            <details className="period-history">
              <summary>History of this period</summary>
              <ul>
                {d.history.map((h, i) => (
                  <li key={i}>
                    {instant(h.at)}: {h.by} {ACTION[h.action] ?? h.action}
                    {typeof h.detail?.reason === 'string' ? `: "${h.detail.reason}"` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      <PayCalendars state={state} allow={allow} onSaved={async () => { await loadPeriods(); await onChanged(); }} />
    </div>
  );
}

const ACTION: Record<string, string> = {
  rota_locked: 'locked the rota',
  rota_unlocked: 'unlocked the rota',
  timecards_approved: 'approved time cards',
  passed: 'passed the hours to payroll',
};

const addDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <div className={`step ${done ? 'done' : ''}`}>
      <div className="step-head">
        <span className="step-n">{done ? '✓' : n}</span>
        <strong>{title}</strong>
      </div>
      <div className="step-body">{children}</div>
    </div>
  );
}

/** Each company's pay calendars, with the next paydays, and who is paid on which. */
function PayCalendars({ state, allow, onSaved }: { state: RotaState; allow: Allow; onSaved: () => Promise<void> }) {
  const [companies, setCompanies] = useState<CompanySchedules[]>([]);
  const [editing, setEditing] = useState<{ entityId: string; schedules: PaySchedule[] } | null>(null);
  const [preview, setPreview] = useState<Record<number, { problems: string[]; upcoming: PayPeriod[] }>>({});
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  // Who was moved here, shown at once rather than waiting for the team to be read again.
  const [placed, setPlaced] = useState<Record<string, string>>({});
  const manages = allow('settings.manage');
  const moves = allow('payroll.send');

  const load = useCallback(async () => setCompanies(await api.get<CompanySchedules[]>('/v1/pay-schedules')), []);
  useEffect(() => {
    void load();
  }, [load]);

  const strip = ({ people: _p, upcoming: _u, ...s }: Schedule): PaySchedule => s;
  const change = (i: number, patch: Partial<PaySchedule>) => {
    if (!editing) return;
    const schedules = editing.schedules.map((s, j) => (j === i ? { ...s, ...patch } : s));
    setEditing({ ...editing, schedules });
    void api.post<{ problems: string[]; upcoming: PayPeriod[] }>('/v1/pay-schedules/preview', { schedule: schedules[i] })
      .then((r) => setPreview((p) => ({ ...p, [i]: r })))
      .catch((e) => setPreview((p) => ({ ...p, [i]: { problems: [e instanceof ApiError ? e.message : 'Not valid'], upcoming: [] } })));
  };
  const add = (frequency: PayFrequency) => {
    if (!editing) return;
    const taken = new Set(editing.schedules.map((s) => s.id));
    let id: string = frequency.replace('_', '-');
    for (let n = 2; taken.has(id); n++) id = `${frequency.replace('_', '-')}-${n}`;
    setEditing({ ...editing, schedules: [...editing.schedules, { id, name: FREQUENCY_LABEL[frequency], ...SCHEDULE_PRESETS[frequency] }] });
  };
  const save = async () => {
    if (!editing) return;
    try {
      await api.put(`/v1/entities/${editing.entityId}/pay-schedules`, { schedules: editing.schedules });
      setMessage({ text: 'Pay calendars saved' });
      setEditing(null);
      setPreview({});
      await load();
      await onSaved();
    } catch (e) {
      setMessage({ text: e instanceof ApiError ? e.message : 'Could not save', bad: true });
    }
  };
  const move = async (employeeId: string, scheduleId: string) => {
    try {
      await api.put(`/v1/employees/${employeeId}/pay-schedule`, { scheduleId });
      setPlaced((p) => ({ ...p, [employeeId]: scheduleId }));
      setMessage({ text: `${state.employees.find((e) => e.id === employeeId)?.name} moved` });
      await load();
      await onSaved();
    } catch (e) {
      setMessage({ text: e instanceof ApiError ? e.message : 'Could not move', bad: true });
    }
  };

  return (
    <section className="pay-calendars">
      <h3>Pay calendars</h3>
      <p className="muted small">
        Each company sets its own payrolls. Every period, cutoff and payday is worked out from these settings, with paydays moved
        to the working day before a weekend or bank holiday. A company that sets none runs weekly, Monday to Sunday, paid the Friday after.
      </p>
      {message && <div className={`notice ${message.bad ? 'error' : ''}`}>{message.text}</div>}
      {companies.map((c) => (
        <div key={c.entityId} className="grid-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{c.name}</th>
                <th>Frequency</th>
                <th className="num">People</th>
                <th>Next periods (hours, cutoff, payday)</th>
              </tr>
            </thead>
            <tbody>
              {c.schedules.map((s, i) => (
                <tr key={s.id}>
                  <td>{s.name}{i === 0 && <span className="muted small"> default</span>}</td>
                  <td>{FREQUENCY_LABEL[s.frequency]}</td>
                  <td className="num">{s.people}</td>
                  <td className="small">
                    {s.upcoming.slice(0, 3).map((p) => (
                      <div key={p.periodStart}>{day(p.periodStart)} to {day(p.periodEnd)}, due {day(p.cutoffDate)} {p.cutoffTime}, paid {day(p.payDate)}</div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {manages && editing?.entityId !== c.entityId && (
            <button onClick={() => { setEditing({ entityId: c.entityId, schedules: c.schedules.map(strip) }); setPreview({}); }}>Edit {c.name}'s pay calendars</button>
          )}
          {editing?.entityId === c.entityId && (
            <div className="schedule-editor">
              {editing.schedules.map((s, i) => (
                <fieldset key={i}>
                  <legend>{i === 0 ? 'Default payroll' : `Payroll ${i + 1}`}</legend>
                  <label>Name <input value={s.name} onChange={(e) => change(i, { name: e.target.value })} /></label>
                  <label>
                    Frequency
                    <select value={s.frequency} onChange={(e) => change(i, { ...SCHEDULE_PRESETS[e.target.value as PayFrequency], frequency: e.target.value as PayFrequency })}>
                      {(Object.keys(FREQUENCY_LABEL) as PayFrequency[]).map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}
                    </select>
                  </label>
                  {(s.frequency === 'weekly' || s.frequency === 'fortnightly' || s.frequency === 'four_weekly') && (
                    <>
                      <label>First day of any period <input type="date" value={s.anchorDate ?? ''} onChange={(e) => change(i, { anchorDate: e.target.value })} /></label>
                      <label>Paid days after period end <Num value={s.payDaysAfterPeriodEnd ?? 5} onChange={(v) => change(i, { payDaysAfterPeriodEnd: v })} /></label>
                    </>
                  )}
                  {s.frequency === 'monthly' && (
                    <>
                      <label>Hours period ends on day (31 = month end) <Num value={s.periodEndDay ?? 31} onChange={(v) => change(i, { periodEndDay: v })} /></label>
                      <label>Payday (31 = last working day) <Num value={s.payDay ?? 31} onChange={(v) => change(i, { payDay: v })} /></label>
                      <label>
                        Paid in
                        <select value={s.payMonthOffset ?? 0} onChange={(e) => change(i, { payMonthOffset: Number(e.target.value) as 0 | 1 })}>
                          <option value={0}>the month the period ends</option>
                          <option value={1}>the month after</option>
                        </select>
                      </label>
                    </>
                  )}
                  {s.frequency === 'last_friday' && (
                    <label>Hours period ends days before payday (5 = the Sunday) <Num value={s.periodEndDaysBeforePay ?? 5} onChange={(v) => change(i, { periodEndDaysBeforePay: v })} /></label>
                  )}
                  <label>Cutoff, days before payday <Num value={s.cutoffDaysBeforePay} onChange={(v) => change(i, { cutoffDaysBeforePay: v })} /></label>
                  <label>Cutoff time <input type="time" value={s.cutoffTime} onChange={(e) => change(i, { cutoffTime: e.target.value })} /></label>
                  {preview[i]?.problems.map((p) => <div key={p} className="bad-text small">{p}</div>)}
                  {preview[i]?.upcoming.slice(0, 4).map((p) => (
                    <div key={p.periodStart} className="small muted">{day(p.periodStart)} to {day(p.periodEnd)}, due {day(p.cutoffDate)}, paid {day(p.payDate)}</div>
                  ))}
                  {editing.schedules.length > 1 && (
                    <button className="link" onClick={() => setEditing({ ...editing, schedules: editing.schedules.filter((_, j) => j !== i) })}>Remove</button>
                  )}
                </fieldset>
              ))}
              <div className="row">
                Add a payroll:
                {(Object.keys(FREQUENCY_LABEL) as PayFrequency[]).map((f) => <button key={f} className="link" onClick={() => add(f)}>{FREQUENCY_LABEL[f]}</button>)}
              </div>
              <div className="row">
                <button className="primary" onClick={() => void save()}>Save</button>
                <button onClick={() => { setEditing(null); setPreview({}); }}>Cancel</button>
              </div>
            </div>
          )}
          {moves && c.schedules.length > 1 && (
            <details>
              <summary>Who is paid on which payroll</summary>
              <table className="table">
                <tbody>
                  {state.employees.filter((e) => e.entityId === c.entityId && e.status !== 'leaver').map((e) => (
                    <tr key={e.id}>
                      <td>{e.name}</td>
                      <td>
                        <select value={placed[e.id] ?? e.payScheduleId ?? c.schedules[0].id} onChange={(ev) => void move(e.id, ev.target.value)} aria-label={`Payroll for ${e.name}`}>
                          {c.schedules.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </div>
      ))}
    </section>
  );
}

function Num({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return <input type="number" min={0} max={31} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: '5em' }} />;
}
