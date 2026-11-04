import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { aliasedTable, and, asc, count, desc, eq, gt, gte, ilike, inArray, lt, lte, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  ACTIVE_RESERVATION_STATUSES,
  ERROR_CODES,
  addDays,
  applyDiscount,
  availabilitySchema,
  createReservationSchema,
  extraQuantity,
  nightsBetween,
  reservationSearchSchema,
  stayDates,
  todayIn,
  updateReservationSchema,
} from '@pms/shared';
import { allowedPropertyIds, ctx, hasPermission, requireTenant } from '../common/context.js';
import { conflict, forbidden, invalidState, notFound, unprocessable } from '../common/errors.js';
import { AuditService } from '../db/audit.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import {
  companies,
  extras,
  folioItems,
  guests,
  housekeepingTasks,
  invoices,
  payments,
  properties,
  reservationGuests,
  promoCodes,
  ratePlans,
  reservations,
  rooms,
  roomTypes,
  users,
} from '../db/schema.js';
import { folioTotals, pendingCharges, postBookedExtras, postRoomCharges } from '../finance/folio.js';
import { assertCompany, insertGuest, presentGuest } from '../guests/guests.module.js';
import { decryptNullable, mask } from '../common/crypto.js';
import { getAccessibleProperty } from '../properties/properties.module.js';
import { availability, bookExtra, findPromo, freeRooms, minFree, packageExtras, promoProblem, quote } from '../properties/pricing.js';

type Reservation = typeof reservations.$inferSelect;
type Property = typeof properties.$inferSelect;
type RoomType = typeof roomTypes.$inferSelect;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const generateCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

