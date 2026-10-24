import { useEffect, useState } from 'react';
import { weekDates } from '../engine/time';
import type { TipsTaken } from '../engine/types';
import { api } from './api';
import { dayLabel, money2 } from './format';

type Source = TipsTaken['source'];

interface Props {
  siteId: string;
  week: string;
  asOf: string;
  /** This site's tips, any week. */
  tips: TipsTaken[];
  /** The scheme says the site takes no service charge and none is recorded this week, so there is no column for it. */
  noServiceCharge: boolean;
  /** The site's cash-up (time.approve with costs.view there) or payroll. */
  canRecord: boolean;
  onChanged: (change: { siteId: string; date: string; source: Source; tip: TipsTaken | null }) => void;
}

const SOURCES: { id: Source; label: string }[] = [
  { id: 'service-charge', label: 'Service charge' },
  { id: 'card-tip', label: 'Card tips' },
  { id: 'cash-pooled', label: 'Cash into the pool' },
];

const key = (date: string, source: Source) => `${date}|${source}`;

/**
 * The week's cash-up: what each day took in service charge, card tips and pooled cash. One figure per
 * day and source, so entering it again corrects it. A figure payroll has marked paid is shown, not
 * offered: the payment has to be taken back off before it can change.
 */
export function TipsTakenPanel({ siteId, week, asOf, tips, noServiceCharge, canRecord, onChanged }: Props) {
  const days = weekDates(week).filter((d) => d <= asOf);
  const sources = SOURCES.filter((s) => !(noServiceCharge && s.id === 'service-charge'));
  const recorded = (date: string, source: Source) => tips.find((t) => t.date === date && t.source === source);
  const initial = () => Object.fromEntries(days.flatMap((d) => sources.map((s) => [key(d, s.id), recorded(d, s.id)?.amount.toString() ?? ''])));
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // A new week, or figures saved, start the grid again from what is recorded. Keyed on the figures,
  // not the array, so typing is never wiped by a render.
  const recordedKey = `${siteId}|${week}|${tips.map((t) => `${t.id}:${t.amount}:${t.paidOn ?? ''}`).join(',')}`;
  useEffect(() => setDraft(initial()), [recordedKey]);

  if (days.length === 0) return null;

  const changed = days.flatMap((date) =>
    sources.flatMap((s) => {
      const value = draft[key(date, s.id)] ?? '';
      const now = recorded(date, s.id);
      const amount = value === '' ? 0 : Number(value);
      return !Number.isFinite(amount) || amount === (now?.amount ?? 0) || now?.paidOn ? [] : [{ date, source: s.id, amount }];
    }),
  );

  async function save() {
    setBusy(true);
    setNote(null);
    const failed: string[] = [];
    for (const c of changed) {
      try {
        const res = await api.put<TipsTaken | { removed: boolean }>('/v1/tronc/tips', { siteId, ...c });
        onChanged({ siteId, date: c.date, source: c.source, tip: 'id' in res ? res : null });
      } catch (err) {
        failed.push(`${dayLabel(c.date).short} ${SOURCES.find((s) => s.id === c.source)?.label.toLowerCase()}: ${(err as Error).message}`);
      }
    }
    setNote(failed.length ? failed.join(' ') : `${changed.length} figure${changed.length === 1 ? '' : 's'} saved.`);
    setBusy(false);
  }

  const total = (date: string) => sources.reduce((s, src) => s + (recorded(date, src.id)?.amount ?? 0), 0);

  return (
    <div className="panel tips-taken">
      <div className="panel-head">
        <h3>Tips taken</h3>
        {canRecord && (
          <div className="close-actions">
            <button disabled={busy || changed.length === 0} onClick={() => void save()}>
              {busy ? 'Saving' : changed.length ? `Save ${changed.length} change${changed.length === 1 ? '' : 's'}` : 'Saved'}
            </button>
          </div>
        )}
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Day</th>
            {sources.map((s) => <th key={s.id} className="num">{s.label}</th>)}
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {days.map((date) => (
            <tr key={date}>
              <td>{dayLabel(date).short} {dayLabel(date).date}</td>
              {sources.map((s) => {
                const tip = recorded(date, s.id);
                return (
                  <td key={s.id} className="num">
                    {tip?.fromTill && <span className="till-mark" title="From the till. Entering a figure here replaces it, and the till then leaves the day alone.">till</span>}{' '}
                    {canRecord && !tip?.paidOn ? (
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        aria-label={`${s.label} ${dayLabel(date).short} ${dayLabel(date).date}`}
                        value={draft[key(date, s.id)] ?? ''}
                        onChange={(e) => setDraft({ ...draft, [key(date, s.id)]: e.target.value })}
                      />
                    ) : tip ? (
                      <span title={tip.paidOn ? `Paid on ${tip.paidOn}` : undefined}>{money2(tip.amount)}{tip.paidOn ? ' paid' : ''}</span>
                    ) : (
                      <span className="muted">-</span>
                    )}
                  </td>
                );
              })}
              <td className="num">{money2(total(date))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {note && <p className="small">{note}</p>}
      <p className="small muted">
        Enter each day's figures from the cash-up; entering a day again corrects it. With a till connected, card tips and
        service charge come in from it, marked till; a figure entered here replaces the till's for that day. Paid figures are fixed: payroll takes
        the payment back off before one can change.
      </p>
    </div>
  );
}
