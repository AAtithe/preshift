import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  REQUEST_KINDS,
  requestOverdue,
  type ProcessingActivity,
  type Processor,
  type RetentionItem,
  type RetentionPolicy,
  type SubjectRequest,
  type SubjectRequestKind,
} from '../engine/gdpr';
import type { Employee, RotaState } from '../engine/types';
import { api, ApiError } from './api';
import { download } from './format';

interface Props {
  state: RotaState;
  /** Holds privacy.manage: the request log, exports, erasure and the retention schedule. */
  canManage: boolean;
  today: string;
  /** Called after anything that changes people's records, so the rest of the app shows it. */
  onChanged: () => Promise<unknown>;
}

type Request = SubjectRequest & { dueOn: string };
type Register = { activities: ProcessingActivity[]; processors: Processor[] };

const problem = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

function csvCell(value: string | number) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CODE_LABEL: Record<RetentionItem['code'], string> = {
  location: 'Clocking location',
  contact: 'Contact details',
  'right-to-work': 'Right to work',
  anonymise: 'Anonymise',
};

/**
 * UK GDPR for staff data in one place: requests people make and their deadlines, what is due to be
 * deleted, and the record of processing an ICO inspection asks for first.
 */
export function PrivacyView({ state, canManage, today, onChanged }: Props) {
  const isAdmin = canManage;
  const [register, setRegister] = useState<Register | null>(null);
  const [retention, setRetention] = useState<{ policy: RetentionPolicy; items: RetentionItem[] } | null>(null);
  const [requests, setRequests] = useState<Request[]>([]);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const [reg, ret, reqs] = await Promise.all([
        api.get<Register>('/v1/privacy/register'),
        isAdmin ? api.get<{ policy: RetentionPolicy; items: RetentionItem[] }>('/v1/privacy/retention') : Promise.resolve(null),
        isAdmin ? api.get<Request[]>('/v1/privacy/requests') : Promise.resolve([]),
      ]);
      setRegister(reg);
      setRetention(ret);
      setRequests(reqs);
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  }, [isAdmin]);
  useEffect(() => void load(), [load]);

  async function act(done: string, fn: () => Promise<unknown>, changesPeople = false) {
    try {
      await fn();
      setMessage({ text: done });
      await load();
      if (changesPeople) await onChanged();
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  }

  const open = requests.filter((r) => r.status === 'open');
  const overdue = open.filter((r) => requestOverdue(r, today));
  const due = retention?.items.filter((i) => i.due) ?? [];
  const locations = register?.activities.find((a) => a.activity === 'Clocking location')?.held ?? 0;

  return (
    <div className="settings privacy">
      <div className="kpis people-kpis">
        <div className={`kpi ${overdue.length ? 'bad' : open.length ? 'warn' : 'good'}`}>
          <div className="kpi-label">Open requests</div>
          <div className="kpi-value">{isAdmin ? open.length : '-'}</div>
          <div className="kpi-hint">{isAdmin ? `${overdue.length} past the one month deadline` : 'Shown to whoever handles staff data requests'}</div>
        </div>
        <div className={`kpi ${due.length ? 'warn' : 'good'}`}>
          <div className="kpi-label">Due for deletion</div>
          <div className="kpi-value">{due.length}</div>
          <div className="kpi-hint">Held past its retention period</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Clocks with a location</div>
          <div className="kpi-value">{locations}</div>
          <div className="kpi-hint">Kept {retention?.policy.locationMonths ?? '-'} months, then removed</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Processors in use</div>
          <div className="kpi-value">{register?.processors.filter((p) => p.active).length ?? '-'}</div>
          <div className="kpi-hint">Each needs an Article 28 contract</div>
        </div>
      </div>

      {message && <div className={`notice ${message.bad ? 'error' : ''}`}>{message.text}</div>}

      {isAdmin && <Requests state={state} requests={requests} today={today} act={act} />}
      {isAdmin && <Subjects state={state} today={today} act={act} />}
      {retention && <Retention retention={retention} isAdmin={isAdmin} act={act} />}
      {register && <RegisterCard register={register} today={today} />}
    </div>
  );
}

type Act = (done: string, fn: () => Promise<unknown>, changesPeople?: boolean) => Promise<void>;

