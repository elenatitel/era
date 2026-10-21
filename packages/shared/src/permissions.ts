/**
 * Permission catalogue. Permissions are the unit of authorization; roles are
 * just named bundles of permissions stored per tenant. Adding a permission here
 * makes it available in the role editor automatically.
 */
export const PERMISSIONS = {
  // Tenant & administration
  'tenant.settings': 'Manage organization settings and security policy',
  'users.read': 'View team members',
  'users.manage': 'Invite, edit and deactivate team members',
  'roles.manage': 'Create and edit roles',
  'audit.read': 'View the audit log',

  // Property management
  'property.read': 'View properties',
  'property.manage': 'Create and edit properties, night audit',
  'rooms.read': 'View room types and rooms',
  'rooms.manage': 'Manage room types and rooms',
  'rates.read': 'View rate plans',
  'rates.manage': 'Manage rate plans and dynamic prices',

  // Reservations & front office
  'reservations.read': 'View reservations and availability',
  'reservations.create': 'Create reservations',
  'reservations.update': 'Modify reservations',
  'reservations.cancel': 'Cancel reservations and mark no-shows',
  'frontdesk.checkin': 'Check guests in',
  'frontdesk.checkout': 'Check guests out',

  // Financial
  'folio.read': 'View guest folios',
  'folio.post': 'Post charges to folios',
  'folio.void': 'Void folio charges',
  'payments.create': 'Record payments',
  'payments.refund': 'Record refunds',
  'invoices.read': 'View invoices and proformas',
  'invoices.issue': 'Issue invoices and proformas',
  'invoices.cancel': 'Cancel invoices (credit notes)',
  'reports.read': 'View dashboards and financial reports',

  // Housekeeping
  'housekeeping.read': 'View room status and tasks',
  'housekeeping.update': 'Update own tasks and room cleaning status',
  'housekeeping.manage': 'Assign tasks, inspect rooms, set out-of-order',

  // Guests / CRM
  'guests.read': 'View guest profiles',
  'guests.manage': 'Create and edit guest profiles and companies',
  'guests.pii': 'View identity document data',
  'guests.gdpr': 'Export and anonymize guest data (GDPR)',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(value: string): value is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

export const PERMISSION_GROUPS: Record<string, Permission[]> = {
  administration: ['tenant.settings', 'users.read', 'users.manage', 'roles.manage', 'audit.read'],
  property: ['property.read', 'property.manage', 'rooms.read', 'rooms.manage', 'rates.read', 'rates.manage'],
  frontOffice: [
    'reservations.read',
    'reservations.create',
    'reservations.update',
    'reservations.cancel',
    'frontdesk.checkin',
    'frontdesk.checkout',
  ],
  financial: [
    'folio.read',
    'folio.post',
    'folio.void',
    'payments.create',
    'payments.refund',
    'invoices.read',
    'invoices.issue',
    'invoices.cancel',
    'reports.read',
  ],
  housekeeping: ['housekeeping.read', 'housekeeping.update', 'housekeeping.manage'],
  guests: ['guests.read', 'guests.manage', 'guests.pii', 'guests.gdpr'],
};

export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
  /** System roles cannot be edited or deleted. */
  system?: boolean;
}

const read: Permission[] = ['property.read', 'rooms.read', 'rates.read', 'reservations.read', 'guests.read'];

/** Roles created for every new tenant. Tenants may add custom roles afterwards. */
export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full access to the organization, including security settings.',
    permissions: ALL_PERMISSIONS,
    system: true,
  },
  {
    key: 'manager',
    name: 'Property Manager',
    description: 'Runs day-to-day hotel operations and the team.',
    permissions: ALL_PERMISSIONS.filter((p) => p !== 'tenant.settings' && p !== 'roles.manage'),
  },
  {
    key: 'front_desk',
    name: 'Front Desk',
    description: 'Reservations, check-in/out, folios and payments.',
    permissions: [
      ...read,
      'reservations.create',
      'reservations.update',
      'reservations.cancel',
      'frontdesk.checkin',
      'frontdesk.checkout',
      'folio.read',
      'folio.post',
      'payments.create',
      'invoices.read',
      'invoices.issue',
      'housekeeping.read',
      'guests.manage',
      'guests.pii',
    ],
  },
  {
    key: 'housekeeping_supervisor',
    name: 'Housekeeping Supervisor',
    description: 'Organizes housekeeping staff and inspects rooms.',
    permissions: ['property.read', 'rooms.read', 'reservations.read', 'housekeeping.read', 'housekeeping.update', 'housekeeping.manage', 'users.read'],
  },
  {
    key: 'housekeeper',
    name: 'Housekeeper',
    description: 'Sees and completes assigned cleaning tasks.',
    permissions: ['property.read', 'rooms.read', 'housekeeping.read', 'housekeeping.update'],
  },
  {
    key: 'revenue_manager',
    name: 'Revenue Manager',
    description: 'Manages rates, availability and reporting.',
    permissions: [...read, 'rates.manage', 'reports.read', 'invoices.read', 'folio.read'],
  },
  {
    key: 'accountant',
    name: 'Accountant',
    description: 'Invoices, payments and financial reporting.',
    permissions: [
      ...read,
      'folio.read',
      'folio.void',
      'payments.create',
      'payments.refund',
      'invoices.read',
      'invoices.issue',
      'invoices.cancel',
      'reports.read',
      'guests.manage',
    ],
  },
];
