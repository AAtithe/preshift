import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { newEmployee } from '../engine/employees';
import {
  defaultRule,
  DEPARTMENTS,
  draftFromState,
  emptyDraft,
  newEntity,
  newSite,
  parseTeamPaste,
  pasteWarnings,
  uid,
  validateSetup,
  type PastedPerson,
  type SetupDraft,
} from '../engine/setup';
import { isAroundTheClock } from '../engine/demand';
import { formatMinute, parseClock, toISODate } from '../engine/time';
import type { DemandRule, Department, Employee, RotaState, Role, Site } from '../engine/types';
import { api, ApiError } from './api';
import { money } from './format';

interface Status {
  sample: boolean;
  empty: boolean;
  canStartFresh: boolean;
  startFreshBlocks: string[];
}

interface Props {
  state: RotaState;
  isAdmin: boolean;
  /** Reloads the organisation after a save, so every other screen sees the new set-up. */
  onSaved: () => Promise<void>;
  /** Opens on the team step: used straight after the first save of a new organisation. */
  startOnTeam?: boolean;
}

const STEPS = ['Companies', 'Sites', 'Roles', 'Trading and staffing', 'Review and save', 'Team'] as const;
const TEAM_STEP = 5;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const problem = (e: unknown) => {
  if (e instanceof ApiError && Array.isArray(e.details)) {
    return [e.message, ...e.details.map((d: unknown) => (typeof d === 'string' ? d : (d as { message?: string }).message ?? ''))].join(' ');
  }
  return e instanceof Error ? e.message : String(e);
};

