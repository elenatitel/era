import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { addDays, todayIn } from '@pms/shared';
import { hasPermission } from '../common/context.js';
import { DbService, type Tx } from '../db/db.service.js';
import { folioItems, guests, housekeepingTasks, payments, ratePlans, reservations, rooms, roomTypes, users } from '../db/schema.js';
import { getAccessibleProperty } from '../properties/properties.module.js';
import { freeRooms } from '../properties/pricing.js';

/** What a room looks like on the house view, from the front desk's point of view. */
export type RoomState = 'in_house' | 'ready' | 'dirty' | 'free' | 'out';

/** First "HH:MM" in a guest's free-text arrival estimate ("16:00 – 17:00", "After 22:00"). */
export function arrivalTime(estimate: string | null, fallback: string) {
  const m = estimate ? /(\d{1,2})[:.](\d{2})/.exec(estimate) : null;
  return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : fallback;
}

/** Local "HH:MM" now in the property's time zone. */
function nowIn(timezone: string) {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timezone }).format(new Date());
}

const name = sql<string>`${guests.firstName} || ' ' || ${guests.lastName}`;

/** Folio charges minus payments per reservation, for the given reservation ids. */
async function balances(tx: Tx, ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = await tx.execute<{ id: string; balance: number }>(sql`
    select r.id,
      ((select coalesce(sum(f.amount), 0) from ${folioItems} f where f.reservation_id = r.id and f.voided_at is null) -
       (select coalesce(sum(p.amount), 0) from ${payments} p where p.reservation_id = r.id))::bigint as balance
    from ${reservations} r where r.id in (${list})`);
  return new Map(rows.rows.map((r) => [r.id, Number(r.balance)]));
}

/**
 * Live views for the redesigned home: the house (rooms by floor, who is where, who is coming),
 * the day (everything that happens today on one timeline) and the night shift (what stands
 * between the desk and the night audit). Guest names need reservations.read; money needs folio.read.
 */
@Injectable()
export class LiveService {
  constructor(private readonly db: DbService) {}

