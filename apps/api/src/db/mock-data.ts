/**
 * Mock operating history for the demo organization: about four months of stays around
 * the business date, with folios, payments, invoices, housekeeping and a few extras.
 * Deterministic (seeded PRNG) and idempotent: runs once per demo tenant.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, like, sql } from 'drizzle-orm';
import { addDays, applyPercent, stayDates, todayIn, vatFromGross, weekday } from '@pms/shared';
import type { DbService, Tx } from './db.service.js';
import {
  type BookedExtra,
  companies,
  documentSeries,
  extras,
  folioItems,
  guests,
  housekeepingTasks,
  invoiceLines,
  invoices,
  memberships,
  payments,
  promoCodes,
  properties,
  rateOverrides,
  ratePlans,
  reservations,
  rooms,
  roomTypes,
  tenants,
  users,
} from './schema.js';

const PAST_DAYS = 60;
const FUTURE_DAYS = 60;
const OUT_OF_ORDER_ROOM = '206';

function prng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Andrei', 'Maria', 'Ioana', 'Alexandru', 'Elena', 'Mihai', 'Cristina', 'Bogdan', 'Raluca', 'Vlad', 'Diana', 'Stefan', 'Ana', 'Sorin', 'Irina', 'Paul', 'Laura', 'George', 'Simona', 'Dan'];
const LAST = ['Popescu', 'Ionescu', 'Dumitrescu', 'Stoica', 'Munteanu', 'Constantin', 'Florea', 'Matei', 'Nistor', 'Barbu', 'Lungu', 'Radu', 'Tudor', 'Ene', 'Moldovan'];
const FOREIGN: [string, string, string][] = [
  ['Sophie', 'Martin', 'FR'], ['Lukas', 'Weber', 'DE'], ['Anna', 'Schmidt', 'DE'], ['James', 'Taylor', 'GB'], ['Emma', 'Wilson', 'GB'],
  ['Marco', 'Rossi', 'IT'], ['Giulia', 'Bianchi', 'IT'], ['Pablo', 'García', 'ES'], ['Lucía', 'Fernández', 'ES'], ['Daan', 'de Vries', 'NL'],
  ['Eszter', 'Nagy', 'HU'], ['Piotr', 'Kowalski', 'PL'], ['Noah', 'Müller', 'AT'], ['Olivia', 'Brown', 'US'], ['Yuki', 'Tanaka', 'JP'],
];
const CITIES = ['București', 'Cluj-Napoca', 'Iași', 'Timișoara', 'Constanța', 'Sibiu', 'Brașov', 'Oradea'];
const REQUESTS = ['High floor, quiet room please', 'Arriving late, around 23:00', 'Celebrating our anniversary', 'Gluten-free breakfast', 'Baby cot needed', 'Early check-in if possible', 'Allergic to feathers'];

/** One timestamp on a business date, in the hotel's (Bucharest) local time. */
const at = (date: string, time: string) => new Date(`${date}T${time}:00+02:00`);

export async function seedMockData(db: DbService) {
  const [tenant] = await db.db.select().from(tenants).where(eq(tenants.slug, 'demo'));
  if (!tenant) return { skipped: true as const, reason: 'no demo organization' };
  return db.tenant((tx) => generate(tx, tenant.id), tenant.id);
}

