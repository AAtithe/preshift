import { useState } from 'react';
import { journeyBetween, siteLocation } from '../engine/travel';
import type { Site } from '../engine/types';

interface Props {
  sites: Site[];
  onSetLocation: (siteId: string, postcode: string) => Promise<unknown>;
  onRefresh: () => Promise<{ fromTfl: number; estimated: number; failures: string[] } | undefined>;
  onSetTravel: (siteId: string, toId: string, minutes: number | null) => Promise<unknown>;
}

const SOURCE: Record<string, string> = { tfl: 'TfL', estimate: 'Estimate', manual: 'Set by hand' };

/**
 * Where each site is and how long it takes to get between them. The rota uses these times to
 * stop a move between sites that cannot be made and to flag one that is tight.
 */
export function TravelPanel({ sites, onSetLocation, onRefresh, onSetTravel }: Props) {
  const [postcodes, setPostcodes] = useState<Record<string, string>>({});
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const located = sites.filter((s) => siteLocation(s));

  async function refresh() {
    setBusy(true);
    const res = await onRefresh();
    setBusy(false);
    if (!res) return;
    setResult(
      `${res.fromTfl} journey${res.fromTfl === 1 ? '' : 's'} from TfL` +
        (res.estimated ? `, ${res.estimated} estimated from distance because TfL had no answer` : '') +
        '.',
    );
  }

  function edit(from: Site, to: Site, value: string, current: number | undefined) {
    const minutes = value.trim() === '' ? null : Math.round(Number(value));
    if (minutes === null && !from.travel?.[to.id] && !to.travel?.[from.id]) return;
    if (minutes !== null && (!Number.isFinite(minutes) || minutes < 0 || minutes > 240)) return;
    if (minutes === current) return;
    void onSetTravel(from.id, to.id, minutes);
  }

  return (
    <div className="panel travel">
      <div className="panel-head">
        <div>
          <div className="panel-title">Travel between sites</div>
          <div className="panel-sub">
            Checks moves between sites on the same day: too little time to get there is blocked, a tight one is flagged.
            Journeys are planned by TfL for a weekday at 17:00 by public transport or on foot. Type a time to set it by
            hand; a refresh keeps it.
          </div>
        </div>
        <button className="primary" disabled={busy || located.length < 2} onClick={() => void refresh()}>
          {busy ? 'Asking TfL' : 'Refresh from TfL'}
        </button>
      </div>
      {result && <p className="travel-result">{result}</p>}
      <div className="grid-wrap">
        <table className="table travel-table">
          <thead>
            <tr>
              <th>Site</th>
              <th>Postcode</th>
              {sites.map((s) => (
                <th key={s.id} className="num">To {s.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sites.map((from) => (
              <tr key={from.id}>
                <th className="strong">{from.name}</th>
                <td>
                  <form
                    className="postcode"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const pc = (postcodes[from.id] ?? '').trim();
                      if (pc) void onSetLocation(from.id, pc).then(() => setPostcodes((p) => ({ ...p, [from.id]: '' })));
                    }}
                  >
                    <input
                      aria-label={`Postcode for ${from.name}`}
                      placeholder={from.location?.postcode ?? 'Not set'}
                      value={postcodes[from.id] ?? ''}
                      onChange={(e) => setPostcodes((p) => ({ ...p, [from.id]: e.target.value }))}
                    />
                    {(postcodes[from.id] ?? '').trim() && <button type="submit">Save</button>}
                  </form>
                </td>
                {sites.map((to) => {
                  if (to.id === from.id) return <td key={to.id} className="num muted">-</td>;
                  const journey = journeyBetween(sites, from.id, to.id);
                  const held = from.travel?.[to.id];
                  return (
                    <td key={to.id} className="num">
                      <span className="travel-cell">
                        <input
                          key={`${held?.minutes ?? journey?.minutes ?? ''}-${held?.source ?? journey?.source ?? ''}`}
                          aria-label={`Minutes from ${from.name} to ${to.name}`}
                          inputMode="numeric"
                          defaultValue={journey?.minutes ?? ''}
                          placeholder="?"
                          onBlur={(e) => edit(from, to, e.target.value, held?.source === 'manual' ? held.minutes : undefined)}
                          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                        />
                        <span className="muted small">min</span>
                      </span>
                      <span className={`travel-source ${journey?.source ?? 'none'}`}>
                        {journey ? (held ? SOURCE[held.source] : 'Estimate') : 'Needs postcodes'}
                        {held?.mode && held.source === 'tfl' ? ` · ${held.mode}` : ''}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