  house(propertyId: string) {
    const names = hasPermission('reservations.read');
    const money = hasPermission('folio.read');
    return this.db.tenant(async (tx) => {
      const property = await getAccessibleProperty(tx, propertyId);
      const day = property.businessDate;
      const roomRows = await tx.execute<{ id: string; number: string; floor: string | null; status: string; occupancy: string; type_code: string; type_name: string }>(sql`
        select r.id, r.number, r.floor, r.status, r.occupancy, rt.code as type_code, rt.name as type_name
        from ${rooms} r join ${roomTypes} rt on rt.id = r.room_type_id
        where r.property_id = ${propertyId} and r.active order by r.number`);

      const stays = await tx.execute<{
        id: string; code: string; room_id: string | null; guest: string; status: string; arrival: string; departure: string;
        adults: number; children: number; estimated_arrival: string | null; online_checkin_at: string | null;
        room_type_id: string; type_name: string; plan: string; requests: string | null;
      }>(sql`
        select r.id, r.code, r.room_id, ${name} as guest, r.status, to_char(r.arrival, 'YYYY-MM-DD') as arrival,
          to_char(r.departure, 'YYYY-MM-DD') as departure, r.adults, r.children, r.estimated_arrival, r.online_checkin_at,
          r.room_type_id, rt.name as type_name, rp.name as plan, r.guest_requests as requests
        from ${reservations} r
        join ${guests} on ${guests.id} = r.guest_id
        join ${roomTypes} rt on rt.id = r.room_type_id
        join ${ratePlans} rp on rp.id = r.rate_plan_id
        where r.property_id = ${propertyId}
          and (r.status = 'checked_in' or (r.arrival = ${day} and r.status in ('tentative', 'confirmed')))`);
      const inHouse = stays.rows.filter((s) => s.status === 'checked_in');
      const arriving = stays.rows.filter((s) => s.status !== 'checked_in');
      const owed = money ? await balances(tx, inHouse.map((s) => s.id)) : new Map<string, number>();

      const roomsOut = roomRows.rows.map((r) => {
        const stay = inHouse.find((s) => s.room_id === r.id);
        const arrival = arriving.find((s) => s.room_id === r.id);
        let state: RoomState;
        if (r.status === 'out_of_order') state = 'out';
        else if (stay || r.occupancy === 'occupied') state = 'in_house';
        else if (r.status === 'dirty') state = 'dirty';
        else if (arrival) state = 'ready';
        else state = 'free';
        return {
          id: r.id,
          number: r.number,
          // Floors come from the room record; without one, the first digit of a 3-digit number.
          floor: r.floor?.trim() || (r.number.length >= 3 ? r.number.slice(0, r.number.length - 2) : '0'),
          roomType: r.type_name,
          roomTypeCode: r.type_code,
          status: r.status,
          state,
          stay: stay
            ? {
                reservationId: stay.id,
                code: stay.code,
                guestName: names ? stay.guest : null,
                departure: stay.departure,
                departsToday: stay.departure === day,
                guests: stay.adults + stay.children,
                balance: money ? (owed.get(stay.id) ?? 0) : null,
              }
            : null,
          arrival: arrival
            ? {
                reservationId: arrival.id,
                code: arrival.code,
                guestName: names ? arrival.guest : null,
                time: arrivalTime(arrival.estimated_arrival, property.checkInTime),
                onlineCheckin: Boolean(arrival.online_checkin_at),
              }
            : null,
        };
      });

      // Arrivals with no room yet: suggest a free room of their type, preferring one already clean.
      const suggestions = [];
      for (const a of arriving.filter((s) => !s.room_id)) {
        const free = await freeRooms(tx, a.room_type_id, a.arrival, a.departure);
        const pick = free.find((f) => f.status !== 'dirty' && f.occupancy === 'vacant') ?? free[0];
        if (pick) suggestions.push({ reservationId: a.id, guestName: names ? a.guest : null, time: arrivalTime(a.estimated_arrival, property.checkInTime), roomId: pick.id, number: pick.number, ready: pick.status !== 'dirty' });
      }

      const crews = await tx.execute<{ name: string | null; open: number; done: number; floors: string[] }>(sql`
        select u.name, count(*) filter (where t.status in ('pending', 'in_progress'))::int as open,
          count(*) filter (where t.status in ('done', 'inspected'))::int as done,
          array_agg(distinct coalesce(nullif(rm.floor, ''), left(rm.number, greatest(length(rm.number) - 2, 1)))) as floors
        from ${housekeepingTasks} t join ${rooms} rm on rm.id = t.room_id left join ${users} u on u.id = t.assigned_to_user_id
        where t.property_id = ${propertyId} and t.date = ${day} and t.status <> 'cancelled'
        group by u.name order by u.name nulls last`);

      const sellable = roomsOut.filter((r) => r.state !== 'out').length;
      const occupied = roomsOut.filter((r) => r.state === 'in_house').length;
      return {
        businessDate: day,
        currency: property.currency,
        timezone: property.timezone,
        rooms: roomsOut,
        counts: {
          sellable,
          occupied,
          occupancy: sellable ? Math.round((occupied / sellable) * 100) : 0,
          ready: roomsOut.filter((r) => r.state === 'ready').length,
          dirty: roomsOut.filter((r) => r.state === 'dirty').length,
          free: roomsOut.filter((r) => r.state === 'free').length,
          guestsInHouse: inHouse.reduce((s, r) => s + r.adults + r.children, 0),
          departuresLeft: inHouse.filter((s) => s.departure === day).length,
        },
        arrivals: names
          ? arriving
              .map((a) => {
                const room = roomRows.rows.find((r) => r.id === a.room_id);
                return {
                  reservationId: a.id,
                  code: a.code,
                  guestName: a.guest,
                  time: arrivalTime(a.estimated_arrival, property.checkInTime),
                  roomNumber: room?.number ?? null,
                  roomReady: room ? room.status !== 'dirty' && room.status !== 'out_of_order' : false,
                  roomType: a.type_name,
                  ratePlan: a.plan,
                  nights: Math.round((Date.parse(a.departure) - Date.parse(a.arrival)) / 86_400_000),
                  guests: a.adults + a.children,
                  onlineCheckin: Boolean(a.online_checkin_at),
                  requests: a.requests,
                };
              })
              .sort((x, y) => x.time.localeCompare(y.time))
          : [],
        suggestions,
        housekeeping: crews.rows.map((c) => ({ name: c.name, open: c.open, done: c.done, floors: (c.floors ?? []).filter(Boolean).sort() })),
      };
    });
  }

