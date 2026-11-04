import { Controller, Get, HttpCode, Injectable, Module, Patch, Post } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { companySchema, guestSchema, guestSearchSchema, nightsBetween, pagination, smartTipSchema, updateCompanySchema, updateGuestSchema } from '@pms/shared';
import { hasPermission, requireTenant } from '../common/context.js';
import { decryptNullable, encryptNullable, mask } from '../common/crypto.js';
import { conflict, invalidState, notFound, unprocessable } from '../common/errors.js';
import { IdParam, ZBody, ZQuery } from '../common/zod.js';
import { Perms } from '../auth/decorators.js';
import { AuditService } from '../db/audit.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { auditLogs, companies, folioItems, guests, invoices, payments, properties, reservations, rooms, roomTypes, users } from '../db/schema.js';
import { GuestInsightService } from './guest-insight.service.js';

type GuestRow = typeof guests.$inferSelect;
type GuestInput = z.infer<typeof guestSchema>;

/** Never return ciphertext; reveal document numbers only with guests.pii. */
export function presentGuest(g: GuestRow) {
  const { documentNumberEnc, ...rest } = g;
  const documentNumber = decryptNullable(documentNumberEnc);
  return { ...rest, documentNumber: hasPermission('guests.pii') ? documentNumber : mask(documentNumber) };
}

function toRow(input: Partial<GuestInput>) {
  const { documentNumber, ...rest } = input;
  return documentNumber === undefined ? rest : { ...rest, documentNumberEnc: encryptNullable(documentNumber) };
}

export async function assertCompany(tx: Tx, companyId: string | null | undefined) {
  if (!companyId) return;
  const [c] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
  if (!c) throw unprocessable('Unknown company');
}

