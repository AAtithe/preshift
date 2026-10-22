export const MINUTES_PER_DAY = 1440;

export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = parseISODate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

/** 0 = Monday ... 6 = Sunday */
export function weekday(iso: string): number {
  return (parseISODate(iso).getUTCDay() + 6) % 7;
}

export function weekStart(iso: string): string {
  return addDays(iso, -weekday(iso));
}

export function weekDates(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parseISODate(b).getTime() - parseISODate(a).getTime()) / 86_400_000);
}

/** Absolute minute on a timeline anchored at `anchor`, for comparing shifts across days. */
export function absoluteMinute(anchor: string, date: string, minute: number): number {
  return daysBetween(anchor, date) * MINUTES_PER_DAY + minute;
}

export function formatMinute(minute: number): string {
  const m = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function parseClock(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + (m || 0);
}

export function ageOn(dateOfBirth: string, on: string): number {
  const dob = parseISODate(dateOfBirth);
  const at = parseISODate(on);
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    at.getUTCMonth() < dob.getUTCMonth() ||
    (at.getUTCMonth() === dob.getUTCMonth() && at.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

/** UK tax year a date falls in, e.g. '2026/27'. The year runs 6 April to 5 April. */
export function taxYearOf(iso: string): string {
  const year = Number(iso.slice(0, 4));
  const start = iso >= `${year}-04-06` ? year : year - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, '0')}`;
}

export function taxYearStartDate(taxYear: string): string {
  return `${taxYear.slice(0, 4)}-04-06`;
}

/** Local date and minute in London for an instant: clocking and rotas are always UK wall-clock time. */
export function londonParts(at: Date): { date: string; minute: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}
