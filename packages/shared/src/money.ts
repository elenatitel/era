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

/** Quantity of an extra for a stay, from how it is priced. */
export function extraQuantity(unit: string, nights: number, guests: number): number {
  switch (unit) {
    case 'per_night':
      return nights;
    case 'per_guest':
      return guests;
    case 'per_guest_night':
      return nights * guests;
    default:
      return 1;
  }
}

/**
 * Takes a promo discount off nightly room rates. A percentage applies to each night;
 * a fixed amount is spread across the nights (remainder on the last) and never goes below zero.
 * Returns the discounted nights and the total discount.
 */
export function applyDiscount<T extends { amount: number }>(nights: T[], type: string, value: number): { nights: T[]; discount: number } {
  const before = nights.reduce((s, n) => s + n.amount, 0);
  let result: T[];
  if (type === 'percent') {
    result = nights.map((n) => ({ ...n, amount: Math.round((n.amount * (100 - Math.min(100, value))) / 100) }));
  } else {
    // Spread evenly; whatever a cheap night cannot absorb moves to the nights that still can.
    const amounts = nights.map((n) => n.amount);
    let left = Math.min(value, before);
    while (left > 0) {
      const open = amounts.map((a, i) => (a > 0 ? i : -1)).filter((i) => i >= 0);
      const share = Math.max(1, Math.floor(left / open.length));
      for (const i of open) {
        const cut = Math.min(share, amounts[i]!, left);
        amounts[i]! -= cut;
        left -= cut;
        if (!left) break;
      }
    }
    result = nights.map((n, i) => ({ ...n, amount: amounts[i]! }));
  }
  return { nights: result, discount: before - result.reduce((s, n) => s + n.amount, 0) };
}
