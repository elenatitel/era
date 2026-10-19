export const TENANT_STATUSES = ['active', 'suspended'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const MEMBERSHIP_STATUSES = ['active', 'disabled'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const ROOM_STATUSES = ['clean', 'dirty', 'inspected', 'out_of_order'] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

export const ROOM_OCCUPANCY = ['vacant', 'occupied'] as const;
export type RoomOccupancy = (typeof ROOM_OCCUPANCY)[number];

export const RESERVATION_STATUSES = ['tentative', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
/** Statuses that hold inventory. */
export const ACTIVE_RESERVATION_STATUSES: ReservationStatus[] = ['tentative', 'confirmed', 'checked_in'];

export const RESERVATION_SOURCES = ['direct', 'phone', 'email', 'walk_in', 'website', 'ota', 'agent', 'corporate'] as const;
export type ReservationSource = (typeof RESERVATION_SOURCES)[number];

export const GUEST_SEGMENTS = ['standard', 'vip', 'business', 'agent'] as const;
export type GuestSegment = (typeof GUEST_SEGMENTS)[number];

export const DOCUMENT_TYPES = ['id_card', 'passport', 'driving_license', 'other'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const CHARGE_CATEGORIES = ['accommodation', 'food_beverage', 'minibar', 'laundry', 'spa', 'parking', 'tourist_tax', 'other'] as const;
export type ChargeCategory = (typeof CHARGE_CATEGORIES)[number];

export const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'voucher', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const INVOICE_TYPES = ['invoice', 'proforma', 'credit_note'] as const;
export type InvoiceType = (typeof INVOICE_TYPES)[number];

export const INVOICE_STATUSES = ['issued', 'paid', 'cancelled'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const HK_TASK_TYPES = ['checkout_clean', 'stayover', 'deep_clean', 'inspection', 'turndown'] as const;
export type HousekeepingTaskType = (typeof HK_TASK_TYPES)[number];

export const HK_TASK_STATUSES = ['pending', 'in_progress', 'done', 'inspected', 'cancelled'] as const;
export type HousekeepingTaskStatus = (typeof HK_TASK_STATUSES)[number];

export const CURRENCIES = ['RON', 'EUR', 'USD', 'GBP'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const LOCALES = ['en', 'ro'] as const;
export type Locale = (typeof LOCALES)[number];

/** Error codes returned by the API in `error.code` so the UI can react precisely. */
export const ERROR_CODES = {
  MFA_REQUIRED: 'MFA_REQUIRED',
  MFA_SETUP_REQUIRED: 'MFA_SETUP_REQUIRED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TENANT_REQUIRED: 'TENANT_REQUIRED',
  TENANT_SUSPENDED: 'TENANT_SUSPENDED',
  NO_AVAILABILITY: 'NO_AVAILABILITY',
  ROOM_CONFLICT: 'ROOM_CONFLICT',
  OUTSTANDING_BALANCE: 'OUTSTANDING_BALANCE',
  INVALID_STATE: 'INVALID_STATE',
  CSRF: 'CSRF',
} as const;
