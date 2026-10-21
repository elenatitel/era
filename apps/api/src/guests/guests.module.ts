import { Controller, Get, HttpCode, Injectable, Module, Patch, Post } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { companySchema, guestSchema, guestSearchSchema, pagination, updateCompanySchema, updateGuestSchema } from '@pms/shared';
import { hasPermission, requireTenant } from '../common/context.js';
import { decryptNullable, encryptNullable, mask } from '../common/crypto.js';
import { invalidState, notFound, unprocessable } from '../common/errors.js';
import { IdParam, ZBody, ZQuery } from '../common/zod.js';
import { Perms } from '../auth/decorators.js';
import { AuditService } from '../db/audit.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { companies, folioItems, guests, invoices, payments, reservations } from '../db/schema.js';

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
        })
        .from(reservations)
        .where(eq(reservations.guestId, id))
        .orderBy(desc(reservations.arrival))
        .limit(100);
      const [spent] = await tx
        .select({ total: sql<number>`coalesce(sum(${folioItems.amount}), 0)::bigint` })
        .from(folioItems)
        .innerJoin(reservations, eq(reservations.id, folioItems.reservationId))
        .where(and(eq(reservations.guestId, id), isNull(folioItems.voidedAt)));
      if (hasPermission('guests.pii')) await this.audit.log(tx, 'guest.pii_viewed', 'guest', id);
      return { ...presentGuest(g), history, lifetimeValue: Number(spent?.total ?? 0) };
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
      await tx.update(reservations).set({ notes: null }).where(eq(reservations.guestId, id));
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

@Module({ controllers: [GuestsController], providers: [GuestsService], exports: [GuestsService] })
export class GuestsModule {}
