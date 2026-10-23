import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ROUND_MINUTES } from '../engine/cover';
import { formatMinute, parseClock } from '../engine/time';
import type { RotaState } from '../engine/types';
import { api, ApiError } from './api';
import { dayLabel, money2 } from './format';

interface CandidateRow {
  employeeId: string;
  name: string;
  homeSite: string;
  borrowed: boolean;
  eligible: boolean;
  reason: string | null;
  warnings: string[];
  marginal?: number;
}

interface Preview {
  label: string;
  holder: { employeeId: string; name: string; published: boolean } | null;
  suggestedRounds: { size: number; everyMinutes: number } | null;
  candidates: CandidateRow[];
}

type Who = 'everyone' | 'rounds' | 'chosen';

const problem = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/**
 * Putting a shift out, someone's or a gap, in one form. The manager sees who could legally take it,
 * cheapest first, and chooses who hears (everyone at once, the cheapest first in rounds, or named
 * people), how it is decided (they approve a claim, or the first legal yes gets it) and, for
 * someone's shift, whether it stays theirs until someone takes it.
 */
export function CoverPanel({
  state,
  siteIds,
  today,
  nowMinute,
  shiftId,
  keepDefault = false,
  onPosted,
}: {
  state: RotaState;
  /** Sites where the person may put shifts out. */
  siteIds: string[];
  today: string;
  nowMinute: number;
  /** A shift to start from: from the rota's shift editor, or sickness to cover. */
  shiftId?: string;
  /** Whether the shift stays with its person until taken: yes from the editor, no for sickness. */
  keepDefault?: boolean;
  onPosted: (line: string) => void;
}) {
  const [source, setSource] = useState<'shift' | 'gap'>('shift');
  const [chosenShift, setChosenShift] = useState(shiftId ?? '');
  const [gap, setGap] = useState({ siteId: siteIds[0] ?? '', roleId: state.roles[0]?.id ?? '', date: today, start: '17:00', end: '23:00', breakMinutes: 0 });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [who, setWho] = useState<Who>('everyone');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [rounds, setRounds] = useState({ size: 3, everyMinutes: 30 });
  const [form, setForm] = useState({ note: '', firstYes: false, urgent: false, keep: keepDefault });
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  const name = (id: string) => state.employees.find((e) => e.id === id)?.name ?? id;
  const role = (id: string) => state.roles.find((r) => r.id === id)?.name ?? id;
  // Shifts still to come at these sites, soonest first.
  const upcoming = useMemo(
    () =>
      state.shifts
        .filter((s) => siteIds.includes(s.siteId) && (s.date > today || (s.date === today && s.startMinute > nowMinute)))
        .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute)
        .slice(0, 300),
    [state.shifts, siteIds, today, nowMinute],
  );

  const slot = () => {
    if (source === 'shift') return chosenShift ? { fromShiftId: chosenShift } : null;
    const start = parseClock(gap.start);
    let end = parseClock(gap.end);
    if (end <= start) end += 1440;
    return gap.siteId && gap.roleId && gap.date ? { siteId: gap.siteId, roleId: gap.roleId, date: gap.date, startMinute: start, endMinute: end, breakMinutes: gap.breakMinutes } : null;
  };
  const slotKey = JSON.stringify(slot());

  useEffect(() => {
    const body = slot();
    if (!body) return setPreview(null);
    api
      .post<Preview>('/v1/open-shifts/preview', body)
      .then((p) => {
        setPreview(p);
        const able = p.candidates.filter((c) => c.eligible);
        setTicked(new Set(able.map((c) => c.employeeId)));
        // With time to spare and more than a few to ask, the cheapest first; at short notice, everyone.
        if (p.suggestedRounds) {
          setWho('rounds');
          setRounds(p.suggestedRounds);
        } else setWho('everyone');
        setMessage(null);
      })
      .catch((e) => {
        setPreview(null);
        setMessage({ text: problem(e), bad: true });
      });
  // The preview follows what is being put out, and nothing else.
  }, [slotKey]);

  async function post(e: FormEvent) {
    e.preventDefault();
    const body = slot();
    if (!body || !preview) return;
    const eligible = preview.candidates.filter((c) => c.eligible).map((c) => c.employeeId);
    try {
      const res = await api.post<{ told: number; line: string }>('/v1/open-shifts', {
        ...body,
        ...(source === 'shift' ? { keepUntilTaken: form.keep } : {}),
        ...(form.note.trim() ? { note: form.note.trim() } : {}),
        fill: form.firstYes ? 'first_yes' : 'claim',
        urgent: form.urgent,
        ...(who === 'chosen' ? { employeeIds: eligible.filter((id) => ticked.has(id)) } : {}),
        ...(who === 'rounds' ? { employeeIds: eligible, rounds } : {}),
      });
      setMessage({
        text:
          who === 'rounds'
            ? `Put out. Asked the ${res.told} cheapest; ${rounds.size} more every ${rounds.everyMinutes} minutes until someone takes it.`
            : `Put out. ${res.told} ${res.told === 1 ? 'person has' : 'people have'} been told.`,
      });
      setChosenShift('');
      setForm({ note: '', firstYes: false, urgent: false, keep: keepDefault });
      onPosted(res.line);
    } catch (err) {
      setMessage({ text: problem(err), bad: true });
    }
  }

  const eligible = preview?.candidates.filter((c) => c.eligible) ?? [];
  const ineligible = preview?.candidates.filter((c) => !c.eligible) ?? [];
  const showCost = eligible.some((c) => c.marginal !== undefined);
  const count = who === 'chosen' ? eligible.filter((c) => ticked.has(c.employeeId)).length : eligible.length;

  return (
    <form className="card compose put-out" onSubmit={(e) => void post(e)}>
      <div className="compose-actions">
        <label className="small"><input type="radio" checked={source === 'shift'} onChange={() => setSource('shift')} /> Someone's shift</label>
        <label className="small"><input type="radio" checked={source === 'gap'} onChange={() => setSource('gap')} /> A shift nobody is on</label>
      </div>
      {source === 'shift' ? (
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
      ) : (
        <div className="requests-post">
          <label>Site
            <select value={gap.siteId} onChange={(e) => setGap({ ...gap, siteId: e.target.value })}>{siteIds.map((id) => <option key={id} value={id}>{state.sites.find((s) => s.id === id)?.name ?? id}</option>)}</select>
          </label>
          <label>Role
            <select value={gap.roleId} onChange={(e) => setGap({ ...gap, roleId: e.target.value })}>{state.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          </label>
          <label>Day <input type="date" min={today} value={gap.date} onChange={(e) => setGap({ ...gap, date: e.target.value })} /></label>
          <label>From <input type="time" value={gap.start} onChange={(e) => setGap({ ...gap, start: e.target.value })} /></label>
          <label>To <input type="time" value={gap.end} onChange={(e) => setGap({ ...gap, end: e.target.value })} /></label>
          <label>Break, minutes <input type="number" min={0} max={240} value={gap.breakMinutes} onChange={(e) => setGap({ ...gap, breakMinutes: Number(e.target.value) })} /></label>
        </div>
      )}

      {preview && (
        <>
          <p className="small">
            {preview.label}.
            {preview.holder && !preview.holder.published ? ' Not published yet: whoever takes it sees it once the week is published.' : ''}
          </p>
          {preview.holder && (
            <label className="small">
              <input type="checkbox" checked={form.keep} onChange={(e) => setForm({ ...form, keep: e.target.checked })} /> Leave it with {preview.holder.name.split(' ')[0]} until someone takes it
              <span className="muted"> (untick if they are off sick or cannot work it at all: it comes off them now and they are told)</span>
            </label>
          )}
          {eligible.length === 0 ? (
            <p className="small warn-text">Nobody trained for this role can legally take it. This is a gap to fill by hiring or cross-training, not by asking around.</p>
          ) : (
            <>
              <div className="compose-actions small">
                <span>
                  <label><input type="radio" checked={who === 'everyone'} onChange={() => setWho('everyone')} /> Tell all {eligible.length} eligible now</label>{' '}
                  <label><input type="radio" checked={who === 'rounds'} onChange={() => setWho('rounds')} /> Cheapest first, in rounds</label>{' '}
                  <label><input type="radio" checked={who === 'chosen'} onChange={() => setWho('chosen')} /> Only those I tick</label>
                </span>
                {who === 'rounds' && (
                  <span>
                    <select aria-label="People a round" value={rounds.size} onChange={(e) => setRounds({ ...rounds, size: Number(e.target.value) })}>
                      {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} at a time</option>)}
                    </select>{' '}
                    <select aria-label="Time between rounds" value={rounds.everyMinutes} onChange={(e) => setRounds({ ...rounds, everyMinutes: Number(e.target.value) })}>
                      {ROUND_MINUTES.map((m) => <option key={m} value={m}>every {m < 60 ? `${m} minutes` : m === 60 ? 'hour' : `${m / 60} hours`}</option>)}
                    </select>
                  </span>
                )}
              </div>
              <table className="table">
                <thead>
                  <tr>
                    {who === 'chosen' && <th />}
                    <th>Eligible, cheapest first</th>
                    {showCost && <th className="num">Adds to labour</th>}
                    <th>To review</th>
                  </tr>
                </thead>
                <tbody>
                  {eligible.map((c, i) => (
                    <tr key={c.employeeId}>
                      {who === 'chosen' && (
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
                      )}
                      <td>
                        {c.name}
                        {c.borrowed && <span className="tag borrowed">From {c.homeSite}</span>}
                        {who === 'rounds' && <span className="muted small"> round {Math.floor(i / rounds.size) + 1}</span>}
                      </td>
                      {showCost && <td className="num">{money2(c.marginal ?? 0)}</td>}
                      <td className="muted small">{c.warnings.join(' ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {ineligible.length > 0 && (
            <details className="small">
              <summary>{ineligible.length} not eligible, and why</summary>
              <ul className="plain">{ineligible.map((c) => <li key={c.employeeId}>{c.name}: {c.reason}</li>)}</ul>
            </details>
          )}
          {eligible.length > 0 && (
            <>
              <textarea maxLength={300} rows={2} placeholder="A note for staff, such as 'Party of 30 at 7'. Never why someone is off." value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
              <div className="compose-actions">
                <span>
                  <label className="small"><input type="radio" checked={!form.firstYes} onChange={() => setForm({ ...form, firstYes: false })} /> I approve who gets it</label>{' '}
                  <label className="small"><input type="radio" checked={form.firstYes} onChange={() => setForm({ ...form, firstYes: true })} /> First legal yes gets it</label>{' '}
                  <label className="small"><input type="checkbox" checked={form.urgent} onChange={(e) => setForm({ ...form, urgent: e.target.checked })} /> Urgent: through quiet hours</label>
                </span>
                <button className="primary" type="submit" disabled={count === 0}>
                  {who === 'rounds' && rounds.size < count ? `Ask the ${rounds.size} cheapest first` : `Tell ${count} ${count === 1 ? 'person' : 'people'}`}
                </button>
              </div>
              {who === 'rounds' && (
                <p className="muted small">
                  Nobody further down the list hears anything unless their round comes. A round goes early if everyone asked says no, and everyone left is asked once there is not time for another round.
                </p>
              )}
            </>
          )}
        </>
      )}
      {message && <p className={`small ${message.bad ? 'bad-text' : 'muted'}`}>{message.text}</p>}
    </form>
  );
}
