import { useCallback, useEffect, useState } from 'react';
import { formatMinute, parseClock } from '../engine/time';
import type { WelfarePolicy } from '../engine/welfare';
import { api } from './api';
import { download } from './format';
import type { WelfareOverview } from './WelfareView';

// The organisation's welfare policy and its Hospitality Rewards connection, for whoever manages
// settings. Connecting checks the key and sends nobody; people go across only on "Sync now" or the
// morning sync after it.

export interface RewardsStatus {
  connection: {
    environment: 'production' | 'simulator';
    baseUrl?: string;
    connectedAt: string;
    connectedBy: string;
    accountName?: string;
    lastSync?: { at: string; ok: boolean; error?: string; enrolled: number; removed: number; awarded: number; waiting: number };
  } | null;
  keyEndsWith: string | null;
  eligible: number;
  enrolled: number;
  optedOut: number;
  waiting: number;
  simulatorAllowed: boolean;
}

const at = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** A late finish typed as a clock time: anything before 06:00 is after midnight. */
const toMinute = (clock: string) => {
  const m = parseClock(clock);
  return m < 6 * 60 ? m + 1440 : m;
};

export function describeRewardsSync(s: NonNullable<NonNullable<RewardsStatus['connection']>['lastSync']>) {
  if (!s.ok && s.error) return `Failed: ${s.error}`;
  return `${s.enrolled} enrolled or updated, ${s.removed} removed, ${s.awarded} awards credited${s.waiting ? `, ${s.waiting} waiting` : ''}`;
}

