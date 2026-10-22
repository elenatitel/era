import { Controller, Get, HttpCode, Injectable, Module, Post } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  addDays,
  cancelInvoiceSchema,
  createInvoiceSchema,
  invoiceSearchSchema,
  isoDate,
  paymentSchema,
  postChargeSchema,
  todayIn,
  vatFromGross,
  voidChargeSchema,
} from '@pms/shared';
import { allowedPropertyIds, ctx, hasPermission, requireTenant } from '../common/context.js';
import { forbidden, invalidState, notFound, unprocessable } from '../common/errors.js';
import { IdParam, ZBody, ZQuery } from '../common/zod.js';
import { Perms } from '../auth/decorators.js';
import { AuditService } from '../db/audit.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import {
  companies,
  documentSeries,
  folioItems,
  guests,
  invoiceLines,
  invoices,
  payments,
  properties,
  reservations,
  type PartySnapshot,
} from '../db/schema.js';
import { getAccessibleProperty } from '../properties/properties.module.js';
import { folioTotals } from './folio.js';

type Property = typeof properties.$inferSelect;
interface Line {
  description: string;
  quantity: number;
  unitPrice: number;
  vatRate: number;
  folioItemId?: string | null;
}

const sellerSnapshot = (p: Property): PartySnapshot => ({
  name: p.legalName ?? p.name,
  taxId: p.taxId,
  registrationNumber: p.registrationNumber,
  address: p.address,
  city: p.city,
  country: p.country,
  email: p.email,
});

async function nextNumber(tx: Tx, propertyId: string, type: string) {
  const [row] = await tx
    .update(documentSeries)
    .set({ nextNumber: sql`${documentSeries.nextNumber} + 1` })
    .where(and(eq(documentSeries.propertyId, propertyId), eq(documentSeries.type, type)))
    .returning({ prefix: documentSeries.prefix, next: documentSeries.nextNumber });
  if (!row) throw invalidState(`No ${type} series configured for this property`);
  const number = row.next - 1;
  return { series: row.prefix, number, fullNumber: `${row.prefix}-${String(number).padStart(6, '0')}` };
}

function computeLine(l: Line) {
  const total = l.quantity * l.unitPrice;
  const vat = Math.sign(total) * vatFromGross(Math.abs(total), l.vatRate);
  return { ...l, total, vat, net: total - vat };
}

