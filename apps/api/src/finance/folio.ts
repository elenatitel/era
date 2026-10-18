import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/db.service.js';
import { folioItems, payments, properties, reservations } from '../db/schema.js';

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
