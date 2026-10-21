/** All money is handled as integer minor units (e.g. bani). Never use floats for amounts. */

/** VAT contained in a VAT-inclusive gross amount. `rateBp` is in basis points (2100 = 21%). */
export function vatFromGross(gross: number, rateBp: number): number {
  if (rateBp <= 0) return 0;
  return Math.round((gross * rateBp) / (10_000 + rateBp));
}

export function applyPercent(amount: number, percent: number): number {
  return Math.round(amount * (1 + percent / 100));
}

export function formatMoney(minor: number, currency: string, locale = 'ro-RO'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 100);
}

/** Parse a user-entered decimal string ("12,50" or "12.5") into minor units. */
export function parseMoney(input: string): number | null {
  const normalized = input.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, frac = ''] = normalized.replace('-', '').split('.');
  const value = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return normalized.startsWith('-') ? -value : value;
}