@Injectable()
export class FinanceService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private async loadReservation(tx: Tx, id: string) {
    const [r] = await tx.select().from(reservations).where(eq(reservations.id, id));
    if (!r) throw notFound('Reservation');
    const property = await getAccessibleProperty(tx, r.propertyId);
    return { reservation: r, property };
  }

  // ---------------------------------------------------------------- folio

  postCharge(reservationId: string, input: z.infer<typeof postChargeSchema>) {
    return this.db.tenant(async (tx) => {
      const { reservation, property } = await this.loadReservation(tx, reservationId);
      const vatRate = input.vatRate ?? (input.category === 'accommodation' ? property.accommodationVatRate : property.standardVatRate);
      const [item] = await tx
        .insert(folioItems)
        .values({
          tenantId: requireTenant(),
          reservationId,
          category: input.category,
          description: input.description,
          quantity: input.quantity,
          unitPrice: input.unitPrice,
          amount: input.quantity * input.unitPrice,
          vatRate,
          serviceDate: input.serviceDate ?? property.businessDate,
          postedById: ctx().userId,
        })
        .returning();
      await this.audit.log(tx, 'folio.charge_posted', 'reservation', reservation.id, {
        itemId: item!.id,
        amount: item!.amount,
        category: input.category,
      });
      return item;
    });
  }

  voidCharge(itemId: string, reason: string) {
    return this.db.tenant(async (tx) => {
      const [item] = await tx.select().from(folioItems).where(eq(folioItems.id, itemId)).for('update');
      if (!item) throw notFound('Charge');
      await this.loadReservation(tx, item.reservationId);
      if (item.voidedAt) throw invalidState('The charge is already void');
      if (item.invoiceId) throw invalidState('The charge is invoiced; cancel the invoice first');
      const [updated] = await tx
        .update(folioItems)
        .set({ voidedAt: new Date(), voidReason: reason, voidedById: ctx().userId })
        .where(eq(folioItems.id, itemId))
        .returning();
      await this.audit.log(tx, 'folio.charge_voided', 'reservation', item.reservationId, { itemId, amount: item.amount, reason });
      return updated;
    });
  }

  addPayment(reservationId: string, input: z.infer<typeof paymentSchema>) {
    if (input.amount < 0 && !hasPermission('payments.refund')) throw forbidden('Refunds require the payments.refund permission');
    return this.db.tenant(async (tx) => {
      const { reservation } = await this.loadReservation(tx, reservationId);
      const [payment] = await tx
        .insert(payments)
        .values({
          tenantId: requireTenant(),
          propertyId: reservation.propertyId,
          reservationId,
          method: input.method,
          amount: input.amount,
          currency: reservation.currency,
          reference: input.reference,
          notes: input.notes,
          receivedById: ctx().userId,
        })
        .returning();
      await this.audit.log(tx, input.amount < 0 ? 'payment.refunded' : 'payment.received', 'reservation', reservationId, {
        paymentId: payment!.id,
        amount: input.amount,
        method: input.method,
      });
      return { payment, totals: await folioTotals(tx, reservationId) };
    });
  }

  paymentsReport(propertyId: string, from: string, to: string) {
    return this.db.tenant(async (tx) => {
      const property = await getAccessibleProperty(tx, propertyId);
      const fromTs = sql`(${from}::date)::timestamp AT TIME ZONE ${property.timezone}`;
      const toTs = sql`((${to}::date + 1))::timestamp AT TIME ZONE ${property.timezone}`;
      const where = and(eq(payments.propertyId, propertyId), sql`${payments.createdAt} >= ${fromTs}`, sql`${payments.createdAt} < ${toTs}`);
      const items = await tx
        .select({
          payment: payments,
          reservationCode: reservations.code,
          guestName: sql<string | null>`${guests.firstName} || ' ' || ${guests.lastName}`,
        })
        .from(payments)
        .leftJoin(reservations, eq(reservations.id, payments.reservationId))
        .leftJoin(guests, eq(guests.id, reservations.guestId))
        .where(where)
        .orderBy(desc(payments.createdAt))
        .limit(1000);
      const byMethod = await tx
        .select({ method: payments.method, total: sql<number>`sum(${payments.amount})::bigint`, n: count() })
        .from(payments)
        .where(where)
        .groupBy(payments.method);
      return {
        items: items.map((i) => ({ ...i.payment, reservationCode: i.reservationCode, guestName: i.guestName })),
        byMethod: byMethod.map((m) => ({ ...m, total: Number(m.total) })),
        total: byMethod.reduce((s, m) => s + Number(m.total), 0),
      };
    });
  }

  // ---------------------------------------------------------------- invoices

  private async billToFor(tx: Tx, companyId?: string | null, guestId?: string | null): Promise<PartySnapshot> {
    if (companyId) {
      const [c] = await tx.select().from(companies).where(eq(companies.id, companyId));
      if (!c) throw unprocessable('Unknown company');
      return { name: c.name, taxId: c.taxId, registrationNumber: c.registrationNumber, address: c.address, city: c.city, country: c.country, email: c.email };
    }
    if (guestId) {
      const [g] = await tx.select().from(guests).where(eq(guests.id, guestId));
      if (!g) throw unprocessable('Unknown guest');
      return { name: `${g.firstName} ${g.lastName}`, address: g.address, city: g.city, country: g.country, email: g.email };
    }
    throw unprocessable('Provide a guest or company to bill');
  }

  createInvoice(input: z.infer<typeof createInvoiceSchema>) {
    return this.db.tenant(async (tx) => {
      const property = await getAccessibleProperty(tx, input.propertyId);
      let lines: Line[] = [];
      let guestId = input.guestId ?? null;
      let companyId = input.companyId ?? null;
      let folioIds: string[] = [];
      let currency = property.currency;
      let reservationId: string | null = null;

      if (input.reservationId) {
        const { reservation } = await this.loadReservation(tx, input.reservationId);
        if (reservation.propertyId !== property.id) throw unprocessable('Reservation belongs to another property');
        reservationId = reservation.id;
        currency = reservation.currency;
        if (!guestId && !companyId) {
          companyId = reservation.companyId;
          guestId = companyId ? null : reservation.guestId;
        }
        const open = await tx
          .select()
          .from(folioItems)
          .where(and(eq(folioItems.reservationId, reservation.id), isNull(folioItems.voidedAt), isNull(folioItems.invoiceId)))
          .orderBy(asc(folioItems.serviceDate))
          .for('update');
        if (input.type === 'invoice') {
          if (!open.length) throw invalidState('There are no uninvoiced charges on this folio');
          folioIds = open.map((i) => i.id);
          lines = open.map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, vatRate: i.vatRate, folioItemId: i.id }));
        } else {
          // Proforma: the expected stay plus extras already posted; does not consume folio items.
          const nights = reservation.nightlyRates.length;
          const stayTotal = reservation.nightlyRates.reduce((s, n) => s + n.amount, 0);
          const postedRoom = open.filter((i) => i.isRoomCharge).reduce((s, i) => s + i.amount, 0);
          lines = [
            {
              description: `Accommodation ${reservation.arrival} – ${reservation.departure} (${nights} nights)`,
              quantity: 1,
              unitPrice: Math.max(stayTotal, postedRoom),
              vatRate: property.accommodationVatRate,
            },
            ...open
              .filter((i) => !i.isRoomCharge)
              .map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, vatRate: i.vatRate })),
          ];
        }
      } else {
        lines = input.lines!;
      }

      const billTo = await this.billToFor(tx, companyId, guestId);
      const computed = lines.map(computeLine);
      const total = computed.reduce((s, l) => s + l.total, 0);
      const vatTotal = computed.reduce((s, l) => s + l.vat, 0);
      const issueDate = todayIn(property.timezone);
      const numbering = await nextNumber(tx, property.id, input.type);
      let status: 'issued' | 'paid' = 'issued';
      if (reservationId && input.type === 'invoice') {
        const totals = await folioTotals(tx, reservationId);
        if (totals.balance <= 0) status = 'paid';
      }

      const [invoice] = await tx
        .insert(invoices)
        .values({
          tenantId: requireTenant(),
          propertyId: property.id,
          type: input.type,
          status,
          ...numbering,
          reservationId,
          guestId,
          companyId,
          seller: sellerSnapshot(property),
          billTo,
          issueDate,
          dueDate: addDays(issueDate, input.dueDays),
          currency,
          subtotal: total - vatTotal,
          vatTotal,
          total,
          notes: input.notes,
          createdById: ctx().userId,
        })
        .returning();
      await tx.insert(invoiceLines).values(
        computed.map((l, i) => ({
          tenantId: requireTenant(),
          invoiceId: invoice!.id,
          position: i + 1,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          vatRate: l.vatRate,
          net: l.net,
          vat: l.vat,
          total: l.total,
          folioItemId: l.folioItemId ?? null,
        })),
      );
      if (folioIds.length) await tx.update(folioItems).set({ invoiceId: invoice!.id }).where(inArray(folioItems.id, folioIds));
      await this.audit.log(tx, `${input.type}.issued`, 'invoice', invoice!.id, { number: invoice!.fullNumber, total });
      return invoice;
    });
  }

  listInvoices(q: z.infer<typeof invoiceSearchSchema>) {
    return this.db.tenant(async (tx) => {
      const allowed = allowedPropertyIds();
      const where = and(
        q.propertyId ? eq(invoices.propertyId, q.propertyId) : undefined,
        allowed ? inArray(invoices.propertyId, allowed) : undefined,
        q.type ? eq(invoices.type, q.type) : undefined,
        q.from ? gte(invoices.issueDate, q.from) : undefined,
        q.to ? lte(invoices.issueDate, q.to) : undefined,
      );
      const items = await tx
        .select({
          id: invoices.id,
          type: invoices.type,
          status: invoices.status,
          fullNumber: invoices.fullNumber,
          issueDate: invoices.issueDate,
          dueDate: invoices.dueDate,
          billTo: invoices.billTo,
          total: invoices.total,
          vatTotal: invoices.vatTotal,
          currency: invoices.currency,
          reservationId: invoices.reservationId,
          propertyId: invoices.propertyId,
        })
        .from(invoices)
        .where(where)
        .orderBy(desc(invoices.issueDate), desc(invoices.number))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize);
      const [total] = await tx.select({ n: count() }).from(invoices).where(where);
      return { items, total: total?.n ?? 0, page: q.page, pageSize: q.pageSize };
    });
  }

  getInvoice(id: string) {
    return this.db.tenant(async (tx) => {
      const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id));
      if (!invoice) throw notFound('Invoice');
      await getAccessibleProperty(tx, invoice.propertyId);
      const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id)).orderBy(asc(invoiceLines.position));
      const paid = await tx
        .select({ total: sql<number>`coalesce(sum(${payments.amount}), 0)::bigint` })
        .from(payments)
        .where(eq(payments.invoiceId, id));
      return { ...invoice, lines, paidDirectly: Number(paid[0]?.total ?? 0) };
    });
  }

  /** Records a payment directly against an invoice (e.g. company bank transfer). */
  payInvoice(id: string, input: z.infer<typeof paymentSchema>) {
    if (input.amount < 0) throw unprocessable('Use a credit note to reverse an invoice');
    return this.db.tenant(async (tx) => {
      const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id)).for('update');
      if (!invoice) throw notFound('Invoice');
      await getAccessibleProperty(tx, invoice.propertyId);
      if (invoice.type !== 'invoice' || invoice.status === 'cancelled') throw invalidState('Only issued invoices can be paid');
      await tx.insert(payments).values({
        tenantId: requireTenant(),
        propertyId: invoice.propertyId,
        invoiceId: id,
        method: input.method,
        amount: input.amount,
        currency: invoice.currency,
        reference: input.reference,
        notes: input.notes,
        receivedById: ctx().userId,
      });
      const [paid] = await tx
        .select({ total: sql<number>`coalesce(sum(${payments.amount}), 0)::bigint` })
        .from(payments)
        .where(eq(payments.invoiceId, id));
      if (Number(paid?.total ?? 0) >= invoice.total) await tx.update(invoices).set({ status: 'paid' }).where(eq(invoices.id, id));
      await this.audit.log(tx, 'invoice.payment_received', 'invoice', id, { amount: input.amount, method: input.method });
      return this.getInvoiceTx(tx, id);
    });
  }

  private async getInvoiceTx(tx: Tx, id: string) {
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id));
    return invoice;
  }

  /** Invoices are never deleted: cancelling issues a credit note (storno) and frees the folio charges. */
  cancelInvoice(id: string, reason: string) {
    return this.db.tenant(async (tx) => {
      const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id)).for('update');
      if (!invoice) throw notFound('Invoice');
      const property = await getAccessibleProperty(tx, invoice.propertyId);
      if (invoice.status === 'cancelled') throw invalidState('The document is already cancelled');
      if (invoice.type === 'credit_note') throw invalidState('Credit notes cannot be cancelled');
      let creditNote = null;
      if (invoice.type === 'invoice') {
        const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id)).orderBy(asc(invoiceLines.position));
        const numbering = await nextNumber(tx, property.id, 'credit_note');
        const issueDate = todayIn(property.timezone);
        [creditNote] = await tx
          .insert(invoices)
          .values({
            tenantId: requireTenant(),
            propertyId: property.id,
            type: 'credit_note',
            status: 'issued',
            ...numbering,
            reservationId: invoice.reservationId,
            guestId: invoice.guestId,
            companyId: invoice.companyId,
            seller: invoice.seller,
            billTo: invoice.billTo,
            issueDate,
            dueDate: issueDate,
            currency: invoice.currency,
            subtotal: -invoice.subtotal,
            vatTotal: -invoice.vatTotal,
            total: -invoice.total,
            notes: `Storno ${invoice.fullNumber}: ${reason}`,
            correctsInvoiceId: invoice.id,
            createdById: ctx().userId,
          })
          .returning();
        await tx.insert(invoiceLines).values(
          lines.map((l) => ({
            tenantId: requireTenant(),
            invoiceId: creditNote!.id,
            position: l.position,
            description: l.description,
            quantity: l.quantity,
            unitPrice: -l.unitPrice,
            vatRate: l.vatRate,
            net: -l.net,
            vat: -l.vat,
            total: -l.total,
          })),
        );
        await tx.update(folioItems).set({ invoiceId: null }).where(eq(folioItems.invoiceId, id));
      }
      await tx.update(invoices).set({ status: 'cancelled', cancelReason: reason, cancelledAt: new Date() }).where(eq(invoices.id, id));
      await this.audit.log(tx, `${invoice.type}.cancelled`, 'invoice', id, { reason, creditNote: creditNote?.fullNumber });
      return { cancelled: invoice.fullNumber, creditNote };
    });
  }
}

