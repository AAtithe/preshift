import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatMinute } from '../engine/time';
import type { Employee, RotaState } from '../engine/types';
import {
  MAX_POINTS_PER_AWARD,
  MIN_PULSE_RESPONSES,
  RECOGNITION_LABEL,
  type ChatRequest,
  type MealWeek,
  type Milestone,
  type PersonWelfare,
  type PulseWeek,
  type Recognition,
  type RecognitionCategory,
  type TravelHome,
  type WelfarePolicy,
} from '../engine/welfare';
import { api } from './api';
import { csvLine, dayLabel, download, money, money2 } from './format';
import type { HrSection } from './HrFile';
import type { Allow } from './permissions';
import { WelfareSettings } from './WelfareSettings';

// Wellbeing: the legal patterns that still wear people out, read early enough to act on, and the
// things a good operator does about them. Who needs a conversation and why, a safe way home after a
// late finish, a meal on a long shift, milestones worth marking, recognition that becomes points in
// Hospitality Rewards, and how each team says its week went. The rules live in src/engine/welfare.ts.

export interface WelfareOverview {
  today: string;
  policy: WelfarePolicy;
  defaults: WelfarePolicy;
  people: PersonWelfare[];
  travelHome: TravelHome[];
  milestones: Milestone[];
  sites: { siteId: string; pointsGiven: number; pointsBudget: number; meals: MealWeek; pulse: PulseWeek[] }[];
  pulse: PulseWeek[];
  chats: ChatRequest[];
  recognitions: Recognition[];
  rewards: { connected: boolean; enrolled: number; optedOut: number };
}

interface Props {
  state: RotaState;
  siteIds: string[];
  today: string;
  allow: Allow;
  onOpenHr: (employee: Employee, section?: HrSection) => void;
}

const LEVEL_LABEL = { act: 'Talk this week', watch: 'Keep an eye', ok: 'Fine' } as const;
const LEVEL_TONE = { act: 'bad', watch: 'warn', ok: 'good' } as const;
const DELIVERY_LABEL: Record<Recognition['rewards']['status'], string> = {
  none: 'Thank you',
  pending: 'Points waiting',
  sent: 'Points credited',
  failed: 'Points not sent yet',
  'not-connected': 'Points not sent',
};
const when = (iso: string) => {
  const d = dayLabel(iso.slice(0, 10));
  return `${d.short} ${d.date}`;
};

type Draft = { employeeId: string; category: RecognitionCategory; message: string; points: number };
const EMPTY: Draft = { employeeId: '', category: 'guest', message: '', points: 25 };

