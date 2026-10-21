import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import type { onlineCheckinSchema } from '@pms/shared';
import { ctx } from '../common/context.js';
import { decrypt, decryptNullable, encryptNullable, mask, safeEqual, sha256 } from '../common/crypto.js';
import { invalidState, notFound, unprocessable } from '../common/errors.js';
import { AuditService } from '../db/audit.service.js';
import { DbService } from '../db/db.service.js';
import {
  guestLinks,
  guests,
  payments,
  properties,
  ratePlans,
  reservationGuests,
  reservations,
  roomTypes,
  tenants,
} from '../db/schema.js';
import { folioTotals } from '../finance/folio.js';
import { MailService } from '../mail/mail.service.js';
import { guestSessionLinkId, setGuestSession } from './guest-session.js';
import { PublicBookingService } from './public-booking.service.js';
import { stripeFor } from './stripe.js';

const CODE_TTL_MS = 10 * 60_000;
const MAX_CODE_ATTEMPTS = 5;
const OPEN_STATUSES = ['tentative', 'confirmed', 'checked_in'];

function maskEmail(email: string | null) {
  if (!email) return null;
  const [name, domain] = email.split('@');
  if (!name || !domain) return '***';
  return `${name[0]}${'*'.repeat(Math.max(2, name.length - 2))}${name.length > 1 ? name.at(-1) : ''}@${domain}`;
}

