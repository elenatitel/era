import { and, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import { ACTIVE_RESERVATION_STATUSES, applyPercent, stayDates } from '@pms/shared';
import type { Tx } from '../db/db.service.js';
import { ratePlans, rateOverrides, reservations, rooms, roomTypes, type NightlyRate } from '../db/schema.js';

type RoomType = typeof roomTypes.$inferSelect;
type RatePlan = typeof ratePlans.$inferSelect;

export interface Quote {
  nightlyRates: NightlyRate[];
  total: number;
  closedDates: string[];
}

/**
 * Price resolution per night, most specific first:
 *   1. override for (room type, rate plan, date)           -> used as-is
 *   2. override for (room type, any plan, date)            -> plan adjustment applied
 *   3. room type base rate                                 -> plan adjustment applied
 * A `closed` override on either level stops the sale for that date.
 */
export async function quote(tx: Tx, roomType: RoomType, plan: RatePlan, arrival: string, departure: string): Promise<Quote> {
  const dates = stayDates(arrival, departure);
  const overrides = await tx
    .select()
    .from(rateOverrides)
    .where(
      and(
        eq(rateOverrides.roomTypeId, roomType.id),
        or(eq(rateOverrides.ratePlanId, plan.id), isNull(rateOverrides.ratePlanId)),
        gte(rateOverrides.date, arrival),
        lt(rateOverrides.date, departure),
      ),
    );
  const closedDates: string[] = [];
  const nightlyRates = dates.map((date) => {
    const specific = overrides.find((o) => o.date === date && o.ratePlanId === plan.id);
    const general = overrides.find((o) => o.date === date && o.ratePlanId === null);
    if (specific?.closed || general?.closed) closedDates.push(date);
    let amount: number;
    if (specific?.price != null) amount = specific.price;
    else amount = applyPercent(general?.price ?? roomType.baseRate, plan.adjustmentPercent);
    return { date, amount };
  });
  return { nightlyRates, total: nightlyRates.reduce((s, n) => s + n.amount, 0), closedDates };
}

export interface AvailabilityRow {
  roomTypeId: string;
  date: string;
  total: number;
  booked: number;
}

/** Sellable rooms per room type and night (excluding out-of-order rooms). */
export async function availability(tx: Tx, propertyId: string, arrival: string, departure: string, roomTypeIds?: string[]) {
  const statuses = sql.join(
    ACTIVE_RESERVATION_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  const filter = roomTypeIds?.length ? sql`and rt.id in (${sql.join(roomTypeIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``;
  const result = await tx.execute<{ room_type_id: string; date: string; total: number; booked: number }>(sql`
    select rt.id as room_type_id, to_char(d, 'YYYY-MM-DD') as date,
      (select count(*)::int from ${rooms} r
        where r.room_type_id = rt.id and r.active and r.status <> 'out_of_order') as total,
      (select count(*)::int from ${reservations} res
        where res.room_type_id = rt.id and res.status in (${statuses})
          and res.arrival <= d::date and res.departure > d::date) as booked
    from ${roomTypes} rt
    cross join generate_series(${arrival}::date, ${departure}::date - 1, interval '1 day') d
    where rt.property_id = ${propertyId} and rt.active ${filter}
    order by rt.id, d`);
  return result.rows.map<AvailabilityRow>((r) => ({ roomTypeId: r.room_type_id, date: r.date, total: r.total, booked: r.booked }));
}

/** Minimum free rooms of a type across the stay. */
export function minFree(rows: AvailabilityRow[], roomTypeId: string): number {
  const own = rows.filter((r) => r.roomTypeId === roomTypeId);
  return own.length ? Math.min(...own.map((r) => r.total - r.booked)) : 0;
}

/** Free physical rooms of a type for the whole stay. */
export async function freeRooms(tx: Tx, roomTypeId: string, arrival: string, departure: string, excludeReservationId?: string) {
  const statuses = sql.join(
    ACTIVE_RESERVATION_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );
  const exclude = excludeReservationId ? sql`and res.id <> ${excludeReservationId}` : sql``;
  return tx
    .select()
    .from(rooms)
    .where(
      and(
        eq(rooms.roomTypeId, roomTypeId),
        eq(rooms.active, true),
        sql`${rooms.status} <> 'out_of_order'`,
        sql`not exists (select 1 from ${reservations} res where res.room_id = ${rooms.id}
            and res.status in (${statuses}) ${exclude}
            and res.arrival < ${departure}::date and res.departure > ${arrival}::date)`,
      ),
    )
    .orderBy(rooms.number);
}

