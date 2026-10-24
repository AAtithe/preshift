import { useState, type FormEvent } from 'react';
import type { Department, Role, TroncScheme } from '../engine/types';
import { api, ApiError } from './api';

interface Props {
  siteId: string;
  siteName: string;
  roles: Role[];
  scheme?: TroncScheme;
  today: string;
  onSaved: (scheme: TroncScheme) => void;
  onCancel: () => void;
}

const DEPARTMENTS: { id: Department; label: string }[] = [
  { id: 'FOH', label: 'Front of house' },
  { id: 'BAR', label: 'Bar' },
  { id: 'BOH', label: 'Kitchen' },
  { id: 'MGMT', label: 'Management' },
];

/**
 * Records the scheme the troncmaster runs: who decides, the points each role earns per clocked
 * hour, any split by department first, and the policy dates the Act asks for. The server checks
 * it again and keeps the audit trail; payroll records it, the troncmaster decides it.
 */
export function TroncSchemeEditor({ siteId, siteName, roles, scheme, today, onSaved, onCancel }: Props) {
  const [troncmaster, setTroncmaster] = useState(scheme?.troncmaster ?? '');
  const [independent, setIndependent] = useState(scheme?.independent ?? true);
  const [serviceCharge, setServiceCharge] = useState<TroncScheme['serviceCharge']>(scheme?.serviceCharge ?? 'discretionary');
  const [points, setPoints] = useState<Record<string, string>>(Object.fromEntries(roles.map((r) => [r.id, String(scheme?.pointsPerHour[r.id] ?? 0)])));
  const [split, setSplit] = useState(!!scheme?.departmentShares);
  const [shares, setShares] = useState<Record<string, string>>(
    Object.fromEntries(DEPARTMENTS.map((d) => [d.id, scheme?.departmentShares?.[d.id] !== undefined ? String(Math.round(scheme.departmentShares[d.id]! * 100)) : ''])),
  );
  const [payoutDay, setPayoutDay] = useState(scheme?.payoutDay ? String(scheme.payoutDay) : '');
  const [policyPublishedOn, setPolicyPublishedOn] = useState(scheme?.policyPublishedOn ?? '');
  const [lastReviewedOn, setLastReviewedOn] = useState(scheme?.lastReviewedOn ?? '');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const shareTotal = DEPARTMENTS.reduce((s, d) => s + (Number(shares[d.id]) || 0), 0);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setProblems([]);
    try {
      const departmentShares = split
        ? Object.fromEntries(DEPARTMENTS.filter((d) => shares[d.id] !== '').map((d) => [d.id, Number(shares[d.id]) / 100]))
        : undefined;
      const saved = await api.put<TroncScheme>(`/v1/tronc/schemes/${encodeURIComponent(siteId)}`, {
        troncmaster,
        independent,
        serviceCharge,
        pointsPerHour: Object.fromEntries(roles.map((r) => [r.id, Number(points[r.id]) || 0])),
        ...(departmentShares && Object.keys(departmentShares).length ? { departmentShares } : {}),
        ...(payoutDay ? { payoutDay: Number(payoutDay) } : {}),
        ...(policyPublishedOn ? { policyPublishedOn } : {}),
        ...(lastReviewedOn ? { lastReviewedOn } : {}),
      });
      onSaved(saved);
    } catch (err) {
      const details = err instanceof ApiError && Array.isArray(err.details) ? (err.details as string[]) : [];
      setProblems(details.length ? details : [(err as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-card">
      <h2>{scheme ? 'Change' : 'Record'} the tronc scheme for {siteName}</h2>
      <p className="muted small">
        Record what the troncmaster decided. Where the scheme is independent, the business does not set the points: changing
        them here is a change to the written policy, so consult staff and republish it.
      </p>
      <form className="form" onSubmit={save}>
        <label className="span2">
          Troncmaster
          <input required maxLength={120} value={troncmaster} onChange={(e) => setTroncmaster(e.target.value)} placeholder="e.g. Grace Mensah, elected by the team" />
        </label>
        <label className="check span2">
          <input type="checkbox" checked={independent} onChange={(e) => setIndependent(e.target.checked)} />
          The troncmaster decides the allocation, independently of the business
        </label>
        <label>
          Service charge
          <select value={serviceCharge} onChange={(e) => setServiceCharge(e.target.value as TroncScheme['serviceCharge'])}>
            <option value="none">None</option>
            <option value="discretionary">Discretionary (no VAT)</option>
            <option value="mandatory">Mandatory (part of the price, VAT due)</option>
          </select>
        </label>
        <span className="hint">{independent ? 'Independent: tronc payments carry PAYE, no Class 1 NI.' : 'The business allocates: Class 1 NI is due on every payment.'}</span>
        <label>
          Paid out
          <select value={payoutDay} onChange={(e) => setPayoutDay(e.target.value)}>
            <option value="">In each pay run</option>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>Monthly, on day {n} of the month after</option>)}
          </select>
        </label>
        <span className="hint">Tips must reach staff by the end of the month after they were taken. The labour cash calendar uses this for when tronc leaves the bank.</span>
        <label>
          Written policy published
          <input type="date" max={today} value={policyPublishedOn} onChange={(e) => setPolicyPublishedOn(e.target.value)} />
        </label>
        <label>
          Last reviewed with staff
          <input type="date" max={today} value={lastReviewedOn} onChange={(e) => setLastReviewedOn(e.target.value)} />
        </label>

        <fieldset className="span2">
          <legend>Points per clocked hour</legend>
          <div className="form">
            {roles.map((r) => (
              <label key={r.id}>
                {r.name}
                <input type="number" min={0} max={1000} step="0.5" value={points[r.id]} onChange={(e) => setPoints({ ...points, [r.id]: e.target.value })} />
              </label>
            ))}
          </div>
        </fieldset>

        <label className="check span2">
          <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
          Split the pool by department before points are applied
        </label>
        {split && (
          <fieldset className="span2">
            <legend>Share of the pool, % (total {shareTotal}%)</legend>
            <div className="form">
              {DEPARTMENTS.map((d) => (
                <label key={d.id}>
                  {d.label}
                  <input type="number" min={0} max={100} value={shares[d.id]} onChange={(e) => setShares({ ...shares, [d.id]: e.target.value })} />
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {problems.length > 0 && (
          <ul className="issues span2">
            {problems.map((p) => <li key={p} className="block">{p}</li>)}
          </ul>
        )}
        <div className="row-actions span2">
          <button disabled={busy}>{busy ? 'Saving' : 'Save scheme'}</button>
          <button type="button" className="link" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </section>
  );
}
