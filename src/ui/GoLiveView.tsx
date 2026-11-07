import { useEffect, useState } from 'react';
import { byPhase, type GoLivePlan, type GoLiveStep } from '../engine/golive';
import { api } from './api';

// Getting started: the organisation's go-live plan, phase by phase, for whoever runs its settings.
// Each step says why it matters and how to do it, and opens the screen it is done on. Nothing is
// ticked by hand: a step is done when the organisation's own data shows it done.

const STATUS: Record<GoLiveStep['status'], { label: string; tone: 'good' | 'warn' | 'bad' | '' }> = {
  done: { label: 'Done', tone: 'good' },
  late: { label: 'Late', tone: 'bad' },
  due: { label: 'Due', tone: 'warn' },
  waiting: { label: 'Waiting', tone: '' },
  upcoming: { label: 'To do', tone: '' },
};

const when = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/** Fetches the plan; null until loaded, or when the person may not see it. */
export function useGoLive(enabled: boolean, refresh: unknown): GoLivePlan | null {
  const [plan, setPlan] = useState<GoLivePlan | null>(null);
  useEffect(() => {
    if (!enabled) return setPlan(null);
    let gone = false;
    api.get<GoLivePlan>('/v1/golive').then((p) => { if (!gone) setPlan(p); }).catch(() => { if (!gone) setPlan(null); });
    return () => { gone = true; };
  }, [enabled, refresh]);
  return plan;
}

/** One line at the top of the workspace while the business is still going live. */
export function GoLiveBanner({ plan, onOpen }: { plan: GoLivePlan | null; onOpen: () => void }) {
  if (!plan || plan.live) return null;
  return (
    <div className="notice">
      {plan.headline}{' '}
      <button className="link" onClick={onOpen}>Open Getting started</button>
    </div>
  );
}

export function GoLiveView({ plan, onOpen }: { plan: GoLivePlan | null; onOpen: (screen: string) => void }) {
  if (!plan) return <p className="muted">Loading the plan.</p>;
  const phases = byPhase(plan);
  const daysLeft = plan.trialEndsOn ? Math.max(0, plan.length - plan.day) : null;
  return (
    <div className="onboarding golive">
      <p className="muted small">
        The path from sign-up to running your week on Preshift Rota, in the order that pays back fastest. Every step is checked against your
        own data, so a tick here means it is really done. The aim by day 7: a rota built from your forecast and published to the team.
        By the end of the trial: takings and clocked hours coming in against it, so labour % is measured, not estimated.
      </p>

      <div className="kpis people-kpis">
        <div className={`kpi ${plan.live ? 'good' : ''}`}>
          <div className="kpi-label">Progress</div>
          <div className="kpi-value">{plan.done} of {plan.of}</div>
          <div className="onboarding-progress" aria-label={`${plan.pct}% done`}>
            <span style={{ width: `${plan.pct}%` }} className={plan.live ? 'good' : plan.late.length ? 'bad' : 'warn'} />
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Day</div>
          <div className="kpi-value">{plan.day}</div>
          <div className="kpi-hint">Started {when(plan.startedOn)}</div>
        </div>
        <div className={`kpi ${plan.late.length ? 'bad' : 'good'}`}>
          <div className="kpi-label">Behind plan</div>
          <div className="kpi-value">{plan.late.length}</div>
          <div className="kpi-hint">{plan.late.length ? 'Steps past their day' : 'On pace'}</div>
        </div>
        {daysLeft !== null && plan.billing === 'trial' && (
          <div className={`kpi ${daysLeft <= 3 ? 'warn' : ''}`}>
            <div className="kpi-label">Trial left</div>
            <div className="kpi-value">{daysLeft}</div>
            <div className="kpi-hint">Ends {when(plan.trialEndsOn!)}</div>
          </div>
        )}
      </div>

      {plan.live ? (
        <p className="notice">{plan.headline} From here the Coach, the Scorecard and the labour programme take over: they measure the week against the target and point at the next saving.</p>
      ) : plan.next ? (
        <section className="settings-card golive-next">
          <h3>Do this next: {plan.next.label}</h3>
          <p>{plan.next.why}</p>
          <p className="muted small">{plan.next.how}</p>
          <p>
            <button className="primary" onClick={() => onOpen(plan.next!.screen)}>Open {screenName(plan.next.screen)}</button>
          </p>
          <p className="muted small">Stuck? Ask Shifty (Ctrl K) "what should I do next" and it answers from this plan.</p>
        </section>
      ) : null}

      {phases.map((p) => (
        <section key={p.id} className="golive-phase">
          <h3 className="section-title">{p.label} <span className="muted small">{p.days}</span></h3>
          <ol className="onboarding-steps">
            {p.steps.map((s) => (
              <li key={s.code} className={s.status}>
                <span className={`badge ${STATUS[s.status].tone}`}>{STATUS[s.status].label}</span>
                <span className="strong">
                  {s.label}
                  {s.optional && <span className="muted small"> if it applies</span>}
                </span>
                <div className="muted small">
                  {s.done ? (s.progress ?? 'Done.') : s.why}
                  {!s.done && s.progress ? ` Now: ${s.progress}.` : ''}
                  {!s.done && !s.optional ? ` Due ${when(s.dueOn)}.` : ''}
                  {!s.done && s.status === 'waiting' ? ` After: ${s.after.map((c) => plan.steps.find((x) => x.code === c)?.label ?? c).join(', ').toLowerCase()}.` : ''}
                </div>
                {!s.done && <button className="link" onClick={() => onOpen(s.screen)}>Open</button>}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

const NAMES: Record<string, string> = {
  profile: 'Profile', setup: 'Set-up', people: 'Staff', settings: 'Settings', access: 'Access', clock: 'Clock in',
  rota: 'Rota', integrations: 'Integrations', payroll: 'Payroll', billing: 'Billing', hr: 'HR overview', training: 'Training',
};
const screenName = (s: string) => NAMES[s] ?? s;
