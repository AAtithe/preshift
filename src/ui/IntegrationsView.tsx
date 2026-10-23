import { useEffect, useState, type ReactNode } from 'react';
import type { RotaState } from '../engine/types';
import { api } from './api';
import { describeSync, syncedAt, type EposStatus } from './EposSetup';
import type { Account } from './SettingsView';
import { describeRewardsSync, type RewardsStatus } from './WelfareSettings';

// One page that answers "what is Preshift connected to, and is each connection healthy".
// Nothing is configured here: each card reads live status and points to where the setting lives.

interface PayrollStatus {
  provider: string;
  employees: { total: number; synced: number };
  employers: { entityId: string; name: string; payeReference: string; employerId: string | null; problem: string | null; employees: { total: number; synced: number } }[];
  outbox: { pending: number; failed: number; delivered: number };
  lastSubmission: { createdAt: string; totalHours: number } | null;
  lastPayRun: { receivedAt: string; periodStart: string } | null;
}

interface Settings {
  claudeApiKey: { set: boolean; endsWith?: string };
  email: { set: boolean; from?: string; keyEndsWith?: string };
}

interface StaffLogin { status: 'active' | 'invited' | 'expired' }

type Health = 'live' | 'partial' | 'attention' | 'off' | 'file' | 'planned';
const HEALTH_LABEL: Record<Health, string> = {
  live: 'Connected',
  partial: 'Simulator',
  attention: 'Needs attention',
  off: 'Not set up',
  file: 'File export',
  planned: 'Not connected',
};

export type IntegrationTarget = 'payroll' | 'close' | 'clock' | 'settings' | 'welfare';

// Connections Preshift does not have yet. Each card says what manual step it would remove.
const REQUEST = (name: string) =>
  `mailto:hello@preshift.co.uk?subject=${encodeURIComponent(`Preshift integration: ${name}`)}`;

