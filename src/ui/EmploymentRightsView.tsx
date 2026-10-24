import { useCallback, useEffect, useState } from 'react';
import type { EraSettings, HoursOffer, OfferCandidate, ShortNoticeRecord } from '../engine/employmentRights';
import { formatMinute } from '../engine/time';
import type { RotaState } from '../engine/types';
import { api } from './api';
import { money2 } from './format';

interface Position {
  settings: EraSettings;
  assumptions: EraSettings;
  canEditSettings: boolean;
  canOffer: boolean;
  canWaive: boolean;
  shortNotice: ShortNoticeRecord[];
  totals: { owed: number; paid: number; wouldHaveCost: number; waived: number };
  candidates: OfferCandidate[];
  offers: (HoursOffer & { standing: HoursOffer['status'] | 'lapsed'; letter: string })[];
}

interface Props {
  state: RotaState;
  siteId: string;
  showCost: boolean;
  /** Reloads the people list after an accepted offer changes someone's contracted hours. */
  onChanged: () => void;
}

const CHANGE = { cancelled: 'Cancelled', cut: 'Cut short', moved: 'Moved' } as const;

/**
 * The Employment Rights Act 2025 measures for zero and low hours workers at one site: pay owed for
 * published shifts changed at short notice, and guaranteed hours offers. Nothing is owed until the
 * organisation sets the date each measure starts; before then the same figures show what it would cost.
 */
