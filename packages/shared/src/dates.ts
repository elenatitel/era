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
