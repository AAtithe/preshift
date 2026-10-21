import { useMemo, useState, type ReactNode } from 'react';
import {
  defaultRule,
  DEPARTMENTS,
  droppedShifts,
  newEmployee,
  newSite,
  parseTeamPaste,
  uid,
  validateSetup,
  type SetupDraft,
} from '../engine/setup';
import { formatMinute, parseClock } from '../engine/time';
import type { DemandRule, Department, Employee, Role, RotaState, Site } from '../engine/types';
import { money } from './format';

interface Props {
  initial: SetupDraft;
  /** The account's current state when editing; null for a new account. */
  prev: RotaState | null;
  onFinish: (draft: SetupDraft) => Promise<void> | void;
  onCancel?: () => void;
}

const STEPS = ['Sites', 'Roles', 'Team', 'Trading and staffing', 'Review'] as const;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function Setup({ initial, prev, onFinish, onCancel }: Props) {
  const [draft, setDraft] = useState<SetupDraft>(initial);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const issues = useMemo(() => validateSetup(draft), [draft]);
  const errors = issues.filter((i) => i.severity === 'error');

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      await onFinish(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the set-up.');
      setBusy(false);
    }
  }

  return (
    <div className="setup">
      <header className="setup-head">
        <div>
          <h1>{prev ? 'Edit set-up' : 'Set up your account'}</h1>
          <p className="muted">
            {prev
              ? 'Changes apply from this week. Past forecasts and rotas stay as they were.'
              : 'Tell us how your sites trade and who works there. The rota, labour cost and compliance checks all run off this, so it is worth ten careful minutes.'}
          </p>
        </div>
        {onCancel && <button onClick={onCancel}>Cancel</button>}
      </header>

      <ol className="steps">
        {STEPS.map((label, i) => (
          <li key={label}>
            <button className={i === step ? 'active' : i < step ? 'done' : ''} onClick={() => setStep(i)}>
              <span>{i + 1}</span> {label}
            </button>
          </li>
        ))}
      </ol>

      <section className="setup-body">
        {step === 0 && <SitesStep draft={draft} setDraft={setDraft} />}
        {step === 1 && <RolesStep draft={draft} setDraft={setDraft} />}
        {step === 2 && <TeamStep draft={draft} setDraft={setDraft} />}
        {step === 3 && <TradingStep draft={draft} setDraft={setDraft} />}
        {step === 4 && <ReviewStep draft={draft} prev={prev} issues={issues} />}
      </section>

      {error && <p className="login-error" role="alert">{error}</p>}

      <footer className="setup-nav">
        <button disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
        {step < STEPS.length - 1 ? (
          <button className="primary" onClick={() => setStep(step + 1)}>Next: {STEPS[step + 1]}</button>
        ) : (
          <button
            className="primary"
            disabled={errors.length > 0 || busy}
            title={errors.length ? 'Fix the items marked as errors first' : undefined}
            onClick={finish}
          >
            {busy ? 'Saving' : prev ? 'Save changes' : 'Finish set-up'}
          </button>
        )}
      </footer>
    </div>
  );
}

type StepProps = { draft: SetupDraft; setDraft: (d: SetupDraft) => void };

