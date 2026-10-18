import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ACTIVE_RESERVATION_STATUSES, addDays } from '@pms/shared';
import { hasPermission } from '../common/context.js';
import { ZQuery } from '../common/zod.js';
import { Perms } from '../auth/decorators.js';
import { DbService } from '../db/db.service.js';
import { folioItems, payments, reservations, rooms } from '../db/schema.js';
import { getAccessibleProperty } from '../properties/properties.module.js';

const statuses = sql.join(
  ACTIVE_RESERVATION_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

@Injectable()
export class DashboardService {
  constructor(private readonly db: DbService) {}

  overview(propertyId: string) {
    return this.db.tenant(async (tx) => {
      const property = await getAccessibleProperty(tx, propertyId);
      const day = property.businessDate;
      const monthStart = `${day.slice(0, 8)}01`;

      const roomStats = await tx.execute<{ status: string; occupancy: string; n: number }>(sql`
        select status, occupancy, count(*)::int as n from ${rooms}
        where property_id = ${propertyId} and active group by status, occupancy`);
      const totalRooms = roomStats.rows.reduce((s, r) => s + r.n, 0);
      const outOfOrder = roomStats.rows.filter((r) => r.status === 'out_of_order').reduce((s, r) => s + r.n, 0);
      const byStatus = Object.fromEntries(
        ['clean', 'dirty', 'inspected', 'out_of_order'].map((s) => [s, roomStats.rows.filter((r) => r.status === s).reduce((a, r) => a + r.n, 0)]),
      );

      const [counts] = (
        await tx.execute<{ in_house: number; arrivals: number; arrived: number; departures: number; departed: number }>(sql`
        select
          count(*) filter (where status = 'checked_in')::int as in_house,
          count(*) filter (where arrival = ${day} and status in ('tentative','confirmed','checked_in'))::int as arrivals,
          count(*) filter (where arrival = ${day} and status = 'checked_in')::int as arrived,
          count(*) filter (where departure = ${day} and status in ('checked_in','checked_out'))::int as departures,
          count(*) filter (where departure = ${day} and status = 'checked_out')::int as departed
        from ${reservations} where property_id = ${propertyId}`)
      ).rows;

      const sellable = Math.max(totalRooms - outOfOrder, 0);
      const forecast = await tx.execute<{ date: string; booked: number }>(sql`
        select to_char(d, 'YYYY-MM-DD') as date,
          (select count(*)::int from ${reservations} r where r.property_id = ${propertyId}
             and r.status in (${statuses}) and r.arrival <= d::date and r.departure > d::date) as booked
        from generate_series(${day}::date, ${addDays(day, 13)}::date, interval '1 day') d`);

      let financial = null;
      if (hasPermission('reports.read')) {
        const [rev] = (
          await tx.execute<{ today: number; mtd: number; room_mtd: number; nights_mtd: number }>(sql`
          select
            coalesce(sum(f.amount) filter (where f.service_date = ${day}), 0)::bigint as today,
            coalesce(sum(f.amount) filter (where f.service_date >= ${monthStart}), 0)::bigint as mtd,
            coalesce(sum(f.amount) filter (where f.service_date >= ${monthStart} and f.is_room_charge), 0)::bigint as room_mtd,
            count(*) filter (where f.service_date >= ${monthStart} and f.is_room_charge)::int as nights_mtd
          from ${folioItems} f join ${reservations} r on r.id = f.reservation_id
          where r.property_id = ${propertyId} and f.voided_at is null and f.service_date >= ${monthStart}`)
        ).rows;
        const [open] = (
          await tx.execute<{ balance: number }>(sql`
          select coalesce(sum(
            (select coalesce(sum(amount),0) from ${folioItems} f where f.reservation_id = r.id and f.voided_at is null) -
            (select coalesce(sum(amount),0) from ${payments} p where p.reservation_id = r.id)
          ), 0)::bigint as balance
          from ${reservations} r where r.property_id = ${propertyId} and r.status = 'checked_in'`)
        ).rows;
        const daysElapsed = Number(day.slice(8, 10));
        const roomMtd = Number(rev?.room_mtd ?? 0);
        const nightsMtd = Number(rev?.nights_mtd ?? 0);
        financial = {
          revenueToday: Number(rev?.today ?? 0),
          revenueMonth: Number(rev?.mtd ?? 0),
          adr: nightsMtd ? Math.round(roomMtd / nightsMtd) : 0,
          revpar: sellable ? Math.round(roomMtd / (sellable * daysElapsed)) : 0,
          openBalance: Number(open?.balance ?? 0),
        };
      }

      return {
        businessDate: day,
        currency: property.currency,
        rooms: { total: totalRooms, sellable, byStatus },
        occupancy: { inHouse: counts?.in_house ?? 0, percent: sellable ? Math.round(((counts?.in_house ?? 0) / sellable) * 100) : 0 },
        arrivals: { expected: counts?.arrivals ?? 0, arrived: counts?.arrived ?? 0 },
        departures: { expected: counts?.departures ?? 0, departed: counts?.departed ?? 0 },
        forecast: forecast.rows.map((f) => ({ date: f.date, booked: f.booked, percent: sellable ? Math.round((f.booked / sellable) * 100) : 0 })),
        financial,
      };
    });
  }
}

const q = z.object({ propertyId: z.uuid() });

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly svc: DashboardService) {}

  @Get()
  @Perms('property.read')
  overview(@ZQuery(q) query: { propertyId: string }) {
    return this.svc.overview(query.propertyId);
  }
}

@Module({ controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}
