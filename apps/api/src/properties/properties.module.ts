import { Controller, Get, HttpCode, Injectable, Module, Patch, Post, Put } from '@nestjs/common';
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import {
  addDays,
  isoDate,
  nightsBetween,
  propertySchema,
  rateOverridesSchema,
  ratePlanSchema,
  roomSchema,
  roomStatusSchema,
  roomTypeSchema,
  updatePropertySchema,
  updateRatePlanSchema,
  updateRoomSchema,
  updateRoomTypeSchema,
  weekday,
} from '@pms/shared';
import { allowedPropertyIds, assertPropertyAccess, ctx, hasPermission, requireTenant } from '../common/context.js';
import { forbidden, notFound, unprocessable } from '../common/errors.js';
import { IdParam, ZBody, ZQuery } from '../common/zod.js';
import { Perms } from '../auth/decorators.js';
import { AuditService } from '../db/audit.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { documentSeries, extras, properties, rateOverrides, ratePlanExtras, ratePlans, rooms, roomTypes } from '../db/schema.js';

type PropertyInput = z.infer<typeof propertySchema>;

/** Loads a property the caller may access, or 404 (never reveals other tenants' or restricted properties). */
export async function getAccessibleProperty(tx: Tx, propertyId: string) {
  assertPropertyAccess(propertyId);
  const [p] = await tx.select().from(properties).where(eq(properties.id, propertyId));
  if (!p) throw notFound('Property');
  return p;
}

