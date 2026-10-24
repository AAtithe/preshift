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

/** What is due across the sites in view, as one line under the top bar. */
export function RemindersBanner({ siteIds, sites, today, onOpen }: { siteIds: string[]; sites: Site[]; today: string; onOpen: (siteId: string) => void }) {
  const [due, setDue] = useState<StatefulReminder[]>([]);
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
  return (
    <div className="notice reminders-banner">
      <strong>Coming up.</strong>{' '}
      {due.slice(0, 4).map((r, i) => (
        <span key={`${r.siteId}${r.key}`}>
          {i > 0 ? '; ' : ''}
          <button className="link" onClick={() => onOpen(r.siteId)}>
            {siteIds.length > 1 ? `${name(r.siteId)}: ` : ''}{r.title} {inDays(today, r.date)}
          </button>
        </span>
      ))}
      {due.length > 4 ? `; and ${due.length - 4} more` : ''}.
      {action > 0 && ` ${action} need${action === 1 ? 's' : ''} your view.`}
    </div>
  );
}
