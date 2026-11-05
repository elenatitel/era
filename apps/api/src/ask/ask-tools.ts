import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool.js';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { isoDate, RESERVATION_STATUSES, type Permission } from '@pms/shared';
import { hasPermission } from '../common/context.js';
import type { DashboardService } from '../dashboard/dashboard.module.js';
import type { LiveService } from '../dashboard/live.service.js';
import { scrub } from '../guests/guest-insight.service.js';
import type { ReservationsService } from '../reservations/reservations.service.js';

export interface StayRef {
  ref: string;
  id: string;
  guestName: string | null;
  code: string | null;
  room: string | null;
}

/**
 * The model only ever sees stand-ins such as R1. Names stay here and are put back in the
 * final answer, so a guest's identity does not leave the system.
 */
export class Refs {
  private readonly byId = new Map<string, StayRef>();
  private readonly byRef = new Map<string, StayRef>();

  add(id: string, known: { guestName?: string | null; code?: string | null; room?: string | null }) {
    let entry = this.byId.get(id);
    if (!entry) {
      entry = { ref: `R${this.byId.size + 1}`, id, guestName: null, code: null, room: null };
      this.byId.set(id, entry);
      this.byRef.set(entry.ref, entry);
    }
    entry.guestName = known.guestName ?? entry.guestName;
    entry.code = known.code ?? entry.code;
    entry.room = known.room ?? entry.room;
    return `[[${entry.ref}]]`;
  }

  find(ref: string) {
    return this.byRef.get(ref.replace(/[[\]\s]/g, ''));
  }

  /** Puts the names back. A reference the tools never handed out is dropped, not trusted. */
  restore(text: string, unknown: string) {
    const mentioned: StayRef[] = [];
    const answer = text.replace(/\[\[\s*(R\d+)\s*\]\]/g, (_, ref: string) => {
      const entry = this.byRef.get(ref);
      if (!entry) return '';
      if (!mentioned.includes(entry)) mentioned.push(entry);
      return entry.guestName ?? unknown;
    });
    return { answer: answer.replace(/ {2,}/g, ' ').trim(), mentioned };
  }
}

/** Contact details in a question stay here too; the search tool swaps them back in. */
export function maskContacts(question: string) {
  const contacts = new Map<string, string>();
  const keep = (value: string) => {
    const key = `[contact${contacts.size + 1}]`;
    contacts.set(key, value);
    return key;
  };
  const masked = question
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, keep)
    .replace(/\+?\d[\d\s().-]{6,}\d/g, (found) => (found.replace(/\D/g, '').length >= 9 ? keep(found) : found));
  return { masked, contacts };
}

/** Amounts are stored in the smallest unit; the model should read them as people do. */
const major = (amount: number | null | undefined) => (amount == null ? null : amount / 100);
const parts = (...names: (string | null | undefined)[]) => names.flatMap((n) => n?.split(/\s+/) ?? []);
const clean = (text: string | null | undefined, names: string[]) => (text ? scrub(text, names) : null);

interface Deps {
  propertyId: string;
  refs: Refs;
  contacts: Map<string, string>;
  used: Set<string>;
  dashboard: DashboardService;
  live: LiveService;
  reservations: ReservationsService;
}

interface Definition {
  perm: Permission;
  tool: BetaRunnableTool<any>;
}

/**
 * Everything the agent can do. Each tool calls a service staff already use, is fixed to the
 * property of the question, and returns only the fields listed here. None of them writes.
 */
