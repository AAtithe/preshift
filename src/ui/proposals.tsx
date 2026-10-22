import { useState } from 'react';
import type { Proposal, Screen } from '../ai/appTools';
import type { Employee } from '../engine/types';
import type { useRotaStore } from './store';

type Actions = ReturnType<typeof useRotaStore>['actions'];

export interface ProposalDeps {
  actions: Actions;
  goTo: (screen: Screen) => void;
  openAssistant: (instruction: string) => void;
  /** Opens the full People editor on a starter, to check or add more before saving. */
  reviewStarter: (employee: Employee) => void;
}

/**
 * Carries out a confirmed proposal through the app's own actions, so every API check still applies.
 * Resolves to a line describing what happened; rejects if the app refused it.
 */
export async function carryOut(p: Proposal, deps: ProposalDeps): Promise<string> {
  const { actions } = deps;
  const done = <T,>(value: T | undefined, line: string) => {
    if (value === undefined) throw new Error(`Not saved: ${actions.lastError() ?? 'the app did not accept it.'}`);
    return line;
  };
  switch (p.kind) {
    case 'add_starter':
      return done(await actions.saveEmployee(p.employee, true), `Added ${p.employee.name} as a starter.`);
    case 'update_person':
      return done(await actions.saveEmployee(p.employee, false), `Updated ${p.employee.name}'s record.`);
    case 'mark_leaver': {
      const res = await actions.markLeaver(p.employeeId, p.leaveDate);
      return done(res, `Marked as a leaver from ${p.leaveDate}${res?.shiftsRemoved ? `; ${res.shiftsRemoved} later shifts removed` : ''}.`);
    }
    case 'book_leave':
      return done(await actions.saveEmployee(p.employee, false), `Booked leave for ${p.employee.name} on ${p.dates.join(', ')}.`);
    case 'record_absence': {
      const res = await actions.saveAbsence(p.employeeId, p.absence, true);
      return done(res, `Recorded the absence${res?.clashes.length ? `; ${res.clashes.length} rostered shifts need re-covering` : ''}.`);
    }
    case 'add_shift':
      return done(await actions.saveShift(p.shift, true), 'Added the shift.');
    case 'remove_shift':
      return done(await actions.deleteShift(p.shiftId), 'Removed the shift.');
    case 'publish_week':
      return done(await actions.publish(p.siteIds, p.weekStart), 'Published the week.');
    case 'draft_rota':
      deps.openAssistant(p.instruction);
      return 'Opened the rota assistant with the request.';
    case 'go_to':
      deps.goTo(p.screen);
      return `Opened ${p.screen}.`;
  }
}

/** Navigation needs no confirmation; everything else waits for the manager. */
export const needsConfirmation = (p: Proposal) => p.kind !== 'go_to';

export type ProposalState = 'waiting' | 'working' | 'done' | 'cancelled' | 'failed';

export function ProposalCard({
  proposal,
  deps,
  onSettled,
}: {
  proposal: Proposal;
  deps: ProposalDeps;
  /** Reports what happened, for Shifty to be told on the next message. */
  onSettled: (outcome: string) => void;
}) {
  const [status, setStatus] = useState<ProposalState>('waiting');
  const [note, setNote] = useState<string | null>(null);

  async function confirm() {
    setStatus('working');
    try {
      const line = await carryOut(proposal, deps);
      setStatus('done');
      setNote(line);
      onSettled(`the manager confirmed "${proposal.summary}": ${line}`);
    } catch (e) {
      setStatus('failed');
      setNote((e as Error).message);
      onSettled(`"${proposal.summary}" was confirmed but the app refused it`);
    }
  }

  function cancel() {
    setStatus('cancelled');
    onSettled(`the manager cancelled "${proposal.summary}"`);
  }

  const openLabel = proposal.kind === 'draft_rota' ? 'Open the rota assistant' : 'Confirm';
  return (
    <div className={`proposal ${status}`}>
      <div className="proposal-title">{proposal.summary}</div>
      {proposal.details.length > 0 && (
        <dl className="proposal-details">
          {proposal.details.map((d) => (
            <div key={d.label}>
              <dt>{d.label}</dt>
              <dd>{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {proposal.warnings.map((w) => <p key={w} className="proposal-warning">{w}</p>)}
      {status === 'waiting' && (
        <div className="proposal-actions">
          <button className="primary" onClick={() => void confirm()}>{openLabel}</button>
          {proposal.kind === 'add_starter' && (
            <button onClick={() => { setStatus('cancelled'); onSettled('the manager opened the starter in People to finish it there'); deps.reviewStarter(proposal.employee); }}>
              Review in People
            </button>
          )}
          <button className="link" onClick={cancel}>Cancel</button>
        </div>
      )}
      {status === 'working' && <p className="muted small">Saving...</p>}
      {status === 'cancelled' && <p className="muted small">Not done.</p>}
      {note && <p className={`small ${status === 'failed' ? 'bad-text' : 'good-text'}`}>{note}</p>}
    </div>
  );
}
