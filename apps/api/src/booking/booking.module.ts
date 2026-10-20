import { Controller, Get, Headers, HttpCode, Injectable, Module, Param, Post, Put, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { and, eq, ne } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  bookingSiteSchema,
  guestCodeSchema,
  onlineCheckinSchema,
  publicAvailabilitySchema,
  publicBookingSchema,
  publicCalendarSchema,
  slug as slugSchema,
} from '@pms/shared';
import { config } from '../config.js';
import { requireTenant } from '../common/context.js';
import { encryptNullable } from '../common/crypto.js';
import { conflict } from '../common/errors.js';
import { IdParam, ZBody, ZodPipe, ZQuery } from '../common/zod.js';
import { Perms, Public, SkipCsrf } from '../auth/decorators.js';
import { AuditService } from '../db/audit.service.js';
import { DbService } from '../db/db.service.js';
import { bookingSites, properties } from '../db/schema.js';
import { getAccessibleProperty } from '../properties/properties.module.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { GuestPortalService } from './portal.service.js';
import { PublicBookingService, paymentsEnabled } from './public-booking.service.js';

const SlugParam = () => Param('slug', new ZodPipe(slugSchema));
const TokenParam = () => Param('token', new ZodPipe(z.string().regex(/^[A-Za-z0-9_-]{30,64}$/, 'Invalid link')));

/** Everything a guest reaches without a staff account. Each route is rate limited. */
@Public()
@Controller('public')
export class PublicController {
  constructor(
    private readonly booking: PublicBookingService,
    private readonly portal: GuestPortalService,
  ) {}

  @Get('sites/:slug')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  site(@SlugParam() slug: string) {
    return this.booking.info(slug);
  }

  @Get('sites/:slug/availability')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  availability(@SlugParam() slug: string, @ZQuery(publicAvailabilitySchema) q: z.infer<typeof publicAvailabilitySchema>) {
    return this.booking.availability(slug, q);
  }

  @Get('sites/:slug/calendar')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  calendar(@SlugParam() slug: string, @ZQuery(publicCalendarSchema) q: z.infer<typeof publicCalendarSchema>) {
    return this.booking.calendar(slug, q);
  }

  @Post('sites/:slug/bookings')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  book(
    @SlugParam() slug: string,
    @ZBody(publicBookingSchema) body: z.infer<typeof publicBookingSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.booking.book(slug, body, res);
  }

  /** Stripe calls this; it is authenticated by the webhook signature, not cookies. */
  @SkipCsrf()
  @Post('stripe/webhook/:slug')
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  webhook(@SlugParam() slug: string, @Req() req: Request & { rawBody?: Buffer }, @Headers('stripe-signature') signature?: string) {
    return this.booking.handleWebhook(slug, req.rawBody, signature);
  }

  @Get('stay/:token')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  stay(@TokenParam() token: string, @Req() req: Request) {
    return this.portal.view(token, req);
  }

  @Post('stay/:token/confirm-payment')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  confirmPayment(@TokenParam() token: string, @Req() req: Request) {
    return this.portal.confirmPayment(token, req);
  }

  @Post('stay/:token/code')
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  sendCode(@TokenParam() token: string) {
    return this.portal.sendCode(token);
  }

  @Post('stay/:token/verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verify(@TokenParam() token: string, @ZBody(guestCodeSchema) body: { code: string }, @Res({ passthrough: true }) res: Response) {
    return this.portal.verifyCode(token, body.code, res);
  }

  @Post('stay/:token/check-in')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  checkIn(@TokenParam() token: string, @Req() req: Request, @ZBody(onlineCheckinSchema) body: z.infer<typeof onlineCheckinSchema>) {
    return this.portal.checkIn(token, req, body);
  }
}

@Injectable()
export class OnlineBookingSettingsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async get(propertyId: string) {
    const property = await this.db.tenant((tx) => getAccessibleProperty(tx, propertyId));
    const [site] = await this.db.db
      .select()
      .from(bookingSites)
      .where(and(eq(bookingSites.propertyId, propertyId), eq(bookingSites.tenantId, requireTenant())));
    const origin = config().WEB_ORIGIN;
    return {
      slug: site?.slug ?? null,
      enabled: site?.enabled ?? false,
      stripePublishableKey: property.stripePublishableKey,
      hasSecretKey: Boolean(property.stripeSecretKeyEnc),
      hasWebhookSecret: Boolean(property.stripeWebhookSecretEnc),
      paymentsEnabled: paymentsEnabled(property),
      bookingUrl: site ? `${origin}/book/${site.slug}` : null,
      webhookUrl: site ? `${origin}/api/public/stripe/webhook/${site.slug}` : null,
    };
  }

  async update(propertyId: string, input: z.infer<typeof bookingSiteSchema>) {
    const tenantId = requireTenant();
    await this.db.tenant((tx) => getAccessibleProperty(tx, propertyId));
    const [taken] = await this.db.db
      .select({ id: bookingSites.id })
      .from(bookingSites)
      .where(and(eq(bookingSites.slug, input.slug), ne(bookingSites.propertyId, propertyId)));
    if (taken) throw conflict('SLUG_TAKEN', 'This web address is already used by another hotel');
    await this.db.db
      .insert(bookingSites)
      .values({ tenantId, propertyId, slug: input.slug, enabled: input.enabled })
      .onConflictDoUpdate({ target: bookingSites.propertyId, set: { slug: input.slug, enabled: input.enabled } });
    await this.db.tenant(async (tx) => {
      const patch: Partial<typeof properties.$inferInsert> = {};
      if (input.stripePublishableKey !== undefined) patch.stripePublishableKey = input.stripePublishableKey;
      if (input.stripeSecretKey !== undefined) patch.stripeSecretKeyEnc = encryptNullable(input.stripeSecretKey);
      if (input.stripeWebhookSecret !== undefined) patch.stripeWebhookSecretEnc = encryptNullable(input.stripeWebhookSecret);
      if (Object.keys(patch).length) await tx.update(properties).set(patch).where(eq(properties.id, propertyId));
      // Secrets are never written to the audit trail, only that they changed.
      await this.audit.log(tx, 'property.online_booking_updated', 'property', propertyId, {
        slug: input.slug,
        enabled: input.enabled,
        stripeKeysChanged: input.stripeSecretKey !== undefined || input.stripeWebhookSecret !== undefined,
      });
    });
    return this.get(propertyId);
  }
}

@Controller('properties/:id/online-booking')
export class OnlineBookingSettingsController {
  constructor(private readonly svc: OnlineBookingSettingsService) {}

  @Get()
  @Perms('property.manage')
  get(@IdParam() id: string) {
    return this.svc.get(id);
  }

  @Put()
  @Perms('property.manage')
  @HttpCode(200)
  update(@IdParam() id: string, @ZBody(bookingSiteSchema) body: z.infer<typeof bookingSiteSchema>) {
    return this.svc.update(id, body);
  }
}

@Module({
  imports: [ReservationsModule],
  controllers: [PublicController, OnlineBookingSettingsController],
  providers: [PublicBookingService, GuestPortalService, OnlineBookingSettingsService],
})
export class BookingModule {}
