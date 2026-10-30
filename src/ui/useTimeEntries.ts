import { useEffect, useState } from 'react';
import type { TimeEntry } from '../engine/types';
import { api } from './api';

/**
 * Clockings for a site and date range, as the screens that read actual hours load them. With no
 * site, every site the reader may see. The API keeps to its own rule on who may read time; `null`
 * while loading, and while `wanted` is false nothing is asked for.
 */
export function useTimeEntries(siteId: string | undefined, from: string, to: string, wanted = true): { entries: TimeEntry[] | null; error: string | null } {
  const [entries, setEntries] = useState<TimeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setEntries(null);
    if (!wanted) return;
    const site = siteId === undefined ? '' : `siteId=${encodeURIComponent(siteId)}&`;
    api.get<TimeEntry[]>(`/v1/time-entries?${site}from=${from}&to=${to}`).then(
      (list) => live && (setEntries(list), setError(null)),
      (e: Error) => live && (setEntries([]), setError(e.message)),
    );
    return () => {
      live = false;
    };
  }, [siteId, from, to, wanted]);
  return { entries, error };
}
