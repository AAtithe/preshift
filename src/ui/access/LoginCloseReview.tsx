import { useCallback, useEffect, useState } from 'react';
import { FLAG_TEXT, reviewRefusal, type LoginCase } from '../../engine/loginreview';
import { addDays } from '../../engine/time';
import { api, ApiError } from '../api';
import { download, toCsv } from '../format';
import { shortDate, today } from './model';

type Row = LoginCase & { name: string; siteId: string | null };
interface Answer {
  cases: Row[];
  summary: { closed: number; needsReview: number; highRisk: number };
}

const PERIODS = [
  { days: 31, label: 'Last month' },
  { days: 92, label: 'Last 3 months' },
  { days: 366, label: 'Last 12 months' },
];
const RISK: Record<LoginCase['risk'], { text: string; tone: string }> = {
  high: { text: 'High', tone: 'bad' },
  medium: { text: 'Medium', tone: 'warn' },
  low: { text: 'Low', tone: 'good' },
};
const day = (iso?: string) => (iso ? shortDate(iso.slice(0, 10)) : '');

/**
 * Staff app logins closed and opened again. A reset only ever goes to the person's own email, so
 * closing a login and inviting again is the one way a manager could set someone's login up
 * themselves and clock their hours. Each one opened again is signed off here, by someone who
 * neither closed nor re-invited it.
 */
export function LoginCloseReview({ me }: { me: string }) {
  const [days, setDays] = useState(31);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { outcome: 'genuine' | 'concern'; note: string }>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setAnswer(await api.get<Answer>(`/v1/staff-logins/review?from=${addDays(today(), -days)}&to=${today()}`));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Cannot load the staff login review');
    }
  }, [days]);
  useEffect(() => void load(), [load]);

  async function signOff(c: Row) {
    const d = drafts[c.id];
    if (!d) return;
    setBusy(true);
    try {
      await api.post('/v1/staff-logins/review', { caseId: c.id, outcome: d.outcome, note: d.note.trim() });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not record the review');
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    const header = ['Person', 'Closed', 'Closed by', 'Re-invited', 'Re-invited by', 'Link', 'Re-joined', 'Email before', 'Email after', 'Phone hours since', 'Flags', 'Risk', 'Outcome', 'Reviewed by', 'Reviewed', 'Note'];
    const rows = answer!.cases.map((c) => [
      c.name, c.closedAt, c.closedBy, c.reinvitedAt ?? '', c.reinvitedBy ?? '', c.reinvitedAt ? (c.reinviteEmailed ? 'Emailed' : 'Handed over') : '',
      c.rejoinedAt ?? '', c.previousEmail ?? '', c.newEmail ?? '', c.phoneHours, c.flags.map((f) => FLAG_TEXT[f]).join('; '), c.risk,
      c.review?.outcome ?? '', c.review?.by ?? '', c.review?.at ?? '', c.review?.note ?? '',
    ]);
    download(`preshift-staff-login-review-${today()}.csv`, toCsv([header, ...rows]));
  }

  return (
    <>
      <p className="muted lead">
        A staff app reset only ever goes to the person's own email. The one way round it is to close their login and invite them again, which is also how someone who
        has lost their address gets back in. Each login opened again is signed off here by someone who neither closed nor re-invited it: ask the person whether they
        asked for it. Monthly is the standard.
      </p>
      <div className="close-actions report-actions">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
          {PERIODS.map((p) => <option key={p.days} value={p.days}>{p.label}</option>)}
        </select>
        <button onClick={exportCsv} disabled={!answer || answer.cases.length === 0}>Download CSV</button>
      </div>
      {error && <p className="small bad-text" role="alert">{error}</p>}
      {answer && (
        <>
          <p>
            {answer.summary.closed === 0
              ? 'No staff login was closed in this period.'
              : `${answer.summary.closed} ${answer.summary.closed === 1 ? 'login' : 'logins'} closed; ${answer.summary.needsReview} to sign off${answer.summary.highRisk ? `, ${answer.summary.highRisk} high risk` : ''}.`}
          </p>
          {answer.cases.length > 0 && (
            <div className="grid-wrap">
              <table className="table">
                <thead>
                  <tr><th>Person</th><th>Closed</th><th>Opened again</th><th className="num">Phone hours since</th><th>Risk</th><th>Review</th></tr>
                </thead>
                <tbody>
                  {answer.cases.map((c) => {
                    const refused = reviewRefusal(c, me);
                    const d = drafts[c.id] ?? { outcome: 'genuine' as const, note: '' };
                    return (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td>{day(c.closedAt)} <span className="muted small">by {c.closedBy}</span></td>
                        <td>
                          {!c.reinvitedAt ? (
                            <span className="muted">Left closed</span>
                          ) : (
                            <>
                              <div>Invited {day(c.reinvitedAt)} <span className="muted small">by {c.reinvitedBy}, {c.reinviteEmailed ? 'emailed' : 'handed over'}</span></div>
                              {c.rejoinedAt ? (
                                <div className="small">Set up {day(c.rejoinedAt)}{c.newEmail ? ` with ${c.newEmail}` : ''}{c.previousEmail && c.newEmail !== c.previousEmail ? `, was ${c.previousEmail}` : ''}</div>
                              ) : (
                                <div className="small muted">Not set up yet</div>
                              )}
                              {c.flags.length > 0 && <ul className="small warn-text login-flags">{c.flags.map((f) => <li key={f}>{FLAG_TEXT[f]}</li>)}</ul>}
                            </>
                          )}
                        </td>
                        <td className="num">{c.rejoinedAt ? c.phoneHours.toFixed(1) : ''}</td>
                        <td>{c.status === 'closed' ? '' : <span className={`tag ${RISK[c.risk].tone}`}>{RISK[c.risk].text}</span>}</td>
                        <td>
                          {c.review ? (
                            <div className="small">
                              <span className={c.review.outcome === 'concern' ? 'bad-text' : 'good-text'}>{c.review.outcome === 'concern' ? 'Concern' : 'Genuine'}</span>, {c.review.by}, {day(c.review.at)}
                              <div className="muted">{c.review.note}</div>
                            </div>
                          ) : !c.needsReview ? (
                            <span className="muted small">Nothing to sign off</span>
                          ) : refused ? (
                            <span className="muted small">{refused}</span>
                          ) : (
                            <div className="login-review-form">
                              <select value={d.outcome} onChange={(e) => setDrafts({ ...drafts, [c.id]: { ...d, outcome: e.target.value as 'genuine' | 'concern' } })} aria-label={`Outcome for ${c.name}`}>
                                <option value="genuine">Genuine</option>
                                <option value="concern">Concern</option>
                              </select>
                              <input value={d.note} placeholder="What you checked, and with whom" onChange={(e) => setDrafts({ ...drafts, [c.id]: { ...d, note: e.target.value } })} aria-label={`Note for ${c.name}`} />
                              <button className="primary" disabled={busy || d.note.trim().length < 10} onClick={() => void signOff(c)}>Sign off</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
