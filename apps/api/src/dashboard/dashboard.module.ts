import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ACTIVE_RESERVATION_STATUSES, addDays } from '@pms/shared';
import { hasPermission } from '../common/context.js';
import { ZQuery } from '../common/zod.js';
import { Perms } from '../auth/decorators.js';
import { DbService } from '../db/db.service.js';
import { folioItems, housekeepingTasks, payments, reservations, rooms } from '../db/schema.js';
import { getAccessibleProperty } from '../properties/properties.module.js';
import { LiveService } from './live.service.js';

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

      // Arrivals today whose assigned room is not ready: the front desk needs to act before guests arrive.
      const notReady = await tx.execute<{ number: string; status: string }>(sql`
        select rm.number, rm.status from ${reservations} r join ${rooms} rm on rm.id = r.room_id
        where r.property_id = ${propertyId} and r.arrival = ${day}
          and r.status in ('tentative','confirmed') and rm.status in ('dirty','out_of_order')
        order by rm.number`);

      const [hk] = (
        await tx.execute<{ total: number; done: number; in_progress: number; unassigned: number }>(sql`
        select count(*)::int as total,
          count(*) filter (where status in ('done','inspected'))::int as done,
          count(*) filter (where status = 'in_progress')::int as in_progress,
          count(*) filter (where status = 'pending' and assigned_to_user_id is null)::int as unassigned
        from ${housekeepingTasks} where property_id = ${propertyId} and date = ${day} and status <> 'cancelled'`)
      ).rows;

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
        const paidToday = await tx.execute<{ method: string; total: number }>(sql`
          select method, sum(amount)::bigint as total from ${payments}
          where property_id = ${propertyId}
            and created_at >= (${day}::date)::timestamp at time zone ${property.timezone}
            and created_at < ((${day}::date + 1))::timestamp at time zone ${property.timezone}
          group by method order by 2 desc`);
        const daysElapsed = Number(day.slice(8, 10));
        const roomMtd = Number(rev?.room_mtd ?? 0);
        const nightsMtd = Number(rev?.nights_mtd ?? 0);
        financial = {
          revenueToday: Number(rev?.today ?? 0),
          revenueMonth: Number(rev?.mtd ?? 0),
          adr: nightsMtd ? Math.round(roomMtd / nightsMtd) : 0,
          revpar: sellable ? Math.round(roomMtd / (sellable * daysElapsed)) : 0,
          openBalance: Number(open?.balance ?? 0),
          paymentsToday: {
            total: paidToday.rows.reduce((sum, r) => sum + Number(r.total), 0),
            byMethod: paidToday.rows.map((r) => ({ method: r.method, total: Number(r.total) })),
          },
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
        attention: { roomsNotReady: notReady.rows.map((r) => ({ number: r.number, status: r.status })) },
        housekeeping: { total: hk?.total ?? 0, done: hk?.done ?? 0, inProgress: hk?.in_progress ?? 0, unassigned: hk?.unassigned ?? 0 },
        financial,
      };
    });
  }
}

const q = z.object({ propertyId: z.uuid() });
const dayQuery = z.object({ propertyId: z.uuid(), date: z.iso.date().optional() });

@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly svc: DashboardService,
    private readonly live: LiveService,
  ) {}

  @Get()
  @Perms('property.read')
  overview(@ZQuery(q) query: { propertyId: string }) {
    return this.svc.overview(query.propertyId);
  }

  /** Rooms by floor with who is in them and who is coming, for the house home screen. */
  @Get('house')
  @Perms('property.read')
  house(@ZQuery(q) query: { propertyId: string }) {
    return this.live.house(query.propertyId);
  }

  /** Everything that happens on one day, placed on a timeline. */
  @Get('day')
  @Perms('property.read')
  day(@ZQuery(dayQuery) query: { propertyId: string; date?: string }) {
    return this.live.day(query.propertyId, query.date);
  }

  /** The night shift: what stands between the desk and the night audit. */
  @Get('night')
  @Perms('property.read')
  night(@ZQuery(q) query: { propertyId: string }) {
    return this.live.night(query.propertyId);
  }
}

@Module({ controllers: [DashboardController], providers: [DashboardService, LiveService] })
export class DashboardModule {}
