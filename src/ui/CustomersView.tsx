import { useEffect, useMemo, useState } from 'react';
import { formatPence } from '../engine/pricing';
import { api } from './api';
import { csvLine, download } from './format';

// Customers, for Williams, Stanley & Co. customer operations: every organisation that signed itself up,
// its trial, subscription and revenue, and who needs a call this week. Counts and billing standing only;
// paying, refunds and cancelling stay in Stripe, so nothing here moves money. See server/routes/customers.ts.

type Standing = 'trial' | 'active' | 'past_due' | 'lapsed' | 'managed';

interface Customer {
  orgId: string;
  name: string;
  owner: { name: string; email: string } | null;
  signedUpAt: string;
  standing: Standing;
  locked: boolean;
  trialEndsAt: string;
  trialDaysLeft: number;
  interval: 'month' | 'year' | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  sites: number;
  sitesBilled: number | null;
  mrrPence: number;
  lastInvoice: { status: 'paid' | 'failed'; amountPence: number; at: string; url?: string } | null;
  onboarding: { done: number; of: number; next: string | null };
  rotaPublished: boolean;
  lastActivity: string | null;
  attention: string[];
}

interface Totals {
  customers: number;
  trials: number;
  paying: number;
  pastDue: number;
  lapsed: number;
  signups7: number;
  signups30: number;
  conversion: number | null;
  mrrPence: number;
  arrPence: number;
  sitesBilled: number;
  trialsWithRota: number;
}

const STANDING: Record<Standing, { label: string; tone: string }> = {
  trial: { label: 'Trial', tone: 'warn' },
  active: { label: 'Paying', tone: 'good' },
  past_due: { label: 'Payment failed', tone: 'bad' },
  lapsed: { label: 'Lapsed', tone: 'bad' },
  managed: { label: 'WS engagement', tone: 'good' },
};

