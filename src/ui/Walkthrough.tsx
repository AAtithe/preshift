import { useEffect, useState } from 'react';
import { HelpModal } from './HelpModal';
import type { Tab } from './nav';
import { releaseLabel, stepsFor, type Release, type WalkStep } from './walkthrough';

/**
 * What pops up at a person's first sign-in of a week with something new for them: what changed,
 * for whom, and the choice to be shown it now. Not now, Escape or a click outside counts as seen;
 * What's new in the left-hand bar brings it back.
 */
export function WhatsNewIntro({ release, steps, onStart, onDismiss }: { release: Release; steps: WalkStep[]; onStart: () => void; onDismiss: () => void }) {
  return (
    <HelpModal
      title="What's new this week"
      onClose={onDismiss}
      actions={
        <>
          <button onClick={onDismiss}>Not now</button>
          <button className="primary" onClick={onStart} autoFocus>Show me</button>
        </>
      }
    >
      <p className="muted">
        {releaseLabel(release.week)}. {steps.length} {steps.length === 1 ? 'change' : 'changes'} for you, two minutes, each shown on the screen it changed.
      </p>
      <ol className="whatsnew-list">
        {steps.map((s) => (
          <li key={s.title}>
            <span className="badge">{s.for}</span> <span className="strong">{s.title}</span>
          </li>
        ))}
      </ol>
    </HelpModal>
  );
}

/**
 * The walkthrough itself: a card docked at the side, so the screen each step opens stays usable
 * while it is read. Moving to a step opens its section; past weeks can be chosen from the list.
 */
export function Walkthrough({
  releases,
  offeredTab,
  onGo,
  onClose,
}: {
  releases: Release[];
  offeredTab: (tab: Tab) => boolean;
  onGo: (step: WalkStep) => void;
  onClose: () => void;
}) {
  const [week, setWeek] = useState(releases[0].week);
  const [at, setAt] = useState(0);
  const release = releases.find((r) => r.week === week) ?? releases[0];
  const steps = stepsFor(release, offeredTab);
  const step = steps[at];
  const last = at === steps.length - 1;

  // Each step opens the screen it is about as it comes up.
  useEffect(() => {
    if (step?.tab) onGo(step);
    // Only on moving to a step: a person who wanders off mid-step is not dragged back.
  }, [week, at]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <section className="walkthrough" aria-label="What's new walkthrough">
      <div className="walkthrough-head">
        {releases.length > 1 ? (
          <select aria-label="Week" value={release.week} onChange={(e) => { setWeek(e.target.value); setAt(0); }}>
            {releases.map((r) => <option key={r.week} value={r.week}>{releaseLabel(r.week)}</option>)}
          </select>
        ) : (
          <span className="eyebrow">{releaseLabel(release.week)}</span>
        )}
        <button className="link" onClick={onClose} aria-label="Close the walkthrough">Close</button>
      </div>
      {step ? (
        <>
          <div className="walkthrough-body">
            <span className="badge">{step.for}</span>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
            {step.tryIt && <p className="walkthrough-try"><span className="strong">Try it:</span> {step.tryIt}</p>}
            {last && <p className="walkthrough-test muted small"><span className="strong">This week's test:</span> {release.test}</p>}
          </div>
          <div className="walkthrough-foot">
            <span className="muted small" aria-live="polite">{at + 1} of {steps.length}</span>
            <div className="walkthrough-dots" aria-hidden="true">
              {steps.map((s, i) => <span key={s.title} className={i === at ? 'on' : ''} />)}
            </div>
            <button disabled={at === 0} onClick={() => setAt(at - 1)}>Back</button>
            {last ? <button className="primary" onClick={onClose}>Done</button> : <button className="primary" onClick={() => setAt(at + 1)}>Next</button>}
          </div>
        </>
      ) : (
        <div className="walkthrough-body"><p className="muted">Nothing new for your role that week.</p></div>
      )}
    </section>
  );
}
