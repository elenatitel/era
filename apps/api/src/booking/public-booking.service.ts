import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Response } from 'express';
import type { z } from 'zod';
import { addDays, nightsBetween, type publicAvailabilitySchema, type publicBookingSchema } from '@pms/shared';
import { config } from '../config.js';
import { ctx } from '../common/context.js';
import { decrypt, decryptNullable, encrypt, randomToken, sha256 } from '../common/crypto.js';
import { notFound, unprocessable } from '../common/errors.js';
import { AuditService } from '../db/audit.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { bookingSites, guestLinks, guests, payments, properties, ratePlans, reservations, roomTypes, tenants } from '../db/schema.js';
import { MailService } from '../mail/mail.service.js';
import { ReservationsService } from '../reservations/reservations.service.js';
import { setGuestSession } from './guest-session.js';
import { type PaymentIntent, stripeFor } from './stripe.js';

type Property = typeof properties.$inferSelect;
type Reservation = typeof reservations.$inferSelect;

export const paymentsEnabled = (p: Property) => Boolean(p.stripePublishableKey && p.stripeSecretKeyEnc);

/** Cancels online bookings whose payment was never completed, freeing their rooms. */
export async function releaseExpiredHolds(tx: Tx, propertyId: string) {
  return tx
    .update(reservations)
    .set({ status: 'cancelled', cancelledAt: new Date(), cancelReason: 'Online payment not completed in time', holdExpiresAt: null })
    .where(
      and(
        eq(reservations.propertyId, propertyId),
        eq(reservations.status, 'tentative'),
        lt(reservations.holdExpiresAt, new Date()),
      ),
    )
    .returning({ id: reservations.id });
}