export function SetupView({ state, isAdmin, onSaved, startOnTeam }: Props) {
  const initial = useMemo(() => (state.sites.length ? draftFromState(state) : emptyDraft()), [state]);
  const [draft, setDraft] = useState<SetupDraft>(initial);
  const [saved, setSaved] = useState(state.sites.length ? JSON.stringify(initial) : '');
  const [step, setStep] = useState(startOnTeam && state.sites.length ? TEAM_STEP : 0);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    api.get<Status>('/v1/setup/status').then(setStatus, () => setStatus(null));
  }, [isAdmin, state]);

  const issues = useMemo(() => validateSetup(draft), [draft]);
  const blocking = issues.filter((i) => i.severity === 'block');
  const dirty = JSON.stringify(draft) !== saved;

  if (!isAdmin) {
    return (
      <section className="settings-card">
        <h2>Set-up</h2>
        <p className="muted">Only an admin can change the companies, sites, roles and staffing rules the rota runs on.</p>
      </section>
    );
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      // Only the fields set-up owns are sent; payroll links, allowances and geofences stay as the server has them.
      const body = {
        entities: draft.entities.map(({ id, name, companyNumber, payeReference, intercompanyCode }) => ({ id, name, companyNumber, payeReference, intercompanyCode })),
        sites: draft.sites.map(({ id, name, entityId, labourTargetPct, trackingCode, openMinute, closeMinute, salesProfile }) => ({
          id, name, entityId, labourTargetPct, trackingCode, openMinute, closeMinute, salesProfile,
        })),
        roles: draft.roles,
        demandRules: draft.demandRules,
      };
      await api.put('/v1/setup', body);
      setSaved(JSON.stringify(draft));
      await onSaved();
      setMessage({ text: 'Saved. The forecast has been worked from your typical weeks for the next eight weeks.' });
      setStep(TEAM_STEP);
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    } finally {
      setBusy(false);
    }
  }

  async function startFresh() {
    if (!confirm('Remove the sample group, its people, rotas and forecast, and start with nothing? This cannot be undone.')) return;
    setBusy(true);
    try {
      await api.post('/v1/setup/start-fresh');
      await onSaved();
      const fresh = emptyDraft();
      setDraft(fresh);
      setSaved('');
      setStep(0);
      setMessage({ text: 'Sample data removed. Set up your business below.' });
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setup">
      <section className="settings-card">
        <h2>{state.sites.length ? 'Business set-up' : 'Set up your business'}</h2>
        <p className="muted small setup-lede">
          The companies that employ your staff, the sites they trade from, the roles you roster and how busy each site is.
          Labour cost, the forecast build, compliance and the close journal all run off this, so it is worth ten careful minutes.
          Changes apply from this week; past weeks stay as the record.
        </p>
        {status?.sample && (
          <div className="notice">
            <b>This is the sample group</b> (West End Dining and East Canteen), there to show how Preshift works.{' '}
            {status.canStartFresh ? (
              <>
                Remove it to set up your own business from nothing.{' '}
                <button className="danger" disabled={busy} onClick={() => void startFresh()}>Remove sample data</button>
              </>
            ) : (
              <>It can no longer be removed in one go: {status.startFreshBlocks.join(' ')} Rename and edit it below instead.</>
            )}
          </div>
        )}
      </section>

      <ol className="setup-steps">
        {STEPS.map((label, i) => (
          <li key={label}>
            <button
              className={i === step ? 'active' : i < step ? 'done' : ''}
              disabled={i === TEAM_STEP && (dirty || !state.sites.length)}
              title={i === TEAM_STEP && (dirty || !state.sites.length) ? 'Save the set-up first' : undefined}
              onClick={() => setStep(i)}
            >
              <span>{i + 1}</span> {label}
            </button>
          </li>
        ))}
      </ol>

      <section className="settings-card setup-body">
        {step === 0 && <CompaniesStep draft={draft} setDraft={setDraft} />}
        {step === 1 && <SitesStep draft={draft} setDraft={setDraft} />}
        {step === 2 && <RolesStep draft={draft} setDraft={setDraft} />}
        {step === 3 && <TradingStep draft={draft} setDraft={setDraft} />}
        {step === 4 && <ReviewStep draft={draft} issues={issues} />}
        {step === TEAM_STEP && <TeamStep state={state} onAdded={onSaved} />}
      </section>

      {message && <div className={`notice${message.bad ? ' error' : ''}`} role={message.bad ? 'alert' : 'status'}>{message.text}</div>}

      <div className="setup-nav">
        <button disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
        {step < 4 && <button className="primary" onClick={() => setStep(step + 1)}>Next: {STEPS[step + 1]}</button>}
        {step === 4 && (
          <button className="primary" disabled={busy || blocking.length > 0 || !dirty} title={blocking.length ? 'Fix the items marked in red first' : !dirty ? 'Nothing has changed' : undefined} onClick={() => void save()}>
            {busy ? 'Saving' : 'Save set-up'}
          </button>
        )}
      </div>
    </div>
  );
}

type StepProps = { draft: SetupDraft; setDraft: (d: SetupDraft) => void };