@Injectable()
export class PropertiesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  // ---------- properties
  list() {
    const ids = allowedPropertyIds();
    return this.db.tenant((tx) =>
      tx
        .select()
        .from(properties)
        .where(ids ? inArray(properties.id, ids) : undefined)
        .orderBy(asc(properties.name)),
    );
  }

  get(id: string) {
    return this.db.tenant((tx) => getAccessibleProperty(tx, id));
  }

  async create(input: PropertyInput) {
    if (allowedPropertyIds()) throw forbidden('Users restricted to specific properties cannot create new ones');
    const { invoicePrefix, proformaPrefix, ...data } = input;
    return this.db.tenant(async (tx) => {
      const tenantId = requireTenant();
      const [p] = await tx.insert(properties).values({ ...data, tenantId }).returning();
      await tx.insert(documentSeries).values([
        { tenantId, propertyId: p!.id, type: 'invoice', prefix: invoicePrefix },
        { tenantId, propertyId: p!.id, type: 'proforma', prefix: proformaPrefix },
        { tenantId, propertyId: p!.id, type: 'credit_note', prefix: `${invoicePrefix}-CN`.slice(0, 16) },
      ]);
      await this.audit.log(tx, 'property.created', 'property', p!.id, { name: p!.name });
      return p;
    });
  }

  async update(id: string, input: Partial<PropertyInput>) {
    const { invoicePrefix, proformaPrefix, ...data } = input;
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, id);
      const [p] = await tx.update(properties).set(data).where(eq(properties.id, id)).returning();
      if (invoicePrefix) {
        await tx.update(documentSeries).set({ prefix: invoicePrefix }).where(and(eq(documentSeries.propertyId, id), eq(documentSeries.type, 'invoice')));
      }
      if (proformaPrefix) {
        await tx.update(documentSeries).set({ prefix: proformaPrefix }).where(and(eq(documentSeries.propertyId, id), eq(documentSeries.type, 'proforma')));
      }
      await this.audit.log(tx, 'property.updated', 'property', id, input);
      return p;
    });
  }

  series(propertyId: string) {
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, propertyId);
      return tx.select().from(documentSeries).where(eq(documentSeries.propertyId, propertyId));
    });
  }

  // ---------- room types
  listRoomTypes(propertyId: string) {
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, propertyId);
      return tx.select().from(roomTypes).where(eq(roomTypes.propertyId, propertyId)).orderBy(asc(roomTypes.name));
    });
  }

  createRoomType(input: z.infer<typeof roomTypeSchema>) {
    if (input.maxOccupancy < input.baseOccupancy) throw unprocessable('Max occupancy must be at least the base occupancy');
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, input.propertyId);
      const [rt] = await tx.insert(roomTypes).values({ ...input, tenantId: requireTenant() }).returning();
      await this.audit.log(tx, 'room_type.created', 'room_type', rt!.id, { code: rt!.code });
      return rt;
    });
  }

  updateRoomType(id: string, input: z.infer<typeof updateRoomTypeSchema> & { active?: boolean }) {
    return this.db.tenant(async (tx) => {
      const [existing] = await tx.select().from(roomTypes).where(eq(roomTypes.id, id));
      if (!existing) throw notFound('Room type');
      await getAccessibleProperty(tx, existing.propertyId);
      const [rt] = await tx.update(roomTypes).set(input).where(eq(roomTypes.id, id)).returning();
      await this.audit.log(tx, 'room_type.updated', 'room_type', id, input);
      return rt;
    });
  }

  // ---------- rooms
  listRooms(propertyId: string) {
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, propertyId);
      return tx
        .select({
          id: rooms.id,
          number: rooms.number,
          floor: rooms.floor,
          status: rooms.status,
          occupancy: rooms.occupancy,
          notes: rooms.notes,
          active: rooms.active,
          roomTypeId: rooms.roomTypeId,
          roomTypeCode: roomTypes.code,
          roomTypeName: roomTypes.name,
        })
        .from(rooms)
        .innerJoin(roomTypes, eq(roomTypes.id, rooms.roomTypeId))
        .where(eq(rooms.propertyId, propertyId))
        .orderBy(asc(rooms.number));
    });
  }

  private async assertRoomType(tx: Tx, roomTypeId: string, propertyId: string) {
    const [rt] = await tx.select().from(roomTypes).where(eq(roomTypes.id, roomTypeId));
    if (!rt || rt.propertyId !== propertyId) throw unprocessable('Room type does not belong to this property');
  }

  createRoom(input: z.infer<typeof roomSchema>) {
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, input.propertyId);
      await this.assertRoomType(tx, input.roomTypeId, input.propertyId);
      const [room] = await tx.insert(rooms).values({ ...input, tenantId: requireTenant() }).returning();
      await this.audit.log(tx, 'room.created', 'room', room!.id, { number: room!.number });
      return room;
    });
  }

  updateRoom(id: string, input: z.infer<typeof updateRoomSchema> & { active?: boolean }) {
    return this.db.tenant(async (tx) => {
      const [existing] = await tx.select().from(rooms).where(eq(rooms.id, id));
      if (!existing) throw notFound('Room');
      await getAccessibleProperty(tx, existing.propertyId);
      if (input.roomTypeId) await this.assertRoomType(tx, input.roomTypeId, existing.propertyId);
      const [room] = await tx.update(rooms).set(input).where(eq(rooms.id, id)).returning();
      await this.audit.log(tx, 'room.updated', 'room', id, input);
      return room;
    });
  }

  /** Housekeeping status changes. Inspection and out-of-order need housekeeping.manage. */
  setRoomStatus(id: string, input: z.infer<typeof roomStatusSchema>) {
    const privileged = input.status === 'inspected' || input.status === 'out_of_order';
    if (privileged && !hasPermission('housekeeping.manage')) throw forbidden();
    return this.db.tenant(async (tx) => {
      const [existing] = await tx.select().from(rooms).where(eq(rooms.id, id));
      if (!existing) throw notFound('Room');
      await getAccessibleProperty(tx, existing.propertyId);
      if (existing.status === 'out_of_order' && !hasPermission('housekeeping.manage')) throw forbidden();
      const [room] = await tx.update(rooms).set({ status: input.status }).where(eq(rooms.id, id)).returning();
      await this.audit.log(tx, 'room.status_changed', 'room', id, { from: existing.status, to: input.status, reason: input.reason });
      return room;
    });
  }

  // ---------- rate plans
  listRatePlans(propertyId: string) {
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, propertyId);
      const plans = await tx.select().from(ratePlans).where(eq(ratePlans.propertyId, propertyId)).orderBy(asc(ratePlans.name));
      const links = plans.length
        ? await tx.select().from(ratePlanExtras).where(inArray(ratePlanExtras.ratePlanId, plans.map((p) => p.id)))
        : [];
      return plans.map((p) => ({ ...p, includedExtraIds: links.filter((l) => l.ratePlanId === p.id).map((l) => l.extraId) }));
    });
  }

  /** Packages: replaces the extras included in a rate plan's price. */
  private async setPackageExtras(tx: Tx, plan: { id: string; propertyId: string }, extraIds: string[]) {
    const unique = [...new Set(extraIds)];
    if (unique.length) {
      const found = await tx
        .select({ id: extras.id })
        .from(extras)
        .where(and(inArray(extras.id, unique), eq(extras.propertyId, plan.propertyId)));
      if (found.length !== unique.length) throw unprocessable('Some extras were not found for this property');
    }
    await tx.delete(ratePlanExtras).where(eq(ratePlanExtras.ratePlanId, plan.id));
    if (unique.length) {
      await tx.insert(ratePlanExtras).values(unique.map((extraId) => ({ tenantId: requireTenant(), ratePlanId: plan.id, extraId })));
    }
    return unique;
  }

  createRatePlan(input: z.infer<typeof ratePlanSchema>) {
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, input.propertyId);
      const { includedExtraIds, ...values } = input;
      const [plan] = await tx.insert(ratePlans).values({ ...values, tenantId: requireTenant() }).returning();
      const included = await this.setPackageExtras(tx, plan!, includedExtraIds ?? []);
      await this.audit.log(tx, 'rate_plan.created', 'rate_plan', plan!.id, { code: plan!.code, includedExtraIds: included });
      return { ...plan!, includedExtraIds: included };
    });
  }

  updateRatePlan(id: string, input: z.infer<typeof updateRatePlanSchema>) {
    return this.db.tenant(async (tx) => {
      const [existing] = await tx.select().from(ratePlans).where(eq(ratePlans.id, id));
      if (!existing) throw notFound('Rate plan');
      await getAccessibleProperty(tx, existing.propertyId);
      const { includedExtraIds, ...values } = input;
      const [plan] = Object.keys(values).length ? await tx.update(ratePlans).set(values).where(eq(ratePlans.id, id)).returning() : [existing];
      const included =
        includedExtraIds !== undefined
          ? await this.setPackageExtras(tx, existing, includedExtraIds)
          : (await tx.select().from(ratePlanExtras).where(eq(ratePlanExtras.ratePlanId, id))).map((l) => l.extraId);
      await this.audit.log(tx, 'rate_plan.updated', 'rate_plan', id, input);
      return { ...plan!, includedExtraIds: included };
    });
  }

  // ---------- dynamic rates
  rateGrid(propertyId: string, from: string, to: string) {
    if (nightsBetween(from, to) > 120 || to < from) throw unprocessable('Range must be between 0 and 120 days');
    return this.db.tenant(async (tx) => {
      await getAccessibleProperty(tx, propertyId);
      const types = await tx.select().from(roomTypes).where(eq(roomTypes.propertyId, propertyId));
      const typeIds = types.map((t) => t.id);
      const overrides = typeIds.length
        ? await tx
            .select()
            .from(rateOverrides)
            .where(and(inArray(rateOverrides.roomTypeId, typeIds), gte(rateOverrides.date, from), lte(rateOverrides.date, to)))
        : [];
      return { roomTypes: types, overrides };
    });
  }

  setRates(input: z.infer<typeof rateOverridesSchema>) {
    const nights = nightsBetween(input.from, input.to);
    if (nights < 0 || nights > 366) throw unprocessable('Range must be between 1 and 367 days');
    return this.db.tenant(async (tx) => {
      const [rt] = await tx.select().from(roomTypes).where(eq(roomTypes.id, input.roomTypeId));
      if (!rt) throw notFound('Room type');
      await getAccessibleProperty(tx, rt.propertyId);
      if (input.ratePlanId) {
        const [plan] = await tx.select().from(ratePlans).where(eq(ratePlans.id, input.ratePlanId));
        if (!plan || plan.propertyId !== rt.propertyId) throw unprocessable('Rate plan does not belong to this property');
      }
      const dates = Array.from({ length: nights + 1 }, (_, i) => addDays(input.from, i)).filter(
        (d) => input.weekdays.length === 0 || input.weekdays.includes(weekday(d)),
      );
      if (!dates.length) return { updated: 0 };
      await tx
        .insert(rateOverrides)
        .values(
          dates.map((date) => ({
            tenantId: requireTenant(),
            roomTypeId: rt.id,
            ratePlanId: input.ratePlanId ?? null,
            date,
            price: input.price,
            closed: input.closed,
          })),
        )
        .onConflictDoUpdate({
          target: [rateOverrides.roomTypeId, rateOverrides.ratePlanId, rateOverrides.date],
          set: { price: input.price, closed: input.closed },
        });
      await this.audit.log(tx, 'rates.updated', 'room_type', rt.id, { ...input, dates: dates.length, by: ctx().userId });
      return { updated: dates.length };
    });
  }
}

