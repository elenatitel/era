import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { ERROR_CODES, type Permission } from '@pms/shared';
import { ctx } from '../common/context.js';
import { DbService } from '../db/db.service.js';
import { sessions, users } from '../db/schema.js';
import { AuthService } from './auth.service.js';
import { IS_PUBLIC, PERMISSIONS_KEY, PLATFORM_ADMIN_KEY, TENANT_KEY } from './decorators.js';
import { ACCESS_COOKIE, TokensService } from './tokens.service.js';

/**
 * Global guard: authenticates every request (unless @Public) and enforces
 * tenant membership, permissions and platform-admin requirements.
 * Deny-by-default: a route needs an explicit @Public to be reachable anonymously.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
    private readonly auth: AuthService,
    private readonly db: DbService,
  ) {}

  private meta<T>(key: string, context: ExecutionContext): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [context.getHandler(), context.getClass()]);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.meta<boolean>(IS_PUBLIC, context)) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const token = req.cookies?.[ACCESS_COOKIE] as string | undefined;
    if (!token) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Not signed in' });

    let claims;
    try {
      claims = await this.tokens.verifyAccess(token);
    } catch {
      throw new UnauthorizedException({ code: 'TOKEN_EXPIRED', message: 'Session token expired' });
    }

    const [row] = await this.db.db
      .select({
        revokedAt: sessions.revokedAt,
        expiresAt: sessions.expiresAt,
        userId: users.id,
        isPlatformAdmin: users.isPlatformAdmin,
        mfaEnabled: users.mfaEnabled,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, claims.sid));
    if (!row || row.revokedAt || row.expiresAt < new Date() || row.userId !== claims.sub) {
      throw new UnauthorizedException({ code: 'SESSION_REVOKED', message: 'Session is no longer valid' });
    }

    const c = ctx();
    c.userId = row.userId;
    c.sessionId = claims.sid;
    c.isPlatformAdmin = row.isPlatformAdmin;
    c.mfaEnabled = row.mfaEnabled;

    if (claims.tid) {
      const m = await this.auth.resolveMembership(row.userId, claims.tid);
      if (m && m.status === 'active' && m.tenantStatus === 'active' && (!m.requireMfa || row.mfaEnabled)) {
        c.tenantId = claims.tid;
        c.membershipId = m.membershipId;
        c.roleId = m.roleId;
        c.roleKey = m.roleKey;
        c.propertyIds = m.propertyIds;
        c.permissions = m.permissions;
      } else if (m?.tenantStatus === 'suspended') {
        throw new ForbiddenException({ code: ERROR_CODES.TENANT_SUSPENDED, message: 'This organization is suspended' });
      }
    }

    if (this.meta<boolean>(PLATFORM_ADMIN_KEY, context)) {
      if (!row.isPlatformAdmin) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Platform administrators only' });
      if (!row.mfaEnabled) {
        throw new ForbiddenException({
          code: ERROR_CODES.MFA_SETUP_REQUIRED,
          message: 'Platform administrators must enable two-factor authentication',
        });
      }
      return true;
    }

    const required = this.meta<Permission[]>(PERMISSIONS_KEY, context);
    const tenantRequired = this.meta<boolean>(TENANT_KEY, context) || (required && required.length > 0);
    if (tenantRequired && !c.tenantId) {
      throw new ForbiddenException({ code: ERROR_CODES.TENANT_REQUIRED, message: 'Select an organization first' });
    }
    if (required?.length) {
      const missing = required.filter((p) => !c.permissions!.has(p));
      if (missing.length) {
        throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You do not have permission to perform this action', details: { missing } });
      }
    }
    return true;
  }
}