function Requests({ state, requests, today, act }: { state: RotaState; requests: Request[]; today: string; act: Act }) {
  const blank = { kind: 'access' as SubjectRequestKind, employeeId: '', subject: '', receivedOn: today, notes: '' };
  const [form, setForm] = useState(blank);
  const [showClosed, setShowClosed] = useState(false);
  const nameOf = (id?: string) => state.employees.find((e) => e.id === id)?.name;

  async function add(e: FormEvent) {
    e.preventDefault();
    const subject = form.subject.trim() || nameOf(form.employeeId) || '';
    await act(`Logged. The reply is due by the date shown.`, () =>
      api.post('/v1/privacy/requests', {
        kind: form.kind,
        subject,
        receivedOn: form.receivedOn,
        ...(form.employeeId ? { employeeId: form.employeeId } : {}),
        ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
      }),
    );
    setForm(blank);
  }

  const shown = requests.filter((r) => showClosed || r.status === 'open');
  return (
    <section className="settings-card">
      <h2>Requests from people about their data</h2>
      <p className="muted small">
        A request does not need to say GDPR or come in writing: a text to a GM asking for "everything you hold on me" counts. Log it the
        day it arrives. The reply is due one calendar month later; it can be extended by two more months only if it is complex, and the
        person must be told within the first month.
      </p>
      <label className="muted small check-inline">
        <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show closed
      </label>
      <table className="table">
        <thead>
          <tr><th>Received</th><th>Type</th><th>Person</th><th>Reply due</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {shown.length === 0 && (
            <tr><td colSpan={6} className="muted">No {showClosed ? '' : 'open '}requests.</td></tr>
          )}
          {shown.map((r) => (
            <tr key={r.id}>
              <td>{r.receivedOn}</td>
              <td>
                {REQUEST_KINDS[r.kind].label}
                <div className="muted small">{REQUEST_KINDS[r.kind].article}</div>
              </td>
              <td>
                {r.subject}
                {r.notes && <div className="muted small">{r.notes}</div>}
              </td>
              <td>
                {r.dueOn}
                {r.extended && <span className="tag">extended</span>}
                {requestOverdue(r, today) && <span className="tag bad">overdue</span>}
              </td>
              <td>{r.status === 'open' ? 'Open' : `Closed ${r.closedOn ?? ''}`}</td>
              <td className="num">
                {r.status === 'open' && !r.extended && (
                  <button
                    className="link"
                    onClick={() => { if (confirm('Extend by two months? Only for complex or repeated requests, and tell the person why within the first month.')) void act('Deadline extended.', () => api.patch(`/v1/privacy/requests/${r.id}`, { extended: true })); }}
                  >
                    Extend
                  </button>
                )}
                {r.status === 'open' ? (
                  <button className="link" onClick={() => void act('Closed.', () => api.patch(`/v1/privacy/requests/${r.id}`, { status: 'closed' }))}>Close</button>
                ) : (
                  <button className="link" onClick={() => void act('Reopened.', () => api.patch(`/v1/privacy/requests/${r.id}`, { status: 'open' }))}>Reopen</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="settings-form" onSubmit={add}>
        <label>
          Type
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as SubjectRequestKind })}>
            {Object.entries(REQUEST_KINDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <label>
          Person on the records
          <select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
            <option value="">Not on the records</option>
            {[...state.employees].sort((a, b) => a.name.localeCompare(b.name)).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <label>
          Name as given
          <input value={form.subject} placeholder={nameOf(form.employeeId) ?? 'Their name'} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
        </label>
        <label>
          Received
          <input type="date" value={form.receivedOn} max={today} onChange={(e) => setForm({ ...form, receivedOn: e.target.value })} required />
        </label>
        <label>
          Notes
          <input value={form.notes} placeholder="How it came in, ID checked" onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </label>
        <button className="primary" type="submit" disabled={!form.subject.trim() && !form.employeeId}>Log request</button>
      </form>
    </section>
  );
}

function Subjects({ state, today, act }: { state: RotaState; today: string; act: Act }) {
  const [employeeId, setEmployeeId] = useState('');
  const person: Employee | undefined = state.employees.find((e) => e.id === employeeId);
  const left = Boolean(person?.leaveDate && person.leaveDate < today);

  async function exportData() {
    if (!person) return;
    await act(`Exported everything held on ${person.name}. Check it, remove anything about other people, and send it securely.`, async () => {
      const bundle = await api.post<unknown>(`/v1/privacy/subjects/${person.id}/export`);
      download(`data-${person.id}-${today}.json`, JSON.stringify(bundle, null, 2), 'application/json');
    });
  }

  function erase() {
    if (!person) return;
    if (!confirm(`Erase ${person.name}'s contact details, availability, card, staff login and clocking locations? This cannot be undone. Pay and right to work records stay until their retention period ends.`)) return;
    void act(`Erased what the law lets us erase for ${person.name}.`, () => api.post(`/v1/privacy/subjects/${person.id}/erase`), true);
  }

  return (
    <section className="settings-card">
      <h2>Answer a request</h2>
      <p className="muted small">
        Access and portability: export everything held on the person, with how it is used and their rights, ready to send. Erasure: for
        leavers only. What the law makes us keep (pay records, right to work) stays until its retention date, and the reply should say so.
        Current staff need their record to be employed and paid; correct it in People instead.
      </p>
      <div className="settings-form">
        <label>
          Person
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Choose someone</option>
            {[...state.employees].sort((a, b) => a.name.localeCompare(b.name)).map((e) => (
              <option key={e.id} value={e.id}>{e.name}{e.leaveDate && e.leaveDate < today ? ' (left)' : ''}</option>
            ))}
          </select>
        </label>
        <button disabled={!person} onClick={() => void exportData()}>Export their data</button>
        <button className="danger" disabled={!person || !left} title={person && !left ? 'Only for people who have left' : undefined} onClick={erase}>
          Erase what we can
        </button>
      </div>
    </section>
  );
}

function Retention({ retention, isAdmin, act }: { retention: { policy: RetentionPolicy; items: RetentionItem[] }; isAdmin: boolean; act: Act }) {
  const [policy, setPolicy] = useState(retention.policy);
  useEffect(() => setPolicy(retention.policy), [retention.policy]);
  const due = retention.items.filter((i) => i.due);
  const changed = JSON.stringify(policy) !== JSON.stringify(retention.policy);
  const field = (key: keyof RetentionPolicy, label: string) => (
    <label>
      {label}
      <input type="number" min={0} value={policy[key]} disabled={!isAdmin} onChange={(e) => setPolicy({ ...policy, [key]: Number(e.target.value) })} />
    </label>
  );

  return (
    <section className="settings-card">
      <h2>Retention</h2>
      <p className="muted small">
        Personal data is kept only as long as its purpose needs. Shown here: what is past its date, and what reaches it in the next 60
        days. Shifts, hours and pay are never deleted, because the accounts depend on them; at the end the person is anonymised instead.
      </p>
      <table className="table">
        <thead>
          <tr><th>Person</th><th>What</th><th>Removes</th><th>Due</th></tr>
        </thead>
        <tbody>
          {retention.items.length === 0 && <tr><td colSpan={4} className="muted">Nothing due in the next 60 days.</td></tr>}
          {retention.items.map((i) => (
            <tr key={`${i.code}-${i.employeeId}`}>
              <td>{i.name}</td>
              <td>
                {CODE_LABEL[i.code]}
                <div className="muted small">{i.reason}</div>
              </td>
              <td>{i.removes}</td>
              <td>{i.dueOn}{i.due && <span className="tag bad">due</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {isAdmin && (
        <button
          className="primary"
          disabled={due.length === 0}
          onClick={() => { if (confirm(`Remove the ${due.length} item${due.length === 1 ? '' : 's'} past their date? This cannot be undone.`)) void act('Done. The audit log records what was removed, by id only.', () => api.post('/v1/privacy/retention/apply'), true); }}
        >
          Apply {due.length} due
        </button>
      )}
      <form
        className="settings-form"
        onSubmit={(e) => { e.preventDefault(); void act('Retention periods saved.', () => api.put('/v1/privacy/policy', policy)); }}
      >
        {field('locationMonths', 'Clocking location, months')}
        {field('contactMonthsAfterLeaving', 'Contact details after leaving, months')}
        {field('rightToWorkYearsAfterLeaving', 'Right to work after leaving, years (min 2)')}
        {field('payrollYearsAfterTaxYear', 'Payroll after the tax year, years (min 3)')}
        {isAdmin && <button type="submit" disabled={!changed}>Save periods</button>}
      </form>
    </section>
  );
}

function RegisterCard({ register, today }: { register: Register; today: string }) {
  function exportCsv() {
    const header = ['Activity', 'Purpose', 'Lawful basis', 'Personal data', 'Recipients', 'Retention', 'Records held'];
    const lines = register.activities.map((a) => [a.activity, a.purpose, a.lawfulBasis, a.categories, a.recipients, a.retention, a.held]);
    const procHeader = ['Processor', 'Role', 'Data', 'Location', 'Safeguard', 'In use'];
    const procLines = register.processors.map((p) => [p.name, p.role, p.data, p.location, p.safeguard, p.active ? 'Yes' : 'No']);
    const csv = [header, ...lines, [], procHeader, ...procLines].map((l) => l.map(csvCell).join(',')).join('\n');
    download(`record-of-processing-${today}.csv`, csv);
  }

  return (
    <section className="settings-card">
      <h2>Record of processing (Article 30)</h2>
      <p className="muted small">
        Built from what Preshift holds today, so it does not drift. Each company in the group is the controller for its own staff and
        must be registered with the ICO. Add it to the group's wider record alongside customer, supplier and CCTV processing.
      </p>
      <table className="table">
        <thead>
          <tr><th>Activity</th><th>Lawful basis</th><th>Personal data</th><th>Recipients</th><th>Retention</th><th className="num">Held</th></tr>
        </thead>
        <tbody>
          {register.activities.map((a) => (
            <tr key={a.activity}>
              <td>{a.activity}<div className="muted small">{a.purpose}</div></td>
              <td className="small">{a.lawfulBasis}</td>
              <td className="small">{a.categories}</td>
              <td className="small">{a.recipients}</td>
              <td className="small">{a.retention}</td>
              <td className="num">{a.held}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Processors</h2>
      <table className="table">
        <thead>
          <tr><th>Processor</th><th>Data</th><th>Location</th><th>What must be in place</th></tr>
        </thead>
        <tbody>
          {register.processors.map((p) => (
            <tr key={p.name} className={p.active ? '' : 'muted'}>
              <td>{p.name}<div className="muted small">{p.role}{p.active ? '' : ', not in use'}</div></td>
              <td className="small">{p.data}</td>
              <td className="small">{p.location}</td>
              <td className="small">{p.safeguard}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={exportCsv}>Export as CSV</button>
    </section>
  );
}