const propertyQuery = z.object({ propertyId: z.uuid() });
const gridQuery = z.object({ propertyId: z.uuid(), from: isoDate, to: isoDate });

@Controller()
export class PropertiesController {
  constructor(private readonly svc: PropertiesService) {}

  @Get('properties')
  @Perms('property.read')
  list() {
    return this.svc.list();
  }

  @Get('properties/:id')
  @Perms('property.read')
  get(@IdParam() id: string) {
    return this.svc.get(id);
  }

  @Post('properties')
  @Perms('property.manage')
  create(@ZBody(propertySchema) body: PropertyInput) {
    return this.svc.create(body);
  }

  @Patch('properties/:id')
  @Perms('property.manage')
  update(@IdParam() id: string, @ZBody(updatePropertySchema) body: Partial<PropertyInput>) {
    return this.svc.update(id, body);
  }

  @Get('properties/:id/document-series')
  @Perms('invoices.read')
  series(@IdParam() id: string) {
    return this.svc.series(id);
  }

  @Get('room-types')
  @Perms('rooms.read')
  roomTypes(@ZQuery(propertyQuery) q: { propertyId: string }) {
    return this.svc.listRoomTypes(q.propertyId);
  }

  @Post('room-types')
  @Perms('rooms.manage')
  createRoomType(@ZBody(roomTypeSchema) body: z.infer<typeof roomTypeSchema>) {
    return this.svc.createRoomType(body);
  }

