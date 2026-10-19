import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@pms/shared';

export const IS_PUBLIC = 'isPublic';
export const PERMISSIONS_KEY = 'permissions';
export const TENANT_KEY = 'tenantRequired';
export const PLATFORM_ADMIN_KEY = 'platformAdmin';

/** No authentication required. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Requires an active tenant and ALL listed permissions. */
export const Perms = (...permissions: Permission[]) => SetMetadata(PERMISSIONS_KEY, permissions);
/** Requires an active tenant, no specific permission. */
export const TenantScoped = () => SetMetadata(TENANT_KEY, true);
/** Platform operators only (must have MFA enabled). */
export const PlatformAdmin = () => SetMetadata(PLATFORM_ADMIN_KEY, true);

export const SKIP_CSRF = 'skipCsrf';
/** For machine-to-machine callbacks that authenticate by signature (Stripe webhooks). */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF, true);
