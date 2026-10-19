import { z } from 'zod';
import {
  CHARGE_CATEGORIES,
  CURRENCIES,
  DOCUMENT_TYPES,
  GUEST_SEGMENTS,
  HK_TASK_STATUSES,
  HK_TASK_TYPES,
  LOCALES,
  PAYMENT_METHODS,
  RESERVATION_SOURCES,
  RESERVATION_STATUSES,
  ROOM_STATUSES,
} from './enums.js';
import { ALL_PERMISSIONS } from './permissions.js';

// ---------- primitives ----------
const trimmed = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const id = z.uuid();
export const isoDate = z.iso.date();
/** Money is always an integer amount of minor units (bani / cents). */
export const money = z.int().min(0).max(1_000_000_000);
export const signedMoney = z.int().min(-1_000_000_000).max(1_000_000_000);
/** VAT in basis points: 2100 = 21%. */
export const vatRate = z.int().min(0).max(10_000);
export const email = z.email().max(254).transform((v) => v.toLowerCase());
export const password = z
  .string()
  .min(12, 'Password must have at least 12 characters')
  .max(128)
  .refine((v) => /[a-zA-Z]/.test(v) && /[0-9\W_]/.test(v), 'Password must mix letters with digits or symbols');
export const totpCode = z.string().regex(/^\d{6}$|^[a-z0-9]{5}-[a-z0-9]{5}$/i, 'Invalid code');
export const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/, 'Use 3-48 lowercase letters, digits or dashes');

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

// ---------- auth ----------
export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
export const mfaLoginSchema = z.object({ mfaToken: z.string().min(10).max(2048), code: totpCode });
export const switchTenantSchema = z.object({ tenantId: id });
export const forgotPasswordSchema = z.object({ email });
export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password });
export const acceptInvitationSchema = z.object({
  token: z.string().min(20).max(200),
  name: trimmed(120).optional(),
  password: password.optional(),
});
export const mfaEnableSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
export const mfaDisableSchema = z.object({ password: z.string().min(1).max(128), code: totpCode });
export const updateProfileSchema = z.object({ name: trimmed(120).optional(), locale: z.enum(LOCALES).optional() });

// ---------- platform ----------
export const createTenantSchema = z.object({
  name: trimmed(160),
  slug,
  ownerEmail: email,
  ownerName: trimmed(120),
  locale: z.enum(LOCALES).default('en'),
});
export const updateTenantStatusSchema = z.object({ status: z.enum(['active', 'suspended']) });

// ---------- tenant settings, users, roles ----------
export const updateTenantSettingsSchema = z.object({
  name: trimmed(160).optional(),
  requireMfa: z.boolean().optional(),
  defaultLocale: z.enum(LOCALES).optional(),
});
export const inviteUserSchema = z.object({
  email,
  roleId: id,
  /** Empty array = access to all properties. */
  propertyIds: z.array(id).max(500).default([]),
});
export const updateMembershipSchema = z.object({
  roleId: id.optional(),
  propertyIds: z.array(id).max(500).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export const roleSchema = z.object({
  name: trimmed(80),
  description: optionalText(300),
  permissions: z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])).max(200),
});

// ---------- property ----------
export const propertySchema = z.object({
  name: trimmed(160),
  legalName: optionalText(200),
  taxId: optionalText(40),
  registrationNumber: optionalText(60),
  address: optionalText(300),
  city: optionalText(120),
  country: z.string().length(2).toUpperCase().default('RO'),
  phone: optionalText(40),
  email: email.optional().nullable(),
  timezone: z.string().min(1).max(64).default('Europe/Bucharest'),
  currency: z.enum(CURRENCIES).default('RON'),
  checkInTime: z.string().regex(/^\d{2}:\d{2}$/).default('14:00'),
  checkOutTime: z.string().regex(/^\d{2}:\d{2}$/).default('12:00'),
  accommodationVatRate: vatRate.default(1100),
  standardVatRate: vatRate.default(2100),
  invoicePrefix: z.string().trim().regex(/^[A-Z0-9-]{1,12}$/).default('INV'),
  proformaPrefix: z.string().trim().regex(/^[A-Z0-9-]{1,12}$/).default('PRO'),
});
export const updatePropertySchema = propertySchema.partial();

export const roomTypeSchema = z.object({
  propertyId: id,
  name: trimmed(120),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,12}$/),
  description: optionalText(1000),
  baseOccupancy: z.int().min(1).max(20).default(2),
  maxOccupancy: z.int().min(1).max(20).default(2),
  baseRate: money,
});
export const updateRoomTypeSchema = roomTypeSchema.omit({ propertyId: true }).partial();

export const roomSchema = z.object({
  propertyId: id,
  roomTypeId: id,
  number: z.string().trim().min(1).max(12),
  floor: z.string().trim().max(12).optional().nullable(),
  notes: optionalText(500),
});
export const updateRoomSchema = roomSchema.omit({ propertyId: true }).partial();
export const roomStatusSchema = z.object({
  status: z.enum(ROOM_STATUSES),
  reason: optionalText(300),
});

