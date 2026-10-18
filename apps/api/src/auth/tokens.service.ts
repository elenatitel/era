import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { CookieOptions, Response } from 'express';
import { jwtVerify, SignJWT } from 'jose';
import { config } from '../config.js';
import { maybeCtx } from '../common/context.js';
import { randomToken, sha256 } from '../common/crypto.js';
import { AuditService } from '../db/audit.service.js';
import { DbService } from '../db/db.service.js';
import { sessions } from '../db/schema.js';

export const ACCESS_COOKIE = 'pms_at';
export const REFRESH_COOKIE = 'pms_rt';
export const CSRF_COOKIE = 'pms_csrf';
const ISSUER = 'pms-api';
const AUDIENCE = 'pms-web';
/** Concurrent refreshes from several tabs within this window are not treated as token theft. */
const ROTATION_GRACE_MS = 20_000;

export interface AccessClaims {
  sub: string;
  sid: string;
  tid: string | null;
}

@Injectable()
export class TokensService {
  private readonly secret = new TextEncoder().encode(config().JWT_SECRET);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  // ---------- JWTs ----------
  async signAccess(claims: AccessClaims): Promise<string> {
    return new SignJWT({ sid: claims.sid, tid: claims.tid, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${config().ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.secret);
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.secret, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
    if (payload.typ !== 'access' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      throw new Error('Invalid token type');
    }
    return { sub: payload.sub, sid: payload.sid, tid: typeof payload.tid === 'string' ? payload.tid : null };
  }

  /** Short-lived token proving the password step succeeded, exchanged for a session after MFA. */
  async signMfa(userId: string): Promise<string> {
    return new SignJWT({ typ: 'mfa' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(this.secret);
  }

  async verifyMfa(token: string): Promise<string> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
      if (payload.typ !== 'mfa' || typeof payload.sub !== 'string') throw new Error('wrong type');
      return payload.sub;
    } catch {
      throw new UnauthorizedException({ code: 'MFA_EXPIRED', message: 'The sign-in attempt expired, please start again' });
    }
  }

  // ---------- cookies ----------
  private cookie(maxAgeMs: number, path = '/', httpOnly = true): CookieOptions {
    return { httpOnly, secure: config().cookieSecure, sameSite: 'strict', path, maxAge: maxAgeMs };
  }

  setCsrfCookie(res: Response, value = randomToken(24)): string {
    res.cookie(CSRF_COOKIE, value, this.cookie(config().SESSION_MAX_DAYS * 86_400_000, '/', false));
    return value;
  }

  private async writeCookies(res: Response, claims: AccessClaims, refreshToken?: string) {
    const access = await this.signAccess(claims);
    res.cookie(ACCESS_COOKIE, access, this.cookie(config().ACCESS_TOKEN_TTL_SECONDS * 1000));
    if (refreshToken) {
      res.cookie(REFRESH_COOKIE, refreshToken, this.cookie(config().SESSION_MAX_DAYS * 86_400_000, '/api/auth'));
    }
  }

  clearCookies(res: Response) {
    const base = { secure: config().cookieSecure, sameSite: 'strict' as const };
    res.clearCookie(ACCESS_COOKIE, { ...base, httpOnly: true, path: '/' });
    res.clearCookie(REFRESH_COOKIE, { ...base, httpOnly: true, path: '/api/auth' });
  }

  // ---------- sessions ----------
  async createSession(res: Response, userId: string, tenantId: string | null) {
    const refreshToken = randomToken(32);
    const c = maybeCtx();
    const [session] = await this.db.db
      .insert(sessions)
      .values({
        userId,
        tenantId,
        familyId: randomUUID(),
        refreshTokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + config().SESSION_MAX_DAYS * 86_400_000),
        ip: c?.ip ?? null,
        userAgent: c?.userAgent?.slice(0, 300) ?? null,
      })
      .returning({ id: sessions.id });
    await this.writeCookies(res, { sub: userId, sid: session!.id, tid: tenantId }, refreshToken);
    this.setCsrfCookie(res);
    return session!.id;
  }

  /** Rotates the refresh token. Re-use of a rotated token revokes the whole session family. */
  async refresh(res: Response, presented: string | undefined) {
    if (!presented) throw new UnauthorizedException({ code: 'NO_SESSION', message: 'Not signed in' });
    const hash = sha256(presented);
    const result = await this.db.db.transaction(async (tx) => {
      const [current] = await tx.select().from(sessions).where(eq(sessions.refreshTokenHash, hash)).for('update');
      if (!current) return { kind: 'invalid' as const };
      if (current.revokedAt) {
        const withinGrace =
          current.revokedReason === 'rotated' && Date.now() - current.revokedAt.getTime() < ROTATION_GRACE_MS;
        if (withinGrace) return { kind: 'race' as const };
        if (current.revokedReason === 'rotated') {
          await tx
            .update(sessions)
            .set({ revokedAt: new Date(), revokedReason: 'reuse_detected' })
            .where(and(eq(sessions.familyId, current.familyId), isNull(sessions.revokedAt)));
          return { kind: 'reuse' as const, userId: current.userId };
        }
        return { kind: 'invalid' as const };
      }
      const idleLimit = Date.now() - config().REFRESH_TOKEN_IDLE_DAYS * 86_400_000;
      if (current.expiresAt.getTime() < Date.now() || current.lastUsedAt.getTime() < idleLimit) {
        await tx.update(sessions).set({ revokedAt: new Date(), revokedReason: 'expired' }).where(eq(sessions.id, current.id));
        return { kind: 'invalid' as const };
      }
      const nextToken = randomToken(32);
      const c = maybeCtx();
      await tx.update(sessions).set({ revokedAt: new Date(), revokedReason: 'rotated' }).where(eq(sessions.id, current.id));
      const [next] = await tx
        .insert(sessions)
        .values({
          userId: current.userId,
          tenantId: current.tenantId,
          familyId: current.familyId,
          refreshTokenHash: sha256(nextToken),
          expiresAt: current.expiresAt,
          ip: c?.ip ?? null,
          userAgent: c?.userAgent?.slice(0, 300) ?? null,
        })
        .returning({ id: sessions.id });
      return { kind: 'ok' as const, nextToken, sessionId: next!.id, userId: current.userId, tenantId: current.tenantId };
    });

    if (result.kind === 'race') {
      throw new ConflictException({ code: 'REFRESH_RACE', message: 'Session was just refreshed; retry the request' });
    }
    if (result.kind === 'reuse') {
      await this.audit.security('refresh_token_reuse', { userId: result.userId });
    }
    if (result.kind !== 'ok') {
      this.clearCookies(res);
      throw new UnauthorizedException({ code: 'SESSION_EXPIRED', message: 'Session expired, please sign in again' });
    }
    await this.writeCookies(res, { sub: result.userId, sid: result.sessionId, tid: result.tenantId }, result.nextToken);
  }

  async setSessionTenant(res: Response, sessionId: string, userId: string, tenantId: string | null) {
    await this.db.db.update(sessions).set({ tenantId }).where(eq(sessions.id, sessionId));
    await this.writeCookies(res, { sub: userId, sid: sessionId, tid: tenantId });
  }

  async revokeSession(sessionId: string, reason = 'logout') {
    const [s] = await this.db.db.select({ familyId: sessions.familyId }).from(sessions).where(eq(sessions.id, sessionId));
    if (!s) return;
    await this.db.db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(sessions.familyId, s.familyId), isNull(sessions.revokedAt)));
  }

  async revokeAllForUser(userId: string, reason: string, exceptSessionId?: string) {
    await this.db.db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          exceptSessionId ? ne(sessions.id, exceptSessionId) : undefined,
        ),
      );
  }
}