export function askTools({ propertyId, refs, contacts, used, dashboard, live, reservations }: Deps): BetaRunnableTool<any>[] {
  const define = <S extends z.ZodType>(perm: Permission, name: string, description: string, inputSchema: S, run: (input: z.infer<S>) => Promise<unknown>): Definition => ({
    perm,
    tool: betaZodTool({
      name,
      description,
      inputSchema,
      run: async (input) => {
        used.add(name);
        return JSON.stringify(await run(input));
      },
    }),
  });
  const none = z.object({});

  const definitions = [
    define('property.read', 'hotel_overview', 'Business date, occupancy, arrivals and departures today, the occupancy forecast for 14 days, cleaning progress and rooms not ready. Revenue appears only when the user may see it.', none, async () => {
      const o = await dashboard.overview(propertyId);
      return {
        businessDate: o.businessDate,
        currency: o.currency,
        rooms: o.rooms,
        occupancy: o.occupancy,
        arrivals: o.arrivals,
        departures: o.departures,
        forecast: o.forecast,
        roomsNotReady: o.attention.roomsNotReady,
        housekeeping: o.housekeeping,
        financial: o.financial && {
          revenueToday: major(o.financial.revenueToday),
          revenueMonth: major(o.financial.revenueMonth),
          adr: major(o.financial.adr),
          revpar: major(o.financial.revpar),
          openBalance: major(o.financial.openBalance),
        },
      };
    }),
    define('property.read', 'rooms_today', 'Every room with its state, who is in it, when they leave and who arrives in it today, plus occupancy counts.', none, async () => {
      const h = await live.house(propertyId);
      const names = hasPermission('reservations.read');
      return {
        businessDate: h.businessDate,
        counts: h.counts,
        rooms: h.rooms.map((r) => ({
          number: r.number,
          floor: r.floor,
          roomType: r.roomType,
          cleaning: r.status,
          state: r.state,
          stay: r.stay && {
            guest: names ? refs.add(r.stay.reservationId, { guestName: r.stay.guestName, code: r.stay.code, room: r.number }) : null,
            departure: r.stay.departure,
            departsToday: r.stay.departsToday,
            guests: r.stay.guests,
            balance: major(r.stay.balance),
          },
          arrival: r.arrival && {
            guest: names ? refs.add(r.arrival.reservationId, { guestName: r.arrival.guestName, code: r.arrival.code, room: r.number }) : null,
            time: r.arrival.time,
          },
        })),
      };
    }),
    define('reservations.read', 'arrivals_today', "Today's arrivals with time, room, how far along the room is, what they asked for, and which free room era. suggests for those without one.", none, async () => {
      const h = await live.house(propertyId);
      return {
        businessDate: h.businessDate,
        arrivals: h.arrivals.map((a) => ({
          guest: refs.add(a.reservationId, { guestName: a.guestName, code: a.code, room: a.roomNumber }),
          time: a.time,
          room: a.roomNumber,
          roomStep: a.roomStep,
          roomType: a.roomType,
          ratePlan: a.ratePlan,
          nights: a.nights,
          guests: a.guests,
          onlineCheckin: a.onlineCheckin,
          requests: clean(a.requests, parts(a.guestName)),
        })),
        suggestions: h.suggestions.map((s) => ({
          guest: refs.add(s.reservationId, { guestName: s.guestName }),
          room: s.number,
          roomStep: s.step,
        })),
      };
    }),
    define('property.read', 'close_of_day', 'What stands before the night audit, arrivals still to come, in-house balances the user may see, and the breakfast count for tomorrow.', none, async () => {
      const n = await live.night(propertyId);
      return {
        businessDate: n.businessDate,
        currency: n.currency,
        now: n.now,
        checks: n.checks,
        ready: n.ready,
        stillToArrive: n.stillToArrive.map((a) => ({
          guest: refs.add(a.reservationId, { guestName: a.guestName, room: a.room }),
          time: a.time,
          room: a.room,
          roomReady: a.roomReady,
          onlineCheckin: a.onlineCheckin,
          paid: a.paid,
          requests: clean(a.requests, parts(a.guestName)),
        })),
        owes: n.owes.map((o) => ({
          guest: refs.add(o.reservationId, { guestName: o.guestName, room: o.room }),
          room: o.room,
          departure: o.departure,
          balance: major(o.balance),
        })),
        tonight: { ...n.tonight, revenueToday: major(n.tonight.revenueToday) },
      };
    }),
    define(
      'reservations.read',
      'find_stays',
      'Search reservations. "search" matches a guest name, reservation code, phone, or a [contactN] placeholder from the question. "from" and "to" keep stays that overlap those dates. Newest arrivals first, 25 at most.',
      z.object({ search: z.string().max(100).optional(), status: z.enum(RESERVATION_STATUSES).optional(), from: isoDate.optional(), to: isoDate.optional() }),
      async ({ search, status, from, to }) => {
        const q = search?.replace(/\[contact\d+\]/g, (key) => contacts.get(key) ?? key);
        const found = await reservations.search({ propertyId, q, status, from, to, page: 1, pageSize: 25 });
        return {
          total: found.total,
          stays: found.items.map((r) => ({
            guest: refs.add(r.id, { guestName: r.guestName, code: r.code, room: r.roomNumber }),
            code: r.code,
            status: r.status,
            source: r.source,
            arrival: r.arrival,
            departure: r.departure,
            adults: r.adults,
            children: r.children,
            room: r.roomNumber,
            roomType: r.roomTypeCode,
            total: major(r.totalAmount),
            currency: r.currency,
          })),
        };
      },
    ),
    define('reservations.read', 'stay_details', 'One stay in full, from a reference such as R1: dates, room, rate, requests, notes, and balance when the user may see it.', z.object({ ref: z.string().max(12) }), async ({ ref }) => {
      const known = refs.find(ref);
      if (!known) throw new Error('Unknown reference. Use one returned by another tool.');
      const r = await reservations.get(known.id);
      const names = parts(r.guest?.firstName, r.guest?.lastName, ...r.companions.flatMap((c) => [c.firstName, c.lastName]));
      refs.add(r.id, { guestName: r.guest && `${r.guest.firstName} ${r.guest.lastName}`, code: r.code, room: r.room?.number });
      return {
        guest: `[[${known.ref}]]`,
        code: r.code,
        status: r.status,
        source: r.source,
        arrival: r.arrival,
        departure: r.departure,
        adults: r.adults,
        children: r.children,
        room: r.room?.number ?? null,
        roomType: r.roomType?.name ?? null,
        ratePlan: r.ratePlan?.name ?? null,
        total: major(r.totalAmount),
        currency: r.currency,
        requests: clean(r.guestRequests, names),
        notes: clean(r.notes, names),
        guestProfile: hasPermission('guests.read') && r.guest ? { notes: clean(r.guest.notes, names), tags: r.guest.tags, segment: r.guest.segment } : null,
        balance: r.totals && { balance: major(r.totals.balance), pending: major(r.totals.pending), due: major(r.totals.due) },
      };
    }),
    define(
      'reservations.read',
      'availability',
      'Free rooms and prices for a stay, per room type and rate plan. Stays are limited to 60 nights.',
      z.object({ arrival: isoDate, departure: isoDate, adults: z.number().int().min(1).max(20).default(2) }),
      async ({ arrival, departure, adults }) => {
        const a = await reservations.searchAvailability({ propertyId, arrival, departure, adults });
        return {
          arrival: a.arrival,
          departure: a.departure,
          nights: a.nights,
          roomTypes: a.roomTypes.map((t) => ({
            roomType: t.roomType.name,
            available: t.available,
            fitsOccupancy: t.fitsOccupancy,
            offers: t.offers.map((o) => ({ ratePlan: o.ratePlanName, includesBreakfast: o.includesBreakfast, total: major(o.total), sellable: o.sellable, minNights: o.minNights })),
          })),
        };
      },
    ),
  ];
  return definitions.filter((d) => hasPermission(d.perm)).map((d) => d.tool);
}