function Num(props: { value: number; onChange: (n: number) => void; step?: number; min?: number; label: string; width?: string }) {
  return (
    <input
      type="number"
      aria-label={props.label}
      step={props.step ?? 1}
      min={props.min ?? 0}
      style={{ width: props.width ?? '90px' }}
      value={Number.isFinite(props.value) ? props.value : ''}
      onChange={(e) => props.onChange(e.target.value === '' ? 0 : Number(e.target.value))}
    />
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

function SitesStep({ draft, setDraft }: StepProps) {
  const update = (id: string, patch: Partial<Site>) =>
    setDraft({ ...draft, sites: draft.sites.map((s) => (s.id === id ? { ...s, ...patch } : s)) });

  function add() {
    const site = newSite();
    setDraft({
      ...draft,
      sites: [...draft.sites, site],
      demandRules: [...draft.demandRules, ...draft.roles.flatMap((r) => defaultRule(r, site.id) ?? [])],
    });
  }

  function remove(site: Site) {
    const people = draft.employees.filter((e) => e.siteId === site.id).length;
    if (people && !confirm(`Remove ${site.name || 'this site'} and its ${people} team members?`)) return;
    setDraft({
      ...draft,
      sites: draft.sites.filter((s) => s.id !== site.id),
      employees: draft.employees.filter((e) => e.siteId !== site.id),
      demandRules: draft.demandRules.filter((r) => r.siteId !== site.id),
    });
  }

  return (
    <>
      <p className="step-intro">
        One entry per trading site. Opening hours decide which hours the rota has to cover. The labour target is
        loaded labour (wages plus holiday, employer NI and pension) as a share of net sales, and is what the rota is
        measured against every week.
      </p>
      {draft.sites.map((site) => (
        <div key={site.id} className="setup-card">
          <div className="field-row">
            <Field label="Site name">
              <input
                value={site.name}
                placeholder="e.g. Marylebone"
                onChange={(e) =>
                  update(site.id, {
                    name: e.target.value,
                    // Keep the tracking category following the name until someone sets it themselves.
                    trackingCode: site.trackingCode === site.name ? e.target.value : site.trackingCode,
                  })
                }
              />
            </Field>
            <Field label="Opens">
              <input type="time" value={formatMinute(site.openMinute)} onChange={(e) => update(site.id, { openMinute: parseClock(e.target.value) })} />
            </Field>
            <Field label="Closes" hint="Midnight at the latest">
              <input
                type="time"
                value={formatMinute(site.closeMinute)}
                onChange={(e) => update(site.id, { closeMinute: parseClock(e.target.value) || 1440 })}
              />
            </Field>
            <Field label="Labour target %">
              <Num
                label="Labour target percent"
                step={0.5}
                value={Math.round(site.labourTargetPct * 1000) / 10}
                onChange={(n) => update(site.id, { labourTargetPct: n / 100 })}
              />
            </Field>
            <Field label="Tracking category" hint="As it appears in Xero">
              <input value={site.trackingCode} onChange={(e) => update(site.id, { trackingCode: e.target.value })} />
            </Field>
          </div>
          {draft.sites.length > 1 && <button className="link danger" onClick={() => remove(site)}>Remove site</button>}
        </div>
      ))}
      <button onClick={add}>Add another site</button>
    </>
  );
}

function RolesStep({ draft, setDraft }: StepProps) {
  const update = (id: string, patch: Partial<Role>) =>
    setDraft({ ...draft, roles: draft.roles.map((r) => (r.id === id ? { ...r, ...patch } : r)) });

  function add() {
    const role: Role = { id: uid('role'), name: '', department: 'FOH', nominalCode: '7000' };
    setDraft({
      ...draft,
      roles: [...draft.roles, role],
      demandRules: [...draft.demandRules, ...draft.sites.flatMap((s) => defaultRule(role, s.id) ?? [])],
    });
  }

  function remove(role: Role) {
    const trained = draft.employees.filter((e) => e.roleIds.includes(role.id)).length;
    if (trained && !confirm(`${trained} team members are trained as ${role.name}. Remove the role from them too?`)) return;
    setDraft({
      ...draft,
      roles: draft.roles.filter((r) => r.id !== role.id),
      employees: draft.employees.map((e) => ({ ...e, roleIds: e.roleIds.filter((id) => id !== role.id) })),
      demandRules: draft.demandRules.filter((r) => r.roleId !== role.id),
    });
  }

  return (
    <>
      <p className="step-intro">
        We have started you with the roles most of our restaurant clients use. Rename, add or remove them to match how
        you actually staff. The nominal code is the wages account each role posts to in the labour accrual journal,
        so wages land in the right line of the P&amp;L.
      </p>
      <div className="grid-wrap">
        <table className="table">
          <thead>
            <tr><th>Role</th><th>Department</th><th>Nominal code</th><th /></tr>
          </thead>
          <tbody>
            {draft.roles.map((role) => (
              <tr key={role.id}>
                <td><input value={role.name} placeholder="e.g. Sommelier" onChange={(e) => update(role.id, { name: e.target.value })} /></td>
                <td>
                  <select
                    value={role.department}
                    onChange={(e) => {
                      const department = e.target.value as Department;
                      const code = DEPARTMENTS.find((d) => d.id === department)!.nominalCode;
                      update(role.id, { department, nominalCode: code });
                    }}
                  >
                    {DEPARTMENTS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                  </select>
                </td>
                <td><input value={role.nominalCode} style={{ width: '90px' }} onChange={(e) => update(role.id, { nominalCode: e.target.value })} /></td>
                <td><button className="link danger" onClick={() => remove(role)}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button onClick={add}>Add a role</button>
    </>
  );
}

function TeamStep({ draft, setDraft }: StepProps) {
  const [siteId, setSiteId] = useState(draft.sites[0]?.id ?? '');
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteErrors, setPasteErrors] = useState<string[]>([]);
  const people = draft.employees.filter((e) => e.siteId === siteId);

  const update = (id: string, patch: Partial<Employee>) =>
    setDraft({ ...draft, employees: draft.employees.map((e) => (e.id === id ? { ...e, ...patch } : e)) });

  function toggleRole(e: Employee, roleId: string) {
    const has = e.roleIds.includes(roleId);
    update(e.id, { roleIds: has ? e.roleIds.filter((r) => r !== roleId) : [...e.roleIds, roleId] });
  }

  function importPaste() {
    const { employees, errors } = parseTeamPaste(pasteText, siteId, draft.roles);
    setPasteErrors(errors);
    setDraft({ ...draft, employees: [...draft.employees, ...employees] });
    if (employees.length && !errors.length) {
      setPasteText('');
      setPasting(false);
    }
  }

  if (!draft.sites.length) return <p className="muted">Add a site first.</p>;

  return (
    <>
      <p className="step-intro">
        Everyone who can be rostered. Date of birth is required: it sets the minimum wage band and the young worker
        limits, which are where most rota fines come from. Contracted hours are guaranteed and costed whether rostered
        or not; leave at 0 for flexible staff, whose holiday then accrues at 12.07% of hours worked. The first role
        ticked is their main role.
      </p>
      {draft.sites.length > 1 && (
        <div className="day-pills">
          {draft.sites.map((s) => (
            <button key={s.id} className={s.id === siteId ? 'active' : ''} onClick={() => setSiteId(s.id)}>
              {s.name || 'Unnamed site'} ({draft.employees.filter((e) => e.siteId === s.id).length})
            </button>
          ))}
        </div>
      )}
      <div className="grid-wrap">
        <table className="table team-edit">
          <thead>
            <tr>
              <th>Name</th><th>Roles</th><th>Pay</th><th>Rate or salary</th><th>Date of birth</th>
              <th>Contract hrs</th><th>Max hrs</th><th>48h opt-out</th><th>Pension</th><th />
            </tr>
          </thead>
          <tbody>
            {people.map((e) => (
              <tr key={e.id}>
                <td><input value={e.name} placeholder="Full name" onChange={(x) => update(e.id, { name: x.target.value })} /></td>
                <td>
                  <div className="role-pills">
                    {draft.roles.map((r) => (
                      <button key={r.id} className={e.roleIds.includes(r.id) ? 'on' : ''} onClick={() => toggleRole(e, r.id)}>
                        {r.name || 'Unnamed'}
                      </button>
                    ))}
                  </div>
                </td>
                <td>
                  <select value={e.payBasis} onChange={(x) => update(e.id, { payBasis: x.target.value as Employee['payBasis'] })}>
                    <option value="hourly">Hourly</option>
                    <option value="salaried">Salaried</option>
                  </select>
                </td>
                <td>
                  {e.payBasis === 'hourly' ? (
                    <Num label="Hourly rate" step={0.01} value={e.hourlyRate} onChange={(n) => update(e.id, { hourlyRate: n })} />
                  ) : (
                    <Num label="Annual salary" step={500} width="100px" value={e.annualSalary} onChange={(n) => update(e.id, { annualSalary: n })} />
                  )}
                </td>
                <td><input type="date" value={e.dateOfBirth} onChange={(x) => update(e.id, { dateOfBirth: x.target.value })} /></td>
                <td><Num label="Contracted hours" width="70px" value={e.contractedHours} onChange={(n) => update(e.id, { contractedHours: n })} /></td>
                <td><Num label="Maximum weekly hours" width="70px" value={e.maxWeeklyHours} onChange={(n) => update(e.id, { maxWeeklyHours: n })} /></td>
                <td className="center"><input type="checkbox" checked={e.optedOutOf48} onChange={(x) => update(e.id, { optedOutOf48: x.target.checked })} aria-label="Opted out of 48 hour week" /></td>
                <td className="center"><input type="checkbox" checked={e.pensionEnrolled} onChange={(x) => update(e.id, { pensionEnrolled: x.target.checked })} aria-label="Pension enrolled" /></td>
                <td><button className="link danger" onClick={() => setDraft({ ...draft, employees: draft.employees.filter((p) => p.id !== e.id) })}>Remove</button></td>
              </tr>
            ))}
            {people.length === 0 && (
              <tr><td colSpan={10} className="muted">No one at this site yet. Add people one by one or paste a list.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="row-actions">
        <button onClick={() => setDraft({ ...draft, employees: [...draft.employees, newEmployee(siteId, draft.roles[0]?.id ?? '')] })}>
          Add a person
        </button>
        <button onClick={() => setPasting(!pasting)}>{pasting ? 'Close paste' : 'Paste from a spreadsheet'}</button>
      </div>
      {pasting && (
        <div className="setup-card">
          <p className="muted">
            Copy five columns from Excel, Google Sheets or a payroll export and paste below: Name, Roles, Rate or
            salary, Date of birth, Contracted hours. Separate several roles with a slash, e.g. Server/Host. Anything
            over £1,000 is read as an annual salary.
          </p>
          <textarea
            rows={6}
            value={pasteText}
            placeholder={'Alex Doe, Server/Host, 13.25, 01/02/1999, 32\nPat Lee, General Manager, 48000, 30/06/1985, 45'}
            onChange={(e) => setPasteText(e.target.value)}
          />
          <button className="primary" disabled={!pasteText.trim()} onClick={importPaste}>Add to team</button>
          {pasteErrors.length > 0 && (
            <ul className="issues">
              {pasteErrors.map((m, i) => <li key={i} className="warn">{m}</li>)}
              <li className="muted">Rows with problems were still added; fix them in the table above.</li>
            </ul>
          )}
        </div>
      )}
    </>
  );
}

type Driver = 'covers' | 'sales' | 'manual';

function TradingStep({ draft, setDraft }: StepProps) {
  const updateSite = (id: string, patch: Partial<Site>) =>
    setDraft({ ...draft, sites: draft.sites.map((s) => (s.id === id ? { ...s, ...patch } : s)) });

  function setRule(siteId: string, role: Role, patch: Partial<DemandRule> | null) {
    const rest = draft.demandRules.filter((r) => !(r.siteId === siteId && r.roleId === role.id));
    if (patch === null) return setDraft({ ...draft, demandRules: rest });
    const current = draft.demandRules.find((r) => r.siteId === siteId && r.roleId === role.id) ?? {
      roleId: role.id,
      siteId,
      minimumWhileOpen: 1,
      maximum: 3,
    };
    setDraft({ ...draft, demandRules: [...rest, { ...current, ...patch }] });
  }

  function setDriver(siteId: string, role: Role, driver: Driver) {
    if (driver === 'manual') return setRule(siteId, role, null);
    const fallback = defaultRule({ ...role, department: driver === 'sales' ? 'BAR' : 'FOH' }, siteId)!;
    setRule(siteId, role, driver === 'sales'
      ? { salesPerLabourHour: fallback.salesPerLabourHour, coversPerHour: undefined }
      : { coversPerHour: fallback.coversPerHour, salesPerLabourHour: undefined });
  }

  return (
    <>
      <p className="step-intro">
        Two things drive the auto-build. First, a typical week's net sales (excluding VAT and service charge) for each
        day, which we spread across your opening hours on a standard lunch and dinner pattern and turn into covers
        using your average spend. Second, how many covers or how much sales one person in each role can carry in an
        hour, with a floor while open and a ceiling. Roles set to "by hand" are never auto-rostered.
      </p>
      {draft.sites.map((site) => {
        const profile = site.salesProfile ?? { dailySales: [0, 0, 0, 0, 0, 0, 0], averageSpend: 40 };
        const week = profile.dailySales.reduce((a, b) => a + (b || 0), 0);
        const setProfile = (patch: Partial<typeof profile>) => updateSite(site.id, { salesProfile: { ...profile, ...patch } });
        return (
          <div key={site.id} className="setup-card">
            <h2>{site.name || 'Unnamed site'}</h2>
            <div className="field-row">
              {DAYS.map((d, i) => (
                <Field key={d} label={d}>
                  <Num
                    label={`${d} net sales`}
                    step={100}
                    value={profile.dailySales[i]}
                    onChange={(n) => setProfile({ dailySales: profile.dailySales.map((v, j) => (j === i ? n : v)) })}
                  />
                </Field>
              ))}
              <Field label="Average spend">
                <Num label="Average spend per cover" step={0.5} value={profile.averageSpend} onChange={(n) => setProfile({ averageSpend: n })} />
              </Field>
            </div>
            <p className="muted">
              {money(week)} a week, about {profile.averageSpend > 0 ? Math.round(week / profile.averageSpend) : 0} covers.
              At a {(site.labourTargetPct * 100).toFixed(1)}% target that is a loaded labour budget of {money(week * site.labourTargetPct)} a week.
            </p>
            <div className="grid-wrap">
              <table className="table">
                <thead>
                  <tr><th>Role</th><th>Driven by</th><th>Per person per hour</th><th>Minimum while open</th><th>Maximum</th></tr>
                </thead>
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
                          {rule && driver === 'covers' && (
                            <><Num label="Covers per person per hour" value={rule.coversPerHour ?? 0} onChange={(n) => setRule(site.id, role, { coversPerHour: n })} /> covers</>
                          )}
                          {rule && driver === 'sales' && (
                            <>£<Num label="Sales per labour hour" step={10} value={rule.salesPerLabourHour ?? 0} onChange={(n) => setRule(site.id, role, { salesPerLabourHour: n })} /></>
                          )}
                        </td>
                        <td>{rule && <Num label="Minimum while open" width="60px" value={rule.minimumWhileOpen} onChange={(n) => setRule(site.id, role, { minimumWhileOpen: n })} />}</td>
                        <td>{rule && <Num label="Maximum headcount" width="60px" value={rule.maximum} onChange={(n) => setRule(site.id, role, { maximum: n })} />}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </>
  );
}

function ReviewStep({ draft, prev, issues }: { draft: SetupDraft; prev: RotaState | null; issues: ReturnType<typeof validateSetup> }) {
  const dropped = droppedShifts(prev, draft);
  return (
    <>
      <div className="grid-wrap">
        <table className="table">
          <thead>
            <tr><th>Site</th><th>Hours</th><th className="num">Team</th><th className="num">Weekly sales</th><th className="num">Target</th><th className="num">Labour budget</th></tr>
          </thead>
          <tbody>
            {draft.sites.map((s) => {
              const week = (s.salesProfile?.dailySales ?? []).reduce((a, b) => a + (b || 0), 0);
              return (
                <tr key={s.id}>
                  <td>{s.name || 'Unnamed site'}</td>
                  <td>{formatMinute(s.openMinute)} to {formatMinute(s.closeMinute)}</td>
                  <td className="num">{draft.employees.filter((e) => e.siteId === s.id).length}</td>
                  <td className="num">{money(week)}</td>
                  <td className="num">{(s.labourTargetPct * 100).toFixed(1)}%</td>
                  <td className="num strong">{money(week * s.labourTargetPct)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {dropped > 0 && (
        <div className="notice">
          {dropped} rostered shifts belong to people, roles or sites you have removed, or to roles a person is no longer
          trained for. They will be deleted when you save.
        </div>
      )}
      {issues.length === 0 ? (
        <p>Everything checks out. Once saved, press "Build from forecast" to generate your first week.</p>
      ) : (
        <ul className="issues">
          {issues.map((i, n) => <li key={n} className={i.severity === 'error' ? 'block' : 'warn'}>{i.message}</li>)}
        </ul>
      )}
    </>
  );
}
