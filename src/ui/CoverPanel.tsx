import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { CHANNEL_NAMES, type Channel } from '../engine/messaging';
import { formatMinute } from '../engine/time';
import type { RotaState } from '../engine/types';
import { api, ApiError } from './api';
import { dayLabel, money2 } from './format';

interface CandidateRow {
  employeeId: string;
  name: string;
  homeSite: string;
  borrowed: boolean;
  askable: boolean;
  reason: string | null;
  warnings: string[];
  marginal?: number;
  siteCost?: number;
  app: boolean;
  channel: Channel | null;
}

interface Preview {
  label: string;
  original: { shiftId: string; employeeId: string; name: string; published: boolean } | null;
  candidates: CandidateRow[];
}

interface RequestRow {
  id: string;
  status: 'open' | 'filled' | 'cancelled' | 'expired';
  label: string;
  originalName: string | null;
  note: string | null;
  firstToAccept: boolean;
  publish: boolean;
  createdAt: string;
  createdBy: string;
  filledBy: string | null;
  closedBy: string | null;
  offers: { employeeId: string; name: string; borrowed: boolean; response: 'accepted' | 'declined' | null; via: string | null; refused: string | null; marginal?: number }[];
}

const problem = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const STATUS: Record<RequestRow['status'], string> = { open: 'Open', filled: 'Covered', cancelled: 'Called off', expired: 'Closed, not covered' };
const TONE: Record<RequestRow['status'], string> = { open: 'tone-warn', filled: 'tone-good', cancelled: '', expired: 'tone-bad' };

/**
 * Cover for a shift someone cannot work. Preshift asks only the people who could legally work it,
 * cheapest first, so whoever says yes can be given it at once, and the manager sees what each
 * would cost before anything is sent.
 */
