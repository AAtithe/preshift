import { useEffect, useState } from 'react';
import type { TimeEntry } from '../engine/types';
import { api } from './api';

/**
 * Clockings for a site and date range, as the screens that read actual hours load them. The API
 * keeps to its own rule on who may read time; `null` while loading.
 */
export function useTimeEntries(siteId: string, from: string, to: string): { entries: TimeEntry[] | null; error: string | null } {
  const [entries, setEntries] = useState<TimeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setEntries(null);
    api.get<TimeEntry[]>(`/v1/time-entries?siteId=${encodeURIComponent(siteId)}&from=${from}&to=${to}`).then(
      (list) => live && (setEntries(list), setError(null)),
      (e: Error) => live && (setEntries([]), setError(e.message)),
    );
    return () => {
      live = false;
    };
  }, [siteId, from, to]);
  return { entries, error };
}