export const ratePlanSchema = z.object({
  propertyId: id,
  name: trimmed(120),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,16}$/),
  description: optionalText(500),
  includesBreakfast: z.boolean().default(false),
  /** Percent adjustment against the room type base rate, e.g. -10 = 10% off. */
  adjustmentPercent: z.number().min(-90).max(500).default(0),
  minNights: z.int().min(1).max(60).default(1),
  active: z.boolean().default(true),
});
export const updateRatePlanSchema = ratePlanSchema.omit({ propertyId: true }).partial();
export const rateOverridesSchema = z.object({
  roomTypeId: id,
  ratePlanId: id.optional().nullable(),
  from: isoDate,
  to: isoDate,
  /** Weekday filter (0=Sunday). Empty = every day. */
  weekdays: z.array(z.int().min(0).max(6)).max(7).default([]),
  price: money.nullable(),
  closed: z.boolean().default(false),
});

// ---------- guests ----------
export const guestSchema = z.object({
  firstName: trimmed(80),
  lastName: trimmed(80),
  email: email.optional().nullable(),
  phone: optionalText(40),
  nationality: z.string().length(2).toUpperCase().optional().nullable(),
  birthDate: isoDate.optional().nullable(),
  documentType: z.enum(DOCUMENT_TYPES).optional().nullable(),
  documentNumber: optionalText(40),
  address: optionalText(300),
  city: optionalText(120),
  country: z.string().length(2).toUpperCase().optional().nullable(),
  segment: z.enum(GUEST_SEGMENTS).default('standard'),
  companyId: id.optional().nullable(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  notes: optionalText(2000),
  marketingConsent: z.boolean().default(false),
});
export const updateGuestSchema = guestSchema.partial();
export const guestSearchSchema = pagination.extend({
  q: z.string().trim().max(100).optional(),
  segment: z.enum(GUEST_SEGMENTS).optional(),
});

export const companySchema = z.object({
  name: trimmed(200),
  taxId: optionalText(40),
  registrationNumber: optionalText(60),
  address: optionalText(300),
  city: optionalText(120),
  country: z.string().length(2).toUpperCase().default('RO'),
  email: email.optional().nullable(),
  phone: optionalText(40),
  isAgency: z.boolean().default(false),
  commissionPercent: z.number().min(0).max(100).default(0),
  notes: optionalText(2000),
});
export const updateCompanySchema = companySchema.partial();

// ---------- reservations ----------
export const availabilitySchema = z.object({
  propertyId: id,
  arrival: isoDate,
  departure: isoDate,
  adults: z.coerce.number().int().min(1).max(20).default(1),
});

export const createReservationSchema = z
  .object({
    propertyId: id,
    roomTypeId: id,
    ratePlanId: id,
    roomId: id.optional().nullable(),
    arrival: isoDate,
    departure: isoDate,
    adults: z.int().min(1).max(20),
    children: z.int().min(0).max(20).default(0),
    guestId: id.optional(),
    guest: guestSchema.optional(),
    companyId: id.optional().nullable(),
    source: z.enum(RESERVATION_SOURCES).default('direct'),
    status: z.enum(['tentative', 'confirmed']).default('confirmed'),
    /** Optional negotiated total that overrides calculated rates (requires rates.manage). */
    totalOverride: money.optional().nullable(),
    externalRef: optionalText(80),
    notes: optionalText(2000),
  })
  .refine((v) => v.departure > v.arrival, { message: 'Departure must be after arrival', path: ['departure'] })
  .refine((v) => Boolean(v.guestId) !== Boolean(v.guest), { message: 'Provide either guestId or guest', path: ['guestId'] });

export const updateReservationSchema = z.object({
  roomId: id.optional().nullable(),
  adults: z.int().min(1).max(20).optional(),
  children: z.int().min(0).max(20).optional(),
  companyId: id.optional().nullable(),
  notes: optionalText(2000),
  status: z.enum(['tentative', 'confirmed']).optional(),
});
export const cancelReservationSchema = z.object({ reason: optionalText(500) });
export const checkInSchema = z.object({ roomId: id, allowDirtyRoom: z.boolean().default(false) });
export const checkOutSchema = z.object({ allowOpenBalance: z.boolean().default(false) });
export const reservationSearchSchema = pagination.extend({
  propertyId: id.optional(),
  status: z.enum(RESERVATION_STATUSES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().trim().max(100).optional(),
});
export const calendarSchema = z.object({ propertyId: id, from: isoDate, to: isoDate });

// ---------- folio, payments, invoices ----------
export const postChargeSchema = z.object({
  category: z.enum(CHARGE_CATEGORIES),
  description: trimmed(200),
  quantity: z.int().min(1).max(1000).default(1),
  unitPrice: money,
  vatRate: vatRate.optional(),
  serviceDate: isoDate.optional(),
});
export const voidChargeSchema = z.object({ reason: trimmed(300) });
export const paymentSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amount: signedMoney.refine((v) => v !== 0, 'Amount cannot be zero'),
  reference: optionalText(120),
  notes: optionalText(300),
});
const invoiceLineSchema = z.object({
  description: trimmed(200),
  quantity: z.int().min(1).max(100000),
  unitPrice: money,
  vatRate,
});
export const createInvoiceSchema = z
  .object({
    propertyId: id,
    type: z.enum(['invoice', 'proforma']),
    reservationId: id.optional().nullable(),
    guestId: id.optional().nullable(),
    companyId: id.optional().nullable(),
    /** Manual lines; when a reservation is provided, its uninvoiced folio charges are used instead. */
    lines: z.array(invoiceLineSchema).max(200).optional(),
    dueDays: z.int().min(0).max(365).default(0),
    notes: optionalText(1000),
  })
  .refine((v) => v.reservationId || (v.lines && v.lines.length > 0), {
    message: 'Provide a reservation or invoice lines',
    path: ['lines'],
  })
  .refine((v) => v.reservationId || v.guestId || v.companyId, {
    message: 'Provide a guest or company to bill',
    path: ['guestId'],
  });
