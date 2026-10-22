import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/db.service.js';
import { extras, folioItems, payments, properties, reservations } from '../db/schema.js';

type Reservation = typeof reservations.$inferSelect;
type Property = typeof properties.$inferSelect;

/**
 * Posts accommodation charges for every night of the stay before `untilExclusive`.
 * Idempotent thanks to the partial unique index folio_room_charge_once.
 */
export async function postRoomCharges(tx: Tx, reservation: Reservation, property: Property, untilExclusive: string, userId?: string) {
  const nights = reservation.nightlyRates.filter((n) => n.date < untilExclusive);
  if (!nights.length) return 0;
  const inserted = await tx
    .insert(folioItems)
    .values(
      nights.map((n) => ({
        tenantId: reservation.tenantId,
        reservationId: reservation.id,
        category: 'accommodation',
        description: `Accommodation ${n.date}`,
        quantity: 1,
        unitPrice: n.amount,
        amount: n.amount,
        vatRate: property.accommodationVatRate,
        serviceDate: n.date,
        isRoomCharge: true,
        postedById: userId ?? null,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: folioItems.id });
  return inserted.length;
}

/**
 * Posts the extras booked with the stay (packages and add-ons) to the folio, once.
 * Runs at check-in; check-out calls it too for stays checked in before extras existed.
 */
export async function postBookedExtras(tx: Tx, reservation: Reservation, userId?: string) {
  if (!reservation.extras.length) return 0;
  const [claimed] = await tx
    .update(reservations)
    .set({ extrasPostedAt: new Date() })
    .where(and(eq(reservations.id, reservation.id), isNull(reservations.extrasPostedAt)))
    .returning({ id: reservations.id });
  if (!claimed) return 0;
  // Category comes from the live extra; a deleted extra falls back to "other".
  const rows = await tx
    .select({ id: extras.id, category: extras.category })
    .from(extras)
    .where(inArray(extras.id, reservation.extras.map((e) => e.extraId)));
  const categories = new Map(rows.map((r) => [r.id, r.category]));
  await tx.insert(folioItems).values(
    reservation.extras.map((e) => ({
      tenantId: reservation.tenantId,
      reservationId: reservation.id,
      category: categories.get(e.extraId) ?? 'other',
      description: e.included ? `${e.name} (package)` : e.name,
      quantity: e.quantity,
      unitPrice: e.unitPrice,
      amount: e.amount,
      vatRate: e.vatRate,
      serviceDate: reservation.arrival,
      postedById: userId ?? null,
    })),
  );
  return reservation.extras.length;
}

export async function folioTotals(tx: Tx, reservationId: string) {
  const [charges] = await tx
    .select({ total: sql<number>`coalesce(sum(${folioItems.amount}), 0)::bigint` })
    .from(folioItems)
    .where(and(eq(folioItems.reservationId, reservationId), isNull(folioItems.voidedAt)));
  const [paid] = await tx
    .select({ total: sql<number>`coalesce(sum(${payments.amount}), 0)::bigint` })
    .from(payments)
    .where(eq(payments.reservationId, reservationId));
  const chargesTotal = Number(charges?.total ?? 0);
  const paymentsTotal = Number(paid?.total ?? 0);
  return { charges: chargesTotal, payments: paymentsTotal, balance: chargesTotal - paymentsTotal };
}