async function generate(tx: Tx, tenantId: string) {
  const [done] = await tx.select({ id: reservations.id }).from(reservations).where(like(reservations.code, 'MK%')).limit(1);
  if (done) return { skipped: true as const, reason: 'mock data already present' };
  const [property] = await tx.select().from(properties).limit(1);
  if (!property) return { skipped: true as const, reason: 'no property' };
  const p = await catchUpBusinessDate(tx, property);
  const T = p.businessDate;
  const rand = prng(480);
  const pick = <V>(xs: readonly V[]) => xs[Math.floor(rand() * xs.length)]!;
  const chance = (x: number) => rand() < x;

  const types = await tx.select().from(roomTypes).where(eq(roomTypes.propertyId, p.id));
  const roomRows = await tx.select().from(rooms).where(eq(rooms.propertyId, p.id));
  const plans = await tx.select().from(ratePlans).where(eq(ratePlans.propertyId, p.id));
  const plan = (code: string) => plans.find((x) => x.code === code) ?? plans[0]!;
  const staff = await tx
    .select({ id: users.id, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.tenantId, tenantId));
  const staffId = (email: string) => staff.find((s) => s.email === email)?.id ?? null;
  const frontDesk = staffId('frontdesk@demo.test');
  const housekeepers = [staffId('housekeeper@demo.test'), staffId('hk-lead@demo.test')].filter(Boolean) as string[];

  // Weekend pricing: Friday and Saturday nights 20% above the base rate.
  const overrides: (typeof rateOverrides.$inferInsert)[] = [];
  for (let d = addDays(T, -PAST_DAYS); d < addDays(T, FUTURE_DAYS + 10); d = addDays(d, 1)) {
    if (weekday(d) !== 5 && weekday(d) !== 6) continue;
    for (const t of types) overrides.push({ tenantId, roomTypeId: t.id, ratePlanId: null, date: d, price: applyPercent(t.baseRate, 20) });
  }
  await tx.insert(rateOverrides).values(overrides).onConflictDoNothing();
  const weekendPrice = new Map(overrides.map((o) => [`${o.roomTypeId}|${o.date}`, o.price!]));

  const extraRows = await tx
    .insert(extras)
    .values([
      { tenantId, propertyId: p.id, name: 'Parking', category: 'parking', unit: 'per_night', price: 4000, vatRate: p.standardVatRate, sortOrder: 1 },
      { tenantId, propertyId: p.id, name: 'Late check-out (16:00)', category: 'other', unit: 'per_stay', price: 9000, vatRate: p.accommodationVatRate, sortOrder: 2 },
      { tenantId, propertyId: p.id, name: 'Spa access', category: 'spa', unit: 'per_guest', price: 12000, vatRate: p.standardVatRate, sortOrder: 3 },
      { tenantId, propertyId: p.id, name: 'Airport transfer', category: 'other', unit: 'per_stay', price: 18000, vatRate: p.standardVatRate, sortOrder: 4 },
      { tenantId, propertyId: p.id, name: 'Bottle of Fetească Neagră', category: 'food_beverage', unit: 'per_stay', price: 11000, vatRate: p.standardVatRate, sortOrder: 5 },
    ])
    .returning();
  const [promo] = await tx
    .insert(promoCodes)
    .values([
      { tenantId, propertyId: p.id, code: 'AUTUMN15', description: '15% off autumn stays', discountType: 'percent', value: 15, minNights: 2, usedCount: 0 },
      { tenantId, propertyId: p.id, code: 'WELCOME50', description: '50 lei off a first stay', discountType: 'fixed', value: 5000, maxUses: 100 },
    ])
    .returning();

  const companyRows = await tx
    .insert(companies)
    .values([
      { tenantId, name: 'Carpathia Software SRL', taxId: 'RO40112233', registrationNumber: 'J40/1111/2019', address: 'Bd. Unirii 15', city: 'București', email: 'travel@carpathia.example' },
      { tenantId, name: 'Transilvania Logistic SA', taxId: 'RO18223344', registrationNumber: 'J12/2222/2008', address: 'Str. Fabricii 7', city: 'Cluj-Napoca', email: 'office@translog.example' },
      { tenantId, name: 'Alpin Tours', taxId: 'RO30334455', city: 'Brașov', email: 'booking@alpintours.example', isAgency: true, commissionPercent: 12 },
      { tenantId, name: 'EuroVoyage Agency', city: 'Wien', country: 'AT', email: 'res@eurovoyage.example', isAgency: true, commissionPercent: 15 },
    ])
    .returning();
  const corporate = companyRows.filter((c) => !c.isAgency);
  const agencies = companyRows.filter((c) => c.isAgency);

  const guestValues: (typeof guests.$inferInsert)[] = [];
  for (let i = 0; i < 70; i++) {
    const foreign = chance(0.35);
    const [firstName, lastName, nationality] = foreign ? pick(FOREIGN) : [pick(FIRST), pick(LAST), 'RO'];
    const slug = `${firstName}.${lastName}`.toLowerCase().normalize('NFD').replace(/[^a-z.]/g, '');
    guestValues.push({
      id: randomUUID(),
      tenantId,
      firstName,
      lastName,
      email: chance(0.85) ? `${slug}${i}@example.com` : null,
      phone: chance(0.7) ? `+40 7${String(20 + (i % 60)).padStart(2, '0')} ${String(100000 + i * 7919).slice(0, 6)}` : null,
      nationality,
      city: nationality === 'RO' ? pick(CITIES) : null,
      country: nationality,
      segment: chance(0.08) ? 'vip' : chance(0.2) ? 'business' : 'standard',
      companyId: chance(0.12) ? pick(corporate).id : null,
      marketingConsent: chance(0.4),
      tags: chance(0.1) ? ['repeat'] : [],
    });
  }
  await tx.insert(guests).values(guestValues);

  // Rooms already used by existing (non-mock) stays stay free for them.
  const existing = await tx
    .select({ roomId: reservations.roomId, arrival: reservations.arrival, departure: reservations.departure })
    .from(reservations)
    .where(and(eq(reservations.propertyId, p.id), sql`${reservations.status} not in ('cancelled', 'no_show')`));
  const busy = (roomId: string, a: string, d: string) => existing.some((e) => e.roomId === roomId && e.arrival < d && a < e.departure);

  type Stay = typeof reservations.$inferInsert & { id: string; nightlyRates: { date: string; amount: number }[]; extras: BookedExtra[] };
  const stays: Stay[] = [];
  let code = 0;
  const SOURCES = ['direct', 'direct', 'phone', 'email', 'website', 'website', 'website', 'ota', 'ota', 'agent', 'corporate', 'walk_in'] as const;

  const makeStay = (room: (typeof roomRows)[0] | null, roomType: (typeof types)[0], arrival: string, nights: number, status: string): Stay => {
    const departure = addDays(arrival, nights);
    const source = pick(SOURCES);
    let ratePlan = chance(0.4) ? plan('BB') : chance(0.3) && nights >= 2 ? plan('NR') : plan('BAR');
    if (ratePlan.minNights > nights) ratePlan = plan('BAR');
    let nightlyRates = stayDates(arrival, departure).map((date) => ({
      date,
      amount: applyPercent(weekendPrice.get(`${roomType.id}|${date}`) ?? roomType.baseRate, ratePlan.adjustmentPercent),
    }));
    let discountAmount = 0;
    let promoCode: string | null = null;
    if (source === 'website' && nights >= 2 && chance(0.25)) {
      const before = nightlyRates.reduce((s, n) => s + n.amount, 0);
      nightlyRates = nightlyRates.map((n) => ({ ...n, amount: Math.round(n.amount * 0.85) }));
      discountAmount = before - nightlyRates.reduce((s, n) => s + n.amount, 0);
      promoCode = promo!.code;
    }
    const adults = Math.min(roomType.maxOccupancy, chance(0.2) ? 1 : chance(0.15) ? 3 : 2);
    const booked: BookedExtra[] = [];
    const addExtra = (name: string, quantity: number) => {
      const e = extraRows.find((x) => x.name === name)!;
      booked.push({ extraId: e.id, name: e.name, unit: e.unit, unitPrice: e.price, quantity, amount: e.price * quantity, vatRate: e.vatRate, included: false });
    };
    if (chance(0.3)) addExtra('Parking', nights);
    if (chance(0.12)) addExtra('Late check-out (16:00)', 1);
    if (chance(0.1)) addExtra('Spa access', adults);
    if (chance(0.06)) addExtra('Airport transfer', 1);
    const extrasAmount = booked.reduce((s, e) => s + e.amount, 0);
    const lead = Math.floor(rand() * 40);
    const created = addDays(arrival, -lead) < T ? addDays(arrival, -lead) : addDays(T, -1);
    const guestId = guestValues[Math.floor(rand() * guestValues.length)]!;
    return {
      id: randomUUID(),
      tenantId,
      propertyId: p.id,
      code: `MK${String(++code).padStart(5, '0')}`,
      guestId: guestId.id!,
      companyId: source === 'corporate' ? (guestId.companyId ?? pick(corporate).id) : source === 'agent' || source === 'ota' ? pick(agencies).id : null,
      roomTypeId: roomType.id,
      roomId: room?.id ?? null,
      ratePlanId: ratePlan.id,
      status,
      source,
      arrival,
      departure,
      adults,
      children: adults === 2 && chance(0.15) ? 1 : 0,
      currency: p.currency,
      totalAmount: nightlyRates.reduce((s, n) => s + n.amount, 0) + extrasAmount,
      nightlyRates,
      extras: booked,
      extrasAmount,
      promoCodeId: promoCode ? promo!.id : null,
      promoCode,
      discountAmount,
      guestLocale: guestId.nationality === 'RO' ? 'ro' : 'en',
      estimatedArrival: arrival >= T && chance(0.6) ? pick(['14:00', '15:30', '16:00', '17:30', '19:00', '21:30', '23:00']) : null,
      guestRequests: chance(0.15) ? pick(REQUESTS) : null,
      createdById: frontDesk,
      createdAt: at(created, '10:15'),
    };
  };

  // Walk each room's calendar, filling it with stays: busy in the past, thinning out ahead.
  for (const room of roomRows) {
    if (room.number === OUT_OF_ORDER_ROOM) continue;
    const roomType = types.find((t) => t.id === room.roomTypeId)!;
    let d = addDays(T, -PAST_DAYS);
    while (d < addDays(T, FUTURE_DAYS)) {
      const ahead = (Date.parse(d) - Date.parse(T)) / 86_400_000;
      const fill = ahead <= 0 ? 0.78 : Math.max(0.12, 0.75 - ahead / 70);
      const nights = pick([1, 2, 2, 2, 3, 3, 4, 5, 7]);
      const departure = addDays(d, nights);
      if (!chance(fill) || busy(room.id, d, departure)) {
        d = addDays(d, 1);
        continue;
      }
      let status: string;
      if (departure < T) status = 'checked_out';
      else if (departure === T) status = chance(0.45) ? 'checked_out' : 'checked_in';
      else if (d < T) status = 'checked_in';
      else status = d === T || chance(0.88) ? 'confirmed' : 'tentative';
      const assign = status !== 'confirmed' && status !== 'tentative' ? true : d === T ? chance(0.7) : chance(0.35);
      stays.push(makeStay(assign ? room : null, roomType, d, nights, status));
      d = addDays(departure, chance(0.6) ? 0 : 1);
    }
  }
  // Cancellations and no-shows (they hold no room).
  for (let i = 0; i < 18; i++) {
    const roomType = pick(types);
    const arrival = addDays(T, Math.floor(rand() * (PAST_DAYS + FUTURE_DAYS)) - PAST_DAYS);
    const s = makeStay(null, roomType, arrival, pick([1, 2, 3]), arrival < T && chance(0.35) ? 'no_show' : 'cancelled');
    if (s.status === 'cancelled') {
      s.cancelReason = pick(['Change of plans', 'Found another hotel', 'Flight cancelled', 'Illness']);
      s.cancelledAt = at(addDays(arrival, -Math.floor(rand() * 10) - 1) < T ? addDays(arrival, -3) : addDays(T, -1), '09:40');
    }
    stays.push(s);
  }
  for (const s of stays) {
    if (s.status === 'checked_in' || s.status === 'checked_out') {
      s.checkedInAt = at(s.arrival, pick(['14:05', '15:20', '16:40', '18:10', '20:30']));
      s.extrasPostedAt = s.extras.length ? s.checkedInAt : null;
    }
    if (s.status === 'checked_out') s.checkedOutAt = at(s.departure, pick(['09:15', '10:30', '11:40']));
    if (s.status === 'checked_in' && s.arrival < T && chance(0.15)) s.onlineCheckinAt = at(addDays(s.arrival, -1), '20:00');
  }
  if (promo) await tx.update(promoCodes).set({ usedCount: stays.filter((s) => s.promoCodeId).length }).where(eq(promoCodes.id, promo.id));
  for (let i = 0; i < stays.length; i += 200) await tx.insert(reservations).values(stays.slice(i, i + 200));

  // Folios: room nights up to the business date, booked extras, and incidentals.
  const items: (typeof folioItems.$inferInsert & { id: string })[] = [];
  const pays: (typeof payments.$inferInsert)[] = [];
  const INCIDENTALS = [
    ['food_beverage', 'Restaurant dinner', 14000, 32000],
    ['food_beverage', 'Lobby bar', 3500, 9000],
    ['minibar', 'Minibar', 1500, 6000],
    ['laundry', 'Laundry', 3000, 7000],
    ['spa', 'Massage 50 min', 22000, 22000],
  ] as const;
  const folio = new Map<string, typeof items>();
  for (const s of stays) {
    if (s.status !== 'checked_in' && s.status !== 'checked_out') continue;
    const own: typeof items = [];
    for (const n of s.nightlyRates) {
      if (n.date >= T) break;
      own.push({ id: randomUUID(), tenantId, reservationId: s.id, category: 'accommodation', description: `Accommodation ${n.date}`, quantity: 1, unitPrice: n.amount, amount: n.amount, vatRate: p.accommodationVatRate, serviceDate: n.date, isRoomCharge: true, createdAt: at(addDays(n.date, 1), '02:00') });
    }
    for (const e of s.extras) {
      const category = extraRows.find((x) => x.id === e.extraId)?.category ?? 'other';
      own.push({ id: randomUUID(), tenantId, reservationId: s.id, category, description: e.name, quantity: e.quantity, unitPrice: e.unitPrice, amount: e.amount, vatRate: e.vatRate, serviceDate: s.arrival, createdAt: s.checkedInAt as Date });
    }
    const nightsSoFar = s.nightlyRates.filter((n) => n.date < T).length;
    for (let k = 0; k < nightsSoFar; k++) {
      if (!chance(0.35)) continue;
      const [category, description, min, max] = pick(INCIDENTALS);
      const unitPrice = Math.round((min + rand() * (max - min)) / 100) * 100;
      const serviceDate = addDays(s.arrival, k);
      own.push({ id: randomUUID(), tenantId, reservationId: s.id, category, description, quantity: 1, unitPrice, amount: unitPrice, vatRate: p.standardVatRate, serviceDate, postedById: frontDesk, createdAt: at(serviceDate, '21:15') });
    }
    folio.set(s.id, own);
    items.push(...own);
    const owed = own.reduce((sum, i) => sum + i.amount!, 0);
    const method = s.companyId && s.source === 'corporate' ? 'bank_transfer' : chance(0.75) ? 'card' : 'cash';
    if (s.status === 'checked_out') {
      if (s.ratePlanId === plan('NR').id) {
        pays.push({ tenantId, propertyId: p.id, reservationId: s.id, method: 'card', amount: s.totalAmount!, currency: p.currency, reference: 'Prepaid online', receivedById: frontDesk, createdAt: s.createdAt as Date });
        if (owed > s.totalAmount!) pays.push({ tenantId, propertyId: p.id, reservationId: s.id, method, amount: owed - s.totalAmount!, currency: p.currency, receivedById: frontDesk, createdAt: s.checkedOutAt as Date });
      } else pays.push({ tenantId, propertyId: p.id, reservationId: s.id, method, amount: owed, currency: p.currency, receivedById: frontDesk, createdAt: s.checkedOutAt as Date });
    } else {
      const r = rand();
      const paid = s.ratePlanId === plan('NR').id || r < 0.35 ? s.totalAmount! : r < 0.6 ? Math.round(s.totalAmount! * 0.3) : 0;
      if (paid) pays.push({ tenantId, propertyId: p.id, reservationId: s.id, method: 'card', amount: paid, currency: p.currency, reference: paid === s.totalAmount ? 'Prepaid' : 'Deposit', receivedById: frontDesk, createdAt: s.checkedInAt as Date });
    }
  }
  // Deposits on upcoming bookings.
  for (const s of stays) {
    if (s.status !== 'confirmed' || s.arrival < T) continue;
    if (s.ratePlanId === plan('NR').id) pays.push({ tenantId, propertyId: p.id, reservationId: s.id, method: 'card', amount: s.totalAmount!, currency: p.currency, reference: 'Prepaid online', createdAt: s.createdAt as Date });
    else if (chance(0.25)) pays.push({ tenantId, propertyId: p.id, reservationId: s.id, method: chance(0.7) ? 'card' : 'bank_transfer', amount: Math.round(s.totalAmount! * 0.3), currency: p.currency, reference: 'Deposit', createdAt: s.createdAt as Date });
  }

  // Invoices for every finished stay, numbered in check-out order.
  const [series] = await tx.select().from(documentSeries).where(and(eq(documentSeries.propertyId, p.id), eq(documentSeries.type, 'invoice')));
  const invoiceRows: (typeof invoices.$inferInsert)[] = [];
  const lineRows: (typeof invoiceLines.$inferInsert)[] = [];
  let number = series?.nextNumber ?? 1;
  const seller = { name: p.legalName ?? p.name, taxId: p.taxId, registrationNumber: p.registrationNumber, address: p.address, city: p.city, country: p.country, email: p.email };
  const finished = series ? stays.filter((s) => s.status === 'checked_out').sort((a, b) => a.departure.localeCompare(b.departure)) : [];
  for (const s of finished) {
    const own = folio.get(s.id) ?? [];
    const company = s.companyId && s.source === 'corporate' ? companyRows.find((c) => c.id === s.companyId) : undefined;
    const g = guestValues.find((x) => x.id === s.guestId)!;
    const billTo = company
      ? { name: company.name, taxId: company.taxId, registrationNumber: company.registrationNumber, address: company.address, city: company.city, country: company.country, email: company.email }
      : { name: `${g.firstName} ${g.lastName}`, city: g.city ?? null, country: g.country ?? null, email: g.email ?? null };
    const room = own.filter((i) => i.isRoomCharge);
    const lines = [
      { description: `Accommodation ${s.arrival} – ${s.departure} (${room.length} nights)`, quantity: 1, unitPrice: room.reduce((sum, i) => sum + i.amount!, 0), vatRate: p.accommodationVatRate, folioItemId: null as string | null },
      ...own.filter((i) => !i.isRoomCharge).map((i) => ({ description: i.description, quantity: i.quantity!, unitPrice: i.unitPrice!, vatRate: i.vatRate, folioItemId: i.id })),
    ].map((l) => {
      const total = l.quantity * l.unitPrice;
      const vat = vatFromGross(total, l.vatRate);
      return { ...l, total, vat, net: total - vat };
    });
    const id = randomUUID();
    const total = lines.reduce((sum, l) => sum + l.total, 0);
    const vatTotal = lines.reduce((sum, l) => sum + l.vat, 0);
    invoiceRows.push({
      id, tenantId, propertyId: p.id, type: 'invoice', status: 'paid', series: series!.prefix, number,
      fullNumber: `${series!.prefix}-${String(number).padStart(6, '0')}`, reservationId: s.id, guestId: s.guestId,
      companyId: company?.id ?? null, seller, billTo, issueDate: s.departure, dueDate: addDays(s.departure, company ? 15 : 0),
      currency: p.currency, subtotal: total - vatTotal, vatTotal, total, createdById: frontDesk, createdAt: s.checkedOutAt as Date,
    });
    number++;
    lines.forEach((l, i) => lineRows.push({ tenantId, invoiceId: id, position: i + 1, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, vatRate: l.vatRate, net: l.net, vat: l.vat, total: l.total, folioItemId: l.folioItemId }));
    for (const i of own) i.invoiceId = id;
    for (const pay of pays) if (pay.reservationId === s.id) pay.invoiceId = id;
  }
  for (let i = 0; i < items.length; i += 500) await tx.insert(folioItems).values(items.slice(i, i + 500));
  for (let i = 0; i < invoiceRows.length; i += 200) await tx.insert(invoices).values(invoiceRows.slice(i, i + 200));
  for (let i = 0; i < lineRows.length; i += 500) await tx.insert(invoiceLines).values(lineRows.slice(i, i + 500));
  for (let i = 0; i < pays.length; i += 500) await tx.insert(payments).values(pays.slice(i, i + 500));
  if (series) await tx.update(documentSeries).set({ nextNumber: number }).where(eq(documentSeries.id, series.id));

  // Today's house: who sleeps where, what needs cleaning.
  const inHouse = new Set(stays.filter((s) => s.status === 'checked_in' && s.roomId).map((s) => s.roomId!));
  const leftToday = new Set(stays.filter((s) => s.status === 'checked_out' && s.departure === T && s.roomId).map((s) => s.roomId!));
  const tasks: (typeof housekeepingTasks.$inferInsert)[] = [];
  for (const room of roomRows) {
    if (room.number === OUT_OF_ORDER_ROOM) {
      if (!busy(room.id, T, addDays(T, 1))) await tx.update(rooms).set({ status: 'out_of_order', occupancy: 'vacant', notes: 'Bathroom leak, plumber booked for Thursday' }).where(eq(rooms.id, room.id));
      continue;
    }
    if (existing.some((e) => e.roomId === room.id && e.arrival <= T && T < e.departure)) continue;
    const assignedToUserId = housekeepers.length ? pick(housekeepers) : null;
    if (leftToday.has(room.id)) {
      const cleaned = chance(0.5);
      tasks.push({ tenantId, propertyId: p.id, roomId: room.id, type: 'checkout_clean', status: cleaned ? 'done' : 'pending', date: T, assignedToUserId, priority: 1, completedAt: cleaned ? at(T, '11:50') : null });
      await tx.update(rooms).set({ status: cleaned ? 'clean' : 'dirty', occupancy: 'vacant' }).where(eq(rooms.id, room.id));
    } else if (inHouse.has(room.id)) {
      const cleaned = chance(0.4);
      tasks.push({ tenantId, propertyId: p.id, roomId: room.id, type: 'stayover', status: cleaned ? 'done' : 'pending', date: T, assignedToUserId, completedAt: cleaned ? at(T, '10:40') : null });
      await tx.update(rooms).set({ status: cleaned ? 'clean' : 'dirty', occupancy: 'occupied' }).where(eq(rooms.id, room.id));
    } else {
      await tx.update(rooms).set({ status: chance(0.6) ? 'inspected' : 'clean', occupancy: 'vacant' }).where(eq(rooms.id, room.id));
    }
  }
  if (tasks.length) await tx.insert(housekeepingTasks).values(tasks).onConflictDoNothing();

  return {
    skipped: false as const,
    reservations: stays.length,
    guests: guestValues.length,
    folioItems: items.length,
    payments: pays.length,
    invoices: invoiceRows.length,
    businessDate: T,
  };
}

/**
 * The demo is seeded once; without night audits its business date stays behind.
 * Move it (and the original demo stays) forward to today so the mock data is current.
 */
async function catchUpBusinessDate(tx: Tx, property: typeof properties.$inferSelect) {
  const today = todayIn(property.timezone);
  if (property.businessDate >= today) return property;
  const shift = Math.round((Date.parse(today) - Date.parse(property.businessDate)) / 86_400_000);
  const demo = await tx.select().from(reservations).where(and(eq(reservations.propertyId, property.id), like(reservations.code, 'DEMO%')));
  for (const r of demo) {
    await tx
      .update(reservations)
      .set({
        arrival: addDays(r.arrival, shift),
        departure: addDays(r.departure, shift),
        nightlyRates: r.nightlyRates.map((n) => ({ ...n, date: addDays(n.date, shift) })),
      })
      .where(eq(reservations.id, r.id));
  }
  const [updated] = await tx.update(properties).set({ businessDate: today }).where(eq(properties.id, property.id)).returning();
  return updated!;
}