export const cancelInvoiceSchema = z.object({ reason: trimmed(300) });
export const invoiceSearchSchema = pagination.extend({
  propertyId: id.optional(),
  type: z.enum(['invoice', 'proforma', 'credit_note']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

// ---------- housekeeping ----------
export const hkTaskSchema = z.object({
  propertyId: id,
  roomId: id,
  type: z.enum(HK_TASK_TYPES),
  date: isoDate,
  assignedToUserId: id.optional().nullable(),
  priority: z.int().min(0).max(2).default(0),
  notes: optionalText(500),
});
export const updateHkTaskSchema = z.object({
  status: z.enum(HK_TASK_STATUSES).optional(),
  assignedToUserId: id.optional().nullable(),
  notes: optionalText(500),
  priority: z.int().min(0).max(2).optional(),
});
export const hkGenerateSchema = z.object({ propertyId: id, date: isoDate });
export const hkTaskSearchSchema = z.object({
  propertyId: id,
  date: isoDate.optional(),
  assignedToMe: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  status: z.enum(HK_TASK_STATUSES).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateReservationInput = z.infer<typeof createReservationSchema>;
export type GuestInput = z.infer<typeof guestSchema>;
export type PropertyInput = z.infer<typeof propertySchema>;

// ---------- guest journey (public booking engine, guest portal) ----------
export const bookingSiteSchema = z.object({
  slug,
  enabled: z.boolean(),
  stripePublishableKey: z
    .string()
    .trim()
    .regex(/^pk_(test|live)_[A-Za-z0-9]+$/, 'Use the publishable key from Stripe (pk_test_… or pk_live_…)')
    .nullable()
    .optional(),
  /** Write-only: omit to keep the stored value, null to remove it. */
  stripeSecretKey: z
    .string()
    .trim()
    .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, 'Use a secret or restricted key from Stripe (sk_… or rk_…)')
    .nullable()
    .optional(),
  stripeWebhookSecret: z
    .string()
    .trim()
    .regex(/^whsec_[A-Za-z0-9]+$/, 'Use the webhook signing secret from Stripe (whsec_…)')
    .nullable()
    .optional(),
});

export const publicAvailabilitySchema = z
  .object({
    arrival: isoDate,
    departure: isoDate,
    adults: z.coerce.number().int().min(1).max(20).default(2),
    children: z.coerce.number().int().min(0).max(20).default(0),
  })
  .refine((v) => v.departure > v.arrival, { message: 'Departure must be after arrival', path: ['departure'] });

export const publicBookingSchema = z
  .object({
    roomTypeId: id,
    ratePlanId: id,
    arrival: isoDate,
    departure: isoDate,
    adults: z.int().min(1).max(20),
    children: z.int().min(0).max(20).default(0),
    guest: z.object({
      firstName: trimmed(80),
      lastName: trimmed(80),
      email,
      phone: optionalText(40),
    }),
    estimatedArrival: optionalText(40),
    requests: optionalText(1000),
    acceptTerms: z.literal(true, { error: 'Please accept the booking terms' }),
    locale: z.enum(LOCALES).default('en'),
  })
  .refine((v) => v.departure > v.arrival, { message: 'Departure must be after arrival', path: ['departure'] });

export const guestCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') });

const travellerDocument = {
  birthDate: isoDate.optional().nullable(),
  nationality: z.string().length(2).toUpperCase().optional().nullable(),
  documentType: z.enum(DOCUMENT_TYPES).optional().nullable(),
  documentNumber: optionalText(40),
};

export const onlineCheckinSchema = z.object({
  mainGuest: z.object({
    ...travellerDocument,
    birthDate: isoDate,
    nationality: z.string().length(2).toUpperCase(),
    documentType: z.enum(DOCUMENT_TYPES),
    documentNumber: trimmed(40),
    address: optionalText(300),
    country: z.string().length(2).toUpperCase().optional().nullable(),
  }),
  companions: z
    .array(z.object({ firstName: trimmed(80), lastName: trimmed(80), ...travellerDocument }))
    .max(19)
    .default([]),
  estimatedArrival: optionalText(40),
  requests: optionalText(1000),
  marketingConsent: z.boolean().default(false),
  confirm: z.literal(true, { error: 'Please confirm that the details are correct' }),
});