export async function insertGuest(tx: Tx, input: GuestInput) {
  await assertCompany(tx, input.companyId);
  const [g] = await tx
    .insert(guests)
    .values({ ...toRow(input), firstName: input.firstName, lastName: input.lastName, tenantId: requireTenant() })
    .returning();
  return g!;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

@Injectable()
export class GuestsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly insight: GuestInsightService,
  ) {}

  search(q: z.infer<typeof guestSearchSchema>) {
    return this.db.tenant(async (tx) => {
      const term = q.q ? `%${escapeLike(q.q)}%` : null;
      const where = and(
        isNull(guests.anonymizedAt),
        q.segment ? eq(guests.segment, q.segment) : undefined,
        term
          ? or(
              ilike(guests.lastName, term),
              ilike(guests.firstName, term),
              ilike(guests.email, term),
              ilike(guests.phone, term),
              ilike(sql`${guests.firstName} || ' ' || ${guests.lastName}`, term),
            )
          : undefined,
      );
      const [items, [total]] = await Promise.all([
        tx
          .select({
            guest: guests,
            companyName: companies.name,
            stays: sql<number>`(select count(*)::int from ${reservations} r where r.guest_id = ${guests.id} and r.status = 'checked_out')`,
          })
          .from(guests)
          .leftJoin(companies, eq(companies.id, guests.companyId))
          .where(where)
          .orderBy(asc(guests.lastName), asc(guests.firstName))
          .limit(q.pageSize)
          .offset((q.page - 1) * q.pageSize),
        tx.select({ n: count() }).from(guests).where(where),
      ]);
      return {
        items: items.map((r) => ({ ...presentGuest(r.guest), companyName: r.companyName, stays: r.stays })),
        total: total?.n ?? 0,
        page: q.page,
        pageSize: q.pageSize,
      };
    });
  }

  get(id: string) {
    return this.db.tenant(async (tx) => {
      const [g] = await tx.select().from(guests).where(eq(guests.id, id));
      if (!g) throw notFound('Guest');
      const history = await tx
        .select({
          id: reservations.id,
          code: reservations.code,
          status: reservations.status,
          arrival: reservations.arrival,
          departure: reservations.departure,
          totalAmount: reservations.totalAmount,
          currency: reservations.currency,
          propertyName: properties.name,
          roomNumber: rooms.number,
          guestRequests: reservations.guestRequests,
        })
        .from(reservations)
        .innerJoin(properties, eq(properties.id, reservations.propertyId))
        .leftJoin(rooms, eq(rooms.id, reservations.roomId))
        .where(eq(reservations.guestId, id))
        .orderBy(desc(reservations.arrival))
        .limit(100);
      const [spent] = await tx
        .select({ total: sql<number>`coalesce(sum(${folioItems.amount}), 0)::bigint` })
        .from(folioItems)
        .innerJoin(reservations, eq(reservations.id, folioItems.reservationId))
        .where(and(eq(reservations.guestId, id), isNull(folioItems.voidedAt)));
      const stayIds = history.map((h) => h.id);
      const billing = hasPermission('invoices.read')
        ? await tx
            .select({ id: invoices.id, fullNumber: invoices.fullNumber, type: invoices.type, status: invoices.status, issueDate: invoices.issueDate, total: invoices.total, currency: invoices.currency })
            .from(invoices)
            .where(or(eq(invoices.guestId, id), stayIds.length ? inArray(invoices.reservationId, stayIds) : undefined))
            .orderBy(desc(invoices.issueDate))
            .limit(100)
        : [];
      const paid = hasPermission('folio.read') && stayIds.length
        ? await tx
            .select({ id: payments.id, method: payments.method, amount: payments.amount, currency: payments.currency, reference: payments.reference, createdAt: payments.createdAt })
            .from(payments)
            .where(inArray(payments.reservationId, stayIds))
            .orderBy(desc(payments.createdAt))
            .limit(100)
        : [];
      // What happened, not the details: audit metadata stays behind audit.read.
      const activity = await tx
        .select({ id: auditLogs.id, action: auditLogs.action, createdAt: auditLogs.createdAt, userName: users.name })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.userId))
        .where(
          and(
            sql`${auditLogs.action} <> 'guest.pii_viewed'`,
            or(
              and(eq(auditLogs.entityType, 'guest'), eq(auditLogs.entityId, id)),
              stayIds.length ? and(eq(auditLogs.entityType, 'reservation'), inArray(auditLogs.entityId, stayIds)) : undefined,
            ),
          ),
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(50);
      if (hasPermission('guests.pii')) await this.audit.log(tx, 'guest.pii_viewed', 'guest', id);
      const stayed = history.filter((h) => h.status === 'checked_out');
      return {
        ...presentGuest(g),
        history,
        lifetimeValue: Number(spent?.total ?? 0),
        stats: { stays: stayed.length, nights: stayed.reduce((s, h) => s + nightsBetween(h.arrival, h.departure), 0), lastStay: stayed[0]?.departure ?? null },
        invoices: billing,
        payments: paid,
        activity,
        smartTipEnabled: this.insight.enabled,
      };
    });
  }

  /**
   * Refreshes the AI summary. The model runs outside the transaction, so a slow reply never
   * holds a database connection.
   */
  async refreshSmartTip(id: string, locale: 'ro' | 'en') {
    if (!this.insight.enabled) throw conflict('AI_NOT_CONFIGURED', 'AI summaries are not configured');
    const source = await this.db.tenant(async (tx) => {
      const [g] = await tx.select().from(guests).where(eq(guests.id, id));
      if (!g) throw notFound('Guest');
      if (g.anonymizedAt) throw invalidState('Anonymized profiles have no summary');
      const stays = await tx
        .select({ arrival: reservations.arrival, requests: reservations.guestRequests, notes: reservations.notes, propertyId: reservations.propertyId })
        .from(reservations)
        .where(eq(reservations.guestId, id))
        .orderBy(desc(reservations.arrival))
        .limit(20);
      const propertyId = stays[0]?.propertyId;
      const [hotel] = propertyId ? await tx.select({ name: properties.name }).from(properties).where(eq(properties.id, propertyId)) : [];
      const types = propertyId ? await tx.select({ name: roomTypes.name }).from(roomTypes).where(eq(roomTypes.propertyId, propertyId)) : [];
      return { guest: g, stays, hotel: hotel?.name ?? null, roomTypes: types.map((t) => t.name) };
    });
    const tip = await this.insight.summarize({
      names: [source.guest.firstName, source.guest.lastName],
      notes: source.guest.notes,
      tags: source.guest.tags,
      stays: source.stays,
      hotel: source.hotel,
      roomTypes: source.roomTypes,
      locale,
    });
    return this.db.tenant(async (tx) => {
      const [g] = await tx.update(guests).set({ smartTip: tip, smartTipAt: tip ? new Date() : null }).where(eq(guests.id, id)).returning({ smartTip: guests.smartTip, smartTipAt: guests.smartTipAt });
      await this.audit.log(tx, 'guest.smart_tip_generated', 'guest', id);
      return g!;
    });
  }

  create(input: GuestInput) {
    return this.db.tenant(async (tx) => {
      const g = await insertGuest(tx, input);
      await this.audit.log(tx, 'guest.created', 'guest', g.id);
      return presentGuest(g);
    });
  }

  update(id: string, input: Partial<GuestInput>) {
    return this.db.tenant(async (tx) => {
      const [existing] = await tx.select().from(guests).where(eq(guests.id, id));
      if (!existing) throw notFound('Guest');
      if (existing.anonymizedAt) throw invalidState('Anonymized profiles cannot be edited');
      await assertCompany(tx, input.companyId);
      const [g] = await tx.update(guests).set(toRow(input)).where(eq(guests.id, id)).returning();
      // Log which fields changed, never their values (PII).
      await this.audit.log(tx, 'guest.updated', 'guest', id, { fields: Object.keys(input) });
      return presentGuest(g!);
    });
  }

  /** GDPR Art. 15/20: machine-readable export of everything held about a guest. */
  export(id: string) {
    return this.db.tenant(async (tx) => {
      const [g] = await tx.select().from(guests).where(eq(guests.id, id));
      if (!g) throw notFound('Guest');
      const stays = await tx.select().from(reservations).where(eq(reservations.guestId, id));
      const stayIds = stays.map((s) => s.id);
      const charges = stayIds.length
        ? await tx.select().from(folioItems).where(inArray(folioItems.reservationId, stayIds))
        : [];
      const pays = stayIds.length ? await tx.select().from(payments).where(inArray(payments.reservationId, stayIds)) : [];
      const docs = await tx.select().from(invoices).where(eq(invoices.guestId, id));
      await this.audit.log(tx, 'guest.gdpr_exported', 'guest', id);
      const { documentNumberEnc, ...profile } = g;
      return {
        exportedAt: new Date().toISOString(),
        profile: { ...profile, documentNumber: decryptNullable(documentNumberEnc) },
        reservations: stays,
        charges,
        payments: pays,
        invoices: docs,
      };
    });
  }

  /**
   * GDPR Art. 17: erase personal data while keeping financial records required by law.
   * Issued invoices keep their own immutable bill-to snapshot.
   */
  anonymize(id: string) {
    return this.db.tenant(async (tx) => {
      const [g] = await tx.select().from(guests).where(eq(guests.id, id));
      if (!g) throw notFound('Guest');
      const [active] = await tx
        .select({ n: count() })
        .from(reservations)
        .where(and(eq(reservations.guestId, id), sql`${reservations.status} in ('tentative','confirmed','checked_in')`));
      if ((active?.n ?? 0) > 0) throw invalidState('The guest has active reservations');
      await tx
        .update(guests)
        .set({
          firstName: 'Anonymized',
          lastName: 'Guest',
          email: null,
          phone: null,
          birthDate: null,
          birthPlace: null,
          language: null,
          occupation: null,
          taxId: null,
          carRegistration: null,
          smartTip: null,
          smartTipAt: null,
          documentType: null,
          documentNumberEnc: null,
          address: null,
          city: null,
          nationality: null,
          notes: null,
          tags: [],
          marketingConsent: false,
          anonymizedAt: new Date(),
        })
        .where(eq(guests.id, id));
      await tx.update(reservations).set({ notes: null, guestRequests: null }).where(eq(reservations.guestId, id));
      await this.audit.log(tx, 'guest.anonymized', 'guest', id);
    });
  }

  // ---------- companies
  listCompanies(q: { page: number; pageSize: number; q?: string }) {
    return this.db.tenant(async (tx) => {
      const term = q.q ? `%${escapeLike(q.q)}%` : null;
      const where = term ? or(ilike(companies.name, term), ilike(companies.taxId, term)) : undefined;
      const items = await tx
        .select()
        .from(companies)
        .where(where)
        .orderBy(asc(companies.name))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize);
      const [total] = await tx.select({ n: count() }).from(companies).where(where);
      return { items, total: total?.n ?? 0 };
    });
  }

  createCompany(input: z.infer<typeof companySchema>) {
    return this.db.tenant(async (tx) => {
      const [c] = await tx.insert(companies).values({ ...input, tenantId: requireTenant() }).returning();
      await this.audit.log(tx, 'company.created', 'company', c!.id, { name: c!.name });
      return c;
    });
  }

  updateCompany(id: string, input: z.infer<typeof updateCompanySchema>) {
    return this.db.tenant(async (tx) => {
      const [c] = await tx.update(companies).set(input).where(eq(companies.id, id)).returning();
      if (!c) throw notFound('Company');
      await this.audit.log(tx, 'company.updated', 'company', id, input);
      return c;
    });
  }
}

