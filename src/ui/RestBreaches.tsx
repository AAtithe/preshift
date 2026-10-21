import { useState } from 'react';
import type { Issue } from '../engine/compliance';
import type { RotaState } from '../engine/types';
import { dayLabel } from './format';

interface Props {
  state: RotaState;
  issues: Issue[];
  onOverride: (key: string, reason: string) => Promise<unknown>;
  onWithdraw: (id: string) => Promise<unknown>;
}

const MIN_REASON = 15;

/**
 * Rest breaches in scope, each with the one way past it short of changing the rota: a manager's
 * recorded reason. The reason travels with the breach, so the audit trail shows who decided and why.
 */
export function RestBreaches({ state, issues, onOverride, onWithdraw }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const rest = issues.filter((i) => i.overrideKey);
  if (rest.length === 0) return null;
  const name = (id: string) => state.employees.find((e) => e.id === id)?.name ?? id;

  async function submit(key: string) {
    setBusy(true);
    const saved = await onOverride(key, reason.trim());
    setBusy(false);
    // Keep the form and the reason if it did not save; the error shows above.
    if (!saved) return;
    setOpen(null);
    setReason('');
  }

  return (
    <div className="notice">
      <strong>Rest breaches</strong>{' '}
      Fix the rota where you can. Where the business needs it, record why and the compensatory rest
      they will get; the breach then publishes as a warning with your name on it.
      <ul className="issues">
        {rest.map((i) => (
          <li key={i.overrideKey} className={i.severity}>
            {name(i.employeeId)}
            {i.date ? `, ${dayLabel(i.date).short} ${dayLabel(i.date).date}` : ', this week'}: {i.message}{' '}
            {i.overridden ? (
              <button className="link" disabled={busy} onClick={async () => { setBusy(true); await onWithdraw(i.overridden!.id); setBusy(false); }}>
                Withdraw override
              </button>
            ) : open === i.overrideKey ? (
              <span className="override-form">
                <textarea
                  value={reason}
                  maxLength={500}
                  rows={2}
                  placeholder="Why, and what compensatory rest they get (for example: covering sickness, Thursday off instead)"
                  onChange={(e) => setReason(e.target.value)}
                  aria-label="Reason for override"
                />
                <button className="primary" disabled={busy || reason.trim().length < MIN_REASON} onClick={() => void submit(i.overrideKey!)}>
                  Override
                </button>
                <button onClick={() => { setOpen(null); setReason(''); }}>Cancel</button>
              </span>
            ) : (
              <button className="link" onClick={() => { setOpen(i.overrideKey!); setReason(''); }}>Override with a reason</button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
