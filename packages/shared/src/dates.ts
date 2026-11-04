/** Date helpers working on ISO calendar dates (YYYY-MM-DD) without timezone drift. */

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function nightsBetween(arrival: string, departure: string): number {
  const ms = Date.parse(`${departure}T00:00:00Z`) - Date.parse(`${arrival}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** Each night of a stay, i.e. arrival .. departure-1. */
export function stayDates(arrival: string, departure: string): string[] {
  const nights = nightsBetween(arrival, departure);
  return Array.from({ length: Math.max(0, nights) }, (_, i) => addDays(arrival, i));
}

export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Today's calendar date in a given IANA timezone. */
export function todayIn(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return parts;
}

function isoIfReal(y: number, m: number, d: number) {
  const day = new Date(Date.UTC(y, m - 1, d));
  if (day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) return null;
  return day.toISOString().slice(0, 10);
}

/**
 * Reads a date typed into a search box: 2026-11-27, 27.11.2026 or 27/11. Without a year it
 * could mean this year or the next, so both are returned.
 */
export function parseSearchDates(token: string, thisYear: number): string[] {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(token);
  if (iso) return [isoIfReal(+iso[1]!, +iso[2]!, +iso[3]!)].filter((d): d is string => d !== null);
  const local = /^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{4}))?$/.exec(token);
  if (!local) return [];
  const years = local[3] ? [+local[3]] : [thisYear, thisYear + 1];
  return years.map((y) => isoIfReal(y, +local[2]!, +local[1]!)).filter((d): d is string => d !== null);
}
