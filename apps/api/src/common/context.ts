import { AsyncLocalStorage } from 'node:async_hooks';
import { ForbiddenException } from '@nestjs/common';
import { ERROR_CODES, type Permission } from '@pms/shared';

export interface RequestContext {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  userId?: string;
  sessionId?: string;
  tenantId?: string;
  isPlatformAdmin?: boolean;
  mfaEnabled?: boolean;
  membershipId?: string;
  roleId?: string;
  roleKey?: string | null;
  /** Empty = all properties of the tenant. */
  propertyIds?: string[];
  permissions?: Set<Permission>;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function ctx(): RequestContext {
  const c = storage.getStore();
  if (!c) throw new Error('Request context is not available');
  return c;
}

export function maybeCtx(): RequestContext | undefined {
  return storage.getStore();
}

export function requireTenant(): string {
  const c = ctx();
  if (!c.tenantId) throw new ForbiddenException({ code: ERROR_CODES.TENANT_REQUIRED, message: 'Select an organization first' });
  return c.tenantId;
}

export function requireUser(): string {
  const c = ctx();
  if (!c.userId) throw new Error('No authenticated user in context');
  return c.userId;
}

export function hasPermission(permission: Permission): boolean {
  return ctx().permissions?.has(permission) ?? false;
}

/** Property-level scoping: memberships can be restricted to a subset of properties. */
export function canAccessProperty(propertyId: string): boolean {
  const ids = ctx().propertyIds;
  return !ids || ids.length === 0 || ids.includes(propertyId);
}

export function assertPropertyAccess(propertyId: string): void {
  if (!canAccessProperty(propertyId)) throw new ForbiddenException('You do not have access to this property');
}

/** null = unrestricted. */
export function allowedPropertyIds(): string[] | null {
  const ids = ctx().propertyIds;
  return ids && ids.length > 0 ? ids : null;
}
