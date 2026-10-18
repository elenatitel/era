import { formatMoney } from '@pms/shared';

export const money = (minor: number | null | undefined, currency = 'RON', locale = 'ro') =>
  formatMoney(minor ?? 0, currency, locale === 'en' ? 'en-GB' : 'ro-RO');

export const date = (iso: string | null | undefined, locale = 'ro') =>
  iso ? new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'ro-RO', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)) : '—';

export const dateTime = (iso: string | null | undefined, locale = 'ro') =>
  iso ? new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'ro-RO', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '—';

export const percent = (bp: number) => `${(bp / 100).toLocaleString()}%`;

/** "12,50" -> 1250 minor units; returns null when invalid. */
export { parseMoney } from '@pms/shared';