const companySearch = pagination.extend({ q: z.string().trim().max(100).optional() });

@Controller()
export class GuestsController {
  constructor(private readonly svc: GuestsService) {}

  @Get('guests')
  @Perms('guests.read')
  search(@ZQuery(guestSearchSchema) q: z.infer<typeof guestSearchSchema>) {
    return this.svc.search(q);
  }

  @Get('guests/:id')
  @Perms('guests.read')
  get(@IdParam() id: string) {
    return this.svc.get(id);
  }

  @Post('guests')
  @Perms('guests.manage')
  create(@ZBody(guestSchema) body: GuestInput) {
    return this.svc.create(body);
  }

  @Patch('guests/:id')
  @Perms('guests.manage')
  update(@IdParam() id: string, @ZBody(updateGuestSchema) body: Partial<GuestInput>) {
    return this.svc.update(id, body);
  }

  @Post('guests/:id/smart-tip')
  @Perms('guests.manage')
  @HttpCode(200)
  smartTip(@IdParam() id: string, @ZBody(smartTipSchema) body: z.infer<typeof smartTipSchema>) {
    return this.svc.refreshSmartTip(id, body.locale);
  }

  @Get('guests/:id/gdpr-export')
  @Perms('guests.gdpr')
  export(@IdParam() id: string) {
    return this.svc.export(id);
  }

  @Post('guests/:id/anonymize')
  @Perms('guests.gdpr')
  @HttpCode(204)
  anonymize(@IdParam() id: string) {
    return this.svc.anonymize(id);
  }

  @Get('companies')
  @Perms('guests.read')
  companies(@ZQuery(companySearch) q: z.infer<typeof companySearch>) {
    return this.svc.listCompanies(q);
  }

  @Post('companies')
  @Perms('guests.manage')
  createCompany(@ZBody(companySchema) body: z.infer<typeof companySchema>) {
    return this.svc.createCompany(body);
  }

  @Patch('companies/:id')
  @Perms('guests.manage')
  updateCompany(@IdParam() id: string, @ZBody(updateCompanySchema) body: z.infer<typeof updateCompanySchema>) {
    return this.svc.updateCompany(id, body);
  }
}

@Module({ controllers: [GuestsController], providers: [GuestsService, GuestInsightService], exports: [GuestsService] })
export class GuestsModule {}
