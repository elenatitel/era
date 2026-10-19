/**
 * Database schema.
 *
 * Global tables (no tenant_id): tenants, users, sessions, password_reset_tokens,
 * invitations, security_events.
 *
 * Every other table is tenant-owned: it has a tenant_id column and is protected by
 * PostgreSQL Row-Level Security (see drizzle/0001_rls.sql). The application connects
 * with a role that cannot bypass RLS and sets `app.tenant_id` per transaction, so a
 * missing WHERE clause can never leak data across tenants.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const pk = () => uuid().primaryKey().default(sql`gen_random_uuid()`);
const tenantId = () => uuid().notNull().references(() => tenants.id, { onDelete: 'cascade' });
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const money = () => bigint({ mode: 'number' }).notNull().default(0);

// ============================================================ global

export const tenants = pgTable('tenants', {
  id: pk(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  status: text().notNull().default('active'),
  requireMfa: boolean().notNull().default(false),
  defaultLocale: text().notNull().default('en'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable(
  'users',
  {
    id: pk(),
    email: text().notNull(),
    name: text().notNull(),
    passwordHash: text(),
    locale: text().notNull().default('en'),
    isPlatformAdmin: boolean().notNull().default(false),
    mfaEnabled: boolean().notNull().default(false),
    mfaSecretEnc: text(),
    mfaRecoveryCodes: jsonb().$type<string[]>().notNull().default([]),
    /** Last accepted TOTP time-step, to reject code replays. */
    mfaLastCounter: integer().notNull().default(0),
    failedLoginCount: integer().notNull().default(0),
    lockedUntil: timestamp({ withTimezone: true }),
    lastLoginAt: timestamp({ withTimezone: true }),
    passwordChangedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_unique').on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid().references(() => tenants.id, { onDelete: 'set null' }),
    familyId: uuid().notNull(),
    refreshTokenHash: text().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    revokedReason: text(),
    ip: text(),
    userAgent: text(),
    createdAt: createdAt(),
    lastUsedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId), index().on(t.familyId)],
);

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: pk(),
  userId: uuid()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text().notNull().unique(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  usedAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
});

/** Looked up by token hash before any tenant context exists, so it is not RLS-protected. */
export const invitations = pgTable(
  'invitations',
  {
    id: pk(),
    tenantId: tenantId(),
    email: text().notNull(),
    roleId: uuid().notNull(),
    propertyIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    tokenHash: text().notNull().unique(),
    invitedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    acceptedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.tenantId)],
);

/** Authentication events (logins, lockouts, MFA changes) for security monitoring. */
export const securityEvents = pgTable(
  'security_events',
  {
    id: pk(),
    userId: uuid(),
    tenantId: uuid(),
    type: text().notNull(),
    ip: text(),
    userAgent: text(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.userId, t.createdAt), index().on(t.createdAt)],
);

// ============================================================ tenant-owned

export const roles = pgTable(
  'roles',
  {
    id: pk(),
    tenantId: tenantId(),
    key: text(),
    name: text().notNull(),
    description: text(),
    permissions: text().array().notNull().default(sql`'{}'::text[]`),
    system: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.tenantId, t.name)],
);

export const memberships = pgTable(
  'memberships',
  {
    id: pk(),
    tenantId: tenantId(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid()
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    /** Empty = access to every property of the tenant. */
    propertyIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    status: text().notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.tenantId, t.userId), index().on(t.userId)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: pk(),
    tenantId: tenantId(),
    userId: uuid(),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: uuid(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ip: text(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.tenantId, t.createdAt), index().on(t.entityType, t.entityId)],
);

export const properties = pgTable('properties', {
  id: pk(),
  tenantId: tenantId(),
  name: text().notNull(),
  legalName: text(),
  taxId: text(),
  registrationNumber: text(),
  address: text(),
  city: text(),
  country: text().notNull().default('RO'),
  phone: text(),
  email: text(),
  timezone: text().notNull().default('Europe/Bucharest'),
  currency: text().notNull().default('RON'),
  checkInTime: text().notNull().default('14:00'),
  checkOutTime: text().notNull().default('12:00'),
  accommodationVatRate: integer().notNull().default(1100),
  standardVatRate: integer().notNull().default(2100),
  /** Hotel business date; advanced by the night audit. */
  businessDate: date().notNull().default(sql`CURRENT_DATE`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Gapless numbering for fiscal documents, per property and document type. */
export const documentSeries = pgTable(
  'document_series',
  {
    id: pk(),
    tenantId: tenantId(),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    prefix: text().notNull(),
    nextNumber: integer().notNull().default(1),
  },
  (t) => [uniqueIndex().on(t.propertyId, t.type)],
);

export const roomTypes = pgTable(
  'room_types',
  {
    id: pk(),
    tenantId: tenantId(),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    code: text().notNull(),
    description: text(),
    baseOccupancy: smallint().notNull().default(2),
    maxOccupancy: smallint().notNull().default(2),
    baseRate: money(),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.propertyId, t.code)],
);

export const rooms = pgTable(
  'rooms',
  {
    id: pk(),
    tenantId: tenantId(),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    roomTypeId: uuid()
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'restrict' }),
    number: text().notNull(),
    floor: text(),
    status: text().notNull().default('clean'),
    occupancy: text().notNull().default('vacant'),
    notes: text(),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.propertyId, t.number), index().on(t.roomTypeId)],
);

