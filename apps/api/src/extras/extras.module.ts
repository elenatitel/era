import { Controller, Get, Module, Patch, Post, Injectable } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { extraSchema, id, promoCodeSchema, updateExtraSchema, updatePromoCodeSchema } from '@pms/shared';
import { requireTenant } from '../common/context.js';
import { conflict, notFound, pgErrorCode, unprocessable } from '../common/errors.js';
import { IdParam, ZBody, ZQuery } from '../common/zod.js';
import { Perms } from '../auth/decorators.js';
import { AuditService } from '../db/audit.service.js';
import { DbService } from '../db/db.service.js';
import { extras, promoCodes, ratePlans } from '../db/schema.js';
import { getAccessibleProperty } from '../properties/properties.module.js';

const propertyQuery = z.object({ propertyId: id });

/** Extras (add-ons and package contents) and promo codes, per property. */
@Injectable()
export class ExtrasService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  listExtras(propertyId: string) {
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, propertyId);
      return tx.select().from(extras).where(eq(extras.propertyId, propertyId)).orderBy(asc(extras.sortOrder), asc(extras.name));
    });
  }

  createExtra(input: z.infer<typeof extraSchema>) {
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, input.propertyId);
      const [extra] = await tx.insert(extras).values({ ...input, tenantId: requireTenant() }).returning();
      await this.audit.log(tx, 'extra.created', 'extra', extra!.id, { name: extra!.name, price: extra!.price });
      return extra;
    });
  }

  updateExtra(extraId: string, input: z.infer<typeof updateExtraSchema>) {
    return this.db.tenant(async (tx) => {
      const [existing] = await tx.select().from(extras).where(eq(extras.id, extraId));
      if (!existing) throw notFound('Extra');
      await getAccessibleProperty(tx, existing.propertyId);
      const [extra] = await tx.update(extras).set(input).where(eq(extras.id, extraId)).returning();
      await this.audit.log(tx, 'extra.updated', 'extra', extraId, input);
      return extra;
    });
  }

  listPromoCodes(propertyId: string) {
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, propertyId);
      return tx.select().from(promoCodes).where(eq(promoCodes.propertyId, propertyId)).orderBy(desc(promoCodes.active), asc(promoCodes.code));
    });
  }

  createPromoCode(input: z.infer<typeof promoCodeSchema>) {
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, input.propertyId);
      if (input.ratePlanId) {
        const [plan] = await tx
          .select({ id: ratePlans.id })
          .from(ratePlans)
          .where(and(eq(ratePlans.id, input.ratePlanId), eq(ratePlans.propertyId, input.propertyId)));
        if (!plan) throw unprocessable('Rate plan not found for this property');
      }
      try {
        const [promo] = await tx.insert(promoCodes).values({ ...input, tenantId: requireTenant() }).returning();
        await this.audit.log(tx, 'promo_code.created', 'promo_code', promo!.id, { code: promo!.code, type: promo!.discountType, value: promo!.value });
        return promo;
      } catch (err) {
        if (pgErrorCode(err) === '23505') throw conflict('DUPLICATE', 'This promo code already exists for the property');
        throw err;
      }
    });
  }

  updatePromoCode(promoId: string, input: z.infer<typeof updatePromoCodeSchema>) {
    return this.db.tenant(async (tx) => {
      const [existing] = await tx.select().from(promoCodes).where(eq(promoCodes.id, promoId));
      if (!existing) throw notFound('Promo code');
      await getAccessibleProperty(tx, existing.propertyId);
      const from = input.stayFrom !== undefined ? input.stayFrom : existing.stayFrom;
      const to = input.stayTo !== undefined ? input.stayTo : existing.stayTo;
      if (from && to && to < from) throw unprocessable('The end date must be after the start date');
      if (input.maxUses != null && input.maxUses < existing.usedCount) throw unprocessable(`This code has already been used ${existing.usedCount} times`);
      const [promo] = await tx.update(promoCodes).set(input).where(eq(promoCodes.id, promoId)).returning();
      await this.audit.log(tx, 'promo_code.updated', 'promo_code', promoId, input);
      return promo;
    });
  }
}

@Controller()
export class ExtrasController {
  constructor(private readonly svc: ExtrasService) {}

  @Get('extras')
  @Perms('rates.read')
  extras(@ZQuery(propertyQuery) q: { propertyId: string }) {
    return this.svc.listExtras(q.propertyId);
  }

  @Post('extras')
  @Perms('rates.manage')
  createExtra(@ZBody(extraSchema) body: z.infer<typeof extraSchema>) {
    return this.svc.createExtra(body);
  }

  @Patch('extras/:id')
  @Perms('rates.manage')
  updateExtra(@IdParam() extraId: string, @ZBody(updateExtraSchema) body: z.infer<typeof updateExtraSchema>) {
    return this.svc.updateExtra(extraId, body);
  }

  @Get('promo-codes')
  @Perms('rates.read')
  promoCodes(@ZQuery(propertyQuery) q: { propertyId: string }) {
    return this.svc.listPromoCodes(q.propertyId);
  }

  @Post('promo-codes')
  @Perms('rates.manage')
  createPromoCode(@ZBody(promoCodeSchema) body: z.infer<typeof promoCodeSchema>) {
    return this.svc.createPromoCode(body);
  }

  @Patch('promo-codes/:id')
  @Perms('rates.manage')
  updatePromoCode(@IdParam() promoId: string, @ZBody(updatePromoCodeSchema) body: z.infer<typeof updatePromoCodeSchema>) {
    return this.svc.updatePromoCode(promoId, body);
  }
}

@Module({ controllers: [ExtrasController], providers: [ExtrasService] })
export class ExtrasModule {}
