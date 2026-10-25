import { useCallback, useEffect, useState } from 'react';
import type { RotaState } from '../engine/types';
import { api } from './api';

interface Hire {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  siteId?: string;
  siteGiven?: string;
  roleId?: string;
  roleGiven?: string;
  startDate?: string;
  hourlyRate?: number;
  receivedAt: string;
}

const problem = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * New hires handed over by recruitment, waiting for a manager at the site to check and add. The
 * applicant's own details fill the starter in; the manager fills what recruitment did not send.
 */
export function NewHiresPanel({ state, siteIds, onAdded }: { state: RotaState; siteIds: string[]; onAdded: () => void }) {
  const [hires, setHires] = useState<Hire[] | null>(null);
  const [fix, setFix] = useState<Record<string, { siteId?: string; roleId?: string; dateOfBirth?: string }>>({});
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const load = useCallback(() => api.get<Hire[]>('/v1/hires').then(setHires).catch(() => setHires([])), []);
  useEffect(() => void load(), [load]);
  const shown = (hires ?? []).filter((h) => !h.siteId || siteIds.includes(h.siteId));
  if (!shown.length) return null;

  const add = async (h: Hire) => {
    const f = fix[h.id] ?? {};
    try {
      await api.post(`/v1/hires/${h.id}/add`, {
        ...(f.siteId ? { siteId: f.siteId } : {}),
        ...(f.roleId ? { roleIds: [f.roleId] } : {}),
        ...(f.dateOfBirth ? { dateOfBirth: f.dateOfBirth } : {}),
      });
      setMessage({ text: `${h.name} added as a starter. Their onboarding steps are below; set their pay in their record if it was not in the offer.` });
      await load();
      onAdded();
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  };
  const dismiss = async (h: Hire) => {
    if (!confirm(`Dismiss ${h.name}? They will not be added.`)) return;
    try {
      await api.post(`/v1/hires/${h.id}/dismiss`, {});
      await load();
    } catch (e) {
      setMessage({ text: problem(e), bad: true });
    }
  };
  const set = (id: string, patch: { siteId?: string; roleId?: string; dateOfBirth?: string }) => setFix({ ...fix, [id]: { ...fix[id], ...patch } });

  return (
    <section className="settings-card">
      <h2>New hires from recruitment</h2>
      <p className="muted small">
        Hired in your recruitment system and handed over with the details the applicant gave. Check each one, fill anything missing,
        and add them as a starter: they go to payroll and onboarding from there, with nobody typing them in again.
      </p>
      <table className="table compact">
        <thead>
          <tr><th>Name</th><th>Site</th><th>Role</th><th>Date of birth</th><th>Starts</th><th /></tr>
        </thead>
        <tbody>
          {shown.map((h) => (
            <tr key={h.id}>
              <td>
                {h.name}
                <div className="small muted">{[h.email, h.phone, h.hourlyRate ? `£${h.hourlyRate.toFixed(2)} an hour offered` : ''].filter(Boolean).join(', ')}</div>
              </td>
              <td>
                {h.siteId ? state.sites.find((s) => s.id === h.siteId)?.name : (
                  <select aria-label={`Site for ${h.name}`} value={fix[h.id]?.siteId ?? ''} onChange={(e) => set(h.id, { siteId: e.target.value })}>
                    <option value="">{h.siteGiven ? `"${h.siteGiven}": choose` : 'Choose'}</option>
                    {state.sites.filter((s) => siteIds.includes(s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                )}
              </td>
              <td>
                {h.roleId ? state.roles.find((r) => r.id === h.roleId)?.name : (
                  <select aria-label={`Role for ${h.name}`} value={fix[h.id]?.roleId ?? ''} onChange={(e) => set(h.id, { roleId: e.target.value })}>
                    <option value="">{h.roleGiven ? `"${h.roleGiven}": choose` : 'Choose'}</option>
                    {state.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                )}
              </td>
              <td>
                {h.dateOfBirth ?? <input type="date" aria-label={`Date of birth for ${h.name}`} value={fix[h.id]?.dateOfBirth ?? ''} onChange={(e) => set(h.id, { dateOfBirth: e.target.value })} />}
              </td>
              <td>{h.startDate ?? ''}</td>
              <td className="close-actions">
                <button className="primary" onClick={() => void add(h)}>Add starter</button>
                <button onClick={() => void dismiss(h)}>Dismiss</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {message && <p className={`small ${message.bad ? 'bad-text' : 'good-text'}`}>{message.text}</p>}
    </section>
  );
}