  day(propertyId: string, date?: string) {
    const names = hasPermission('reservations.read');
    const money = hasPermission('folio.read');
    return this.db.tenant(async (tx) => {
      const property = await getAccessibleProperty(tx, propertyId);
      const day = date ?? property.businessDate;
      const tz = property.timezone;
      const isToday = day === todayIn(tz);
      type Item = { lane: string; time: string; end?: string; title: string; sub: string; state: 'done' | 'plan' | 'warn' | 'span' | 'key'; reservationId?: string };
      const items: Item[] = [];

      if (names) {
        const res = await tx.execute<{
          id: string; guest: string; status: string; arrival: string; departure: string; estimated_arrival: string | null;
          checked_in: string | null; checked_out: string | null; room: string | null; room_status: string | null;
        }>(sql`
          select r.id, ${name} as guest, r.status, to_char(r.arrival, 'YYYY-MM-DD') as arrival, to_char(r.departure, 'YYYY-MM-DD') as departure,
            r.estimated_arrival, to_char(r.checked_in_at at time zone ${tz}, 'HH24:MI') as checked_in,
            to_char(r.checked_out_at at time zone ${tz}, 'HH24:MI') as checked_out, rm.number as room, rm.status as room_status
          from ${reservations} r join ${guests} on ${guests.id} = r.guest_id left join ${rooms} rm on rm.id = r.room_id
          where r.property_id = ${propertyId}
            and ((r.arrival = ${day} and r.status in ('tentative', 'confirmed', 'checked_in', 'checked_out'))
              or (r.departure = ${day} and r.status in ('checked_in', 'checked_out')))`);
        const leaving = res.rows.filter((r) => r.departure === day && r.status === 'checked_in');
        const owed = money ? await balances(tx, leaving.map((r) => r.id)) : new Map<string, number>();
        for (const r of res.rows) {
          if (r.arrival === day) {
            if (r.checked_in) items.push({ lane: 'arrivals', time: r.checked_in, title: r.guest, sub: r.room ? `${r.room}` : '', state: 'done', reservationId: r.id });
            else if (r.status !== 'checked_out')
              items.push({
                lane: 'arrivals',
                time: arrivalTime(r.estimated_arrival, property.checkInTime),
                title: r.guest,
                sub: r.room ?? '',
                state: !r.room || r.room_status === 'dirty' ? 'warn' : 'plan',
                reservationId: r.id,
              });
          }
          if (r.departure === day) {
            if (r.status === 'checked_out') items.push({ lane: 'departures', time: r.checked_out ?? property.checkOutTime, title: r.guest, sub: r.room ?? '', state: 'done', reservationId: r.id });
            else
              items.push({
                lane: 'departures',
                time: property.checkOutTime,
                title: r.guest,
                sub: r.room ?? '',
                state: (owed.get(r.id) ?? 0) > 0 ? 'warn' : 'plan',
                reservationId: r.id,
              });
          }
        }
      }

      const tasks = await tx.execute<{ room: string; status: string; who: string | null; started: string | null; completed: string | null }>(sql`
        select rm.number as room, t.status, u.name as who,
          to_char(t.started_at at time zone ${tz}, 'HH24:MI') as started, to_char(t.completed_at at time zone ${tz}, 'HH24:MI') as completed
        from ${housekeepingTasks} t join ${rooms} rm on rm.id = t.room_id left join ${users} u on u.id = t.assigned_to_user_id
        where t.property_id = ${propertyId} and t.date = ${day} and t.status <> 'cancelled' order by rm.number`);
      const waiting = new Map<string, string[]>();
      for (const t of tasks.rows) {
        if ((t.status === 'done' || t.status === 'inspected') && t.completed) items.push({ lane: 'housekeeping', time: t.completed, title: t.room, sub: t.who ?? '', state: 'done' });
        else if (t.status === 'in_progress') items.push({ lane: 'housekeeping', time: t.started ?? (isToday ? nowIn(tz) : '09:00'), title: t.room, sub: t.who ?? '', state: 'span' });
        else if (t.status === 'pending') waiting.set(t.who ?? '', [...(waiting.get(t.who ?? '') ?? []), t.room]);
      }
      for (const [who, list] of waiting) {
        items.push({ lane: 'housekeeping', time: isToday ? nowIn(tz) : '09:00', title: who || '—', sub: list.join(', '), state: who ? 'plan' : 'warn' });
      }

      if (money) {
        const paid = await tx.execute<{ at: string; amount: number; method: string }>(sql`
          select to_char(created_at at time zone ${tz}, 'HH24:MI') as at, amount::bigint as amount, method from ${payments}
          where property_id = ${propertyId}
            and created_at >= (${day}::date)::timestamp at time zone ${tz}
            and created_at < ((${day}::date + 1))::timestamp at time zone ${tz}
          order by created_at`);
        for (const p of paid.rows) items.push({ lane: 'money', time: p.at, title: String(Number(p.amount)), sub: p.method, state: 'done' });
      }
      items.push({ lane: 'money', time: '23:00', title: 'night_audit', sub: '', state: property.businessDate > day ? 'done' : 'key' });

      return {
        date: day,
        businessDate: property.businessDate,
        currency: property.currency,
        now: isToday ? nowIn(tz) : null,
        checkInTime: property.checkInTime,
        checkOutTime: property.checkOutTime,
        items: items.sort((a, b) => a.time.localeCompare(b.time)),
      };
    });
  }

