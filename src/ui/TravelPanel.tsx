import { useState } from 'react';
import { journeyBetween, siteLocation } from '../engine/travel';
import type { Entity, Site, TravelPay } from '../engine/types';
import { UK_RATES_2026_27 } from '../engine/ukRates';

interface Props {
  sites: Site[];
  /** The companies these sites belong to, for what each pays for travel. */
  entities: Entity[];
  /** Absent for anyone who cannot change company settings. */
  onSetTravelPay?: (entityId: string, travelPay: TravelPay) => Promise<unknown>;
  onSetLocation: (siteId: string, postcode: string) => Promise<unknown>;
  onRefresh: () => Promise<{ fromTfl: number; estimated: number; failures: string[] } | undefined>;
  onSetTravel: (siteId: string, toId: string, minutes: number | null) => Promise<unknown>;
}

const SOURCE: Record<string, string> = { tfl: 'TfL', estimate: 'Estimate', manual: 'Set by hand' };

/**
 * Where each site is and how long it takes to get between them. The rota uses these times to
 * stop a move between sites that cannot be made and to flag one that is tight.
 */
export function TravelPanel({ sites, entities, onSetTravelPay, onSetLocation, onRefresh, onSetTravel }: Props) {
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
      {sites.length - located.length > 0 && (
        <p className="travel-missing">
          No postcode for {sites.filter((s) => !siteLocation(s)).map((s) => s.name).join(' and ')}. Moves to and from{' '}
          {sites.length - located.length === 1 ? 'it' : 'them'} are not checked for time or costed as paid travel until one is set.
        </p>
      )}
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
      <TravelPayRows entities={entities} onSetTravelPay={onSetTravelPay} />
    </div>
  );
}

const ADULT_MINIMUM = UK_RATES_2026_27.minimumWage[0];

/**
 * What each company pays for an hour of travel. The journey is working time, so the rota, the
 * P&L, payroll and holiday all follow this one setting.
 */
function TravelPayRows({ entities, onSetTravelPay }: Pick<Props, 'entities' | 'onSetTravelPay'>) {
  function choose(entity: Entity, basis: TravelPay['basis']) {
    if (!onSetTravelPay) return;
    if (basis === 'fixed') {
      // Starts at the adult minimum, the usual choice; the amount can be changed once it is set.
      void onSetTravelPay(entity.id, { basis: 'fixed', hourly: ADULT_MINIMUM.hourly });
    } else {
      void onSetTravelPay(entity.id, { basis });
    }
  }

  function saveAmount(entity: Entity, value: string) {
    const hourly = Math.round(Number(value) * 100) / 100;
    if (!onSetTravelPay || !Number.isFinite(hourly) || hourly < 0 || hourly > 200) return;
    if (entity.travelPay?.basis !== 'fixed' || entity.travelPay.hourly === hourly) return;
    void onSetTravelPay(entity.id, { basis: 'fixed', hourly, averaging: entity.travelPay.averaging });
  }

  return (
    <div className="travel-pay">
      <div className="eyebrow">Travel pay</div>
      <p className="muted small">
        A move between sites in a working day is working time, so it is paid and costed to the site travelled to.
        A fixed rate is lifted to the minimum wage for the person's age (£{ADULT_MINIMUM.hourly.toFixed(2)} at 21 and over) on
        every hour, so travel stays legal on its own. Choose averaging to pay less per hour of travel: the week is then topped
        up wherever its average pay over work and travel would fall below the minimum, and the top-up is flagged.
      </p>
      {entities.map((entity) => {
        const basis = entity.travelPay?.basis ?? '';
        return (
          <div key={entity.id} className="travel-pay-row">
            <span className="strong">{entity.name}</span>
            <select
              aria-label={`Travel pay for ${entity.name}`}
              value={basis}
              disabled={!onSetTravelPay}
              title={onSetTravelPay ? undefined : 'Set by whoever manages company settings'}
              onChange={(e) => choose(entity, e.target.value as TravelPay['basis'])}
            >
              {basis === '' && <option value="" disabled>Choose how travel is paid</option>}
              <option value="normal">Their normal rate</option>
              <option value="minimum">Minimum wage for their age</option>
              <option value="fixed">A fixed rate</option>
            </select>
            {basis === '' && <span className="travel-unchosen small">Not chosen yet: paid at their normal rate until it is.</span>}
            {basis === 'fixed' && entity.travelPay?.basis === 'fixed' && (
              <span className="travel-cell">
                <span className="muted small">£</span>
                <input
                  key={entity.travelPay.hourly}
                  aria-label={`Fixed travel rate for ${entity.name}`}
                  inputMode="decimal"
                  disabled={!onSetTravelPay}
                  defaultValue={entity.travelPay.hourly.toFixed(2)}
                  onBlur={(e) => saveAmount(entity, e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                />
                <span className="muted small">an hour</span>
              </span>
            )}
            {basis === 'fixed' && entity.travelPay?.basis === 'fixed' && (
              <label className="muted small check-inline" title="The law allows a lower travel rate if each pay period's pay averages the minimum wage over work and travel">
                <input
                  type="checkbox"
                  checked={!!entity.travelPay.averaging}
                  disabled={!onSetTravelPay}
                  onChange={(e) => {
                    const t = entity.travelPay;
                    if (onSetTravelPay && t?.basis === 'fixed') void onSetTravelPay(entity.id, { basis: 'fixed', hourly: t.hourly, averaging: e.target.checked });
                  }}
                />{' '}
                Average to the minimum wage over the week instead
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}