export function EmploymentRightsView({ state, siteId, showCost, onChanged }: Props) {
  const [pos, setPos] = useState<Position | null>(null);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const [drafting, setDrafting] = useState<{ candidate: OfferCandidate; hours: number } | null>(null);
  const [letter, setLetter] = useState<string | null>(null);
  const name = (id: string) => state.employees.find((e) => e.id === id)?.name ?? id;

  const load = useCallback(async () => {
    try {
      setPos(await api.get<Position>(`/v1/employment-rights?siteId=${encodeURIComponent(siteId)}`));
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
  }, [siteId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>, done: string) {
    setMessage(null);
    try {
      await fn();
      setMessage({ text: done });
      await load();
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
  }

  if (!pos) return <p className="muted">{message?.text ?? 'Loading'}</p>;
  const { settings } = pos;
  const noticeStarted = !!settings.shortNoticeFrom;
  const offersStarted = !!settings.guaranteedHoursFrom;
  const due = pos.candidates.filter((c) => c.due);

  return (
    <div className="rights">
      <p className="muted small">
        The Employment Rights Act 2025 gives zero and low hours workers pay when a shift they were given is cancelled, cut or moved at short notice, and
        an offer of guaranteed hours that reflect what they regularly work. The Act sets the rights; the numbers wait for regulations not yet made, so
        the figures below run on assumptions you can change. Until you set the date each measure starts, nothing is owed: what you see is what it would cost.
      </p>
      {message && <p className={`notice${message.bad ? ' error' : ''}`}>{message.text}</p>}

      <div className="kpis people-kpis">
        <div className={`kpi ${pos.totals.owed > 0 ? 'warn' : ''}`}>
          <div className="kpi-label">Short notice pay owed</div>
          <div className="kpi-value">{showCost ? money2(pos.totals.owed) : '-'}</div>
          <div className="kpi-hint">{noticeStarted ? `Goes with the next pay run. Started ${settings.shortNoticeFrom}` : 'Not started yet'}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Would have cost</div>
          <div className="kpi-value">{showCost ? money2(pos.totals.wouldHaveCost) : '-'}</div>
          <div className="kpi-hint">Changes before short notice pay starts</div>
        </div>
        <div className={`kpi ${due.length ? 'warn' : ''}`}>
          <div className="kpi-label">Guaranteed hours offers</div>
          <div className="kpi-value">{offersStarted ? `${due.length} due` : `${pos.candidates.length} would be`}</div>
          <div className="kpi-hint">{offersStarted ? `Started ${settings.guaranteedHoursFrom}` : 'Not started yet'}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Paid so far</div>
          <div className="kpi-value">{showCost ? money2(pos.totals.paid) : '-'}</div>
          <div className="kpi-hint">{showCost && pos.totals.waived > 0 ? `${money2(pos.totals.waived)} waived` : 'Through TeamPay'}</div>
        </div>
      </div>

      <div className="people-bar">
        <h3 className="section-title">Settings</h3>
        {pos.canEditSettings && !editing && <button onClick={() => setEditing(true)}>Change</button>}
      </div>
      {editing ? (
        <SettingsForm
          settings={settings}
          onCancel={() => setEditing(false)}
          onSave={(next) => act(async () => { await api.put('/v1/employment-rights/settings', next); setEditing(false); }, 'Settings saved.')}
        />
      ) : (
        <ul className="rights-settings muted small">
          <li>Zero or low hours: contracted for fewer than {settings.lowHoursThreshold} hours a week{mark(settings.lowHoursThreshold, pos.assumptions.lowHoursThreshold)}.</li>
          <li>Short notice: a change with less than {settings.shortNoticeHours} hours' notice{mark(settings.shortNoticeHours, pos.assumptions.shortNoticeHours)}, paid at {Math.round(settings.compensationShare * 100)}% of the hours lost{mark(settings.compensationShare, pos.assumptions.compensationShare)}.</li>
          <li>Guaranteed hours: worked out on the last {settings.referenceWeeks} weeks of clocked hours{mark(settings.referenceWeeks, pos.assumptions.referenceWeeks)}; the worker has {settings.responseDays} days to answer.</li>
          <li>Short notice pay starts: {settings.shortNoticeFrom ?? 'not set'}. Guaranteed hours offers start: {settings.guaranteedHoursFrom ?? 'not set'}.</li>
        </ul>
      )}

      <h3 className="section-title">Guaranteed hours</h3>
      <div className="grid-wrap">
        <table className="table people">
          <thead>
            <tr>
              <th>Person</th>
              <th className="num">Contract</th>
              <th className="num">Worked on average</th>
              <th className="num">Offer</th>
              {showCost && <th className="num">Fixed cost a week</th>}
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pos.candidates.length === 0 && (
              <tr><td colSpan={7} className="muted">Nobody here works beyond their contract over the reference weeks.</td></tr>
            )}
            {pos.candidates.map((c) => (
              <tr key={c.employeeId}>
                <td>{name(c.employeeId)}</td>
                <td className="num">{c.contractedHours}h</td>
                <td className="num">{c.averageHours}h over {c.weeksUsed} weeks</td>
                <td className="num">{c.suggestedHours}h</td>
                {showCost && <td className="num">{money2(c.weeklyFixedCost)}</td>}
                <td>{c.due ? 'Due now' : offersStarted ? `Needs ${settings.referenceWeeks} weeks` : 'Would be due'}{c.lastOffer ? ` (last offer lapsed)` : ''}</td>
                <td>{pos.canOffer && <button onClick={() => setDrafting({ candidate: c, hours: c.suggestedHours })}>Make an offer</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {drafting && (
        <div className="premium-company">
          <div className="form">
            <label>
              Guaranteed hours to offer {name(drafting.candidate.employeeId)}
              <input
                type="number"
                min={drafting.candidate.contractedHours + 0.5}
                max={60}
                step={0.5}
                value={drafting.hours}
                onChange={(e) => setDrafting({ ...drafting, hours: Number(e.target.value) })}
              />
            </label>
            <p className="hint">They worked {drafting.candidate.averageHours}h a week on average from {drafting.candidate.referenceFrom} to {drafting.candidate.referenceTo}.</p>
            <div className="modal-actions span2">
              <span className="spacer" />
              <button onClick={() => setDrafting(null)}>Cancel</button>
              <button
                className="primary"
                onClick={() =>
                  act(async () => {
                    const res = await api.post<{ letter: string }>('/v1/employment-rights/offers', { employeeId: drafting.candidate.employeeId, offeredHours: drafting.hours });
                    setLetter(res.letter);
                    setDrafting(null);
                  }, 'Offer recorded. Check the letter, sign it and give it to them.')
                }
              >
                Record the offer
              </button>
            </div>
          </div>
        </div>
      )}
      {letter && (
        <div className="premium-company">
          <div className="people-bar">
            <strong>Offer letter</strong>
            <span className="people-actions">
              <button onClick={() => void navigator.clipboard?.writeText(letter)}>Copy</button>
              <button className="link" onClick={() => setLetter(null)}>Close</button>
            </span>
          </div>
          <pre className="letter">{letter}</pre>
        </div>
      )}

      {pos.offers.length > 0 && (
        <div className="grid-wrap">
          <table className="table people">
            <thead>
              <tr>
                <th>Offers made</th>
                <th className="num">Hours</th>
                <th>Offered</th>
                <th>Answer by</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pos.offers.map((o) => (
                <tr key={o.id}>
                  <td>{name(o.employeeId)}</td>
                  <td className="num">{o.contractedBefore}h to {o.offeredHours}h</td>
                  <td>{o.offeredOn}</td>
                  <td>{o.respondBy}</td>
                  <td>{o.standing === 'offered' ? 'Waiting' : o.standing === 'lapsed' ? 'Lapsed, stays on current contract' : o.standing === 'accepted' ? 'Accepted' : 'Declined'}</td>
                  <td className="people-actions">
                    <button className="link" onClick={() => setLetter(o.letter)}>Letter</button>
                    {pos.canOffer && o.standing === 'offered' && (
                      <>
                        <button className="link" onClick={() => act(async () => { await api.post(`/v1/employment-rights/offers/${o.id}/response`, { response: 'accepted' }); onChanged(); }, `${name(o.employeeId)} accepted: contracted hours raised and TeamPay told.`)}>Accepted</button>
                        <button className="link" onClick={() => act(() => api.post(`/v1/employment-rights/offers/${o.id}/response`, { response: 'declined' }), 'Recorded as declined.')}>Declined</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="section-title">Shifts changed at short notice</h3>
      <div className="grid-wrap">
        <table className="table people">
          <thead>
            <tr>
              <th>Shift</th>
              <th>Person</th>
              <th>Change</th>
              <th className="num">Hours lost</th>
              <th className="num">Notice</th>
              {showCost && <th className="num">Pay</th>}
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pos.shortNotice.length === 0 && (
              <tr><td colSpan={8} className="muted">No published shift here has been changed at short notice.</td></tr>
            )}
            {pos.shortNotice.map((r) => (
              <tr key={r.id}>
                <td>{r.original.date} {formatMinute(r.original.startMinute)} to {formatMinute(r.original.endMinute)}</td>
                <td>{name(r.employeeId)}</td>
                <td>{CHANGE[r.change]}</td>
                <td className="num">{(r.minutesLost / 60).toFixed(1)}h</td>
                <td className="num">{Math.floor(r.noticeHours)}h</td>
                {showCost && <td className="num">{money2(r.amount)}</td>}
                <td>
                  {r.status === 'waived'
                    ? `Waived: ${r.waiveReason}`
                    : r.sentIn
                      ? 'Paid'
                      : r.owed
                        ? 'Owed, goes with next pay'
                        : 'Would be owed'}
                </td>
                <td>
                  {pos.canWaive && r.status === 'open' && !r.sentIn && r.owed && (
                    <button
                      className="link"
                      onClick={() => {
                        const reason = window.prompt('Why is nothing owed? For example: the worker asked for the change.');
                        if (reason && reason.trim().length >= 3) void act(() => api.post(`/v1/employment-rights/short-notice/${r.id}/waive`, { reason }), 'Waived.');
                      }}
                    >
                      Waive
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const mark = (value: number, assumption: number) => (value === assumption ? ' (assumption)' : '');

function SettingsForm({ settings, onSave, onCancel }: { settings: EraSettings; onSave: (s: Record<string, unknown>) => void; onCancel: () => void }) {
  const [d, setD] = useState({
    lowHoursThreshold: settings.lowHoursThreshold,
    shortNoticeHours: settings.shortNoticeHours,
    compensationPct: Math.round(settings.compensationShare * 100),
    referenceWeeks: settings.referenceWeeks,
    responseDays: settings.responseDays,
    shortNoticeFrom: settings.shortNoticeFrom ?? '',
    guaranteedHoursFrom: settings.guaranteedHoursFrom ?? '',
  });
  const num = (k: keyof typeof d) => (e: React.ChangeEvent<HTMLInputElement>) => setD({ ...d, [k]: Number(e.target.value) });
  return (
    <div className="form premium-form">
      <label>Low hours: fewer than (hours a week)<input type="number" min={0} max={48} value={d.lowHoursThreshold} onChange={num('lowHoursThreshold')} /></label>
      <label>Short notice: less than (hours)<input type="number" min={1} max={336} value={d.shortNoticeHours} onChange={num('shortNoticeHours')} /></label>
      <label>Short notice pay (% of hours lost)<input type="number" min={0} max={200} value={d.compensationPct} onChange={num('compensationPct')} /></label>
      <label>Reference period (weeks)<input type="number" min={4} max={52} value={d.referenceWeeks} onChange={num('referenceWeeks')} /></label>
      <label>Days to answer an offer<input type="number" min={1} max={90} value={d.responseDays} onChange={num('responseDays')} /></label>
      <span />
      <label>Short notice pay starts<input type="date" value={d.shortNoticeFrom} onChange={(e) => setD({ ...d, shortNoticeFrom: e.target.value })} /></label>
      <label>Guaranteed hours offers start<input type="date" value={d.guaranteedHoursFrom} onChange={(e) => setD({ ...d, guaranteedHoursFrom: e.target.value })} /></label>
      <p className="hint span2">Set the start dates from the commencement regulations. Until then nothing is owed and nothing goes to payroll.</p>
      <div className="modal-actions span2">
        <span className="spacer" />
        <button onClick={onCancel}>Cancel</button>
        <button
          className="primary"
          onClick={() =>
            onSave({
              lowHoursThreshold: d.lowHoursThreshold,
              shortNoticeHours: d.shortNoticeHours,
              compensationShare: d.compensationPct / 100,
              referenceWeeks: d.referenceWeeks,
              responseDays: d.responseDays,
              shortNoticeFrom: d.shortNoticeFrom || null,
              guaranteedHoursFrom: d.guaranteedHoursFrom || null,
            })
          }
        >
          Save settings
        </button>
      </div>
    </div>
  );
}