const reportQuery = z.object({ propertyId: z.uuid(), from: isoDate, to: isoDate });

@Controller()
export class FinanceController {
  constructor(private readonly svc: FinanceService) {}

  @Post('reservations/:id/charges')
  @Perms('folio.post')
  postCharge(@IdParam() id: string, @ZBody(postChargeSchema) body: z.infer<typeof postChargeSchema>) {
    return this.svc.postCharge(id, body);
  }

  @Post('folio-items/:id/void')
  @Perms('folio.void')
  @HttpCode(200)
  voidCharge(@IdParam() id: string, @ZBody(voidChargeSchema) body: { reason: string }) {
    return this.svc.voidCharge(id, body.reason);
  }

  @Post('reservations/:id/payments')
  @Perms('payments.create')
  addPayment(@IdParam() id: string, @ZBody(paymentSchema) body: z.infer<typeof paymentSchema>) {
    return this.svc.addPayment(id, body);
  }

  @Get('payments')
  @Perms('reports.read')
  payments(@ZQuery(reportQuery) q: z.infer<typeof reportQuery>) {
    return this.svc.paymentsReport(q.propertyId, q.from, q.to);
  }

  @Get('invoices')
  @Perms('invoices.read')
  invoices(@ZQuery(invoiceSearchSchema) q: z.infer<typeof invoiceSearchSchema>) {
    return this.svc.listInvoices(q);
  }

  @Get('invoices/:id')
  @Perms('invoices.read')
  invoice(@IdParam() id: string) {
    return this.svc.getInvoice(id);
  }

  @Post('invoices')
  @Perms('invoices.issue')
  createInvoice(@ZBody(createInvoiceSchema) body: z.infer<typeof createInvoiceSchema>) {
    return this.svc.createInvoice(body);
  }

  @Post('invoices/:id/payments')
  @Perms('payments.create')
  payInvoice(@IdParam() id: string, @ZBody(paymentSchema) body: z.infer<typeof paymentSchema>) {
    return this.svc.payInvoice(id, body);
  }

  @Post('invoices/:id/cancel')
  @Perms('invoices.cancel')
  @HttpCode(200)
  cancelInvoice(@IdParam() id: string, @ZBody(cancelInvoiceSchema) body: { reason: string }) {
    return this.svc.cancelInvoice(id, body.reason);
  }
}

@Module({ controllers: [FinanceController], providers: [FinanceService] })
export class FinanceModule {}