export function WelfareSettings({ overview, onChanged }: { overview: WelfareOverview; onChanged: () => Promise<void> }) {
  const [policy, setPolicy] = useState<WelfarePolicy>(overview.policy);
  const [late, setLate] = useState(formatMinute(overview.policy.lateFinishMinute));
  const [status, setStatus] = useState<RewardsStatus | null>(null);
  const [environment, setEnvironment] = useState<'production' | 'simulator'>('production');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = useCallback(async () => {
    const s = await api.get<RewardsStatus>('/v1/integrations/rewards');
    setStatus(s);
    if (s.connection) {
      setEnvironment(s.connection.environment);
      setBaseUrl(s.connection.baseUrl ?? '');
    }
  }, []);
  useEffect(() => {
    load().catch((e) => setMessage({ text: e instanceof Error ? e.message : String(e), bad: true }));
  }, [load]);

  async function run(label: string, fn: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      const text = await fn();
      await Promise.all([load(), onChanged()]);
      setMessage({ text });
    } catch (e) {
      setMessage({ text: `${label}: ${e instanceof Error ? e.message : String(e)}`, bad: true });
    } finally {
      setBusy(false);
    }
  }

  const savePolicy = () =>
    run('Policy', async () => {
      const next = await api.put<WelfarePolicy>('/v1/welfare/policy', {
        lateFinishMinute: toMinute(late),
        travelHomeAllowance: policy.travelHomeAllowance,
        under18TravelHome: policy.under18TravelHome,
        mealFromHours: policy.mealFromHours,
        mealCost: policy.mealCost,
        pointsPerSiteMonth: policy.pointsPerSiteMonth,
        supportLine: policy.supportLine?.name?.trim() ? policy.supportLine : null,
      });
      setPolicy(next);
      return 'Policy saved. The staff app shows the support line straight away.';
    });

  const connect = () =>
    run('Connect', async () => {
      await api.put('/v1/integrations/rewards', environment === 'simulator' ? { environment } : { environment, baseUrl, ...(apiKey ? { apiKey } : {}) });
      setApiKey('');
      return 'Connected and the key checked. Nobody has been sent yet: press Sync now when you are ready.';
    });

  const sync = () =>
    run('Sync', async () => {
      const r = await api.post<NonNullable<NonNullable<RewardsStatus['connection']>['lastSync']>>('/v1/integrations/rewards/sync');
      if (!r.ok) throw new Error(r.error);
      return describeRewardsSync(r);
    });

  const disconnect = () =>
    run('Disconnect', async () => {
      await api.del('/v1/integrations/rewards');
      return 'Disconnected. Ask Hospitality Rewards to close the memberships: Preshift can no longer reach them.';
    });

  const eligibility = () =>
    run('Eligibility file', async () => {
      const csv = await api.get<string>('/v1/integrations/rewards/eligibility.csv');
      download(`hospitality-rewards-eligibility-${overview.today}.csv`, csv);
      return 'Downloaded. It holds names and work emails: send it to Hospitality Rewards through their secure upload, not by email.';
    });

  const conn = status?.connection;
  const line = policy.supportLine ?? { name: '' };

  return (
    <>
      <h3 className="section-title">Policy and connections</h3>
      <div className="welfare-settings">
        <section className="settings-card">
          <h2>Welfare policy</h2>
          <p className="muted small">What the business commits to. Every figure has a sensible default; change only what you have agreed.</p>
          <form className="settings-form" onSubmit={(e) => { e.preventDefault(); void savePolicy(); }}>
            <label>
              Late finish from
              <input type="time" value={late} onChange={(e) => setLate(e.target.value)} />
            </label>
            <label>
              Travel home allowance (£ a journey)
              <input type="number" min={0} max={100} step={0.5} value={policy.travelHomeAllowance} onChange={(e) => setPolicy({ ...policy, travelHomeAllowance: Number(e.target.value) })} />
            </label>
            <label className="check-inline">
              <input type="checkbox" checked={policy.under18TravelHome} onChange={(e) => setPolicy({ ...policy, under18TravelHome: e.target.checked })} />
              Always arrange a way home for under 18s after 22:00
            </label>
            <label>
              Staff meal on shifts of (hours)
              <input type="number" min={3} max={12} step={0.5} value={policy.mealFromHours} onChange={(e) => setPolicy({ ...policy, mealFromHours: Number(e.target.value) })} />
            </label>
            <label>
              Food cost a meal (£)
              <input type="number" min={0} max={25} step={0.1} value={policy.mealCost} onChange={(e) => setPolicy({ ...policy, mealCost: Number(e.target.value) })} />
            </label>
            <label>
              Recognition points per site a month
              <input type="number" min={0} step={50} value={policy.pointsPerSiteMonth} onChange={(e) => setPolicy({ ...policy, pointsPerSiteMonth: Number(e.target.value) })} />
            </label>
            <label>
              Support line shown in the staff app
              <input value={line.name} placeholder="Your employee assistance programme" maxLength={80} onChange={(e) => setPolicy({ ...policy, supportLine: { ...line, name: e.target.value } })} />
            </label>
            <label>
              Its phone number
              <input value={line.phone ?? ''} maxLength={30} onChange={(e) => setPolicy({ ...policy, supportLine: { ...line, phone: e.target.value } })} />
            </label>
            <label>
              Its web address
              <input value={line.url ?? ''} placeholder="https://" maxLength={200} onChange={(e) => setPolicy({ ...policy, supportLine: { ...line, url: e.target.value } })} />
            </label>
            <button className="primary" type="submit" disabled={busy}>Save policy</button>
          </form>
          <p className="muted small">
            Hospitality Action runs an employee assistance programme for hospitality businesses; put your own provider's details here. The
            staff app always shows Samaritans, 116 123, free at any hour, as well.
          </p>
        </section>

        <section className="settings-card">
          <h2>Hospitality Rewards</h2>
          <p className="muted small">
            Staff discounts, wellbeing support and recognition points for hospitality teams. Preshift enrols everyone who has started and
            not opted out, removes leavers the day after their last day, and credits the points managers give. It sends name, work email,
            site, company and start date: never pay, age, absence or anything from the personnel file.
          </p>
          {!status ? (
            <p className="small muted">...</p>
          ) : (
            <>
              <p className="small">
                {conn
                  ? `Connected to ${conn.accountName ?? 'Hospitality Rewards'} by ${conn.connectedBy}, ${at(conn.connectedAt)}.${status.keyEndsWith ? ` Key ending ${status.keyEndsWith}.` : ''}`
                  : 'Not connected. Recognition still works; points are recorded but not credited anywhere.'}
              </p>
              <dl className="facts">
                <dt>Eligible today</dt>
                <dd>{status.eligible}</dd>
                <dt>Enrolled</dt>
                <dd>{status.enrolled}</dd>
                <dt>Opted out</dt>
                <dd>{status.optedOut}</dd>
                {status.waiting > 0 && (
                  <>
                    <dt>Awards waiting</dt>
                    <dd className="warn-text">{status.waiting}</dd>
                  </>
                )}
                {conn?.lastSync && (
                  <>
                    <dt>Last sync</dt>
                    <dd className={conn.lastSync.ok ? undefined : 'bad-text'}>{at(conn.lastSync.at)}: {describeRewardsSync(conn.lastSync)}</dd>
                  </>
                )}
              </dl>
              <form className="settings-form" onSubmit={(e) => { e.preventDefault(); void connect(); }}>
                <label>
                  Account
                  <select value={environment} onChange={(e) => setEnvironment(e.target.value as 'production' | 'simulator')}>
                    <option value="production">Hospitality Rewards</option>
                    {status.simulatorAllowed && <option value="simulator">Simulated (demo)</option>}
                  </select>
                </label>
                {environment === 'production' && (
                  <>
                    <label>
                      API address
                      <input type="url" required placeholder="https://" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                    </label>
                    <label>
                      {conn && status.keyEndsWith ? 'Replace API key (optional)' : 'API key'}
                      <input type="password" autoComplete="off" required={!status.keyEndsWith} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                    </label>
                  </>
                )}
                <button className="primary" type="submit" disabled={busy}>{conn ? 'Reconnect' : 'Connect'}</button>
                {conn && <button type="button" disabled={busy} onClick={() => void sync()}>Sync now</button>}
                {conn && <button type="button" className="danger" disabled={busy} onClick={() => { if (confirm('Disconnect Hospitality Rewards? Points waiting will not be sent, and memberships must be closed with Hospitality Rewards.')) void disconnect(); }}>Disconnect</button>}
              </form>
              <p className="muted small">
                Hospitality Rewards agrees API access account by account: ask your account manager for the API address and a key. Until
                then, the eligibility file does the same job by upload.{' '}
                <button className="link" disabled={busy} onClick={() => void eligibility()}>Download the eligibility file</button>
              </p>
              <p className="muted small">
                Before going live, add Hospitality Rewards to your staff privacy notice and check the contract says whether they act as your
                processor or as a controller once someone signs up. Anyone can opt out from the staff app.
              </p>
            </>
          )}
        </section>
      </div>
      {message && <p className={`small ${message.bad ? 'bad-text' : 'good-text'}`} role="status">{message.text}</p>}
    </>
  );
}