  @Patch('room-types/:id')
  @Perms('rooms.manage')
  updateRoomType(@IdParam() id: string, @ZBody(updateRoomTypeSchema.extend({ active: z.boolean().optional() })) body: z.infer<typeof updateRoomTypeSchema> & { active?: boolean }) {
    return this.svc.updateRoomType(id, body);
  }

  @Get('rooms')
  @Perms('rooms.read')
  rooms(@ZQuery(propertyQuery) q: { propertyId: string }) {
    return this.svc.listRooms(q.propertyId);
  }

  @Post('rooms')
  @Perms('rooms.manage')
  createRoom(@ZBody(roomSchema) body: z.infer<typeof roomSchema>) {
    return this.svc.createRoom(body);
  }

  @Patch('rooms/:id')
  @Perms('rooms.manage')
  updateRoom(@IdParam() id: string, @ZBody(updateRoomSchema.extend({ active: z.boolean().optional() })) body: z.infer<typeof updateRoomSchema> & { active?: boolean }) {
    return this.svc.updateRoom(id, body);
  }

  @Put('rooms/:id/status')
  @Perms('housekeeping.update')
  @HttpCode(200)
  roomStatus(@IdParam() id: string, @ZBody(roomStatusSchema) body: z.infer<typeof roomStatusSchema>) {
    return this.svc.setRoomStatus(id, body);
  }

  @Get('rate-plans')
  @Perms('rates.read')
  ratePlans(@ZQuery(propertyQuery) q: { propertyId: string }) {
    return this.svc.listRatePlans(q.propertyId);
  }

  @Post('rate-plans')
  @Perms('rates.manage')
  createRatePlan(@ZBody(ratePlanSchema) body: z.infer<typeof ratePlanSchema>) {
    return this.svc.createRatePlan(body);
  }

  @Patch('rate-plans/:id')
  @Perms('rates.manage')
  updateRatePlan(@IdParam() id: string, @ZBody(updateRatePlanSchema) body: z.infer<typeof updateRatePlanSchema>) {
    return this.svc.updateRatePlan(id, body);
  }

  @Get('rates')
  @Perms('rates.read')
  rateGrid(@ZQuery(gridQuery) q: { propertyId: string; from: string; to: string }) {
    return this.svc.rateGrid(q.propertyId, q.from, q.to);
  }

  @Put('rates')
  @Perms('rates.manage')
  @HttpCode(200)
  setRates(@ZBody(rateOverridesSchema) body: z.infer<typeof rateOverridesSchema>) {
    return this.svc.setRates(body);
  }
}

@Module({ controllers: [PropertiesController], providers: [PropertiesService], exports: [PropertiesService] })
export class PropertiesModule {}