@Injectable()
export class GuestPortalService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly booking: PublicBookingService,
  ) {}

  /** Finds a live guest link and binds the request to its organization. */
  private async link(token: string) {
    const [row] = await this.db.db
      .select({ link: guestLinks, tenantStatus: tenants.status })
      .from(guestLinks)
      .innerJoin(tenants, eq(tenants.id, guestLinks.tenantId))
      .where(and(eq(guestLinks.tokenHash, sha256(token)), gt(guestLinks.expiresAt, new Date())));
    if (!row || row.tenantStatus !== 'active') throw new NotFoundException({ code: 'LINK_INVALID', message: 'This link is invalid or has expired' });
    ctx().tenantId = row.link.tenantId;
    return row.link;
  }

  async view(token: string, req: Request) {
    const link = await this.link(token);
    const verified = (await guestSessionLinkId(req)) === link.id;
    return this.db.tenant(async (tx) => {
      const [row] = await tx
        .select({ r: reservations, g: guests, p: properties, room: roomTypes.name, plan: ratePlans.name, breakfast: ratePlans.includesBreakfast })
        .from(reservations)
        .innerJoin(guests, eq(guests.id, reservations.guestId))
        .innerJoin(properties, eq(properties.id, reservations.propertyId))
        .innerJoin(roomTypes, eq(roomTypes.id, reservations.roomTypeId))
        .innerJoin(ratePlans, eq(ratePlans.id, reservations.ratePlanId))
        .where(eq(reservations.id, link.reservationId));
      if (!row) throw notFound('Booking');
      const { r, g, p } = row;
      const [paid] = await tx
        .select({ total: sql<number>`coalesce(sum(${payments.amount}), 0)::bigint` })
        .from(payments)
        .where(eq(payments.reservationId, r.id));
      const paidTotal = Number(paid?.total ?? 0);
      const inHouse = r.status === 'checked_in' || r.status === 'checked_out';
      const balance = inHouse ? (await folioTotals(tx, r.id)).balance : Math.max(0, r.totalAmount - paidTotal);
      const companions = await tx.select().from(reservationGuests).where(eq(reservationGuests.reservationId, r.id));
      return {
        verified,
        hotel: {
          name: p.name,
          address: p.address,
          city: p.city,
          country: p.country,
          phone: p.phone,
          email: p.email,
          checkInTime: p.checkInTime,
          checkOutTime: p.checkOutTime,
        },
        booking: {
          code: r.code,
          status: r.status,
          arrival: r.arrival,
          departure: r.departure,
          nights: r.nightlyRates.length,
          adults: r.adults,
          children: r.children,
          roomType: row.room,
          ratePlan: row.plan,
          includesBreakfast: row.breakfast,
          currency: r.currency,
          total: r.totalAmount,
          paid: paidTotal,
          balance,
          awaitingPayment: r.status === 'tentative' && Boolean(r.stripePaymentIntentId),
          estimatedArrival: r.estimatedArrival,
          requests: r.guestRequests,
          onlineCheckinAt: r.onlineCheckinAt,
          locale: r.guestLocale,
        },
        guest: {
          firstName: g.firstName,
          lastName: verified ? g.lastName : null,
          email: maskEmail(g.email),
        },
        // Identity details only after the browser proved access; document numbers stay masked.
        checkin: verified
          ? {
              mainGuest: {
                birthDate: g.birthDate,
                nationality: g.nationality,
                documentType: g.documentType,
                documentNumber: mask(decryptNullable(g.documentNumberEnc)),
                address: g.address,
                country: g.country,
              },
              companions: companions.map((c) => ({
                firstName: c.firstName,
                lastName: c.lastName,
                birthDate: c.birthDate,
                nationality: c.nationality,
                documentType: c.documentType,
                documentNumber: mask(decryptNullable(c.documentNumberEnc)),
              })),
            }
          : null,
      };
    }, link.tenantId);
  }

  /** The guest came back from Stripe: confirm the payment without waiting for the webhook. */
  async confirmPayment(token: string, req: Request) {
    const link = await this.link(token);
    const [r] = await this.db.tenant((tx) => tx.select().from(reservations).where(eq(reservations.id, link.reservationId)), link.tenantId);
    if (r?.status === 'tentative' && r.stripePaymentIntentId) {
      const [p] = await this.db.tenant((tx) => tx.select().from(properties).where(eq(properties.id, r.propertyId)), link.tenantId);
      if (p?.stripeSecretKeyEnc) {
        const pi = await stripeFor(decrypt(p.stripeSecretKeyEnc)).paymentIntents.retrieve(r.stripePaymentIntentId);
        await this.booking.confirmPayment(link.tenantId, r.id, pi, token);
      }
    }
    return this.view(token, req);
  }

  async sendCode(token: string) {
    const link = await this.link(token);
    const data = await this.db.tenant(async (tx) => {
      const [row] = await tx
        .select({ email: guests.email, hotel: properties.name, locale: reservations.guestLocale })
        .from(reservations)
        .innerJoin(guests, eq(guests.id, reservations.guestId))
        .innerJoin(properties, eq(properties.id, reservations.propertyId))
        .where(eq(reservations.id, link.reservationId));
      return row;
    }, link.tenantId);
    if (!data?.email) throw invalidState('No e-mail address is on this booking; please contact the hotel');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.db
      .update(guestLinks)
      .set({ codeHash: sha256(`${link.id}:${code}`), codeExpiresAt: new Date(Date.now() + CODE_TTL_MS), codeAttempts: 0 })
      .where(eq(guestLinks.id, link.id));
    await this.mail.sendGuestCode(data.email, data.hotel, code, data.locale === 'ro' ? 'ro' : 'en');
    return { sentTo: maskEmail(data.email) };
  }

  async verifyCode(token: string, code: string, res: Response) {
    const link = await this.link(token);
    if (!link.codeHash || !link.codeExpiresAt || link.codeExpiresAt < new Date()) {
      throw new BadRequestException({ code: 'CODE_EXPIRED', message: 'The code has expired. Ask for a new one.' });
    }
    if (link.codeAttempts >= MAX_CODE_ATTEMPTS) {
      throw new BadRequestException({ code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Ask for a new code.' });
    }
    if (!safeEqual(sha256(`${link.id}:${code}`), link.codeHash)) {
      await this.db.db.update(guestLinks).set({ codeAttempts: link.codeAttempts + 1 }).where(eq(guestLinks.id, link.id));
      throw new BadRequestException({ code: 'INVALID_CODE', message: 'That code is not correct.' });
    }
    await this.db.db.update(guestLinks).set({ codeHash: null, codeExpiresAt: null, codeAttempts: 0 }).where(eq(guestLinks.id, link.id));
    await setGuestSession(res, link.id);
    return { verified: true };
  }

  async checkIn(token: string, req: Request, input: z.infer<typeof onlineCheckinSchema>) {
    const link = await this.link(token);
    if ((await guestSessionLinkId(req)) !== link.id) {
      throw new UnauthorizedException({ code: 'GUEST_VERIFICATION_REQUIRED', message: 'Confirm it is you with the code we e-mail you' });
    }
    await this.db.tenant(async (tx) => {
      const [r] = await tx.select().from(reservations).where(eq(reservations.id, link.reservationId)).for('update');
      if (!r || !OPEN_STATUSES.includes(r.status)) throw invalidState('This booking can no longer be checked in online');
      if (r.status === 'tentative' && r.stripePaymentIntentId) throw invalidState('Complete the payment before checking in');
      if (input.companions.length > r.adults + r.children - 1) {
        throw unprocessable(`This booking is for ${r.adults + r.children} guests in total`);
      }
      const m = input.mainGuest;
      await tx
        .update(guests)
        .set({
          birthDate: m.birthDate,
          nationality: m.nationality,
          documentType: m.documentType,
          documentNumberEnc: encryptNullable(m.documentNumber),
          address: m.address,
          country: m.country ?? null,
          marketingConsent: input.marketingConsent,
        })
        .where(eq(guests.id, r.guestId));
      await tx.delete(reservationGuests).where(eq(reservationGuests.reservationId, r.id));
      if (input.companions.length) {
        await tx.insert(reservationGuests).values(
          input.companions.map((c) => ({
            tenantId: link.tenantId,
            reservationId: r.id,
            firstName: c.firstName,
            lastName: c.lastName,
            birthDate: c.birthDate ?? null,
            nationality: c.nationality ?? null,
            documentType: c.documentType ?? null,
            documentNumberEnc: encryptNullable(c.documentNumber),
          })),
        );
      }
      await tx
        .update(reservations)
        .set({ estimatedArrival: input.estimatedArrival, guestRequests: input.requests, onlineCheckinAt: new Date() })
        .where(eq(reservations.id, r.id));
      await this.audit.log(tx, 'reservation.online_checkin', 'reservation', r.id, { companions: input.companions.length });
    }, link.tenantId);
    return this.view(token, req);
  }
}