  night(propertyId: string) {
    const names = hasPermission('reservations.read');
    const money = hasPermission('folio.read');
    return this.db.tenant(async (tx) => {
      const property = await getAccessibleProperty(tx, propertyId);
      const day = property.businessDate;
      const [counts] = (
        await tx.execute<{ departures_left: number; arrivals_left: number; in_house_rooms: number; guests: number; breakfast: number; hk_open: number; sellable: number }>(sql`
          select
            (select count(*)::int from ${reservations} where property_id = ${propertyId} and departure <= ${day} and status = 'checked_in') as departures_left,
            (select count(*)::int from ${reservations} where property_id = ${propertyId} and arrival = ${day} and status in ('tentative', 'confirmed')) as arrivals_left,
            (select count(*)::int from ${reservations} where property_id = ${propertyId} and status = 'checked_in') as in_house_rooms,
            (select coalesce(sum(adults + children), 0)::int from ${reservations} where property_id = ${propertyId} and status = 'checked_in') as guests,
            (select coalesce(sum(r.adults + r.children), 0)::int from ${reservations} r join ${ratePlans} rp on rp.id = r.rate_plan_id
              where r.property_id = ${propertyId} and r.status in ('confirmed', 'checked_in') and r.arrival <= ${day} and r.departure > ${day}
                and (rp.includes_breakfast or exists (select 1 from jsonb_array_elements(r.extras) e
                  where e->>'name' ilike '%breakfast%' or e->>'name' ilike '%mic dejun%'))) as breakfast,
            (select count(*)::int from ${housekeepingTasks} where property_id = ${propertyId} and date = ${day} and status in ('pending', 'in_progress')) as hk_open,
            (select count(*)::int from ${rooms} where property_id = ${propertyId} and active and status <> 'out_of_order') as sellable`)
      ).rows;

      const late = names
        ? await tx.execute<{ id: string; guest: string; estimated_arrival: string | null; room: string | null; room_status: string | null; online: boolean; requests: string | null; total: number; paid: number }>(sql`
            select r.id, ${name} as guest, r.estimated_arrival, rm.number as room, rm.status as room_status, r.online_checkin_at is not null as online,
              r.guest_requests as requests, r.total_amount::bigint as total,
              (select coalesce(sum(p.amount), 0) from ${payments} p where p.reservation_id = r.id)::bigint as paid
            from ${reservations} r join ${guests} on ${guests.id} = r.guest_id left join ${rooms} rm on rm.id = r.room_id
            where r.property_id = ${propertyId} and r.arrival = ${day} and r.status in ('tentative', 'confirmed')`)
        : { rows: [] };

      let owes: { reservationId: string; guestName: string | null; room: string | null; departure: string; balance: number }[] = [];
      if (money) {
        const inHouse = await tx.execute<{ id: string; guest: string; room: string | null; departure: string }>(sql`
          select r.id, ${name} as guest, rm.number as room, to_char(r.departure, 'YYYY-MM-DD') as departure
          from ${reservations} r join ${guests} on ${guests.id} = r.guest_id left join ${rooms} rm on rm.id = r.room_id
          where r.property_id = ${propertyId} and r.status = 'checked_in'`);
        const owed = await balances(tx, inHouse.rows.map((r) => r.id));
        owes = inHouse.rows
          .map((r) => ({ reservationId: r.id, guestName: names ? r.guest : null, room: r.room, departure: r.departure, balance: owed.get(r.id) ?? 0 }))
          .filter((r) => r.balance > 0)
          .sort((a, b) => a.departure.localeCompare(b.departure) || b.balance - a.balance);
      }

      let revenueToday: number | null = null;
      if (hasPermission('reports.read')) {
        const [rev] = (
          await tx.execute<{ total: number }>(sql`
            select coalesce(sum(f.amount), 0)::bigint as total from ${folioItems} f join ${reservations} r on r.id = f.reservation_id
            where r.property_id = ${propertyId} and f.voided_at is null and f.service_date = ${day}`)
        ).rows;
        revenueToday = Number(rev?.total ?? 0);
      }

      const c = counts!;
      const checks = [
        { key: 'departures', done: c.departures_left === 0, count: c.departures_left },
        { key: 'arrivals', done: c.arrivals_left === 0, count: c.arrivals_left },
        { key: 'housekeeping', done: c.hk_open === 0, count: c.hk_open },
        ...(money ? [{ key: 'balances', done: owes.every((o) => o.departure > addDays(day, 1)), count: owes.filter((o) => o.departure <= addDays(day, 1)).length }] : []),
      ];
      return {
        businessDate: day,
        currency: property.currency,
        timezone: property.timezone,
        now: nowIn(property.timezone),
        checks,
        ready: checks.every((k) => k.done),
        stillToArrive: late.rows
          .map((r) => ({
            reservationId: r.id,
            guestName: r.guest,
            time: arrivalTime(r.estimated_arrival, property.checkInTime),
            room: r.room,
            roomReady: Boolean(r.room) && r.room_status !== 'dirty' && r.room_status !== 'out_of_order',
            onlineCheckin: r.online,
            paid: money ? Number(r.paid) >= Number(r.total) : null,
            requests: r.requests,
          }))
          .sort((a, b) => a.time.localeCompare(b.time)),
        owes,
        tonight: { occupied: c.in_house_rooms, sellable: c.sellable, guests: c.guests, breakfastTomorrow: c.breakfast, revenueToday },
      };
    });
  }
}
