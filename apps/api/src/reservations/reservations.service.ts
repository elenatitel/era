import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { aliasedTable, and, asc, count, desc, eq, gt, gte, ilike, inArray, lt, lte, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  ACTIVE_RESERVATION_STATUSES,
  ERROR_CODES,
  addDays,
  availabilitySchema,
  createReservationSchema,
  nightsBetween,
  reservationSearchSchema,
  todayIn,
  updateReservationSchema,
} from '@pms/shared';
import { allowedPropertyIds, ctx, hasPermission, requireTenant } from '../common/context.js';
import { conflict, forbidden, invalidState, notFound, unprocessable } from '../common/errors.js';
import { AuditService } from '../db/audit.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import {
  companies,
  folioItems,
  guests,
  housekeepingTasks,
  invoices,
  payments,
  properties,
  ratePlans,
  reservations,
  rooms,
  roomTypes,
  users,
} from '../db/schema.js';
import { folioTotals, postRoomCharges } from '../finance/folio.js';
import { assertCompany, insertGuest, presentGuest } from '../guests/guests.module.js';
import { getAccessibleProperty } from '../properties/properties.module.js';
import { availability, freeRooms, minFree, quote } from '../properties/pricing.js';

type Reservation = typeof reservations.$inferSelect;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const generateCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

/** Serializes inventory changes for one room type (prevents overbooking under concurrency). */
async function lockRoomType(tx: Tx, roomTypeId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${roomTypeId}, 0))`);
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

  create(input: z.infer<typeof createReservationSchema>) {
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
      const totalAmount = nightlyRates.reduce((s, n) => s + n.amount, 0);

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
        totals,
      };
    });
  }

  // ---------------------------------------------------------------- modify

  update(id: string, input: z.infer<typeof updateReservationSchema>) {
    return this.db.tenant(async (tx) => {
      const { reservation } = await this.load(tx, id, true);
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
      const [updated] = await tx.update(reservations).set(input).where(eq(reservations.id, id)).returning();
      await this.audit.log(tx, 'reservation.updated', 'reservation', id, input);
      return updated;
    });
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
      await this.audit.log(tx, 'reservation.checked_in', 'reservation', id, { room: room.number, dirty: room.status === 'dirty' });
      return updated;
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
      const minDeparture = addDays(reservation.arrival, 1);
      const actualDeparture = today < reservation.departure ? (today > minDeparture ? today : minDeparture) : reservation.departure;
      // Early departure: release the remaining nights.
      if (actualDeparture < reservation.departure) {
        const nightlyRates = reservation.nightlyRates.filter((n) => n.date < actualDeparture);
        await tx
          .update(reservations)
          .set({ departure: actualDeparture, nightlyRates, totalAmount: nightlyRates.reduce((s, n) => s + n.amount, 0) })
          .where(eq(reservations.id, id));
        reservation.nightlyRates = nightlyRates;
      }
      await postRoomCharges(tx, reservation, property, actualDeparture, ctx().userId);
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
      await this.audit.log(tx, 'reservation.checked_out', 'reservation', id, { balance: totals.balance, early: actualDeparture !== reservation.departure });
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
          })
          .from(reservations)
          .innerJoin(guests, eq(guests.id, reservations.guestId))
          .leftJoin(rooms, eq(rooms.id, reservations.roomId))
          .where(and(eq(reservations.propertyId, propertyId), lte(reservations.departure, day), inArray(reservations.status, ['checked_in'])))
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