const FILTERS: { id: 'all' | 'attention' | Standing; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'attention', label: 'Need attention' },
  { id: 'trial', label: 'Trials' },
  { id: 'active', label: 'Paying' },
  { id: 'past_due', label: 'Payment failed' },
  { id: 'lapsed', label: 'Lapsed' },
];

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export function CustomersView() {
  const [data, setData] = useState<{ customers: Customer[]; totals: Totals; stripe: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    api.get<{ customers: Customer[]; totals: Totals; stripe: boolean }>('/v1/customers').then(setData).catch((e) => setError((e as Error).message));
  }, []);

  const visible = useMemo(() => {
    const list = data?.customers ?? [];
    return list.filter(
      (c) =>
        (filter === 'all' || (filter === 'attention' ? c.attention.length > 0 : c.standing === filter)) &&
        (!query || `${c.name} ${c.owner?.name ?? ''} ${c.owner?.email ?? ''}`.toLowerCase().includes(query.toLowerCase())),
    );
  }, [data, filter, query]);

  function exportCsv() {
    // Business and owner names are typed in by the public at sign-up: never let one run as a spreadsheet formula.
    const safe = (v: string) => (/^[=+\-@]/.test(v) ? `'${v}` : v);
    const rows = [
      ['Customer', 'Owner', 'Owner email', 'Signed up', 'Standing', 'Trial ends', 'Billing', 'Sites set up', 'Sites billed', 'MRR (£, list, ex VAT)', 'Onboarding steps done', 'First rota published', 'Last change', 'Attention'],
      ...visible.map((c) => [
        c.name, c.owner?.name ?? '', c.owner?.email ?? '', c.signedUpAt.slice(0, 10), STANDING[c.standing].label, c.trialEndsAt.slice(0, 10),
        c.interval ?? '', String(c.sites), c.sitesBilled === null ? '' : String(c.sitesBilled), (c.mrrPence / 100).toFixed(2),
        `${c.onboarding.done} of ${c.onboarding.of}`, c.rotaPublished ? 'Yes' : 'No', c.lastActivity?.slice(0, 10) ?? '', c.attention.join(' '),
      ]),
    ];
    download(`preshift-customers-${new Date().toISOString().slice(0, 10)}.csv`, rows.map((r) => csvLine(r.map(safe))).join('\n'));
  }

  if (error) return <p className="bad-text small" role="alert">{error}</p>;
  if (!data) return <p className="muted small">Loading customers.</p>;
  const t = data.totals;
  const attention = data.customers.filter((c) => c.attention.length > 0).length;

  return (
    <div className="clients customers">
      <p className="muted small">
        Every business that signed itself up, its trial, subscription and revenue. Counts and billing standing only, never a customer's
        staff or pay. Paying, refunds and cancelling are in Stripe. Clients billed under a WS engagement are under Clients. Each time this page
        opens it is recorded in the audit trail.
      </p>
      {!data.stripe && <p className="notice small">Card payments are not set up on this system yet, so nobody can subscribe and nothing is paused.</p>}

      <div className="kpis people-kpis">
        <div className="kpi">
          <div className="kpi-label">MRR</div>
          <div className="kpi-value">{formatPence(t.mrrPence)}</div>
          <div className="kpi-hint">{formatPence(t.arrPence)} a year, list price before VAT, {t.sitesBilled} sites billed</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Paying</div>
          <div className="kpi-value">{t.paying + t.pastDue}</div>
          <div className="kpi-hint">{t.pastDue ? `${t.pastDue} with a failed payment` : 'All paid up'}</div>
        </div>
        <div className={`kpi ${t.trials ? 'warn' : ''}`}>
          <div className="kpi-label">Trials</div>
          <div className="kpi-value">{t.trials}</div>
          <div className="kpi-hint">{t.trialsWithRota} have published a rota</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Trial to paid</div>
          <div className="kpi-value">{t.conversion === null ? 'n/a' : `${Math.round(t.conversion * 100)}%`}</div>
          <div className="kpi-hint">Of trials that have ended</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Sign-ups</div>
          <div className="kpi-value">{t.signups7}</div>
          <div className="kpi-hint">Last 7 days, {t.signups30} in 30</div>
        </div>
        <div className={`kpi ${attention ? 'bad' : 'good'}`}>
          <div className="kpi-label">Need attention</div>
          <div className="kpi-value">{attention}</div>
          <div className="kpi-hint">{t.lapsed} lapsed</div>
        </div>
      </div>

      <div className="people-bar">
        <div className="segmented" role="radiogroup" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} role="radio" aria-checked={filter === f.id} className={filter === f.id ? 'active' : ''} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="people-actions">
          <input type="search" placeholder="Search customers or owners" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search customers" />
          <button onClick={exportCsv} disabled={visible.length === 0}>Download CSV</button>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="muted">{data.customers.length === 0 ? 'Nobody has signed themselves up yet.' : 'No customer matches.'}</p>
      ) : (
        <div className="grid-wrap">
          <table className="table people clients-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Standing</th>
                <th>Signed up</th>
                <th className="num">Sites</th>
                <th className="num">MRR</th>
                <th>Onboarding</th>
                <th>Needs</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => (
                <tr key={c.orgId}>
                  <td>
                    <div>{c.name}</div>
                    {c.owner && (
                      <div className="muted small">
                        {c.owner.name}, <a href={`mailto:${c.owner.email}`}>{c.owner.email}</a>
                      </div>
                    )}
                  </td>
                  <td>
                    <span className={`pill tone-${STANDING[c.standing].tone}`}>{STANDING[c.standing].label}</span>
                    <div className="muted small">
                      {c.standing === 'trial'
                        ? `${c.trialDaysLeft} day${c.trialDaysLeft === 1 ? '' : 's'} left`
                        : c.interval
                          ? `${c.interval === 'year' ? 'Yearly' : 'Monthly'}${c.cancelAtPeriodEnd ? ', cancelled' : ''}`
                          : ''}
                    </div>
                  </td>
                  <td>{day(c.signedUpAt)}</td>
                  <td className="num">{c.sitesBilled === null ? c.sites : `${c.sites} / ${c.sitesBilled} billed`}</td>
                  <td className="num">{c.mrrPence ? formatPence(c.mrrPence) : ''}</td>
                  <td>
                    {c.onboarding.done} of {c.onboarding.of}
                    {c.onboarding.next && <div className="muted small">Next: {c.onboarding.next}</div>}
                  </td>
                  <td className="small">{c.attention.length ? c.attention.map((a) => <div key={a}>{a}</div>) : <span className="muted">Nothing</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