export const ratePlans = pgTable(
  'rate_plans',
  {
    id: pk(),
    tenantId: tenantId(),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    code: text().notNull(),
    description: text(),
    includesBreakfast: boolean().notNull().default(false),
    adjustmentPercent: doublePrecision().notNull().default(0),
    minNights: smallint().notNull().default(1),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex().on(t.propertyId, t.code)],
);

/** Date-specific prices (dynamic pricing) and stop-sell for a room type, optionally per rate plan. */
export const rateOverrides = pgTable(
  'rate_overrides',
  {
    id: pk(),
    tenantId: tenantId(),
    roomTypeId: uuid()
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'cascade' }),
    ratePlanId: uuid().references(() => ratePlans.id, { onDelete: 'cascade' }),
    date: date().notNull(),
    price: bigint({ mode: 'number' }),
    closed: boolean().notNull().default(false),
  },
  (t) => [unique().on(t.roomTypeId, t.ratePlanId, t.date).nullsNotDistinct()],
);

export const companies = pgTable(
  'companies',
  {
    id: pk(),
    tenantId: tenantId(),
    name: text().notNull(),
    taxId: text(),
    registrationNumber: text(),
    address: text(),
    city: text(),
    country: text().notNull().default('RO'),
    email: text(),
    phone: text(),
    isAgency: boolean().notNull().default(false),
    commissionPercent: doublePrecision().notNull().default(0),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.tenantId, t.name)],
);

export const guests = pgTable(
  'guests',
  {
    id: pk(),
    tenantId: tenantId(),
    firstName: text().notNull(),
    lastName: text().notNull(),
    email: text(),
    phone: text(),
    nationality: text(),
    birthDate: date(),
    documentType: text(),
    /** AES-256-GCM encrypted at the application layer. */
    documentNumberEnc: text(),
    address: text(),
    city: text(),
    country: text(),
    segment: text().notNull().default('standard'),
    companyId: uuid().references(() => companies.id, { onDelete: 'set null' }),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    notes: text(),
    marketingConsent: boolean().notNull().default(false),
    anonymizedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index().on(t.tenantId, t.lastName), index().on(t.tenantId, t.email)],
);

export interface NightlyRate {
  date: string;
  amount: number;
}

export const reservations = pgTable(
  'reservations',
  {
    id: pk(),
    tenantId: tenantId(),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    code: text().notNull(),
    guestId: uuid()
      .notNull()
      .references(() => guests.id, { onDelete: 'restrict' }),
    companyId: uuid().references(() => companies.id, { onDelete: 'set null' }),
    roomTypeId: uuid()
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'restrict' }),
    roomId: uuid().references(() => rooms.id, { onDelete: 'set null' }),
    ratePlanId: uuid()
      .notNull()
      .references(() => ratePlans.id, { onDelete: 'restrict' }),
    status: text().notNull().default('confirmed'),
    source: text().notNull().default('direct'),
    arrival: date().notNull(),
    departure: date().notNull(),
    adults: smallint().notNull().default(1),
    children: smallint().notNull().default(0),
    currency: text().notNull().default('RON'),
    totalAmount: money(),
    nightlyRates: jsonb().$type<NightlyRate[]>().notNull().default([]),
    externalRef: text(),
    notes: text(),
    cancelReason: text(),
    cancelledAt: timestamp({ withTimezone: true }),
    checkedInAt: timestamp({ withTimezone: true }),
    checkedOutAt: timestamp({ withTimezone: true }),
    createdById: uuid(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex().on(t.tenantId, t.code),
    index().on(t.propertyId, t.arrival),
    index().on(t.propertyId, t.departure),
    index().on(t.roomTypeId, t.arrival, t.departure),
    index().on(t.guestId),
  ],
);