/** Serializes inventory changes for one room type (prevents overbooking under concurrency). */
async function lockRoomType(tx: Tx, roomTypeId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${roomTypeId}, 0))`);
}

/** The day an in-house guest really leaves: never before the first night is over, never after the booking ends. */
function actualDeparture(reservation: Reservation, today: string) {
  if (today >= reservation.departure) return reservation.departure;
  const firstMorning = addDays(reservation.arrival, 1);
  return today > firstMorning ? today : firstMorning;
}

@Injectable()
export class ReservationsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private async load(tx: Tx, id: string, forUpdate = false) {
    const query = tx.select().from(reservations).where(eq(reservations.id, id));
    const [r] = forUpdate ? await query.for('update') : await query;
    if (!r) throw notFound('Reservation');
    const property = await getAccessibleProperty(tx, r.propertyId);
    return { reservation: r, property };
  }

  // ---------------------------------------------------------------- availability

  searchAvailability(q: z.infer<typeof availabilitySchema>) {
    if (q.departure <= q.arrival) throw unprocessable('Departure must be after arrival');
    if (nightsBetween(q.arrival, q.departure) > 60) throw unprocessable('Stays are limited to 60 nights');
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, q.propertyId);
      const types = await tx
        .select()
        .from(roomTypes)
        .where(and(eq(roomTypes.propertyId, q.propertyId), eq(roomTypes.active, true)))
        .orderBy(asc(roomTypes.baseRate));
      const plans = await tx
        .select()
        .from(ratePlans)
        .where(and(eq(ratePlans.propertyId, q.propertyId), eq(ratePlans.active, true)));
      const rows = await availability(tx, q.propertyId, q.arrival, q.departure);
      const nights = nightsBetween(q.arrival, q.departure);
      const result = [];
      for (const rt of types) {
        const free = minFree(rows, rt.id);
        const offers = [];
        for (const plan of plans) {
          const qt = await quote(tx, rt, plan, q.arrival, q.departure);
          offers.push({
            ratePlanId: plan.id,
            ratePlanName: plan.name,
            includesBreakfast: plan.includesBreakfast,
            total: qt.total,
            nightlyRates: qt.nightlyRates,
            sellable: qt.closedDates.length === 0 && nights >= plan.minNights,
            minNights: plan.minNights,
          });
        }
        result.push({
          roomType: rt,
          available: Math.max(0, free),
          fitsOccupancy: q.adults <= rt.maxOccupancy,
          offers,
        });
      }
      return { arrival: q.arrival, departure: q.departure, nights, roomTypes: result };
    });
  }

  freeRooms(reservationId: string) {
    return this.db.tenant(async (tx) => {
      const { reservation } = await this.load(tx, reservationId);
      return freeRooms(tx, reservation.roomTypeId, reservation.arrival, reservation.departure, reservation.id);
    });
  }

  // ---------------------------------------------------------------- create

  /**
   * `options` carries optional extras and a promo code. Guests can only book extras sold
   * online; `staff` lifts that limit. Package extras of the rate plan are always added.
   */
  create(input: Omit<z.infer<typeof createReservationSchema>, 'extraIds' | 'promoCode'>, options: { extraIds?: string[]; promoCode?: string | null; staff?: boolean } = {}) {
    if (input.totalOverride != null && !hasPermission('rates.manage')) {
      throw forbidden('Overriding the price requires the rates.manage permission');
    }
    return this.db.tenant(async (tx) => {
      const property = await getAccessibleProperty(tx, input.propertyId);
      const [rt] = await tx
        .select()
        .from(roomTypes)
        .where(and(eq(roomTypes.id, input.roomTypeId), eq(roomTypes.propertyId, property.id), eq(roomTypes.active, true)));
      if (!rt) throw unprocessable('Room type not found for this property');
      const [plan] = await tx
        .select()
        .from(ratePlans)
        .where(and(eq(ratePlans.id, input.ratePlanId), eq(ratePlans.propertyId, property.id), eq(ratePlans.active, true)));
      if (!plan) throw unprocessable('Rate plan not found for this property');
      if (input.adults + input.children > rt.maxOccupancy) {
        throw unprocessable(`This room type allows at most ${rt.maxOccupancy} guests`);
      }
      const nights = nightsBetween(input.arrival, input.departure);
      if (nights > 60) throw unprocessable('Stays are limited to 60 nights');
      if (nights < plan.minNights) throw unprocessable(`This rate requires a minimum stay of ${plan.minNights} nights`);
      if (input.arrival < property.businessDate) throw unprocessable('Arrival cannot be before the current business date');

      await lockRoomType(tx, rt.id);
      const free = minFree(await availability(tx, property.id, input.arrival, input.departure, [rt.id]), rt.id);
      if (free < 1) throw conflict(ERROR_CODES.NO_AVAILABILITY, 'No rooms of this type are available for the selected dates');
      const qt = await quote(tx, rt, plan, input.arrival, input.departure);
      if (qt.closedDates.length) {
        throw conflict(ERROR_CODES.NO_AVAILABILITY, 'Sales are closed on some of the selected dates', { closedDates: qt.closedDates });
      }
      let nightlyRates = qt.nightlyRates;
      if (input.totalOverride != null) {
        const per = Math.floor(input.totalOverride / nights);
        nightlyRates = qt.nightlyRates.map((n, i) => ({
          date: n.date,
          amount: i === nights - 1 ? input.totalOverride! - per * (nights - 1) : per,
        }));
      }

      // Promo codes discount the room nights only, so night audit posts the discounted rates.
      let promo: typeof promoCodes.$inferSelect | null = null;
      let discountAmount = 0;
      if (options.promoCode && input.totalOverride == null) {
        promo = await findPromo(tx, property.id, options.promoCode, true);
        const problem = promoProblem(promo, { arrival: input.arrival, nights, ratePlanId: plan.id });
        if (problem) throw unprocessable('This promo code cannot be used for this stay', { code: ERROR_CODES.PROMO_INVALID, reason: problem });
        const applied = applyDiscount(nightlyRates, promo!.discountType, promo!.value);
        nightlyRates = applied.nights;
        discountAmount = applied.discount;
        await tx.update(promoCodes).set({ usedCount: sql`${promoCodes.usedCount} + 1` }).where(eq(promoCodes.id, promo!.id));
      }

      const guestCount = input.adults + input.children;
      const included = (await packageExtras(tx, [plan.id])).get(plan.id) ?? [];
      const bookedExtras = included.map((e) => bookExtra(e, nights, guestCount, true));
      const optionalIds = [...new Set(options.extraIds ?? [])].filter((id) => !included.some((e) => e.id === id));
      if (optionalIds.length) {
        const chosen = await tx
          .select()
          .from(extras)
          .where(and(inArray(extras.id, optionalIds), eq(extras.propertyId, property.id), eq(extras.active, true), options.staff ? undefined : eq(extras.bookableOnline, true)));
        if (chosen.length !== optionalIds.length) throw unprocessable('Some of the selected extras are no longer available');
        bookedExtras.push(...chosen.map((e) => bookExtra(e, nights, guestCount, false)));
      }
      const extrasAmount = bookedExtras.reduce((s, e) => s + e.amount, 0);
      const totalAmount = nightlyRates.reduce((s, n) => s + n.amount, 0) + extrasAmount;

      if (input.roomId) await this.assertRoomForType(tx, input.roomId, rt.id);
      await assertCompany(tx, input.companyId);

      let guestId = input.guestId;
      if (guestId) {
        const [g] = await tx.select({ id: guests.id }).from(guests).where(eq(guests.id, guestId));
        if (!g) throw unprocessable('Guest not found');
      } else {
        guestId = (await insertGuest(tx, input.guest!)).id;
      }

      const [created] = await tx
        .insert(reservations)
        .values({
          tenantId: requireTenant(),
          propertyId: property.id,
          code: generateCode(),
          guestId,
          companyId: input.companyId ?? null,
          roomTypeId: rt.id,
          roomId: input.roomId ?? null,
          ratePlanId: plan.id,
          status: input.status,
          source: input.source,
          arrival: input.arrival,
          departure: input.departure,
          adults: input.adults,
          children: input.children,
          currency: property.currency,
          totalAmount,
          nightlyRates,
          extras: bookedExtras,
          extrasAmount,
          promoCodeId: promo?.id ?? null,
          promoCode: promo?.code ?? null,
          discountAmount,
          externalRef: input.externalRef,
          notes: input.notes,
          createdById: ctx().userId,
        })
        .returning();
      await this.audit.log(tx, 'reservation.created', 'reservation', created!.id, {
        code: created!.code,
        arrival: input.arrival,
        departure: input.departure,
        total: totalAmount,
        override: input.totalOverride != null,
        ...(promo ? { promo: promo.code, discount: discountAmount } : {}),
        ...(bookedExtras.length ? { extras: bookedExtras.map((e) => e.name) } : {}),
      });
      return created!;
    });
  }

  private async assertRoomForType(tx: Tx, roomId: string, roomTypeId: string) {
    const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId));
    if (!room || room.roomTypeId !== roomTypeId) throw unprocessable('The room must be of the reserved room type');
    if (!room.active || room.status === 'out_of_order') throw invalidState('The room is out of order');
    return room;
  }

  // ---------------------------------------------------------------- read

  search(q: z.infer<typeof reservationSearchSchema>) {
    return this.db.tenant(async (tx) => {
      const allowed = allowedPropertyIds();
      const term = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const where = and(
        q.propertyId ? eq(reservations.propertyId, q.propertyId) : undefined,
        allowed ? inArray(reservations.propertyId, allowed) : undefined,
        q.status ? eq(reservations.status, q.status) : undefined,
        q.from ? gte(reservations.departure, q.from) : undefined,
        q.to ? lte(reservations.arrival, q.to) : undefined,
        term
          ? or(
              ilike(reservations.code, term),
              ilike(guests.lastName, term),
              ilike(guests.firstName, term),
              ilike(sql`${guests.firstName} || ' ' || ${guests.lastName}`, term),
              ilike(guests.email, term),
              ilike(reservations.externalRef, term),
            )
          : undefined,
      );
      const items = await tx
        .select({
          id: reservations.id,
          code: reservations.code,
          status: reservations.status,
          source: reservations.source,
          arrival: reservations.arrival,
          departure: reservations.departure,
          adults: reservations.adults,
          children: reservations.children,
          totalAmount: reservations.totalAmount,
          currency: reservations.currency,
          propertyId: reservations.propertyId,
          guestId: guests.id,
          guestName: sql<string>`${guests.firstName} || ' ' || ${guests.lastName}`,
          guestSegment: guests.segment,
          roomNumber: rooms.number,
          roomTypeCode: roomTypes.code,
          createdAt: reservations.createdAt,
        })
        .from(reservations)
        .innerJoin(guests, eq(guests.id, reservations.guestId))
        .innerJoin(roomTypes, eq(roomTypes.id, reservations.roomTypeId))
        .leftJoin(rooms, eq(rooms.id, reservations.roomId))
        .where(where)
        .orderBy(desc(reservations.arrival), desc(reservations.createdAt))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize);
      const [total] = await tx
        .select({ n: count() })
        .from(reservations)
        .innerJoin(guests, eq(guests.id, reservations.guestId))
        .where(where);
      return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
    });
  }

  get(id: string) {
    return this.db.tenant(async (tx) => {
      const { reservation, property } = await this.load(tx, id);
      const poster = aliasedTable(users, 'poster');
      const [[guest], [roomType], [ratePlan], room, company, items, pays, docs, totals] = await Promise.all([
        tx.select().from(guests).where(eq(guests.id, reservation.guestId)),
        tx.select().from(roomTypes).where(eq(roomTypes.id, reservation.roomTypeId)),
        tx.select().from(ratePlans).where(eq(ratePlans.id, reservation.ratePlanId)),
        reservation.roomId ? tx.select().from(rooms).where(eq(rooms.id, reservation.roomId)).then((r) => r[0] ?? null) : null,
        reservation.companyId
          ? tx.select().from(companies).where(eq(companies.id, reservation.companyId)).then((r) => r[0] ?? null)
          : null,
        hasPermission('folio.read')
          ? tx
              .select({ item: folioItems, postedBy: poster.name })
              .from(folioItems)
              .leftJoin(poster, eq(poster.id, folioItems.postedById))
              .where(eq(folioItems.reservationId, id))
              .orderBy(asc(folioItems.serviceDate), asc(folioItems.createdAt))
          : [],
        hasPermission('folio.read') ? tx.select().from(payments).where(eq(payments.reservationId, id)).orderBy(asc(payments.createdAt)) : [],
        hasPermission('invoices.read')
          ? tx
              .select({ id: invoices.id, fullNumber: invoices.fullNumber, type: invoices.type, status: invoices.status, total: invoices.total })
              .from(invoices)
              .where(eq(invoices.reservationId, id))
          : [],
        hasPermission('folio.read') ? folioTotals(tx, id) : null,
      ]);
      const companions = await tx.select().from(reservationGuests).where(eq(reservationGuests.reservationId, id));
      const open = ['tentative', 'confirmed', 'checked_in'].includes(reservation.status);
      const pending = totals && open ? await pendingCharges(tx, reservation, reservation.departure) : 0;
      return {
        ...reservation,
        property: { id: property.id, name: property.name, businessDate: property.businessDate, currency: property.currency },
        guest: guest ? presentGuest(guest) : null,
        roomType,
        ratePlan,
        room,
        company,
        folio: items.map((i) => ({ ...i.item, postedBy: i.postedBy })),
        payments: pays,
        invoices: docs,
        totals: totals && { ...totals, pending, due: totals.balance + pending },
        companions: companions.map((c) => {
          const doc = decryptNullable(c.documentNumberEnc);
          return {
            id: c.id,
            firstName: c.firstName,
            lastName: c.lastName,
            birthDate: c.birthDate,
            nationality: c.nationality,
            documentType: c.documentType,
            documentNumber: hasPermission('guests.pii') ? doc : mask(doc),
          };
        }),
      };
    });
  }

  // ---------------------------------------------------------------- modify

  update(id: string, input: z.infer<typeof updateReservationSchema>) {
    return this.db.tenant(async (tx) => {
      const { reservation, property } = await this.load(tx, id, true);
      if (!['tentative', 'confirmed', 'checked_in'].includes(reservation.status)) {
        throw invalidState('Only active reservations can be modified');
      }
      if (input.status && reservation.status === 'checked_in') throw invalidState('Guest is already checked in');
      if (input.roomId !== undefined && reservation.status === 'checked_in') {
        throw invalidState('Use a room move for in-house guests');
      }
      if (input.roomId) await this.assertRoomForType(tx, input.roomId, reservation.roomTypeId);
      await assertCompany(tx, input.companyId);
      const [rt] = await tx.select().from(roomTypes).where(eq(roomTypes.id, reservation.roomTypeId));
      const adults = input.adults ?? reservation.adults;
      const children = input.children ?? reservation.children;
      if (adults + children > rt!.maxOccupancy) throw unprocessable(`This room type allows at most ${rt!.maxOccupancy} guests`);
      const stay = await this.repriceStay(tx, reservation, property, rt!, input.arrival ?? reservation.arrival, input.departure ?? reservation.departure, adults + children);
      const [updated] = await tx.update(reservations).set({ ...input, ...stay }).where(eq(reservations.id, id)).returning();
      await this.audit.log(tx, 'reservation.updated', 'reservation', id, { ...input, total: stay.totalAmount, previousTotal: reservation.totalAmount });
      return updated;
    });
  }

  /**
   * Prices a changed stay. Nights that stay keep their agreed price (promo or negotiated);
   * only added nights take the current rate. Extras follow the stay until they reach the folio.
   */
  private async repriceStay(tx: Tx, r: Reservation, property: Property, rt: RoomType, arrival: string, departure: string, guestCount: number) {
    let nightlyRates = r.nightlyRates;
    if (arrival !== r.arrival || departure !== r.departure) {
      const inHouse = r.status === 'checked_in';
      if (departure <= arrival) throw unprocessable('Departure must be after arrival');
      const nights = nightsBetween(arrival, departure);
      if (nights > 60) throw unprocessable('Stays are limited to 60 nights');
      if (inHouse && arrival !== r.arrival) throw invalidState('The arrival of an in-house guest cannot change');
      if (inHouse && departure <= property.businessDate) throw invalidState('Use check-out for a guest who leaves today');
      if (!inHouse && arrival < property.businessDate) throw unprocessable('Arrival cannot be before the current business date');
      const [plan] = await tx.select().from(ratePlans).where(eq(ratePlans.id, r.ratePlanId));
      if (!inHouse && nights < plan!.minNights) throw unprocessable(`This rate requires a minimum stay of ${plan!.minNights} nights`);

      await lockRoomType(tx, rt.id);
      const agreed = new Map(r.nightlyRates.map((n) => [n.date, n.amount]));
      const added = new Set(stayDates(arrival, departure).filter((d) => !agreed.has(d)));
      const sold = (await availability(tx, property.id, arrival, departure, [rt.id])).filter((row) => added.has(row.date) && row.total - row.booked < 1);
      if (sold.length) {
        throw conflict(ERROR_CODES.NO_AVAILABILITY, 'No rooms of this type are available for the selected dates', { dates: sold.map((row) => row.date) });
      }
      if (r.roomId && !(await freeRooms(tx, rt.id, arrival, departure, r.id)).some((room) => room.id === r.roomId)) {
        throw conflict(ERROR_CODES.ROOM_CONFLICT, 'The assigned room is taken on the new dates');
      }
      const qt = await quote(tx, rt, plan!, arrival, departure);
      const closed = qt.closedDates.filter((d) => added.has(d));
      if (closed.length) throw conflict(ERROR_CODES.NO_AVAILABILITY, 'Sales are closed on some of the selected dates', { closedDates: closed });
      nightlyRates = qt.nightlyRates.map((n) => ({ date: n.date, amount: agreed.get(n.date) ?? n.amount }));
    }
    const bookedExtras = r.extrasPostedAt
      ? r.extras
      : r.extras.map((e) => {
          const quantity = extraQuantity(e.unit, nightlyRates.length, guestCount);
          return { ...e, quantity, amount: e.unitPrice * quantity };
        });
    const extrasAmount = bookedExtras.reduce((s, e) => s + e.amount, 0);
    return { nightlyRates, extras: bookedExtras, extrasAmount, totalAmount: nightlyRates.reduce((s, n) => s + n.amount, 0) + extrasAmount };
  }

  cancel(id: string, reason: string | null, noShow = false) {
    return this.db.tenant(async (tx) => {
      const { reservation, property } = await this.load(tx, id, true);
      if (!['tentative', 'confirmed'].includes(reservation.status)) {
        throw invalidState('Only reservations that are not yet checked in can be cancelled');
      }
      if (noShow && reservation.arrival > property.businessDate) throw invalidState('A no-show can only be recorded on or after arrival');
      const status = noShow ? 'no_show' : 'cancelled';
      const [updated] = await tx
        .update(reservations)
        .set({ status, cancelReason: reason, cancelledAt: new Date() })
        .where(eq(reservations.id, id))
        .returning();
      await this.audit.log(tx, `reservation.${status}`, 'reservation', id, { reason });
      return updated;
    });
  }

  // ---------------------------------------------------------------- front desk

  checkIn(id: string, roomId: string, allowDirtyRoom: boolean) {
    return this.db.tenant(async (tx) => {
      const { reservation, property } = await this.load(tx, id, true);
      if (!['tentative', 'confirmed'].includes(reservation.status)) throw invalidState('Reservation cannot be checked in');
      const today = property.businessDate;
      if (today < reservation.arrival || today >= reservation.departure) {
        throw invalidState(`Check-in is only possible between ${reservation.arrival} and the day before departure`);
      }
      const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for('update');
      if (!room || room.roomTypeId !== reservation.roomTypeId) throw unprocessable('The room must be of the reserved room type');
      if (!room.active || room.status === 'out_of_order') throw invalidState('The room is out of order');
      if (room.occupancy === 'occupied') throw conflict(ERROR_CODES.ROOM_CONFLICT, 'The room is currently occupied');
      if (room.status === 'dirty' && !allowDirtyRoom) throw conflict('ROOM_NOT_READY', 'The room has not been cleaned yet');
      const [updated] = await tx
        .update(reservations)
        .set({ roomId, status: 'checked_in', checkedInAt: new Date() })
        .where(eq(reservations.id, id))
        .returning();
      await tx.update(rooms).set({ occupancy: 'occupied' }).where(eq(rooms.id, roomId));
      await postBookedExtras(tx, reservation, ctx().userId);
      await this.audit.log(tx, 'reservation.checked_in', 'reservation', id, { room: room.number, dirty: room.status === 'dirty' });
      return updated;
    });
  }

  /** What check-out will do, so the desk sees the final bill before committing to it. */
  checkOutPreview(id: string) {
    return this.db.tenant(async (tx) => {
      const { reservation, property } = await this.load(tx, id);
      if (reservation.status !== 'checked_in') throw invalidState('Only in-house guests can be checked out');
      const departure = actualDeparture(reservation, property.businessDate);
      const pending = await pendingCharges(tx, reservation, departure);
      const totals = await folioTotals(tx, id);
      return {
        propertyId: property.id,
        departure,
        nightsReleased: reservation.nightlyRates.filter((n) => n.date >= departure).length,
        charges: totals.charges + pending,
        payments: totals.payments,
        balance: totals.balance + pending,
      };
    });
  }

  checkOut(id: string, allowOpenBalance: boolean) {
    if (allowOpenBalance && !hasPermission('invoices.issue')) {
      throw forbidden('Checking out with an open balance requires the invoices.issue permission');
    }
    return this.db.tenant(async (tx) => {
      const { reservation, property } = await this.load(tx, id, true);
      if (reservation.status !== 'checked_in') throw invalidState('Only in-house guests can be checked out');
      const today = property.businessDate;
      const leaving = actualDeparture(reservation, today);
      // Early departure: release the remaining nights.
      if (leaving < reservation.departure) {
        const nightlyRates = reservation.nightlyRates.filter((n) => n.date < leaving);
        await tx
          .update(reservations)
          .set({ departure: leaving, nightlyRates, totalAmount: nightlyRates.reduce((s, n) => s + n.amount, 0) + reservation.extrasAmount })
          .where(eq(reservations.id, id));
        reservation.nightlyRates = nightlyRates;
      }
      await postRoomCharges(tx, reservation, property, leaving, ctx().userId);
      await postBookedExtras(tx, reservation, ctx().userId);
      const totals = await folioTotals(tx, id);
      if (totals.balance > 0 && !allowOpenBalance) {
        throw conflict(ERROR_CODES.OUTSTANDING_BALANCE, 'The folio has an outstanding balance', totals);
      }
      const [updated] = await tx
        .update(reservations)
        .set({ status: 'checked_out', checkedOutAt: new Date() })
        .where(eq(reservations.id, id))
        .returning();
      if (reservation.roomId) {
        await tx.update(rooms).set({ occupancy: 'vacant', status: 'dirty' }).where(eq(rooms.id, reservation.roomId));
        await tx
          .insert(housekeepingTasks)
          .values({
            tenantId: requireTenant(),
            propertyId: property.id,
            roomId: reservation.roomId,
            type: 'checkout_clean',
            date: today,
            priority: 1,
            createdById: ctx().userId,
          })
          .onConflictDoNothing();
      }
      await this.audit.log(tx, 'reservation.checked_out', 'reservation', id, { balance: totals.balance, early: leaving !== reservation.departure });
      return { ...updated, totals };
    });
  }

  frontDesk(propertyId: string, date?: string) {
    return this.db.tenant(async (tx) => {
      const property = await getAccessibleProperty(tx, propertyId);
      const day = date ?? property.businessDate;
      const base = tx
        .select({
          id: reservations.id,
          code: reservations.code,
          status: reservations.status,
          arrival: reservations.arrival,
          departure: reservations.departure,
          adults: reservations.adults,
          children: reservations.children,
          guestName: sql<string>`${guests.firstName} || ' ' || ${guests.lastName}`,
          guestSegment: guests.segment,
          roomId: reservations.roomId,
          roomNumber: rooms.number,
          roomStatus: rooms.status,
          roomTypeCode: roomTypes.code,
          notes: reservations.notes,
          onlineCheckinAt: reservations.onlineCheckinAt,
          estimatedArrival: reservations.estimatedArrival,
          source: reservations.source,
        })
        .from(reservations)
        .innerJoin(guests, eq(guests.id, reservations.guestId))
        .innerJoin(roomTypes, eq(roomTypes.id, reservations.roomTypeId))
        .leftJoin(rooms, eq(rooms.id, reservations.roomId))
        .$dynamic();
      const [arrivals, departures, inHouse] = await Promise.all([
        base
          .where(and(eq(reservations.propertyId, propertyId), eq(reservations.arrival, day), inArray(reservations.status, ['tentative', 'confirmed', 'checked_in'])))
          .orderBy(asc(guests.lastName)),
        tx
          .select({
            id: reservations.id,
            code: reservations.code,
            status: reservations.status,
            guestName: sql<string>`${guests.firstName} || ' ' || ${guests.lastName}`,
            roomNumber: rooms.number,
            departure: reservations.departure,
            balance: hasPermission('folio.read')
              ? sql<number | null>`((select coalesce(sum(f.amount), 0) from ${folioItems} f where f.reservation_id = ${reservations.id} and f.voided_at is null)
                  - (select coalesce(sum(p.amount), 0) from ${payments} p where p.reservation_id = ${reservations.id}))::bigint`
              : sql<null>`null`,
          })
          .from(reservations)
          .innerJoin(guests, eq(guests.id, reservations.guestId))
          .leftJoin(rooms, eq(rooms.id, reservations.roomId))
          .where(and(eq(reservations.propertyId, propertyId), or(and(lte(reservations.departure, day), eq(reservations.status, 'checked_in')), and(eq(reservations.departure, day), eq(reservations.status, 'checked_out')))))
          .orderBy(asc(rooms.number)),
        tx
          .select({
            id: reservations.id,
            code: reservations.code,
            guestName: sql<string>`${guests.firstName} || ' ' || ${guests.lastName}`,
            roomNumber: rooms.number,
            arrival: reservations.arrival,
            departure: reservations.departure,
          })
          .from(reservations)
          .innerJoin(guests, eq(guests.id, reservations.guestId))
          .leftJoin(rooms, eq(rooms.id, reservations.roomId))
          .where(and(eq(reservations.propertyId, propertyId), eq(reservations.status, 'checked_in')))
          .orderBy(asc(rooms.number)),
      ]);
      return { date: day, businessDate: property.businessDate, arrivals, departures, inHouse };
    });
  }

  calendar(propertyId: string, from: string, to: string) {
    if (to <= from || nightsBetween(from, to) > 62) throw unprocessable('Range must be between 1 and 62 days');
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, propertyId);
      const roomList = await tx
        .select({
          id: rooms.id,
          number: rooms.number,
          floor: rooms.floor,
          status: rooms.status,
          occupancy: rooms.occupancy,
          roomTypeId: rooms.roomTypeId,
          roomTypeCode: roomTypes.code,
        })
        .from(rooms)
        .innerJoin(roomTypes, eq(roomTypes.id, rooms.roomTypeId))
        .where(and(eq(rooms.propertyId, propertyId), eq(rooms.active, true)))
        .orderBy(asc(roomTypes.code), asc(rooms.number));
      const bookings = await tx
        .select({
          id: reservations.id,
          code: reservations.code,
          status: reservations.status,
          roomId: reservations.roomId,
          roomTypeId: reservations.roomTypeId,
          arrival: reservations.arrival,
          departure: reservations.departure,
          guestName: sql<string>`${guests.firstName} || ' ' || ${guests.lastName}`,
          segment: guests.segment,
        })
        .from(reservations)
        .innerJoin(guests, eq(guests.id, reservations.guestId))
        .where(
          and(
            eq(reservations.propertyId, propertyId),
            lt(reservations.arrival, to),
            gt(reservations.departure, from),
            inArray(reservations.status, [...ACTIVE_RESERVATION_STATUSES, 'checked_out']),
          ),
        );
      return { from, to, rooms: roomList, reservations: bookings };
    });
  }

  /** Rooms sold per day of a year, for the year overview. Past stays count too. */
  calendarYear(propertyId: string, year: number) {
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, propertyId);
      const [total] = await tx
        .select({ n: count() })
        .from(rooms)
        .where(and(eq(rooms.propertyId, propertyId), eq(rooms.active, true), sql`${rooms.status} <> 'out_of_order'`));
      const rows = await tx.execute<{ date: string; sold: number }>(sql`
        select to_char(d, 'YYYY-MM-DD') as date, count(r.id)::int as sold
        from generate_series(${`${year}-01-01`}::date, ${`${year}-12-31`}::date, interval '1 day') d
        left join ${reservations} r on r.property_id = ${propertyId} and r.arrival <= d::date and r.departure > d::date
          and r.status in ('tentative', 'confirmed', 'checked_in', 'checked_out')
        group by d order by d`);
      return { year, rooms: total?.n ?? 0, days: rows.rows };
    });
  }

  // ---------------------------------------------------------------- night audit

  /**
   * Closes the business day: posts room charges for in-house guests, marks no-shows,
   * prepares stay-over housekeeping and advances the business date.
   */
  nightAudit(propertyId: string) {
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, propertyId);
      const [property] = await tx.select().from(properties).where(eq(properties.id, propertyId)).for('update');
      const day = property!.businessDate;
      if (day > todayIn(property!.timezone)) {
        throw invalidState('The business date is already ahead of the calendar date; run the audit tomorrow');
      }
      const inHouse = await tx
        .select()
        .from(reservations)
        .where(and(eq(reservations.propertyId, propertyId), eq(reservations.status, 'checked_in')));
      let posted = 0;
      const overstays: string[] = [];
      for (const r of inHouse) {
        if (r.departure <= day) overstays.push(r.code);
        posted += await postRoomCharges(tx, r as Reservation, property!, addDays(day, 1), ctx().userId);
      }
      const noShows = await tx
        .update(reservations)
        .set({ status: 'no_show', cancelledAt: new Date(), cancelReason: 'Night audit: guest did not arrive' })
        .where(
          and(
            eq(reservations.propertyId, propertyId),
            lte(reservations.arrival, day),
            inArray(reservations.status, ['tentative', 'confirmed']),
          ),
        )
        .returning({ code: reservations.code });
      const next = addDays(day, 1);
      await tx.update(properties).set({ businessDate: next }).where(eq(properties.id, propertyId));
      const stayovers = inHouse.filter((r) => r.roomId && r.departure > next);
      if (stayovers.length) {
        await tx
          .insert(housekeepingTasks)
          .values(
            stayovers.map((r) => ({
              tenantId: requireTenant(),
              propertyId,
              roomId: r.roomId!,
              type: 'stayover',
              date: next,
              createdById: ctx().userId,
            })),
          )
          .onConflictDoNothing();
      }
      const summary = {
        closedDate: day,
        newBusinessDate: next,
        roomChargesPosted: posted,
        noShows: noShows.map((n) => n.code),
        overstays,
        stayoverTasks: stayovers.length,
      };
      await this.audit.log(tx, 'property.night_audit', 'property', propertyId, summary);
      return summary;
    });
  }
}
