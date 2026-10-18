import type { Permission } from '@pms/shared';

export interface Me {
  user: { id: string; email: string; name: string; locale: string; mfaEnabled: boolean; isPlatformAdmin: boolean; recoveryCodesLeft: number };
  tenant: { id: string; name: string; slug: string; requireMfa: boolean; defaultLocale: string } | null;
  role: { id: string; key: string | null } | null;
  permissions: Permission[];
  propertyIds: string[];
  memberships: { tenantId: string; name: string; slug: string; status: string; requireMfa: boolean; roleName: string }[];
}

export interface Property {
  id: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  registrationNumber: string | null;
  address: string | null;
  city: string | null;
  country: string;
  phone: string | null;
  email: string | null;
  timezone: string;
  currency: string;
  checkInTime: string;
  checkOutTime: string;
  accommodationVatRate: number;
  standardVatRate: number;
  businessDate: string;
}

export interface RoomType {
  id: string;
  propertyId: string;
  name: string;
  code: string;
  description: string | null;
  baseOccupancy: number;
  maxOccupancy: number;
  baseRate: number;
  active: boolean;
}

export interface Room {
  id: string;
  number: string;
  floor: string | null;
  status: string;
  occupancy: string;
  notes: string | null;
  active: boolean;
  roomTypeId: string;
  roomTypeCode: string;
  roomTypeName: string;
}

export interface RatePlan {
  id: string;
  name: string;
  code: string;
  description: string | null;
  includesBreakfast: boolean;
  adjustmentPercent: number;
  minNights: number;
  active: boolean;
}

export interface Guest {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  nationality: string | null;
  birthDate: string | null;
  documentType: string | null;
  documentNumber: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  segment: string;
  companyId: string | null;
  companyName?: string | null;
  tags: string[];
  notes: string | null;
  marketingConsent: boolean;
  anonymizedAt: string | null;
  stays?: number;
}

export interface Company {
  id: string;
  name: string;
  taxId: string | null;
  registrationNumber: string | null;
  address: string | null;
  city: string | null;
  country: string;
  email: string | null;
  phone: string | null;
  isAgency: boolean;
  commissionPercent: number;
  notes: string | null;
}

export interface ReservationListItem {
  id: string;
  code: string;
  status: string;
  source: string;
  arrival: string;
  departure: string;
  adults: number;
  children: number;
  totalAmount: number;
  currency: string;
  guestId: string;
  guestName: string;
  guestSegment: string;
  roomNumber: string | null;
  roomTypeCode: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page?: number;
  pageSize?: number;
}

export interface FolioItem {
  id: string;
  category: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  vatRate: number;
  serviceDate: string;
  isRoomCharge: boolean;
  invoiceId: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  postedBy: string | null;
}

export interface Payment {
  id: string;
  method: string;
  amount: number;
  currency: string;
  reference: string | null;
  createdAt: string;
  reservationCode?: string | null;
  guestName?: string | null;
}

export interface ReservationDetail {
  id: string;
  code: string;
  status: string;
  source: string;
  arrival: string;
  departure: string;
  adults: number;
  children: number;
  currency: string;
  totalAmount: number;
  nightlyRates: { date: string; amount: number }[];
  notes: string | null;
  externalRef: string | null;
  cancelReason: string | null;
  createdAt: string;
  property: { id: string; name: string; businessDate: string; currency: string };
  guest: Guest | null;
  roomType: RoomType;
  ratePlan: RatePlan;
  room: Room | null;
  company: Company | null;
  folio: FolioItem[];
  payments: Payment[];
  invoices: { id: string; fullNumber: string; type: string; status: string; total: number }[];
  totals: { charges: number; payments: number; balance: number } | null;
}

export interface Party {
  name: string;
  taxId?: string | null;
  registrationNumber?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  email?: string | null;
}

export interface Invoice {
  id: string;
  type: 'invoice' | 'proforma' | 'credit_note';
  status: string;
  fullNumber: string;
  issueDate: string;
  dueDate: string;
  billTo: Party;
  seller: Party;
  subtotal: number;
  vatTotal: number;
  total: number;
  currency: string;
  notes: string | null;
  reservationId: string | null;
  propertyId: string;
  cancelReason?: string | null;
  lines?: { id: string; position: number; description: string; quantity: number; unitPrice: number; vatRate: number; net: number; vat: number; total: number }[];
}