export function WelfareView({ state, siteIds, today, allow, onOpenHr }: Props) {
  const [data, setData] = useState<WelfareOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = useCallback(async () => {
    setData(await api.get<WelfareOverview>(`/v1/welfare?sites=${encodeURIComponent(siteIds.join(','))}`));
  }, [siteIds]);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [load]);

  const person = useMemo(() => new Map(state.employees.map((e) => [e.id, e])), [state.employees]);
  const name = (id: string) => person.get(id)?.name ?? 'Someone';
  const siteName = (id: string) => state.sites.find((s) => s.id === id)?.name ?? id;
  const many = siteIds.length > 1;

  if (error) return <p className="bad-text">{error}</p>;
  if (!data) return <p className="muted">Loading</p>;

  const act = data.people.filter((p) => p.level === 'act');
  const watch = data.people.filter((p) => p.level === 'watch');
  const shown = showAll ? data.people : data.people.filter((p) => p.level !== 'ok');
  const young = data.travelHome.filter((t) => t.under18).length;
  const latestPulse = data.pulse[data.pulse.length - 1];
  const lastShown = [...data.pulse].reverse().find((w) => w.average !== null);
  const given = data.sites.reduce((n, s) => n + s.pointsGiven, 0);
  const budget = data.sites.reduce((n, s) => n + s.pointsBudget, 0);
  const manages = (siteId: string) => allow('team.manage', siteId);
  const team = state.employees.filter((e) => siteIds.includes(e.siteId) && manages(e.siteId) && e.status !== 'leaver' && (!e.startDate || e.startDate <= today));
  const draftSite = person.get(draft.employeeId)?.siteId;
  const draftRoom = draftSite ? (data.sites.find((s) => s.siteId === draftSite)?.pointsBudget ?? 0) - (data.sites.find((s) => s.siteId === draftSite)?.pointsGiven ?? 0) : null;

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      const text = await fn();
      await load();
      setMessage({ text });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), bad: true });
    } finally {
      setBusy(false);
    }
  }

  const recognise = () =>
    run(async () => {
      const r = await api.post<Recognition>('/v1/welfare/recognitions', draft);
      setDraft(EMPTY);
      const pts = r.points ? `, ${r.points} points` : '';
      return r.rewards.status === 'sent'
        ? `Recognised ${name(r.employeeId)}${pts}, credited to their Hospitality Rewards account.`
        : r.rewards.status === 'pending'
          ? `Recognised ${name(r.employeeId)}${pts}. The points go across once they are a Hospitality Rewards member.`
          : `Recognised ${name(r.employeeId)}${pts}. They see it in the staff app.`;
    });

  const chatHeld = (chat: ChatRequest) =>
    run(async () => {
      await api.post(`/v1/welfare/chats/${chat.id}/done`);
      return `Marked the chat with ${name(chat.employeeId)} as held.`;
    });

  const fromMilestone = (m: Milestone) => {
    setDraft({ employeeId: m.employeeId, category: 'milestone', message: m.kind === 'birthday' ? 'Happy birthday from all of us.' : m.kind === 'probation' ? 'Probation passed. Glad to have you on the team.' : `${m.label}. Thank you for everything you bring.`, points: m.points });
    document.getElementById('recognise')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  function exportCsv() {
    const header = ['Name', 'Site', 'Level', 'Average weekly hours', 'Days worked (4 weeks)', 'Late finishes', 'Signals', 'Next step'];
    const rows = data!.people.map((p) => [name(p.employeeId), siteName(p.siteId), LEVEL_LABEL[p.level], p.averageWeeklyHours, p.daysWorked, p.lateFinishes, p.signals.map((s) => s.label).join('; '), p.signals[0]?.action ?? '']);
    download(`wellbeing-${today}.csv`, [header, ...rows].map(csvLine).join('\n'));
  }

  return (
    <div className="welfare">
      <p className="muted small">
        What the last four weeks and the fortnight ahead say about each person: long weeks, runs of days, close then open, late finishes,
        no weekend off, missed breaks, no holiday, hours cut. None of these breaks the law; each wears people down. Look at the people at
        the top of the list before you build next week.
      </p>

      <div className="kpis people-kpis">
        <div className={`kpi ${act.length ? 'bad' : 'good'}`}>
          <div className="kpi-label">Talk this week</div>
          <div className="kpi-value">{act.length}</div>
          <div className="kpi-hint">{watch.length} more to keep an eye on</div>
        </div>
        <div className={`kpi ${data.chats.length ? 'bad' : 'good'}`}>
          <div className="kpi-label">Asked for a chat</div>
          <div className="kpi-value">{data.chats.length}</div>
          <div className="kpi-hint">From the staff app</div>
        </div>
        <div className={`kpi ${young ? 'warn' : ''}`}>
          <div className="kpi-label">Late finishes, 14 days</div>
          <div className="kpi-value">{data.travelHome.length}</div>
          <div className="kpi-hint">{young ? `${young} by under 18s` : 'Check how each gets home'}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Team pulse</div>
          <div className="kpi-value">{lastShown?.average !== undefined && lastShown?.average !== null ? `${lastShown.average} / 5` : 'Not yet'}</div>
          <div className="kpi-hint">{latestPulse.responses} {latestPulse.responses === 1 ? 'answer' : 'answers'} this week</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Points given this month</div>
          <div className="kpi-value">{given.toLocaleString('en-GB')}</div>
          <div className="kpi-hint">of {budget.toLocaleString('en-GB')} across {data.sites.length} {data.sites.length === 1 ? 'site' : 'sites'}</div>
        </div>
      </div>

      {message && <p className={`small ${message.bad ? 'bad-text' : 'good-text'}`} role="status">{message.text}</p>}

      <div className="people-bar">
        <h3 className="section-title">Who needs a conversation</h3>
        <div className="people-actions">
          <label className="check small">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show everyone
          </label>
          <button onClick={exportCsv} disabled={data.people.length === 0}>Wellbeing CSV</button>
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="muted">Nothing in the last four weeks or the fortnight ahead needs a conversation. Keep it that way when you build next week.</p>
      ) : (
        <div className="grid-wrap">
          <table className="table people welfare-table">
            <thead>
              <tr>
                <th>Name</th>
                {many && <th>Site</th>}
                <th>Level</th>
                <th className="num">Hours a week</th>
                <th>What we see</th>
                <th>Next step</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => {
                const expanded = open === p.employeeId;
                const toggle = () => setOpen(expanded ? null : p.employeeId);
                const chat = data.chats.find((c) => c.employeeId === p.employeeId);
                const e = person.get(p.employeeId);
                return [
                  <tr key={p.employeeId} className="clickable" tabIndex={0} aria-expanded={expanded} onClick={toggle} onKeyDown={(ev) => { if (ev.key === 'Enter') toggle(); }}>
                    <td className="strong">{name(p.employeeId)}</td>
                    {many && <td className="muted">{siteName(p.siteId)}</td>}
                    <td><span className={`badge ${LEVEL_TONE[p.level]}`}>{LEVEL_LABEL[p.level]}</span></td>
                    <td className="num">{p.averageWeeklyHours.toFixed(1)}</td>
                    <td>{p.signals.map((s) => s.label).join(', ') || <span className="muted">Nothing</span>}</td>
                    <td className="small">{p.signals[0]?.action ?? ''}</td>
                  </tr>,
                  expanded && (
                    <tr key={`${p.employeeId}-detail`} className="onboarding-detail">
                      <td colSpan={many ? 6 : 5}>
                        <ul className="welfare-signals">
                          {p.signals.map((s) => (
                            <li key={s.code}>
                              <span className={`badge ${s.level === 'act' ? 'bad' : 'warn'}`}>{s.label}</span>
                              <span>{s.detail}</span>
                              <span className="muted small">{s.action}</span>
                            </li>
                          ))}
                        </ul>
                        <p className="muted small">Over four weeks: {p.daysWorked} days worked, {p.lateFinishes} late finishes.</p>
                        <div className="close-actions">
                          {chat && manages(chat.siteId) && <button className="primary" disabled={busy} onClick={() => void chatHeld(chat)}>Mark the chat held</button>}
                          {e && manages(e.siteId) && <button disabled={busy} onClick={() => { setDraft({ ...EMPTY, employeeId: e.id }); document.getElementById('recognise')?.scrollIntoView({ behavior: 'smooth' }); }}>Recognise</button>}
                          {e && allow('hr.view', e.siteId) && <button onClick={() => onOpenHr(e, 'profile')}>Open HR file</button>}
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="section-title">A safe way home</h3>
      <p className="muted small">
        Shifts in the next fortnight finishing at {formatMinute(data.policy.lateFinishMinute)} or later
        {data.policy.under18TravelHome ? ', and under 18s finishing after 22:00' : ''}.
        {data.policy.travelHomeAllowance ? ` The policy pays ${money2(data.policy.travelHomeAllowance)} a journey.` : ' No travel home allowance is set: agree how each person gets home.'}
      </p>
      {data.travelHome.length === 0 ? (
        <p className="muted">No late finishes on the rota in the next fortnight.</p>
      ) : (
        <div className="grid-wrap">
          <table className="table compact">
            <thead>
              <tr><th>Day</th><th>Name</th>{many && <th>Site</th>}<th>Finishes</th><th /><th className="num">Allowance</th></tr>
            </thead>
            <tbody>
              {data.travelHome.map((t) => (
                <tr key={t.shiftId}>
                  <td>{when(t.date)}</td>
                  <td>{name(t.employeeId)}</td>
                  {many && <td className="muted">{siteName(t.siteId)}</td>}
                  <td className="num">{formatMinute(t.endMinute)}</td>
                  <td>{t.under18 && <span className="badge warn">Under 18: arrange it</span>}</td>
                  <td className="num">{t.allowance ? money2(t.allowance) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.policy.travelHomeAllowance > 0 && (
            <p className="muted small">Fortnight cost: {money(data.travelHome.length * data.policy.travelHomeAllowance)}. A taxi home is a taxable benefit unless the late night working exemption applies: kept at work until 21:00 or later, not regularly, with public transport stopped or unsafe, up to 60 journeys a year. Regular closing shifts usually fail it, so a taxi after every close goes through payroll or a PAYE Settlement Agreement.</p>
          )}
        </div>
      )}

      <h3 className="section-title" id="recognise">Recognition</h3>
      <p className="muted small">
        Say what they did, so it means something. Points come from the site's {data.policy.pointsPerSiteMonth.toLocaleString('en-GB')} a month
        {data.rewards.connected ? ' and are credited to their Hospitality Rewards account' : '; connect Hospitality Rewards to turn them into discounts and rewards'}.
        Nobody recognises themselves.
      </p>
      {team.length > 0 && (
        <form className="settings-form welfare-recognise" onSubmit={(e) => { e.preventDefault(); void recognise(); }}>
          <label>
            Who
            <select required value={draft.employeeId} onChange={(e) => setDraft({ ...draft, employeeId: e.target.value })}>
              <option value="">Choose someone</option>
              {[...team].sort((a, b) => a.name.localeCompare(b.name)).map((e) => <option key={e.id} value={e.id}>{e.name}{many ? `, ${siteName(e.siteId)}` : ''}</option>)}
            </select>
          </label>
          <label>
            For
            <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as RecognitionCategory })}>
              {Object.entries(RECOGNITION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="wide">
            What they did
            <input required minLength={10} maxLength={280} value={draft.message} placeholder="Turned a complaint at table 12 into a booking for their anniversary" onChange={(e) => setDraft({ ...draft, message: e.target.value })} />
          </label>
          <label>
            Points
            <input type="number" min={0} max={Math.min(MAX_POINTS_PER_AWARD, Math.max(0, draftRoom ?? MAX_POINTS_PER_AWARD))} step={5} value={draft.points} onChange={(e) => setDraft({ ...draft, points: Number(e.target.value) })} />
          </label>
          <button className="primary" type="submit" disabled={busy || !draft.employeeId}>Recognise</button>
          {draftRoom !== null && <span className="muted small">{draftRoom.toLocaleString('en-GB')} points left at {siteName(draftSite!)} this month</span>}
        </form>
      )}

      {data.milestones.length > 0 && (
        <>
          <h4 className="section-inline">Coming up</h4>
          <ul className="welfare-milestones">
            {data.milestones.map((m) => (
              <li key={`${m.employeeId}-${m.kind}`}>
                <span className="muted">{when(m.date)}</span>
                <span><span className="strong">{name(m.employeeId)}</span> {m.label.toLowerCase()}</span>
                {manages(person.get(m.employeeId)?.siteId ?? '') && <button className="link" onClick={() => fromMilestone(m)}>Mark it, {m.points} points</button>}
              </li>
            ))}
          </ul>
        </>
      )}

      {data.recognitions.length > 0 && (
        <div className="grid-wrap">
          <table className="table compact">
            <thead>
              <tr><th>When</th><th>Who</th><th>For</th><th>What they did</th><th>By</th><th className="num">Points</th><th /></tr>
            </thead>
            <tbody>
              {data.recognitions.slice(0, 25).map((r) => (
                <tr key={r.id}>
                  <td>{when(r.at)}</td>
                  <td>{name(r.employeeId)}</td>
                  <td>{RECOGNITION_LABEL[r.category]}</td>
                  <td className="small">{r.message}</td>
                  <td className="muted">{r.by}</td>
                  <td className="num">{r.points || ''}</td>
                  <td className="small"><span className={r.rewards.status === 'failed' ? 'bad-text' : r.rewards.status === 'sent' ? 'good-text' : 'muted'} title={r.rewards.error}>{DELIVERY_LABEL[r.rewards.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="section-title">Team pulse</h3>
      <p className="muted small">
        Each week the staff app asks "How was your week?", one to five. Answers are kept without names, and a week shows only once{' '}
        {MIN_PULSE_RESPONSES} people at a site have answered, so nobody can be picked out. Anyone can also ask for a private chat; that
        one carries their name, because they chose it.
      </p>
      <div className="grid-wrap">
        <table className="table compact welfare-pulse">
          <thead>
            <tr>
              <th>Site</th>
              {data.pulse.map((w) => <th key={w.week} className="num">{when(w.week)}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.sites.map((s) => (
              <tr key={s.siteId}>
                <td>{siteName(s.siteId)}</td>
                {s.pulse.map((w) => (
                  <td key={w.week} className={`num ${w.average !== null && w.average < 3 ? 'bad-text' : ''}`} title={`${w.responses} answers`}>
                    {w.average !== null ? w.average.toFixed(1) : <span className="muted">{w.responses ? `${w.responses} of ${MIN_PULSE_RESPONSES}` : ''}</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="section-title">Staff meals this week</h3>
      <p className="muted small">
        One meal for each shift of {data.policy.mealFromHours} hours or more, at {money2(data.policy.mealCost)} food cost. Meals on the
        premises offered to all staff are not a taxable benefit (ITEPA 2003 s317), unless given through salary sacrifice or flexible
        remuneration.
      </p>
      <table className="table compact">
        <thead><tr><th>Site</th><th className="num">Meals</th><th className="num">Food cost</th></tr></thead>
        <tbody>
          {data.sites.map((s) => (
            <tr key={s.siteId}><td>{siteName(s.siteId)}</td><td className="num">{s.meals.meals}</td><td className="num">{money2(s.meals.cost)}</td></tr>
          ))}
        </tbody>
      </table>

      {allow('settings.manage') && <WelfareSettings overview={data} onChanged={load} />}
    </div>
  );
}
