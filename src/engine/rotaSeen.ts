// Whether each person has confirmed their published week: "Seen it" in the staff app. A confirmation
// is of the week as it was then, so a change afterwards needs confirming again.

/** What a person confirmed: when, and the week as it read to them then. */
export interface SeenRecord {
  at: string;
  lines: string[];
}

export interface WeekSeen {
  employeeId: string;
  siteId: string;
  weekStart: string;
  /** Confirmed the week as it stands now. */
  seen: boolean;
  /** Confirmed an earlier version: something changed since. */
  changed: boolean;
  seenAt: string | null;
}

/** Same key as the record of what each person was told: `employeeId|siteId|weekStart`. */
export const weekKey = (employeeId: string, siteId: string, weekStart: string) => `${employeeId}|${siteId}|${weekStart}`;

const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);

/**
 * Every week a person has been told about, with whether they confirmed it as it now stands.
 * `told` is what publishing last told each person (see notifyPublished); weeks with no shifts left are not in it.
 */
export function weeksSeen(told: Record<string, string[]>, seen: Record<string, SeenRecord>, keep: (w: { employeeId: string; siteId: string; weekStart: string }) => boolean): WeekSeen[] {
  return Object.entries(told).flatMap(([key, lines]) => {
    const [employeeId, siteId, weekStart] = key.split('|');
    if (!keep({ employeeId, siteId, weekStart })) return [];
    const record = seen[key];
    const current = Boolean(record && sameLines(record.lines, lines));
    return [{ employeeId, siteId, weekStart, seen: current, changed: Boolean(record) && !current, seenAt: current ? record!.at : null }];
  });
}

/** Records a confirmation of each of the person's weeks starting `weekStart`, as they read now. */
export function confirmWeek(told: Record<string, string[]>, seen: Record<string, SeenRecord>, employeeId: string, weekStart: string, at: string): number {
  let confirmed = 0;
  for (const [key, lines] of Object.entries(told)) {
    const [who, , ws] = key.split('|');
    if (who !== employeeId || ws !== weekStart) continue;
    seen[key] = { at, lines: [...lines] };
    confirmed++;
  }
  return confirmed;
}

/** Drops confirmations of weeks long gone, so the record stays a few months of rota. */
export function pruneSeen(seen: Record<string, SeenRecord>, before: string): Record<string, SeenRecord> {
  return Object.fromEntries(Object.entries(seen).filter(([key]) => key.split('|')[2] >= before));
}