export const folioItems = pgTable(
  'folio_items',
  {
    id: pk(),
    tenantId: tenantId(),
    reservationId: uuid()
      .notNull()
      .references(() => reservations.id, { onDelete: 'cascade' }),
    category: text().notNull(),
    description: text().notNull(),
    quantity: integer().notNull().default(1),
    unitPrice: money(),
    amount: money(),
    vatRate: integer().notNull(),
    serviceDate: date().notNull(),
    isRoomCharge: boolean().notNull().default(false),
    invoiceId: uuid(),
    voidedAt: timestamp({ withTimezone: true }),
    voidReason: text(),
    voidedById: uuid(),
    postedById: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.reservationId),
    uniqueIndex('folio_room_charge_once')
      .on(t.reservationId, t.serviceDate)
      .where(sql`${t.isRoomCharge} AND ${t.voidedAt} IS NULL`),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: pk(),
    tenantId: tenantId(),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    reservationId: uuid().references(() => reservations.id, { onDelete: 'set null' }),
    invoiceId: uuid(),
    method: text().notNull(),
    /** Positive = received, negative = refund. */
    amount: bigint({ mode: 'number' }).notNull(),
    currency: text().notNull(),
    reference: text(),
    notes: text(),
    receivedById: uuid(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.reservationId), index().on(t.propertyId, t.createdAt)],
);

export interface PartySnapshot {
  name: string;
  taxId?: string | null;
  registrationNumber?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  email?: string | null;
}

export const invoices = pgTable(
  'invoices',
  {
    id: pk(),
    tenantId: tenantId(),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    type: text().notNull(),
    status: text().notNull().default('issued'),
    series: text().notNull(),
    number: integer().notNull(),
    fullNumber: text().notNull(),
    reservationId: uuid().references(() => reservations.id, { onDelete: 'set null' }),
    guestId: uuid().references(() => guests.id, { onDelete: 'set null' }),
    companyId: uuid().references(() => companies.id, { onDelete: 'set null' }),
    /** Immutable snapshots: fiscal documents must not change when profiles change. */
    seller: jsonb().$type<PartySnapshot>().notNull(),
    billTo: jsonb().$type<PartySnapshot>().notNull(),
    issueDate: date().notNull(),
    dueDate: date().notNull(),
    currency: text().notNull(),
    subtotal: money(),
    vatTotal: money(),
    total: money(),
    notes: text(),
    correctsInvoiceId: uuid(),
    cancelReason: text(),
    cancelledAt: timestamp({ withTimezone: true }),
    createdById: uuid(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex().on(t.propertyId, t.type, t.series, t.number), index().on(t.tenantId, t.issueDate)],
);

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: pk(),
    tenantId: tenantId(),
    invoiceId: uuid()
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    position: smallint().notNull(),
    description: text().notNull(),
    quantity: integer().notNull(),
    unitPrice: bigint({ mode: 'number' }).notNull(),
    vatRate: integer().notNull(),
    net: bigint({ mode: 'number' }).notNull(),
    vat: bigint({ mode: 'number' }).notNull(),
    total: bigint({ mode: 'number' }).notNull(),
    folioItemId: uuid(),
  },
  (t) => [index().on(t.invoiceId)],
);

export const housekeepingTasks = pgTable(
  'housekeeping_tasks',
  {
    id: pk(),
    tenantId: tenantId(),
    propertyId: uuid()
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    roomId: uuid()
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    status: text().notNull().default('pending'),
    date: date().notNull(),
    assignedToUserId: uuid(),
    priority: smallint().notNull().default(0),
    notes: text(),
    startedAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
    inspectedAt: timestamp({ withTimezone: true }),
    inspectedById: uuid(),
    createdById: uuid(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index().on(t.propertyId, t.date),
    index().on(t.assignedToUserId, t.date),
    uniqueIndex('hk_task_once_per_day')
      .on(t.roomId, t.date, t.type)
      .where(sql`${t.status} <> 'cancelled'`),
  ],
);

/** Tables protected by RLS. Keep in sync with drizzle/0001_rls.sql (verified by tests). */
export const TENANT_TABLES = [
  'roles',
  'memberships',
  'audit_logs',
  'properties',
  'document_series',
  'room_types',
  'rooms',
  'rate_plans',
  'rate_overrides',
  'companies',
  'guests',
  'reservations',
  'folio_items',
  'payments',
  'invoices',
  'invoice_lines',
  'housekeeping_tasks',
] as const;