const dayLabel = (iso: string, locale: 'en' | 'ro') =>
  new Intl.DateTimeFormat(locale === 'ro' ? 'ro-RO' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${iso}T00:00:00Z`),
  );

@Injectable()
export class PublicBookingService {
  private readonly logger = new Logger(PublicBookingService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly reservations: ReservationsService,
  ) {}

  /** Resolves a public booking page and binds the request to its organization. */
  async resolve(slug: string, { allowDisabled = false } = {}) {
    const [row] = await this.db.db
      .select({ site: bookingSites, tenantStatus: tenants.status })
      .from(bookingSites)
      .innerJoin(tenants, eq(tenants.id, bookingSites.tenantId))
      .where(eq(bookingSites.slug, slug));
    if (!row || row.tenantStatus !== 'active' || (!row.site.enabled && !allowDisabled)) throw notFound('Booking page');
    ctx().tenantId = row.site.tenantId;
    const [property] = await this.db.tenant((tx) => tx.select().from(properties).where(eq(properties.id, row.site.propertyId)), row.site.tenantId);
    if (!property) throw notFound('Booking page');
    return { site: row.site, property };
  }

  async info(slug: string) {
    const { site, property } = await this.resolve(slug);
    return {
      slug: site.slug,
      name: property.name,
      address: property.address,
      city: property.city,
      country: property.country,
      phone: property.phone,
      email: property.email,
      currency: property.currency,
      checkInTime: property.checkInTime,
      checkOutTime: property.checkOutTime,
      earliestArrival: property.businessDate,
      accommodationVatRate: property.accommodationVatRate,
      payments: paymentsEnabled(property) ? { provider: 'stripe', publishableKey: property.stripePublishableKey } : null,
    };
  }

  async availability(slug: string, q: z.infer<typeof publicAvailabilitySchema>) {
    const { property } = await this.resolve(slug);
    if (q.arrival < property.businessDate) throw unprocessable('Arrival cannot be in the past');
    await this.db.tenant((tx) => releaseExpiredHolds(tx, property.id));
    const result = await this.reservations.searchAvailability({ propertyId: property.id, arrival: q.arrival, departure: q.departure, adults: q.adults + q.children });
    const nights = nightsBetween(q.arrival, q.departure);
    return {
      arrival: q.arrival,
      departure: q.departure,
      nights,
      currency: property.currency,
      roomTypes: result.roomTypes
        .filter((r) => r.fitsOccupancy)
        .map((r) => ({
          id: r.roomType.id,
          name: r.roomType.name,
          description: r.roomType.description,
          maxOccupancy: r.roomType.maxOccupancy,
          available: r.available,
          offers:
            r.available > 0
              ? r.offers
                  .filter((o) => o.sellable)
                  .map((o) => ({ ratePlanId: o.ratePlanId, name: o.ratePlanName, includesBreakfast: o.includesBreakfast, total: o.total, perNight: Math.round(o.total / nights) }))
              : [],
        })),
    };
  }

  async book(slug: string, input: z.infer<typeof publicBookingSchema>, res: Response) {
    const { property } = await this.resolve(slug);
    const tenantId = ctx().tenantId!;
    const online = paymentsEnabled(property);
    await this.db.tenant((tx) => releaseExpiredHolds(tx, property.id));

    // Returning guests keep one CRM profile, matched by e-mail.
    const [existing] = await this.db.tenant((tx) =>
      tx
        .select({ id: guests.id })
        .from(guests)
        .where(and(sql`lower(${guests.email}) = ${input.guest.email}`, isNull(guests.anonymizedAt)))
        .limit(1),
    );
    const created = await this.reservations.create({
      propertyId: property.id,
      roomTypeId: input.roomTypeId,
      ratePlanId: input.ratePlanId,
      roomId: null,
      arrival: input.arrival,
      departure: input.departure,
      adults: input.adults,
      children: input.children,
      ...(existing
        ? { guestId: existing.id }
        : {
            guest: {
              firstName: input.guest.firstName,
              lastName: input.guest.lastName,
              email: input.guest.email,
              phone: input.guest.phone,
              nationality: null,
              birthDate: null,
              documentType: null,
              documentNumber: null,
              address: null,
              city: null,
              country: null,
              segment: 'standard',
              companyId: null,
              tags: [],
              notes: null,
              marketingConsent: false,
            },
          }),
      companyId: null,
      source: 'website',
      status: online ? 'tentative' : 'confirmed',
      totalOverride: null,
      externalRef: null,
      notes: null,
    });

    const token = randomToken(32);
    const link = await this.db.db
      .insert(guestLinks)
      .values({ tenantId, reservationId: created.id, tokenHash: sha256(token), tokenEnc: encrypt(token), expiresAt: new Date(`${addDays(input.departure, 30)}T00:00:00Z`) })
      .returning({ id: guestLinks.id })
      .then((r) => r[0]!);

    await this.db.tenant(async (tx) => {
      await tx
        .update(reservations)
        .set({
          holdExpiresAt: online ? new Date(Date.now() + config().BOOKING_HOLD_MINUTES * 60_000) : null,
          guestLocale: input.locale,
          estimatedArrival: input.estimatedArrival,
          guestRequests: input.requests,
        })
        .where(eq(reservations.id, created.id));
      await this.audit.log(tx, 'reservation.online_booking', 'reservation', created.id, { code: created.code, online });
    });

    let payment: { clientSecret: string; publishableKey: string } | null = null;
    if (online) {
      try {
        const pi = await stripeFor(decrypt(property.stripeSecretKeyEnc!)).paymentIntents.create(
          {
            amount: created.totalAmount,
            currency: created.currency.toLowerCase(),
            automatic_payment_methods: { enabled: true },
            receipt_email: input.guest.email,
            description: `${property.name} · ${created.code}`,
            metadata: { reservationId: created.id, tenantId, code: created.code },
          },
          { idempotencyKey: `booking-${created.id}` },
        );
        await this.db.tenant((tx) => tx.update(reservations).set({ stripePaymentIntentId: pi.id }).where(eq(reservations.id, created.id)));
        payment = { clientSecret: pi.client_secret!, publishableKey: property.stripePublishableKey! };
      } catch (err) {
        this.logger.error(`Stripe PaymentIntent failed for ${created.code}: ${(err as Error).message}`);
        await this.db.tenant((tx) =>
          tx
            .update(reservations)
            .set({ status: 'cancelled', cancelledAt: new Date(), cancelReason: 'Online payment unavailable', holdExpiresAt: null })
            .where(eq(reservations.id, created.id)),
        );
        throw new ServiceUnavailableException({ code: 'PAYMENT_UNAVAILABLE', message: 'Online payment is unavailable right now. Please try again or contact the hotel.' });
      }
    } else {
      await this.sendConfirmation(created.id, token);
    }

    await setGuestSession(res, link.id);
    return { code: created.code, token, status: online ? 'awaiting_payment' : 'confirmed', total: created.totalAmount, currency: created.currency, payment };
  }

  /**
   * Marks a paid online booking confirmed. Safe to call repeatedly (webhook and the guest's
   * return can both arrive): the payment is recorded once and checked against the booking.
   */
  async confirmPayment(tenantId: string, reservationId: string, pi: PaymentIntent, token?: string) {
    ctx().tenantId = tenantId;
    const outcome = await this.db.tenant(async (tx) => {
      const [r] = await tx.select().from(reservations).where(eq(reservations.id, reservationId)).for('update');
      if (!r) return { changed: false };
      const matches =
        pi.status === 'succeeded' &&
        pi.id === r.stripePaymentIntentId &&
        pi.amount === r.totalAmount &&
        pi.currency === r.currency.toLowerCase() &&
        pi.metadata?.reservationId === r.id;
      if (!matches) return { changed: false };
      const [already] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(and(eq(payments.reservationId, r.id), eq(payments.reference, pi.id)));
      if (!already) {
        await tx.insert(payments).values({
          tenantId,
          propertyId: r.propertyId,
          reservationId: r.id,
          method: 'card',
          amount: pi.amount_received || pi.amount,
          currency: r.currency,
          reference: pi.id,
          notes: 'Online booking (Stripe)',
        });
      }
      if (r.status === 'tentative') {
        await tx.update(reservations).set({ status: 'confirmed', holdExpiresAt: null }).where(eq(reservations.id, r.id));
        await this.audit.log(tx, 'reservation.online_payment_confirmed', 'reservation', r.id, { paymentIntent: pi.id, amount: pi.amount });
        return { changed: true };
      }
      if (r.status === 'cancelled' && !already) {
        // The hold expired before the payment landed: staff must re-book or refund.
        await this.audit.log(tx, 'reservation.payment_after_cancellation', 'reservation', r.id, { paymentIntent: pi.id, amount: pi.amount });
      }
      return { changed: false };
    }, tenantId);
    if (outcome.changed) await this.sendConfirmation(reservationId, token ?? null);
    return outcome;
  }

  async handleWebhook(slug: string, rawBody: Buffer | undefined, signature: string | undefined) {
    const { site, property } = await this.resolve(slug, { allowDisabled: true });
    const secret = decryptNullable(property.stripeWebhookSecretEnc);
    if (!secret || !property.stripeSecretKeyEnc || !rawBody || !signature) {
      throw new BadRequestException({ code: 'WEBHOOK_REJECTED', message: 'Webhook not configured or unsigned' });
    }
    let event;
    try {
      event = stripeFor(decrypt(property.stripeSecretKeyEnc)).webhooks.constructEvent(rawBody, signature, secret);
    } catch {
      throw new BadRequestException({ code: 'WEBHOOK_SIGNATURE', message: 'Invalid signature' });
    }
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object as PaymentIntent;
      const reservationId = pi.metadata?.reservationId;
      if (reservationId && pi.metadata?.tenantId === site.tenantId) await this.confirmPayment(site.tenantId, reservationId, pi);
    }
    return { received: true };
  }

  /** Booking confirmation e-mail with the private portal link (a new link if the old one is not known). */
  private async sendConfirmation(reservationId: string, token: string | null) {
    const data = await this.db.tenant(async (tx) => {
      const [row] = await tx
        .select({ r: reservations, email: guests.email, room: roomTypes.name, plan: ratePlans.name, hotel: properties.name })
        .from(reservations)
        .innerJoin(guests, eq(guests.id, reservations.guestId))
        .innerJoin(roomTypes, eq(roomTypes.id, reservations.roomTypeId))
        .innerJoin(ratePlans, eq(ratePlans.id, reservations.ratePlanId))
        .innerJoin(properties, eq(properties.id, reservations.propertyId))
        .where(eq(reservations.id, reservationId));
      return row;
    });
    if (!data?.email) return;
    let link = token;
    if (!link) {
      const [row] = await this.db.db.select({ tokenEnc: guestLinks.tokenEnc }).from(guestLinks).where(eq(guestLinks.reservationId, reservationId));
      if (!row) return;
      link = decrypt(row.tokenEnc);
    }
    const locale = data.r.guestLocale === 'ro' ? 'ro' : 'en';
    await this.mail.sendBookingConfirmation(
      data.email,
      {
        hotel: data.hotel,
        code: data.r.code,
        arrival: dayLabel(data.r.arrival, locale),
        departure: dayLabel(data.r.departure, locale),
        room: `${data.room} · ${data.plan}`,
      },
      link,
      locale,
    );
  }
}

export type { Reservation };
