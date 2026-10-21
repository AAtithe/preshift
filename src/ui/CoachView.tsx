import { useCallback, useEffect, useState } from 'react';
import type { Move, MoveRecord } from '../engine/coach';
import type { Scorecard } from '../engine/scorecard';
import { addDays } from '../engine/time';
import type { RotaState } from '../engine/types';
import { api, ApiError } from './api';
import { dayLabel, hours, money, pct } from './format';

interface Props {
  state: RotaState;
  siteId: string;
  week: string;
  /** Reloads the rota after a move changes a shift. */
  onChanged: () => Promise<void>;
}

interface Offer {
  moves: Move[];
  records: MoveRecord[];
  labourPctBefore: number;
  labourPctAfter: number;
  saving: number;
}

type HistoryRow = MoveRecord & { realisedSaving: number | null };

const problem = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/**
 * The GM's coach: this week's moves, priced and one tap to take, then the
 * ladder and scorecard that show whether the habits are holding. Every move
 * taken is measured against the clock once the week is worked.
 */
export function CoachView({ state, siteId, week, onChanged }: Props) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [card, setCard] = useState<Scorecard | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const [declining, setDeclining] = useState<{ id: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [o, c, h] = await Promise.all([
        api.post<Offer>('/v1/coach/moves', { siteId, weekStart: week }),
        api.get<Scorecard>(`/v1/scorecard?siteId=${siteId}&weeks=8`),
        api.get<HistoryRow[]>(`/v1/coach/history?siteId=${siteId}`),
      ]);
      setOffer(o);
      setCard(c);
      setHistory(h.filter((m) => m.status !== 'offered').sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? '')));
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  }, [siteId, week]);

  // The moves follow the rota: offer again whenever the week's shifts change.
  const weekEnd = addDays(week, 6);
  const weekShiftsKey = state.shifts
    .filter((s) => s.siteId === siteId && s.date >= week && s.date <= weekEnd)
    .map((s) => `${s.id}:${s.employeeId}:${s.startMinute}:${s.endMinute}:${s.breakMinutes}`)
    .join();
  useEffect(() => void load(), [load, weekShiftsKey]);

  async function take(move: Move) {
    setBusy(true);
    try {
      await api.post('/v1/coach/apply', { moveId: move.id });
      setMessage({ text: `Taken: ${move.title}` });
      await onChanged();
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    if (!declining) return;
    setBusy(true);
    try {
      await api.post('/v1/coach/dismiss', { moveId: declining.id, reason: declining.reason || undefined });
      setDeclining(null);
      await load();
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    } finally {
      setBusy(false);
    }
  }

  const realised = history.filter((m) => m.status === 'taken' && m.realisedSaving !== null);

  return (
    <div className="coach">
      {message && (
        <div className={`notice ${message.bad ? 'error' : ''}`}>
          {message.text} <button className="link" onClick={() => setMessage(null)}>Dismiss</button>
        </div>
      )}

      <section className="settings-card">
        <div className="coach-head">
          <div>
            <h2>This week's moves</h2>
            <p className="muted small">
              The changes that save most without leaving the floor short or breaking a rule. Savings are loaded (holiday, NI and
              pension) and worked on each person's whole week, so for people who also work another site they can differ a little
              from this site's labour line. Each move assumes the ones above it are taken; take them in order, or refresh after
              skipping one.
            </p>
          </div>
          {offer && offer.moves.length > 0 && (
            <div className="coach-total">
              <div className="big good-text">{money(offer.saving)}</div>
              <div className="muted small">
                Labour {pct(offer.labourPctBefore)} to {pct(offer.labourPctAfter)}
              </div>
            </div>
          )}
        </div>
        {!offer ? (
          <p className="muted">Working out the moves</p>
        ) : offer.moves.length === 0 ? (
          <p className="muted">
            Nothing worth moving. Every hour still to come is staffed to the forecast, or the remaining savings are under £5. Build
            the week first if it is empty.
          </p>
        ) : (
          <ol className="moves">
            {offer.moves.map((m) => (
              <li key={m.id} className="move">
                <div className="move-body">
                  <div className="move-title">{m.title}</div>
                  <div className="muted small">{m.detail}</div>
                  {declining?.id === m.id && (
                    <div className="settings-form move-decline">
                      <label>
                        Why not? (helps the coaching)
                        <input
                          value={declining.reason}
                          maxLength={300}
                          placeholder="e.g. Function booked, need the cover"
                          onChange={(e) => setDeclining({ id: m.id, reason: e.target.value })}
                        />
                      </label>
                      <button disabled={busy} onClick={() => void decline()}>Turn down</button>
                      <button className="link" onClick={() => setDeclining(null)}>Cancel</button>
                    </div>
                  )}
                </div>
                <div className="move-actions">
                  <span className="big">{money(m.saving)}</span>
                  <button className="primary" disabled={busy} onClick={() => void take(m)}>Take it</button>
                  <button className="link" disabled={busy} onClick={() => setDeclining({ id: m.id, reason: '' })}>Not this one</button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {card && <Ladder card={card} />}

      {card && (
        <section className="settings-card">
          <h2>Scorecard</h2>
          <p className="muted small">The last eight finished weeks. Actual labour, and clocked time against the rota, appear once every hour at the site is approved.</p>
          <div className="grid-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Week</th>
                  <th className="num">Notice</th>
                  <th className="num">Labour planned</th>
                  <th className="num">Labour actual</th>
                  <th className="num">Target</th>
                  <th className="num">Over demand</th>
                  <th className="num">Clock vs rota</th>
                  <th className="num">Forecast error</th>
                  <th className="num">Moves taken</th>
                  <th className="num">Saved</th>
                </tr>
              </thead>
              <tbody>
                {card.weeks.map((w) => (
                  <tr key={w.weekStart}>
                    <td>w/c {dayLabel(w.weekStart).date}{!w.legal && <span className="tag bad">Blocking</span>}</td>
                    <td className={`num ${w.publishedOnTime ? 'good-text' : 'bad-text'}`}>{w.noticeDays === undefined ? 'Not published' : `${w.noticeDays} days`}</td>
                    <td className="num">{w.plannedLabourPct ? pct(w.plannedLabourPct) : 'None'}</td>
                    <td className="num">{w.actualLabourPct === null ? 'Pending' : pct(w.actualLabourPct)}</td>
                    <td className={`num ${w.onTarget ? 'good-text' : 'muted'}`}>{pct(w.targetPct, 0)}</td>
                    <td className="num">{w.rosteredHours === 0 ? 'No rota' : <>{pct(w.overstaffedShare)} <span className="muted small">({hours(w.overstaffedHours)})</span></>}</td>
                    <td className="num">{w.rotaToPayrollVariance === null ? 'Pending' : pct(w.rotaToPayrollVariance, 2)}</td>
                    <td className="num">{w.forecastWape === null ? 'No till data' : pct(w.forecastWape)}</td>
                    <td className="num">{w.movesOffered ? `${w.movesTaken} of ${w.movesOffered}` : 'None offered'}</td>
                    <td className="num">{!w.movesTaken ? '' : w.actualLabourPct === null ? 'Pending' : money(w.realisedSaving)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="settings-card">
        <h2>Moves taken and turned down</h2>
        {history.length === 0 ? (
          <p className="muted">No moves decided yet.</p>
        ) : (
          <>
            {realised.length > 0 && (
              <p className="muted small">
                Promised {money(realised.reduce((s, m) => s + m.expectedSaving, 0))} on the weeks already worked; the clock says{' '}
                {money(realised.reduce((s, m) => s + (m.realisedSaving ?? 0), 0))}. Most of any gap is people working past the new times; check those shifts in the clock record.
              </p>
            )}
            <div className="grid-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Week</th>
                    <th>Move</th>
                    <th>Decision</th>
                    <th className="num">Promised</th>
                    <th className="num">Realised</th>
                  </tr>
                </thead>
                <tbody>
                  {history.slice(0, 20).map((m) => (
                    <tr key={`${m.weekStart}${m.id}`}>
                      <td>w/c {dayLabel(m.weekStart).date}</td>
                      <td>{m.title}</td>
                      <td>
                        {m.status === 'taken' ? 'Taken' : 'Turned down'} by {m.decidedBy}
                        {m.reason && <div className="muted small">{m.reason}</div>}
                      </td>
                      <td className="num">{money(m.expectedSaving)}</td>
                      <td className="num">{m.status !== 'taken' ? '' : m.realisedSaving === null ? 'After the week' : money(m.realisedSaving)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function Ladder({ card }: { card: Scorecard }) {
  const m = card.maturity;
  return (
    <section className="settings-card">
      <h2>The ladder: rung {m.level} of 4</h2>
      <p className="muted small">Each rung is a habit that has to hold three weeks in four before the next one counts.</p>
      <ol className="ladder">
        {m.rungs.map((r) => (
          <li key={r.level} className={r.met ? 'met' : r.level === m.level + 1 ? 'next' : ''}>
            <span className="step-n">{r.level}</span>
            <div>
              <strong>{r.label}</strong>
              <div className="muted small">{r.detail}</div>
            </div>
          </li>
        ))}
      </ol>
      <div className="notice coach-next">
        <strong>Next step.</strong> {m.next}
      </div>
    </section>
  );
}
