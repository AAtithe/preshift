import { useEffect, useState } from 'react';
import type { Reminder } from '../engine/plan';
import { daysBetween } from '../engine/time';
import type { Site } from '../engine/types';
import { api } from './api';

// Its own file, apart from the Calendar screen, because it shows on every screen: the
// calendar stays out of the first download and loads when someone opens it.

export type StatefulReminder = Reminder & { siteId: string; status: 'open' | 'done' | 'dismissed'; decidedBy?: string };

export const inDays = (today: string, date: string) => {
  const n = daysBetween(today, date);
  return n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`;
};

/**
 * What is due across the sites in view, as one line under the heading: the first two, how many
 * more, and how many need a decision. The rest open on request, so the line never pushes the rota
 * down the screen.
 */
export function RemindersBanner({ siteIds, sites, today, onOpen }: { siteIds: string[]; sites: Site[]; today: string; onOpen: (siteId: string) => void }) {
  const [due, setDue] = useState<StatefulReminder[]>([]);
  const [all, setAll] = useState(false);
  const key = siteIds.join(',');
  useEffect(() => {
    let live = true;
    api
      .get<StatefulReminder[]>(`/v1/reminders?siteIds=${key}`)
      .then((r) => live && setDue(r))
      .catch(() => live && setDue([]));
    return () => {
      live = false;
    };
  }, [key]);
  if (due.length === 0) return null;
  const name = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
  const action = due.filter((r) => r.needsInput).length;
  const shown = all ? due : due.slice(0, 2);
  const rest = due.length - shown.length;
  return (
    <div className={`notice reminders-banner${all ? ' open' : ''}`}>
      <strong>Coming up.</strong>{' '}
      {shown.map((r, i) => (
        <span key={`${r.siteId}${r.key}`}>
          {i > 0 ? '; ' : ''}
          <button className="link" onClick={() => onOpen(r.siteId)}>
            {siteIds.length > 1 ? `${name(r.siteId)}: ` : ''}{r.title} {inDays(today, r.date)}
          </button>
        </span>
      ))}
      {rest > 0 ? '; ' : '.'}
      {rest > 0 && (
        <>
          <button className="link" aria-expanded={false} onClick={() => setAll(true)}>
            {rest} more
          </button>
          .
        </>
      )}
      {all && due.length > 2 && (
        <>
          {' '}
          <button className="link" aria-expanded={true} onClick={() => setAll(false)}>Show fewer</button>
        </>
      )}
      {action > 0 && <span className="reminders-need"> {action} need{action === 1 ? 's' : ''} your view.</span>}
    </div>
  );
}