interface Props {
  state: RotaState;
  account: Account | null;
  /** Holds settings.manage: sees the keys' details and manages them. */
  canSettings: boolean;
  /** The one site in scope, if any: the Payroll and Clock in tabs work on one site. */
  today: string;
  onOpen: (target: IntegrationTarget) => void;
}

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function IntegrationsView({ state, account, canSettings, today, onOpen }: Props) {
  const [payroll, setPayroll] = useState<PayrollStatus | null>(null);
  const [payrollError, setPayrollError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [logins, setLogins] = useState<StaffLogin[] | null>(null);
  const [epos, setEpos] = useState<EposStatus | null>(null);
  const [rewards, setRewards] = useState<RewardsStatus | null>(null);
  const admin = canSettings;

  useEffect(() => {
    api.get<PayrollStatus>('/v1/integrations/payroll').then(setPayroll).catch((e) => setPayrollError(e instanceof Error ? e.message : String(e)));
    api.get<StaffLogin[]>('/v1/staff-logins').then(setLogins).catch(() => setLogins(null));
    api.get<EposStatus>('/v1/integrations/epos').then(setEpos).catch(() => setEpos(null));
    api.get<RewardsStatus>('/v1/integrations/rewards').then(setRewards).catch(() => setRewards(null));
  }, []);
  // Keys are admin only; members see that a connection exists but not its details.
  useEffect(() => {
    if (admin) api.get<Settings>('/v1/settings').then(setSettings).catch(() => setSettings(null));
  }, [admin]);

  // Payroll
  const simulated = payroll?.provider.toLowerCase().includes('simulator') ?? false;
  const missingEmployer = payroll?.employers.filter((e) => !e.employerId) ?? [];
  const payrollHealth: Health | null = !payroll
    ? payrollError ? 'attention' : null
    : missingEmployer.length > 0 || payroll.outbox.failed > 0
      ? 'attention'
      : simulated ? 'partial' : 'live';
  const webhookUrl = account ? `${location.origin}/v1/integrations/teampay/webhook/${account.orgId}` : null;

  // Clock in hardware
  const active = state.employees.filter((e) => e.status !== 'leaver');
  const badged = active.filter((e) => e.badgeId).length;
  const fenced = state.sites.filter((s) => s.geofence).length;
  const clockHealth: Health = badged === 0 && fenced === 0 ? 'off' : fenced < state.sites.length ? 'attention' : 'live';

  // Staff app
  const staffActive = logins?.filter((l) => l.status === 'active').length ?? 0;
  const staffInvited = logins?.filter((l) => l.status === 'invited').length ?? 0;
  const staffHealth: Health | null = logins === null ? null : staffActive > 0 ? 'live' : staffInvited > 0 ? 'attention' : 'off';

  const keyHealth = (set: boolean | undefined): Health | null => (set === undefined ? null : set ? 'live' : 'off');
  const claudeHealth = keyHealth(settings?.claudeApiKey.set);
  const emailHealth = keyHealth(settings?.email.set);

  // Sales: what the forecast has to work with, per site.
  const forecastFrom = today;
  const forecastSites = new Set(state.forecast.filter((f) => f.date >= forecastFrom).map((f) => f.siteId)).size;

  // Right to work, as recorded by hand on each person today.
  const soon = new Date(Date.parse(today) + 60 * 86400000).toISOString().slice(0, 10);
  const rtwMissing = active.filter((e) => !e.rightToWork?.checked).length;
  const rtwExpiring = active.filter((e) => e.rightToWork?.checked && e.rightToWork.expiry && e.rightToWork.expiry <= soon).length;
  const starters = active.filter((e) => e.startDate && e.startDate > today).length;

  // EPOS
  const eposConn = epos?.connection;
  const eposMatched = epos?.sites.filter((s) => s.locationId).length ?? 0;
  const eposHealth: Health | null = !epos
    ? null
    : !eposConn
      ? 'off'
      : eposConn.lastSync?.ok === false || eposMatched === 0
        ? 'attention'
        : eposConn.environment === 'simulator' ? 'partial' : eposMatched < epos.sites.length ? 'attention' : 'live';
  const siteName = (id: string) => state.sites.find((s) => s.id === id)?.name ?? id;

  // Hospitality Rewards
  const rewardsConn = rewards?.connection;
  const rewardsHealth: Health | null = !rewards
    ? null
    : !rewardsConn
      ? 'off'
      : rewardsConn.lastSync?.ok === false || rewards.waiting > 0 || !rewardsConn.lastSync
        ? 'attention'
        : rewardsConn.environment === 'simulator' ? 'partial' : 'live';

  const known = [payrollHealth, clockHealth, staffHealth, claudeHealth, emailHealth, eposHealth, rewardsHealth].filter((h): h is Health => h !== null);
  const connected = known.filter((h) => h === 'live').length;
  const attention = known.filter((h) => h === 'attention').length;

  return (
    <div className="integrations">
      <p className="muted small integrations-lede">
        Everything Preshift exchanges data with, and whether each connection is working. Labour should reach payroll and the ledger
        without anyone re-keying it; any card not showing Connected is a step someone is still doing by hand.
      </p>
      <div className="integrations-summary">
        <span><strong>{connected}</strong> connected</span>
        <span className={attention ? 'bad-text' : 'muted'}><strong>{attention}</strong> need attention</span>
        <span className="muted"><strong>{known.length - connected - attention}</strong> not set up or simulated</span>
        <span className="muted"><strong>3</strong> not connected yet</span>
      </div>

      <h2 className="integrations-group">Sales</h2>
      <div className="integrations-grid">
        <Card
          name="EPOS"
          kind={eposConn ? (eposConn.environment === 'simulator' ? 'Square, simulated till' : eposConn.environment === 'sandbox' ? 'Square sandbox' : 'Square') : 'Square today; Lightspeed, Tevalis, Zonal and others on request'}
          health={eposHealth}
          purpose="Net takings from the till by trading day and hour. Actual sales are what turn forecast labour % into true labour %, and what tells a GM mid-week that they are overstaffed for the trade they are really doing."
          action={
            admin ? (
              <button onClick={() => onOpen('settings')}>{eposConn ? 'Manage in Settings' : 'Connect Square in Settings'}</button>
            ) : eposConn ? null : (
              <a className="button" href={REQUEST('EPOS')}>Ask for your EPOS</a>
            )
          }
        >
          <dl className="facts">
            {eposConn ? (
              <>
                <dt>Account</dt>
                <dd>{eposConn.accountName ?? 'Square'}</dd>
                <dt>Sites matched</dt>
                <dd className={eposMatched < (epos?.sites.length ?? 0) ? 'warn-text' : undefined}>{eposMatched} of {epos?.sites.length}</dd>
                <dt>Last sync</dt>
                <dd className={eposConn.lastSync?.ok === false ? 'bad-text' : undefined}>
                  {eposConn.lastSync ? `${syncedAt(eposConn.lastSync.at)}: ${describeSync(eposConn.lastSync, siteName)}` : 'Not yet'}
                </dd>
                <dt>Schedule</dt>
                <dd>The last three trading days, every morning</dd>
              </>
            ) : (
              <>
                <dt>Today</dt>
                <dd>Takings are keyed in or imported on the Takings report</dd>
                <dt>Sites with a forecast ahead</dt>
                <dd className={forecastSites < state.sites.length ? 'bad-text' : undefined}>{forecastSites} of {state.sites.length}</dd>
                <dt>What it removes</dt>
                <dd>Keying or uploading sales by hand, and labour % that only goes true at month end</dd>
              </>
            )}
          </dl>
        </Card>
      </div>

      <h2 className="integrations-group">Finance</h2>
      <div className="integrations-grid">
        <Card
          name="TeamPay"
          kind="Payroll"
          health={payrollHealth}
          purpose="Starters, changes and leavers sync as they are saved. Approved clocked hours go across as one batch per company, and the completed pay run comes back to be reconciled against the labour accrual."
          action={
            <button onClick={() => onOpen('payroll')}>Open Payroll</button>
          }
        >
          {payrollError && <p className="bad-text small">{payrollError}</p>}
          {payroll && (
            <>
              {simulated && (
                <p className="small">
                  Running against the TeamPay simulator. Nothing reaches a real payroll until the TeamPay API key is set on the server.
                </p>
              )}
              <dl className="facts">
                <dt>People set up</dt>
                <dd>{payroll.employees.synced} of {payroll.employees.total}</dd>
                <dt>Outbox</dt>
                <dd className={payroll.outbox.failed ? 'bad-text' : undefined}>
                  {payroll.outbox.pending} waiting, {payroll.outbox.failed} failed, {payroll.outbox.delivered} delivered
                </dd>
                <dt>Last hours sent</dt>
                <dd>{payroll.lastSubmission ? `${when(payroll.lastSubmission.createdAt)}, ${payroll.lastSubmission.totalHours.toFixed(1)}h` : 'None yet'}</dd>
                <dt>Last pay run back</dt>
                <dd>{payroll.lastPayRun ? when(payroll.lastPayRun.receivedAt) : 'None yet'}</dd>
              </dl>
              <table className="table">
                <thead>
                  <tr><th>Company</th><th>PAYE ref</th><th>TeamPay employer</th><th className="num">People</th></tr>
                </thead>
                <tbody>
                  {payroll.employers.map((e) => (
                    <tr key={e.entityId}>
                      <td>{e.name}</td>
                      <td className="muted">{e.payeReference}</td>
                      <td className={e.employerId ? undefined : 'bad-text'} title={e.problem ?? undefined}>{e.employerId ?? 'Not set'}</td>
                      <td className="num">{e.employees.synced} / {e.employees.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {missingEmployer.length > 0 && (
                <p className="bad-text small">
                  {missingEmployer.map((e) => e.name).join(', ')} {missingEmployer.length === 1 ? 'has' : 'have'} no TeamPay employer. Each
                  company is its own PAYE scheme, so nothing is sent until every company with hours has one.
                </p>
              )}
              {webhookUrl && !simulated && (
                <p className="small">
                  Webhook address for TeamPay: <code>{webhookUrl}</code>
                </p>
              )}
            </>
          )}
        </Card>

        <Card
          name="Xero"
          kind="Accounting"
          health="file"
          purpose="The weekly labour accrual, by role nominal and site tracking category, one journal per company, in Xero's manual journal import format. This is what lets the P&L carry true labour before payroll has run."
          action={<button onClick={() => onOpen('close')}>Open Close</button>}
        >
          <dl className="facts">
            <dt>Journals per week</dt>
            <dd>{state.entities.length}, one per company</dd>
            <dt>Tracking categories</dt>
            <dd>{state.sites.map((s) => `${s.name} (${s.trackingCode})`).join(', ')}</dd>
            <dt>How it gets there</dt>
            <dd>Download from Close and import in Xero under Manual Journals</dd>
          </dl>
        </Card>
      </div>

      <h2 className="integrations-group">Wellbeing and rewards</h2>
      <div className="integrations-grid">
        <Card
          name="Hospitality Rewards"
          kind={rewardsConn?.environment === 'simulator' ? 'Employee benefits, simulated' : 'Employee benefits'}
          health={rewardsHealth}
          purpose="Staff discounts, wellbeing support and recognition points for hospitality teams. Everyone who has started is enrolled and leavers are removed the day after their last day, so nobody re-keys the team; points a manager gives on the Wellbeing screen are credited to the person's account."
          action={<button onClick={() => onOpen('welfare')}>{admin && !rewardsConn ? 'Connect on Wellbeing' : 'Open Wellbeing'}</button>}
        >
          {rewards && (
            <dl className="facts">
              <dt>Enrolled</dt>
              <dd>{rewards.enrolled} of {rewards.eligible} eligible{rewards.optedOut ? `, ${rewards.optedOut} opted out` : ''}</dd>
              <dt>Last sync</dt>
              <dd className={rewardsConn?.lastSync?.ok === false ? 'bad-text' : undefined}>
                {rewardsConn?.lastSync ? `${when(rewardsConn.lastSync.at)}: ${describeRewardsSync(rewardsConn.lastSync)}` : rewardsConn ? 'Not yet: press Sync now on Wellbeing' : 'Not connected'}
              </dd>
              {rewards.waiting > 0 && (
                <>
                  <dt>Awards waiting</dt>
                  <dd className="warn-text">{rewards.waiting}</dd>
                </>
              )}
              <dt>Schedule</dt>
              <dd>Every morning, with the payroll retry</dd>
            </dl>
          )}
        </Card>
      </div>

      <h2 className="integrations-group">Hiring and right to work</h2>
      <div className="integrations-grid">
        <Card
          name="Talent Funnel"
          kind="Hospitality recruitment"
          health="planned"
          purpose="When a candidate is hired, they arrive in People as a starter with their site, role, start date and agreed rate already filled in, and flow on to TeamPay from there. The hiring signal from unfilled gaps on the rota goes the other way, as a vacancy."
          action={<a className="button" href={REQUEST('Talent Funnel')}>Register interest</a>}
        >
          <dl className="facts">
            <dt>Today</dt>
            <dd>Starters are typed into People by hand</dd>
            <dt>Starters not yet started</dt>
            <dd>{starters}</dd>
            <dt>What it removes</dt>
            <dd>Re-keying offer details, and pay set up wrong on day one</dd>
          </dl>
        </Card>

        <Card
          name="Other ATS"
          kind="Applicant tracking"
          health="planned"
          purpose="The same starter hand-off for groups on another applicant tracking system, such as Harri, Workable or Teamtailor. Hired candidates become starters; vacancies go out from the gaps the rota cannot fill legally."
          action={<a className="button" href={REQUEST('ATS')}>Tell us your ATS</a>}
        >
          <dl className="facts">
            <dt>Today</dt>
            <dd>Any ATS can create starters through the Preshift API</dd>
          </dl>
        </Card>

        <Card
          name="TrustID"
          kind="Right to work"
          health="planned"
          purpose="Identity document and share code checks done through TrustID, with the result, the evidence seen and any expiry written back to the person's record. A time-limited permission raises the follow-up check before it lapses, which is what keeps the statutory excuse against a civil penalty intact."
          action={<a className="button" href={REQUEST('TrustID')}>Register interest</a>}
        >
          <dl className="facts">
            <dt>Today</dt>
            <dd>Checks are done elsewhere and recorded on each person by hand</dd>
            <dt>No check recorded</dt>
            <dd className={rtwMissing ? 'bad-text' : undefined}>{rtwMissing} of {active.length} people</dd>
            <dt>Expiring within 60 days</dt>
            <dd className={rtwExpiring ? 'bad-text' : undefined}>{rtwExpiring}</dd>
          </dl>
        </Card>
      </div>

      <h2 className="integrations-group">On site</h2>
      <div className="integrations-grid">
        <Card
          name="Card readers and NFC"
          kind="Clock in"
          health={clockHealth}
          purpose="A USB RFID reader on the entrance tablet, or a phone's NFC on Android Chrome. Each site's geofence decides where signing in by name, and clocking from a phone, is allowed."
          action={
            <button onClick={() => onOpen('clock')}>
              Open Clock in
            </button>
          }
        >
          <dl className="facts">
            <dt>Cards issued</dt>
            <dd>{badged} of {active.length} people</dd>
            <dt>Sites with a geofence</dt>
            <dd className={fenced < state.sites.length ? 'bad-text' : undefined}>{fenced} of {state.sites.length}</dd>
          </dl>
          {fenced < state.sites.length && (
            <p className="small muted">
              Without a geofence, staff cannot clock in from their phones at that site. Set one under Clock in setup.
            </p>
          )}
        </Card>

        <Card
          name="Staff app"
          kind="Phones"
          health={staffHealth}
          purpose="Staff clock in and out on their own phones, record breaks and see their published shifts. Logins are separate from manager accounts and reach nothing else."
          action={
            <button onClick={() => onOpen('clock')}>
              Send invites
            </button>
          }
        >
          {logins === null ? (
            <p className="small muted">...</p>
          ) : (
            <dl className="facts">
              <dt>Active logins</dt>
              <dd>{staffActive} of {active.length} people</dd>
              <dt>Invites waiting</dt>
              <dd>{staffInvited}</dd>
              <dt>Address</dt>
              <dd><code>{location.origin}/staff/</code></dd>
            </dl>
          )}
        </Card>
      </div>

      <h2 className="integrations-group">Services</h2>
      <div className="integrations-grid">
        <Card
          name="Claude"
          kind="Rota assistant"
          health={admin ? claudeHealth : null}
          purpose="Drafts the week from a plain English request by calling the rota engine's own tools, so every shift it proposes is costed and compliance checked. Uses your organisation's own key."
          action={admin ? <button onClick={() => onOpen('settings')}>Manage key</button> : null}
        >
          <p className="small">
            {!admin
              ? 'Whoever manages settings manages this key.'
              : settings?.claudeApiKey.set
                ? `Key saved, ending ${settings.claudeApiKey.endsWith}.`
                : 'No key saved, so the assistant is off.'}
          </p>
        </Card>

        <Card
          name="Resend"
          kind="Email"
          health={admin ? emailHealth : null}
          purpose="Sends invitations, password resets and the Forgot your password link, and tracks whether each arrived. Until it is set, links are shown once to whoever sends them."
          action={admin ? <button onClick={() => onOpen('settings')}>Manage email</button> : null}
        >
          <p className="small">
            {!admin
              ? 'Whoever manages settings manages this.'
              : settings?.email.set
                ? `Sending from ${settings.email.from}, key ending ${settings.email.keyEndsWith}.`
                : 'Off. Invitation and reset links are shown to whoever sends them, to hand over.'}
          </p>
        </Card>

        <Card
          name="Preshift API"
          kind="Build your own"
          health={null}
          purpose="The open REST API the web app itself runs on. Anything this app does, an EPOS, BI tool or in-house system can do too, and webhooks tell it the moment a rota is published, a starter is added or hours are approved."
          action={
            <>
              <button onClick={() => window.open('/docs', '_blank', 'noopener')}>Open API docs</button>
              {admin && <button onClick={() => onOpen('settings')}>Manage keys and webhooks</button>}
            </>
          }
        >
          <p className="small muted">
            {admin
              ? 'Make a key for each system under Settings, limited to the scopes it needs, and revoke it when the system is retired.'
              : 'An admin makes API keys and webhooks under Settings.'}
          </p>
        </Card>
      </div>

      <h2 className="integrations-group">Other payrolls</h2>
      <div className="settings-card">
        <p className="small">
          BrightPay and Staffology. The payroll connection is written against one interface, so another payroll slots in without
          changing how the rota, costing or close work. <a href={REQUEST('Payroll')}>Tell us which one your group runs.</a>
        </p>
      </div>
    </div>
  );
}

function Card({ name, kind, health, purpose, action, children }: { name: string; kind: string; health: Health | null; purpose: string; action: ReactNode; children?: ReactNode }) {
  return (
    <section className="settings-card integration">
      <div className="integration-head">
        <div>
          <div className="muted small">{kind}</div>
          <h3>{name}</h3>
        </div>
        {health && <span className={`status health-${health}`}>{HEALTH_LABEL[health]}</span>}
      </div>
      <p className="muted small">{purpose}</p>
      {children}
      {action && <div className="integration-actions">{action}</div>}
    </section>
  );
}