function Num(props: { value: number; onChange: (n: number) => void; step?: number; label: string; width?: number }) {
  return (
    <input
      type="number"
      aria-label={props.label}
      step={props.step ?? 1}
      min={0}
      style={{ width: props.width ?? 96 }}
      value={Number.isFinite(props.value) ? props.value : ''}
      onChange={(e) => props.onChange(e.target.value === '' ? 0 : Number(e.target.value))}
    />
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="setup-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function CompaniesStep({ draft, setDraft }: StepProps) {
  const update = (id: string, patch: Partial<SetupDraft['entities'][number]>) =>
    setDraft({ ...draft, entities: draft.entities.map((e) => (e.id === id ? { ...e, ...patch } : e)) });
  return (
    <>
      <p className="step-intro">
        Each limited company that employs staff or trades a site. Each has its own PAYE scheme and its own books, so labour is
        costed per company and recharged between them when someone works at another company's site. Most single-site
        operators have one.
      </p>
      {draft.entities.map((e) => (
        <div key={e.id} className="setup-row">
          <Field label="Registered name"><input value={e.name} placeholder="e.g. Clerkenwell Kitchen Ltd" onChange={(x) => update(e.id, { name: x.target.value })} /></Field>
          <Field label="Company number"><input value={e.companyNumber} placeholder="12345678" style={{ width: 110 }} onChange={(x) => update(e.id, { companyNumber: x.target.value })} /></Field>
          <Field label="PAYE reference" hint="On your P32 or HMRC letters"><input value={e.payeReference} placeholder="120/AB12345" style={{ width: 130 }} onChange={(x) => update(e.id, { payeReference: x.target.value })} /></Field>
          {draft.entities.length > 1 && (
            <Field label="Intercompany code" hint="Same in every ledger"><input value={e.intercompanyCode} placeholder="1351" style={{ width: 90 }} onChange={(x) => update(e.id, { intercompanyCode: x.target.value })} /></Field>
          )}
          {draft.entities.length > 1 && (
            <button className="link danger" onClick={() => setDraft({ ...draft, entities: draft.entities.filter((x) => x.id !== e.id), sites: draft.sites.map((s) => (s.entityId === e.id ? { ...s, entityId: '' } : s)) })}>
              Remove
            </button>
          )}
        </div>
      ))}
      <button onClick={() => setDraft({ ...draft, entities: [...draft.entities, newEntity()] })}>Add another company</button>
    </>
  );
}

function SitesStep({ draft, setDraft }: StepProps) {
  const update = (id: string, patch: Partial<Site>) => setDraft({ ...draft, sites: draft.sites.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  function add() {
    const site = newSite(draft.entities[0]?.id ?? '');
    setDraft({ ...draft, sites: [...draft.sites, site], demandRules: [...draft.demandRules, ...draft.roles.flatMap((r) => defaultRule(r, site.id) ?? [])] });
  }
  return (
    <>
      <p className="step-intro">
        One entry per trading site. Opening hours decide which hours the rota has to cover. The labour target is loaded labour
        (wages plus holiday, employer NI and pension) as a share of net sales, and is what every week is measured against.
      </p>
      {draft.sites.map((site) => (
        <div key={site.id} className="setup-row">
          <Field label="Site name">
            <input
              value={site.name}
              placeholder="e.g. Clerkenwell"
              onChange={(e) => update(site.id, { name: e.target.value, trackingCode: site.trackingCode === site.name ? e.target.value : site.trackingCode })}
            />
          </Field>
          <Field label="Company">
            <select value={site.entityId} onChange={(e) => update(site.id, { entityId: e.target.value })}>
              {!site.entityId && <option value="">Choose</option>}
              {draft.entities.map((e) => <option key={e.id} value={e.id}>{e.name || 'Unnamed company'}</option>)}
            </select>
          </Field>
          <Field label="Opens">
            <input
              type="time"
              value={formatMinute(site.openMinute)}
              onChange={(e) => {
                const at = parseClock(e.target.value);
                // A site open round the clock stays open round the clock from its new opening time.
                update(site.id, isAroundTheClock(site) ? { openMinute: at, closeMinute: at + 1440 } : { openMinute: at });
              }}
            />
          </Field>
          <Field label="Closes" hint={isAroundTheClock(site) ? 'Open round the clock' : site.closeMinute > 1440 ? 'The next morning' : 'After midnight is fine'}>
            <input
              type="time"
              value={formatMinute(site.closeMinute)}
              disabled={isAroundTheClock(site)}
              // A closing time at or before opening is after midnight: 02:00 for a site opening at noon.
              onChange={(e) => {
                const at = parseClock(e.target.value);
                update(site.id, { closeMinute: at <= site.openMinute ? at + 1440 : at });
              }}
            />
            <label className="check-inline small">
              <input
                type="checkbox"
                checked={isAroundTheClock(site)}
                onChange={(e) => update(site.id, { closeMinute: e.target.checked ? site.openMinute + 1440 : Math.min(site.openMinute + 12 * 60, 1440) })}
              />{' '}
              Open round the clock
            </label>
          </Field>
          <Field label="Labour target %">
            <Num label="Labour target percent" step={0.5} width={80} value={Math.round(site.labourTargetPct * 1000) / 10} onChange={(n) => update(site.id, { labourTargetPct: n / 100 })} />
          </Field>
          <Field label="Tracking category" hint="As it appears in Xero"><input value={site.trackingCode} style={{ width: 140 }} onChange={(e) => update(site.id, { trackingCode: e.target.value })} /></Field>
          {draft.sites.length > 1 && (
            <button className="link danger" onClick={() => setDraft({ ...draft, sites: draft.sites.filter((s) => s.id !== site.id), demandRules: draft.demandRules.filter((r) => r.siteId !== site.id) })}>
              Remove
            </button>
          )}
        </div>
      ))}
      <button onClick={add}>Add another site</button>
    </>
  );
}

function RolesStep({ draft, setDraft }: StepProps) {
  const update = (id: string, patch: Partial<Role>) => setDraft({ ...draft, roles: draft.roles.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  function add() {
    const role: Role = { id: uid('role'), name: '', department: 'FOH', nominalCode: '7000' };
    setDraft({ ...draft, roles: [...draft.roles, role], demandRules: [...draft.demandRules, ...draft.sites.flatMap((s) => defaultRule(role, s.id) ?? [])] });
  }
  return (
    <>
      <p className="step-intro">
        We start you with the roles most of our restaurant clients use. Rename, add or remove them to match how you staff. The
        nominal code is the wages account each role posts to in the labour accrual, so wages land on the right line of the P&amp;L.
      </p>
      <table className="table">
        <thead><tr><th>Role</th><th>Department</th><th>Nominal code</th><th /></tr></thead>
        <tbody>
          {draft.roles.map((role) => (
            <tr key={role.id}>
              <td><input value={role.name} placeholder="e.g. Sommelier" onChange={(e) => update(role.id, { name: e.target.value })} /></td>
              <td>
                <select
                  value={role.department}
                  onChange={(e) => {
                    const department = e.target.value as Department;
                    update(role.id, { department, nominalCode: DEPARTMENTS.find((d) => d.id === department)!.nominalCode });
                  }}
                >
                  {DEPARTMENTS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
              </td>
              <td><input value={role.nominalCode} style={{ width: 90 }} onChange={(e) => update(role.id, { nominalCode: e.target.value })} /></td>
              <td className="num">
                <button className="link danger" onClick={() => setDraft({ ...draft, roles: draft.roles.filter((r) => r.id !== role.id), demandRules: draft.demandRules.filter((r) => r.roleId !== role.id) })}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={add}>Add a role</button>
    </>
  );
}

type Driver = 'covers' | 'sales' | 'manual';

function TradingStep({ draft, setDraft }: StepProps) {
  const updateSite = (id: string, patch: Partial<Site>) => setDraft({ ...draft, sites: draft.sites.map((s) => (s.id === id ? { ...s, ...patch } : s)) });

  function setRule(siteId: string, role: Role, patch: Partial<DemandRule> | null) {
    const rest = draft.demandRules.filter((r) => !(r.siteId === siteId && r.roleId === role.id));
    if (patch === null) return setDraft({ ...draft, demandRules: rest });
    const current = draft.demandRules.find((r) => r.siteId === siteId && r.roleId === role.id) ?? { roleId: role.id, siteId, minimumWhileOpen: 1, maximum: 3 };
    setDraft({ ...draft, demandRules: [...rest, { ...current, ...patch }] });
  }

  function setDriver(siteId: string, role: Role, driver: Driver) {
    if (driver === 'manual') return setRule(siteId, role, null);
    const fallback = defaultRule({ ...role, id: '', department: driver === 'sales' ? 'BAR' : 'FOH' }, siteId)!;
    setRule(siteId, role, driver === 'sales'
      ? { salesPerLabourHour: fallback.salesPerLabourHour, coversPerHour: undefined }
      : { coversPerHour: fallback.coversPerHour, salesPerLabourHour: undefined });
  }

  return (
    <>
      <p className="step-intro">
        Two things drive the build from forecast. First, a typical week's net sales for each day, excluding VAT and service
        charge. We spread each day across your opening hours on a standard lunch and dinner pattern and turn it into covers with
        your average spend. When Preshift Reports or your till sends real hourly figures for a week, those replace it. Second,
        how many covers or how much in sales one person in each role carries in an hour, with a floor while open and a ceiling.
        Roles set to "by hand" are never built automatically.
      </p>
      {draft.sites.map((site) => {
        const profile = site.salesProfile ?? { dailySales: [0, 0, 0, 0, 0, 0, 0], averageSpend: 0 };
        const week = profile.dailySales.reduce((a, b) => a + (b || 0), 0);
        const setProfile = (patch: Partial<typeof profile>) => updateSite(site.id, { salesProfile: { ...profile, ...patch } });
        return (
          <div key={site.id} className="setup-site">
            <h3>{site.name || 'Unnamed site'}</h3>
            <div className="setup-row">
              {DAYS.map((d, i) => (
                <Field key={d} label={d}>
                  <Num label={`${d} net sales`} step={100} width={88} value={profile.dailySales[i]} onChange={(n) => setProfile({ dailySales: profile.dailySales.map((v, j) => (j === i ? n : v)) })} />
                </Field>
              ))}
              <Field label="Average spend"><Num label="Average spend per cover" step={0.5} width={80} value={profile.averageSpend} onChange={(n) => setProfile({ averageSpend: n })} /></Field>
            </div>
            <p className="muted small">
              {money(week)} a week, about {profile.averageSpend > 0 ? Math.round(week / profile.averageSpend).toLocaleString('en-GB') : 0} covers. At a{' '}
              {(site.labourTargetPct * 100).toFixed(1)}% target that is a loaded labour budget of {money(week * site.labourTargetPct)} a week.
            </p>
            <table className="table">
              <thead><tr><th>Role</th><th>Driven by</th><th>Per person per hour</th><th>Minimum while open</th><th>Maximum</th></tr></thead>
              <tbody>
                {draft.roles.map((role) => {
                  const rule = draft.demandRules.find((r) => r.siteId === site.id && r.roleId === role.id);
                  const driver: Driver = !rule ? 'manual' : rule.salesPerLabourHour ? 'sales' : 'covers';
                  return (
                    <tr key={role.id}>
                      <td>{role.name || 'Unnamed role'}</td>
                      <td>
                        <select value={driver} onChange={(e) => setDriver(site.id, role, e.target.value as Driver)}>
                          <option value="covers">Covers</option>
                          <option value="sales">Sales</option>
                          <option value="manual">By hand</option>
                        </select>
                      </td>
                      <td>
                        {rule && driver === 'covers' && <><Num label="Covers per person per hour" width={70} value={rule.coversPerHour ?? 0} onChange={(n) => setRule(site.id, role, { coversPerHour: n })} /> covers</>}
                        {rule && driver === 'sales' && <>£<Num label="Sales per labour hour" step={10} width={80} value={rule.salesPerLabourHour ?? 0} onChange={(n) => setRule(site.id, role, { salesPerLabourHour: n })} /></>}
                      </td>
                      <td>{rule && <Num label="Minimum while open" width={60} value={rule.minimumWhileOpen} onChange={(n) => setRule(site.id, role, { minimumWhileOpen: n })} />}</td>
                      <td>{rule && <Num label="Maximum headcount" width={60} value={rule.maximum} onChange={(n) => setRule(site.id, role, { maximum: n })} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}

function ReviewStep({ draft, issues }: { draft: SetupDraft; issues: ReturnType<typeof validateSetup> }) {
  return (
    <>
      <table className="table">
        <thead>
          <tr><th>Site</th><th>Company</th><th>Hours</th><th className="num">Weekly sales</th><th className="num">Target</th><th className="num">Labour budget</th></tr>
        </thead>
        <tbody>
          {draft.sites.map((s) => {
            const week = (s.salesProfile?.dailySales ?? []).reduce((a, b) => a + (b || 0), 0);
            return (
              <tr key={s.id}>
                <td>{s.name || 'Unnamed site'}</td>
                <td className="muted">{draft.entities.find((e) => e.id === s.entityId)?.name || 'None'}</td>
                <td className="tnum">{isAroundTheClock(s) ? 'Round the clock' : `${formatMinute(s.openMinute)} to ${formatMinute(s.closeMinute)}`}</td>
                <td className="num">{money(week)}</td>
                <td className="num">{(s.labourTargetPct * 100).toFixed(1)}%</td>
                <td className="num strong">{money(week * s.labourTargetPct)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {issues.length === 0 ? (
        <p>Everything checks out. Save, then add your team.</p>
      ) : (
        <ul className="issues">
          {issues.map((i, n) => <li key={n} className={i.severity}>{i.message}</li>)}
        </ul>
      )}
      <p className="muted small">
        Removing a company, site or role that people, rotas or clocked time still use is refused when you save, with the reason.
        Those are payroll records, so move people or mark them as leavers in People first.
      </p>
    </>
  );
}

type Result = { name: string; ok: boolean; message?: string };

function TeamStep({ state, onAdded }: { state: RotaState; onAdded: () => Promise<void> }) {
  const [siteId, setSiteId] = useState(state.sites[0]?.id ?? '');
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<{ people: PastedPerson[]; errors: string[]; warnings: string[] } | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  // Rates a person pastes in are proposals: they wait for the finance director like any pay change.
  const [awaitingPay, setAwaitingPay] = useState(0);
  const [busy, setBusy] = useState(false);
  const today = toISODate(new Date());
  const site = state.sites.find((s) => s.id === siteId);
  const team = state.employees.filter((e) => e.siteId === siteId && e.status !== 'leaver');

  function preview() {
    const { people, errors } = parseTeamPaste(text, state.roles);
    setParsed({ people, errors, warnings: pasteWarnings(people, today) });
    setResults([]);
  }

  async function add() {
    if (!parsed || !site) return;
    setBusy(true);
    const done: Result[] = [];
    let awaiting = 0;
    // One at a time through the starter route, so each person is set up in payroll exactly as from People.
    for (const { person } of parsed.people) {
      const base = newEmployee(site.id, site.entityId, person.roleIds[0], today);
      const { id: _id, startDate: _start, ...rest } = { ...base, ...person };
      const body: Partial<Employee> = { ...rest, ...(person.startDate ? { startDate: person.startDate } : {}) };
      try {
        const saved = await api.post<Employee>('/v1/employees', body);
        if (saved.pendingPay) awaiting++;
        done.push({ name: person.name, ok: true });
      } catch (e) {
        done.push({ name: person.name, ok: false, message: problem(e) });
      }
      setResults([...done]);
    }
    await onAdded();
    setAwaitingPay(awaiting);
    setBusy(false);
    if (done.every((r) => r.ok)) {
      setText('');
      setParsed(null);
    }
  }

  if (!site) return <p className="muted">Save at least one site first.</p>;

  return (
    <>
      <p className="step-intro">
        Paste your team from Excel, Google Sheets or a payroll export, one person per line, in this order: Name, Roles, Rate or
        salary, Date of birth, Contracted hours, Start date, Right to work checked on. Separate several roles with a slash, e.g.
        Server/Host. Anything over £1,000 is read as an annual salary. Leave the start date blank for people already working for
        you. Nobody can be rostered without a right to work check on file: give the date it was done, or record it in People
        with the evidence seen. Availability and the rest of each record are completed in People.
      </p>
      <div className="notice">
        If your payroll already runs in TeamPay, people already there are linked to their existing record, not set up twice:
        automatically where TeamPay holds exactly one person with the same name and date of birth, and by hand in Payroll, under
        "Link existing TeamPay people", for anyone else. Where the two disagree on pay or hours, nothing is overwritten until
        someone decides which is right.
      </div>
      <div className="setup-row">
        <Field label="Site">
          <select value={siteId} onChange={(e) => { setSiteId(e.target.value); setParsed(null); setResults([]); }}>
            {state.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <p className="muted small">{team.length ? `${team.length} people at ${site.name} already: ${team.slice(0, 6).map((e) => e.name).join(', ')}${team.length > 6 ? ' and more' : ''}.` : `No one at ${site.name} yet.`}</p>
      </div>
      <textarea
        className="setup-paste"
        rows={7}
        value={text}
        placeholder={'Alex Doe, Server/Host, 13.25, 01/02/1999, 32, , 14/03/2023\nPat Lee, General Manager, 48000, 30/06/1985, 45, , 02/09/2021\nSam Cook, Chef, 15.50, 12/04/2001, 40, 03/11/2026'}
        onChange={(e) => { setText(e.target.value); setParsed(null); }}
      />
      <div className="row-actions">
        <button disabled={!text.trim()} onClick={preview}>Check the list</button>
        {parsed && parsed.people.length > 0 && (
          <button className="primary" disabled={busy} onClick={() => void add()}>
            {busy ? `Adding ${results.length + 1} of ${parsed.people.length}` : `Add ${parsed.people.length} ${parsed.people.length === 1 ? 'person' : 'people'} to ${site.name}`}
          </button>
        )}
      </div>
      {parsed && (
        <>
          {parsed.people.length > 0 && (
            <table className="table">
              <thead><tr><th>Name</th><th>Roles</th><th className="num">Pay</th><th>Date of birth</th><th className="num">Contract</th><th>Start</th><th>Right to work</th><th /></tr></thead>
              <tbody>
                {parsed.people.map(({ line, person }) => {
                  const r = results.find((x) => x.name === person.name);
                  return (
                    <tr key={line}>
                      <td>{person.name}</td>
                      <td className="muted">{person.roleIds.map((id) => state.roles.find((x) => x.id === id)?.name).join(', ')}</td>
                      <td className="num">{person.payBasis === 'salaried' ? `${money(person.annualSalary)} pa` : `£${person.hourlyRate.toFixed(2)}`}</td>
                      <td className="tnum">{new Date(`${person.dateOfBirth}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC' })}</td>
                      <td className="num">{person.contractedHours ? `${person.contractedHours}h` : 'Flexible'}</td>
                      <td className="muted">{person.startDate ? new Date(`${person.startDate}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC' }) : 'Existing'}</td>
                      <td>{person.rightToWork?.checked ? <span className="muted">Checked</span> : <span className="tag bad">Not on file</span>}</td>
                      <td>{r && <span className={`badge ${r.ok ? 'good' : 'bad'}`} title={r.message}>{r.ok ? 'Added' : 'Not added'}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {parsed.people.some((p) => !p.person.rightToWork?.checked) && (
            <p className="small">
              {parsed.people.filter((p) => !p.person.rightToWork?.checked).length} without a right to work check will be added but
              cannot be rostered until the check is recorded in People.
            </p>
          )}
          {(parsed.errors.length > 0 || parsed.warnings.length > 0) && (
            <ul className="issues">
              {parsed.errors.map((m, i) => <li key={`e${i}`} className="block">{m}</li>)}
              {parsed.warnings.map((m, i) => <li key={`w${i}`} className="warn">{m}</li>)}
              {parsed.errors.length > 0 && <li className="muted">Lines in red are left out. Fix them in the box and check again.</li>}
            </ul>
          )}
          {results.some((r) => !r.ok) && (
            <ul className="issues">
              {results.filter((r) => !r.ok).map((r) => <li key={r.name} className="block">{r.name}: {r.message}</li>)}
            </ul>
          )}
        </>
      )}
      {awaitingPay > 0 && (
        <p className="notice">
          {awaitingPay} {awaitingPay === 1 ? 'rate is' : 'rates are'} waiting for the finance director under Pay approvals. Until approved,
          those people are on nought and cannot be costed or paid.
        </p>
      )}
    </>
  );
}