export function CoverPanel({ state, siteId, today, nowMinute, shiftId }: { state: RotaState; siteId: string; today: string; nowMinute: number; shiftId?: string }) {
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [chosenShift, setChosenShift] = useState(shiftId ?? '');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [form, setForm] = useState({ note: '', firstToAccept: true, urgent: false });
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      setRequests(await api.get<RequestRow[]>(`/v1/cover?siteId=${encodeURIComponent(siteId)}`));
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  }, [siteId]);
  useEffect(() => void load(), [load]);

  const name = (id: string) => state.employees.find((e) => e.id === id)?.name ?? id;
  const role = (id: string) => state.roles.find((r) => r.id === id)?.name ?? id;
  // Shifts still to come at this site, soonest first.
  const upcoming = useMemo(
    () =>
      state.shifts
        .filter((s) => s.siteId === siteId && (s.date > today || (s.date === today && s.startMinute > nowMinute)))
        .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute)
        .slice(0, 200),
    [state.shifts, siteId, today, nowMinute],
  );

  useEffect(() => {
    if (!chosenShift) return setPreview(null);
    api
      .post<Preview>('/v1/cover/preview', { shiftId: chosenShift })
      .then((p) => {
        setPreview(p);
        setTicked(new Set(p.candidates.filter((c) => c.askable).map((c) => c.employeeId)));
        setMessage(null);
      })
      .catch((e) => {
        setPreview(null);
        setMessage({ text: problem(e), bad: true });
      });
  }, [chosenShift]);

  async function ask(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post('/v1/cover', { shiftId: chosenShift, employeeIds: [...ticked], ...form });
      setMessage({ text: `Asked ${ticked.size} ${ticked.size === 1 ? 'person' : 'people'}. You will see each answer here.` });
      setChosenShift('');
      setForm({ note: '', firstToAccept: true, urgent: false });
      await load();
    } catch (err) {
      setMessage({ text: problem(err), bad: true });
    }
  }

  async function act(fn: () => Promise<unknown>, done: string) {
    try {
      await fn();
      setMessage({ text: done });
      await load();
    } catch (err) {
      setMessage({ text: problem(err), bad: true });
    }
  }

  const askable = preview?.candidates.filter((c) => c.askable) ?? [];
  const blocked = preview?.candidates.filter((c) => !c.askable) ?? [];
  const showCost = askable.some((c) => c.marginal !== undefined);

  return (
    <div className="messages-main">
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Ask for cover</span>
          <span className="panel-sub">Only people who could legally work it are asked</span>
        </div>
        <form className="panel-body compose" onSubmit={(e) => void ask(e)}>
          <label className="small muted">
            Shift
            <select value={chosenShift} onChange={(e) => setChosenShift(e.target.value)}>
              <option value="">Choose a shift</option>
              {upcoming.map((s) => {
                const d = dayLabel(s.date);
                return (
                  <option key={s.id} value={s.id}>
                    {d.short} {d.date}, {formatMinute(s.startMinute)} to {formatMinute(s.endMinute)}, {role(s.roleId)}: {name(s.employeeId)}
                  </option>
                );
              })}
            </select>
          </label>
          {preview && (
            <>
              <p className="small">
                {preview.label}. {preview.original ? `${preview.original.name} is off it once someone takes it.` : ''}
                {preview.original && !preview.original.published ? ' The shift is not published yet, so the change stays a draft until you publish.' : ''}
              </p>
              {askable.length === 0 ? (
                <p className="small warn-text">Nobody trained for this role can legally work it. This is a gap to fill by hiring or cross-training, not by asking around.</p>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th />
                      <th>Who</th>
                      {showCost && <th className="num">Adds to labour</th>}
                      <th>Reached by</th>
                      <th>To review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {askable.map((c) => (
                      <tr key={c.employeeId}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Ask ${c.name}`}
                            checked={ticked.has(c.employeeId)}
                            onChange={(e) => {
                              const next = new Set(ticked);
                              if (e.target.checked) next.add(c.employeeId);
                              else next.delete(c.employeeId);
                              setTicked(next);
                            }}
                          />
                        </td>
                        <td>
                          {c.name}
                          {c.borrowed && <span className="tag borrowed">From {c.homeSite}</span>}
                        </td>
                        {showCost && <td className="num">{money2(c.marginal ?? 0)}</td>}
                        <td className="small">
                          {c.channel ? `App and ${CHANNEL_NAMES[c.channel]}` : c.app ? 'Staff app' : <span className="warn-text">Nobody: no app login or channel</span>}
                        </td>
                        <td className="muted small">{c.warnings.join('; ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {blocked.length > 0 && (
                <details className="small">
                  <summary>{blocked.length} not asked, and why</summary>
                  <ul className="plain">
                    {blocked.map((c) => <li key={c.employeeId}>{c.name}: {c.reason}</li>)}
                  </ul>
                </details>
              )}
              {askable.length > 0 && (
                <>
                  <textarea maxLength={280} rows={2} placeholder="A note for the team, such as 'Party of 30 at 7'. Never why someone is off." value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
                  <div className="compose-actions">
                    <span>
                      <label className="small"><input type="checkbox" checked={form.firstToAccept} onChange={(e) => setForm({ ...form, firstToAccept: e.target.checked })} /> First to say yes gets it</label>{' '}
                      <label className="small"><input type="checkbox" checked={form.urgent} onChange={(e) => setForm({ ...form, urgent: e.target.checked })} /> Urgent: through quiet hours</label>
                    </span>
                    <button className="primary" type="submit" disabled={ticked.size === 0}>Ask {ticked.size} {ticked.size === 1 ? 'person' : 'people'}</button>
                  </div>
                </>
              )}
            </>
          )}
          {message && <p className={`small ${message.bad ? 'bad-text' : 'muted'}`}>{message.text}</p>}
        </form>
      </section>

      {requests.length > 0 && (
        <section className="panel">
          <div className="panel-head"><span className="panel-title">Cover asked for</span></div>
          <div className="panel-body">
            <ul className="plain cover-list">
              {requests.map((r) => {
                const yes = r.offers.filter((o) => o.response === 'accepted' && !o.refused);
                const waiting = r.offers.filter((o) => !o.response).length;
                return (
                  <li key={r.id} className="cover-row">
                    <div>
                      <span className="strong">{r.label}</span> <span className={`pill ${TONE[r.status]}`}>{STATUS[r.status]}</span>
                    </div>
                    <div className="muted small">
                      {r.originalName ? `For ${r.originalName}. ` : ''}Asked by {r.createdBy}. {r.offers.length} asked, {yes.length} yes, {r.offers.filter((o) => o.response === 'declined').length} no, {waiting} not answered.
                      {r.filledBy ? ` Covered by ${r.filledBy}.` : ''}
                      {r.closedBy && r.status === 'cancelled' ? ` Called off by ${r.closedBy}.` : ''}
                      {r.status === 'filled' && !r.publish ? ' Publish the rota to send it to the team.' : ''}
                    </div>
                    {r.status === 'open' && (
                      <div className="panel-actions">
                        {!r.firstToAccept &&
                          yes.map((o) => (
                            <button key={o.employeeId} className="primary" onClick={() => void act(() => api.post(`/v1/cover/${r.id}/assign`, { employeeId: o.employeeId }), `${o.name} has it.`)}>
                              Give it to {o.name}
                            </button>
                          ))}
                        <button className="ghost" onClick={() => void act(() => api.post(`/v1/cover/${r.id}/cancel`), 'Called off. Nobody else can accept it.')}>Call off</button>
                      </div>
                    )}
                    {r.offers.some((o) => o.refused) && (
                      <div className="small warn-text">{r.offers.filter((o) => o.refused).map((o) => `${o.name} said yes but could not be given it: ${o.refused}`).join(' ')}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}
