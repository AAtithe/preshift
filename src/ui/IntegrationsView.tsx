import { useEffect, useState, type ReactNode } from 'react';
import type { RotaState } from '../engine/types';
import { api } from './api';
import type { Me } from './SettingsView';

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

export type IntegrationTarget = 'payroll' | 'close' | 'clock' | 'settings';

// Connections Preshift does not have yet. Each card says what manual step it would remove.
const REQUEST = (name: string) =>
  `mailto:hello@preshift.co.uk?subject=${encodeURIComponent(`Preshift integration: ${name}`)}`;

interface Props {
  state: RotaState;
  me: Me | null;
  /** The one site in scope, if any: the Payroll and Clock in tabs work on one site. */
  singleSite: boolean;
  today: string;
  onOpen: (target: IntegrationTarget) => void;
}

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function IntegrationsView({ state, me, singleSite, today, onOpen }: Props) {
  const [payroll, setPayroll] = useState<PayrollStatus | null>(null);
  const [payrollError, setPayrollError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [logins, setLogins] = useState<StaffLogin[] | null>(null);
  const admin = me?.role === 'admin';

  useEffect(() => {
    api.get<PayrollStatus>('/v1/integrations/payroll').then(setPayroll).catch((e) => setPayrollError(e instanceof Error ? e.message : String(e)));
    api.get<StaffLogin[]>('/v1/staff-logins').then(setLogins).catch(() => setLogins(null));
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
  const webhookUrl = me ? `${location.origin}/v1/integrations/teampay/webhook/${me.orgId}` : null;

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

  const known = [payrollHealth, clockHealth, staffHealth, claudeHealth, emailHealth].filter((h): h is Health => h !== null);
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
        <span className="muted"><strong>4</strong> not connected yet</span>
      </div>

      <h2 className="integrations-group">Sales</h2>
      <div className="integrations-grid">
        <Card
          name="EPOS"
          kind="Lightspeed, Square, Tevalis, Zonal and others"
          health="planned"
          purpose="Hourly net sales and covers from the till, both as history to forecast from and as actuals. Actual sales are what turn forecast labour % into true labour %, and what tells a GM mid-week that they are overstaffed for the trade they are really doing."
          action={<a className="button" href={REQUEST('EPOS')}>Ask for your EPOS</a>}
        >
          <dl className="facts">
            <dt>Today</dt>
            <dd>Forecasts are pushed through the API, for example from Preshift Reports</dd>
            <dt>Sites with a forecast ahead</dt>
            <dd className={forecastSites < state.sites.length ? 'bad-text' : undefined}>{forecastSites} of {state.sites.length}</dd>
            <dt>What it removes</dt>
            <dd>Keying or uploading sales by hand, and labour % that only goes true at month end</dd>
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
            <button
              disabled={!singleSite}
              title={singleSite ? undefined : 'Choose one site to open Payroll'}
              onClick={() => onOpen('payroll')}
            >
              Open Payroll
            </button>
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
            <button disabled={!singleSite} title={singleSite ? undefined : 'Choose one site to open Clock in'} onClick={() => onOpen('clock')}>
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
            <button disabled={!singleSite} title={singleSite ? undefined : 'Choose one site to open Clock in'} onClick={() => onOpen('clock')}>
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
              ? 'An admin manages this key under Settings.'
              : settings?.claudeApiKey.set
                ? `Key saved, ending ${settings.claudeApiKey.endsWith}.`
                : 'No key saved, so the assistant is off.'}
          </p>
        </Card>

        <Card
          name="Resend"
          kind="Email"
          health={admin ? emailHealth : null}
          purpose="Sends the single-use link behind Forgot your password on the sign-in page. Until it is set, an admin hands out reset links by hand."
          action={admin ? <button onClick={() => onOpen('settings')}>Manage email</button> : null}
        >
          <p className="small">
            {!admin
              ? 'An admin manages this under Settings.'
              : settings?.email.set
                ? `Sending from ${settings.email.from}, key ending ${settings.email.keyEndsWith}.`
                : 'Off. Reset links are handed out by an admin.'}
          </p>
        </Card>

        <Card
          name="Preshift API"
          kind="Build your own"
          health={null}
          purpose="The REST API the web app itself runs on, with scoped API keys per organisation. Anything this app does, an EPOS, BI tool or in-house system can do too."
          action={<button onClick={() => window.open('/docs', '_blank', 'noopener')}>Open API docs</button>}
        >
          <p className="small muted">API keys are issued by Preshift for your organisation, each limited to the scopes it needs.</p>
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
