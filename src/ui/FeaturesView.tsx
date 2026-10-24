import { useEffect, useMemo, useState } from 'react';
import { CORE_TABS, FEATURES, featureOf, type FeatureDef, type FeatureGroup } from '../engine/features';
import type { RotaState } from '../engine/types';
import { api, ApiError } from './api';
import { NAV_ITEMS, type Tab } from './nav';

interface Change {
  at: string;
  by: string;
  on: string[];
  off: string[];
}

interface FeatureSettings {
  featuresOff: string[];
  benchmarking: boolean;
  changes: Change[];
}

interface AutoApprove {
  siteId: string;
  siteName: string;
  on: boolean;
}

const GROUPS: FeatureGroup[] = ['Overview', 'Planning', 'Hours and pay', 'People', 'Finance'];
const label = (tab: string) => NAV_ITEMS.find((t) => t.id === tab)?.label ?? tab;
const problem = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const names = (ids: string[]) => ids.map((id) => featureOf(id)?.label ?? id).join(', ');

/**
 * Which parts of Preshift the organisation uses. Switches are staged and saved together, so an owner
 * sees the whole change before anyone loses a section. Switching off hides; it never deletes, and it
 * never changes who may do what: that stays on the Access tab.
 */
export function FeaturesView({ state, onChanged, onOpen }: { state: RotaState; onChanged: () => Promise<void> | void; onOpen: (tab: Tab) => void }) {
  const [saved, setSaved] = useState<FeatureSettings | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [auto, setAuto] = useState<AutoApprove[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  useEffect(() => {
    api
      .get<FeatureSettings>('/v1/settings/features')
      .then((s) => {
        setSaved(s);
        setOff(new Set(s.featuresOff));
      })
      .catch((e) => setMessage({ text: problem(e), bad: true }));
    api.get<AutoApprove[]>('/v1/open-shifts/auto-approve').then(setAuto).catch(() => setAuto([]));
  }, []);

  const before = useMemo(() => new Set(saved?.featuresOff ?? []), [saved]);
  const turningOff = FEATURES.filter((f) => off.has(f.id) && !before.has(f.id));
  const turningOn = FEATURES.filter((f) => !off.has(f.id) && before.has(f.id));
  const pending = turningOff.length + turningOn.length;
  const onCount = FEATURES.length - off.size;

  function flip(f: FeatureDef, on: boolean) {
    setMessage(null);
    setOff((s) => {
      const next = new Set(s);
      if (on) next.delete(f.id);
      else next.add(f.id);
      return next;
    });
  }

  async function save() {
    const hides = turningOff.flatMap((f) => f.tabs.map(label));
    if (hides.length && !confirm(`Hide ${hides.join(', ')} for everyone in the organisation? Nothing is deleted, and turning it back on restores it as it was.`)) return;
    setBusy(true);
    try {
      const next = await api.put<FeatureSettings>('/v1/settings/features', { featuresOff: [...off] });
      setSaved(next);
      setOff(new Set(next.featuresOff));
      const said = [turningOn.length ? `On: ${names(turningOn.map((f) => f.id))}.` : '', turningOff.length ? `Off: ${names(turningOff.map((f) => f.id))}.` : ''];
      setMessage({ text: `Saved. ${said.filter(Boolean).join(' ')} Everyone sees the change the next time their page loads.` });
      await onChanged();
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    } finally {
      setBusy(false);
    }
  }

  async function setBenchmarking(on: boolean) {
    try {
      await api.put('/v1/settings/benchmarking', { benchmarking: on });
      setSaved((s) => s && { ...s, benchmarking: on });
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  }

  async function setAutoOn(siteId: string, on: boolean) {
    try {
      await api.put('/v1/open-shifts/auto-approve', { siteId, on });
      setAuto((list) => list && list.map((a) => (a.siteId === siteId ? { ...a, on } : a)));
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  }

  if (!saved) return <div className="settings">{message ? <p className="bad-text">{message.text}</p> : <p className="muted">Loading features</p>}</div>;

  const core = CORE_TABS.filter((t) => NAV_ITEMS.some((i) => i.id === t)).map(label);
  const requestsOff = off.has('requests');
  const programmeOff = off.has('programme');

  return (
    <div className="settings features">
      <section className="settings-card">
        <div className="features-head">
          <div>
            <h2>Features</h2>
            <p className="muted small">
              Choose which parts of Preshift your organisation uses. A feature switched off leaves the bar for everyone, whatever their roles, so
              each team sees only what it works with. Nothing is deleted: records stay, the law still applies, and switching a feature back on
              restores it as it was. Who may do what is set on the{' '}
              <button type="button" className="link" onClick={() => onOpen('access')}>Access</button> tab, not here.
            </p>
          </div>
          <p className="features-count">
            <strong>{onCount}</strong> of {FEATURES.length} on
          </p>
        </div>
        <div className="features-actions">
          <button type="button" className="small" disabled={busy || off.size === 0} onClick={() => setOff(new Set())}>Turn everything on</button>
          {pending > 0 && <button type="button" className="small" disabled={busy} onClick={() => setOff(new Set(before))}>Undo changes</button>}
        </div>
      </section>

      {GROUPS.map((group) => {
        const items = FEATURES.filter((f) => f.group === group);
        return (
          <section key={group} className="settings-card">
            <h2>{group}</h2>
            <ul className="feature-list">
              {items.map((f) => {
                const on = !off.has(f.id);
                const changed = on === before.has(f.id);
                return (
                  <li key={f.id} className={`feature-row${on ? '' : ' is-off'}`}>
                    <div className="feature-text">
                      <div className="feature-name">
                        {f.label}
                        {changed && <span className="badge warn">Not saved</span>}
                      </div>
                      <p className="small muted">{f.about}</p>
                      {f.tabs.length > 1 && <p className="small muted">Sections: {f.tabs.map(label).join(', ')}.</p>}
                      {!on && f.offMeans && <p className="small feature-off-means">{f.offMeans}</p>}
                    </div>
                    <div className="toggle small-toggle" role="group" aria-label={`${f.label} on or off`}>
                      <button type="button" className={on ? 'active' : ''} aria-pressed={on} disabled={busy} onClick={() => flip(f, true)}>On</button>
                      <button type="button" className={on ? '' : 'active'} aria-pressed={!on} disabled={busy} onClick={() => flip(f, false)}>Off</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      <section className="settings-card">
        <h2>Always on</h2>
        <p className="small muted">
          The rota and what runs it, pay, and what an owner needs to stay in control and meet the law are never switched off: {core.join(', ')}.
        </p>
      </section>

      <section className="settings-card">
        <h2>Other switches</h2>
        <ul className="feature-list">
          <li className="feature-row">
            <div className="feature-text">
              <div className="feature-name">Benchmarking</div>
              <p className="small muted">
                Shares your sites' figures, anonymised, with other operators who also share, and shows you the cohort in return. Off until you turn it on.
                {programmeOff && ' The labour programme is switched off, so the benchmarks have nowhere to show until it is back on.'}
              </p>
            </div>
            <div className="toggle small-toggle" role="group" aria-label="Benchmarking on or off">
              <button type="button" className={saved.benchmarking ? 'active' : ''} aria-pressed={saved.benchmarking} onClick={() => void setBenchmarking(true)}>On</button>
              <button type="button" className={saved.benchmarking ? '' : 'active'} aria-pressed={!saved.benchmarking} onClick={() => void setBenchmarking(false)}>Off</button>
            </div>
          </li>
          {auto && auto.length > 0 && (
            <li className="feature-row feature-row-stack">
              <div className="feature-text">
                <div className="feature-name">Open shifts approved without a manager</div>
                <p className="small muted">
                  A claim is approved the moment it is made if it breaks no rule, raises nothing to review and keeps the site's labour for the week at or under target. Anything else waits for a manager.
                  {requestsOff && ' Staff requests is switched off, so managers cannot see claims that wait.'}
                </p>
              </div>
              <table className="table feature-sites">
                <tbody>
                  {auto.map((a) => (
                    <tr key={a.siteId}>
                      <td>{state.sites.find((s) => s.id === a.siteId)?.name ?? a.siteName}</td>
                      <td className="num">
                        <div className="toggle small-toggle" role="group" aria-label={`Automatic approval at ${a.siteName}`}>
                          <button type="button" className={a.on ? 'active' : ''} aria-pressed={a.on} onClick={() => void setAutoOn(a.siteId, true)}>On</button>
                          <button type="button" className={a.on ? '' : 'active'} aria-pressed={!a.on} onClick={() => void setAutoOn(a.siteId, false)}>Off</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </li>
          )}
        </ul>
        <p className="small muted">These two save as soon as they are changed, as they do on Programme and Staff requests.</p>
      </section>

      <section className="settings-card">
        <h2>Changes</h2>
        {saved.changes.length === 0 ? (
          <p className="small muted">No feature has been switched yet. Every change is kept here and in the audit trail on the Access tab, with who made it.</p>
        ) : (
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>Change</th></tr></thead>
            <tbody>
              {saved.changes.map((c, i) => (
                <tr key={`${c.at}-${i}`}>
                  <td>{when(c.at)}</td>
                  <td>{c.by}</td>
                  <td>{[c.on.length ? `On: ${names(c.on)}` : '', c.off.length ? `Off: ${names(c.off)}` : ''].filter(Boolean).join('. ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className={`features-save${pending ? ' is-pending' : ''}`} aria-live="polite">
        {message && <p className={`small ${message.bad ? 'bad-text' : 'muted'}`}>{message.text}</p>}
        {pending > 0 && (
          <>
            <p className="small">
              {pending} {pending === 1 ? 'change' : 'changes'} not saved.
              {turningOff.length > 0 && ` Off: ${names(turningOff.map((f) => f.id))}.`}
              {turningOn.length > 0 && ` On: ${names(turningOn.map((f) => f.id))}.`}
            </p>
            <button type="button" className="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving' : 'Save changes'}</button>
          </>
        )}
      </div>
    </div>
  );
}
