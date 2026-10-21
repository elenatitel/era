import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import argon2 from 'argon2';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Response } from 'express';
import QRCode from 'qrcode';
import { ERROR_CODES, type Permission, isPermission } from '@pms/shared';
import { config } from '../config.js';
import { ctx, requireUser } from '../common/context.js';
import { decrypt, encrypt, randomToken, sha256 } from '../common/crypto.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../common/totp.js';
import { AuditService } from '../db/audit.service.js';
import { DbService } from '../db/db.service.js';
import { invitations, memberships, passwordResetTokens, roles, tenants, users } from '../db/schema.js';
import { MailService } from '../mail/mail.service.js';
import { TokensService } from './tokens.service.js';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const RESET_TTL_MS = 60 * 60 * 1000;
export const ARGON_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string) => argon2.hash(password, ARGON_OPTIONS);

type User = typeof users.$inferSelect;

@Injectable()
export class AuthService {
  /** Used to keep response timing identical whether or not the account exists. */
  private readonly dummyHash = hashPassword(randomToken(16));

  constructor(
    private readonly db: DbService,
    private readonly tokens: TokensService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  private findUserByEmail(email: string) {
    return this.db.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      .then((r) => r[0]);
  }

  // ---------------------------------------------------------------- login

  async login(res: Response, email: string, password: string) {
    const user = await this.findUserByEmail(email);
    if (!user || !user.passwordHash) {
      await argon2.verify(await this.dummyHash, password).catch(() => false);
      await this.audit.security('login_failed', { metadata: { email, reason: 'unknown_user' } });
      throw this.invalidCredentials();
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.audit.security('login_blocked', { userId: user.id });
      throw new UnauthorizedException({
        code: ERROR_CODES.ACCOUNT_LOCKED,
        message: 'Too many failed attempts. Try again later or reset your password.',
      });
    }
    const valid = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!valid) {
      await this.registerFailure(user);
      throw this.invalidCredentials();
    }
    if (argon2.needsRehash(user.passwordHash, ARGON_OPTIONS)) {
      await this.db.db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, user.id));
    }
    if (user.mfaEnabled) {
      return { mfaRequired: true as const, mfaToken: await this.tokens.signMfa(user.id) };
    }
    return this.completeLogin(res, user);
  }

  async loginWithMfa(res: Response, mfaToken: string, code: string) {
    const userId = await this.tokens.verifyMfa(mfaToken);
    const [user] = await this.db.db.select().from(users).where(eq(users.id, userId));
    if (!user || !user.mfaEnabled) throw this.invalidCredentials();
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedException({ code: ERROR_CODES.ACCOUNT_LOCKED, message: 'Too many failed attempts. Try again later.' });
    }
    if (!(await this.consumeSecondFactor(user, code))) {
      await this.registerFailure(user);
      throw new UnauthorizedException({ code: 'INVALID_MFA_CODE', message: 'Invalid authentication code' });
    }
    return this.completeLogin(res, user);
  }

  private invalidCredentials() {
    return new UnauthorizedException({ code: ERROR_CODES.INVALID_CREDENTIALS, message: 'Invalid e-mail or password' });
  }

  private async registerFailure(user: User) {
    const count = user.failedLoginCount + 1;
    const lock = count >= MAX_FAILED_LOGINS;
    await this.db.db
      .update(users)
      .set({
        failedLoginCount: lock ? 0 : count,
        lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : user.lockedUntil,
      })
      .where(eq(users.id, user.id));
    await this.audit.security(lock ? 'account_locked' : 'login_failed', { userId: user.id });
  }

  /** Verifies a TOTP code (with replay protection) or consumes a one-time recovery code. */
  private async consumeSecondFactor(user: User, code: string): Promise<boolean> {
    if (!user.mfaSecretEnc) return false;
    if (/^\d{6}$/.test(code)) {
      const counter = verifyTotp(decrypt(user.mfaSecretEnc), code);
      if (counter === null || counter <= user.mfaLastCounter) return false;
      const updated = await this.db.db
        .update(users)
        .set({ mfaLastCounter: counter })
        .where(and(eq(users.id, user.id), sql`${users.mfaLastCounter} < ${counter}`))
        .returning({ id: users.id });
      return updated.length === 1;
    }
    const hash = sha256(code.toLowerCase());
    if (!user.mfaRecoveryCodes.includes(hash)) return false;
    await this.db.db
      .update(users)
      .set({ mfaRecoveryCodes: user.mfaRecoveryCodes.filter((h) => h !== hash) })
      .where(eq(users.id, user.id));
    await this.audit.security('mfa_recovery_code_used', { userId: user.id });
    return true;
  }

  private async completeLogin(res: Response, user: User) {
    await this.db.db
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
      .where(eq(users.id, user.id));
    const available = await this.listTenants(user.id);
    const usable = available.filter((t) => t.status === 'active' && (!t.requireMfa || user.mfaEnabled));
    const tenantId = usable.length === 1 ? usable[0]!.tenantId : null;
    await this.tokens.createSession(res, user.id, tenantId);
    await this.audit.security('login_success', { userId: user.id, tenantId });
    return { mfaRequired: false as const, tenantSelected: tenantId !== null };
  }

  // ---------------------------------------------------------------- tenants

  listTenants(userId: string) {
    return this.db.asUser(userId, (tx) =>
      tx
        .select({
          tenantId: tenants.id,
          name: tenants.name,
          slug: tenants.slug,
          status: tenants.status,
          requireMfa: tenants.requireMfa,
          roleName: roles.name,
        })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .innerJoin(roles, eq(roles.id, memberships.roleId))
        .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')))
        .orderBy(tenants.name),
    );
  }

  async switchTenant(res: Response, tenantId: string) {
    const c = ctx();
    const userId = requireUser();
    const options = await this.listTenants(userId);
    const target = options.find((t) => t.tenantId === tenantId);
    if (!target) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'You are not a member of this organization' });
    if (target.status !== 'active') {
      throw new ForbiddenException({ code: ERROR_CODES.TENANT_SUSPENDED, message: 'This organization is suspended' });
    }
    if (target.requireMfa && !c.mfaEnabled) {
      throw new ForbiddenException({
        code: ERROR_CODES.MFA_SETUP_REQUIRED,
        message: 'This organization requires two-factor authentication. Enable it in your profile first.',
      });
    }
    await this.tokens.setSessionTenant(res, c.sessionId!, userId, tenantId);
    await this.audit.security('tenant_switched', { userId, tenantId });
  }

  async me() {
    const c = ctx();
    const userId = requireUser();
    const [user] = await this.db.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        locale: users.locale,
        mfaEnabled: users.mfaEnabled,
        isPlatformAdmin: users.isPlatformAdmin,
        recoveryCodesLeft: sql<number>`jsonb_array_length(${users.mfaRecoveryCodes})`,
      })
      .from(users)
      .where(eq(users.id, userId));
    const memberships = await this.listTenants(userId);
    let tenant = null;
    if (c.tenantId) {
      const [t] = await this.db.db
        .select({ id: tenants.id, name: tenants.name, slug: tenants.slug, requireMfa: tenants.requireMfa, defaultLocale: tenants.defaultLocale })
        .from(tenants)
        .where(eq(tenants.id, c.tenantId));
      tenant = t ?? null;
    }
    return {
      user,
      tenant,
      role: c.tenantId ? { id: c.roleId, key: c.roleKey } : null,
      permissions: c.permissions ? [...c.permissions] : [],
      propertyIds: c.propertyIds ?? [],
      memberships,
    };
  }

  // ---------------------------------------------------------------- profile & password

  async updateProfile(data: { name?: string; locale?: 'ro' | 'en' }) {
    await this.db.db.update(users).set(data).where(eq(users.id, requireUser()));
  }

  async changePassword(currentPassword: string, newPassword: string) {
    const userId = requireUser();
    const [user] = await this.db.db.select().from(users).where(eq(users.id, userId));
    if (!user?.passwordHash || !(await argon2.verify(user.passwordHash, currentPassword).catch(() => false))) {
      throw new BadRequestException({ code: 'INVALID_PASSWORD', message: 'Current password is incorrect' });
    }
    await this.db.db
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date() })
      .where(eq(users.id, userId));
    await this.tokens.revokeAllForUser(userId, 'password_changed', ctx().sessionId);
    await this.audit.security('password_changed', { userId });
  }

  async forgotPassword(email: string) {
    const user = await this.findUserByEmail(email);
    if (!user) {
      await this.audit.security('password_reset_unknown', { metadata: { email } });
      return;
    }
    const token = randomToken(32);
    await this.db.db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
    });
    await this.mail.sendPasswordReset(user.email, token, user.locale === 'ro' ? 'ro' : 'en');
    await this.audit.security('password_reset_requested', { userId: user.id });
  }

  async resetPassword(token: string, password: string) {
    const hash = sha256(token);
    const userId = await this.db.db.transaction(async (tx) => {
      const [row] = await tx
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(passwordResetTokens.tokenHash, hash),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.expiresAt, new Date()),
          ),
        )
        .returning({ userId: passwordResetTokens.userId });
      if (!row) return null;
      await tx
        .update(users)
        .set({ passwordHash: await hashPassword(password), passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null })
        .where(eq(users.id, row.userId));
      return row.userId;
    });
    if (!userId) throw new BadRequestException({ code: 'INVALID_TOKEN', message: 'This link is invalid or has expired' });
    await this.tokens.revokeAllForUser(userId, 'password_reset');
    await this.audit.security('password_reset', { userId });
  }

  // ---------------------------------------------------------------- invitations

  private async findInvitation(token: string) {
    const [row] = await this.db.db
      .select({ invitation: invitations, tenantName: tenants.name, tenantStatus: tenants.status, tenantLocale: tenants.defaultLocale })
      .from(invitations)
      .innerJoin(tenants, eq(tenants.id, invitations.tenantId))
      .where(
        and(
          eq(invitations.tokenHash, sha256(token)),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      );
    if (!row || row.tenantStatus !== 'active') {
      throw new BadRequestException({ code: 'INVALID_TOKEN', message: 'This invitation is invalid or has expired' });
    }
    return row;
  }

  async describeInvitation(token: string) {
    const { invitation, tenantName } = await this.findInvitation(token);
    const existing = await this.findUserByEmail(invitation.email);
    return { email: invitation.email, organization: tenantName, accountExists: Boolean(existing?.passwordHash) };
  }

  async acceptInvitation(token: string, name?: string, password?: string) {
    const { invitation, tenantLocale } = await this.findInvitation(token);
    let user = await this.findUserByEmail(invitation.email);
    if (!user?.passwordHash) {
      if (!name || !password) {
        throw new BadRequestException({ code: 'VALIDATION', message: 'Name and password are required to create your account' });
      }
      const passwordHash = await hashPassword(password);
      if (user) {
        [user] = await this.db.db.update(users).set({ name, passwordHash }).where(eq(users.id, user.id)).returning();
      } else {
        // New people start in their organization's default language; they can change it in My account.
        [user] = await this.db.db.insert(users).values({ email: invitation.email, name, passwordHash, locale: tenantLocale }).returning();
      }
    }
    const userId = user!.id;
    await this.db.tenant(async (tx) => {
      const [role] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, invitation.roleId));
      if (!role) throw new BadRequestException({ code: 'INVALID_TOKEN', message: 'The role for this invitation no longer exists' });
      await tx
        .insert(memberships)
        .values({ tenantId: invitation.tenantId, userId, roleId: invitation.roleId, propertyIds: invitation.propertyIds })
        .onConflictDoUpdate({
          target: [memberships.tenantId, memberships.userId],
          set: { roleId: invitation.roleId, propertyIds: invitation.propertyIds, status: 'active' },
        });
      await tx.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, invitation.id));
    }, invitation.tenantId);
    await this.audit.security('invitation_accepted', { userId, tenantId: invitation.tenantId });
    return { email: invitation.email };
  }

  // ---------------------------------------------------------------- MFA

  async mfaSetup() {
    const userId = requireUser();
    const [user] = await this.db.db.select().from(users).where(eq(users.id, userId));
    if (!user) throw new UnauthorizedException();
    if (user.mfaEnabled) throw new BadRequestException({ code: 'MFA_ALREADY_ENABLED', message: 'Two-factor authentication is already enabled' });
    const secret = generateTotpSecret();
    await this.db.db.update(users).set({ mfaSecretEnc: encrypt(secret) }).where(eq(users.id, userId));
    const url = otpauthUrl(secret, user.email, config().APP_NAME);
    return { secret, otpauthUrl: url, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 220 }) };
  }

  async mfaEnable(code: string) {
    const userId = requireUser();
    const [user] = await this.db.db.select().from(users).where(eq(users.id, userId));
    if (!user?.mfaSecretEnc || user.mfaEnabled) throw new BadRequestException({ code: 'MFA_NOT_PENDING', message: 'Start the setup first' });
    const counter = verifyTotp(decrypt(user.mfaSecretEnc), code);
    if (counter === null) throw new BadRequestException({ code: 'INVALID_MFA_CODE', message: 'Invalid authentication code' });
    const recoveryCodes = Array.from({ length: 10 }, () => {
      const raw = randomToken(8).toLowerCase().replace(/[^a-z0-9]/g, 'x');
      return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
    });
    await this.db.db
      .update(users)
      .set({ mfaEnabled: true, mfaLastCounter: counter, mfaRecoveryCodes: recoveryCodes.map((c) => sha256(c)) })
      .where(eq(users.id, userId));
    await this.audit.security('mfa_enabled', { userId });
    return { recoveryCodes };
  }

  async mfaDisable(password: string, code: string) {
    const userId = requireUser();
    const [user] = await this.db.db.select().from(users).where(eq(users.id, userId));
    if (!user?.mfaEnabled) throw new BadRequestException({ code: 'MFA_NOT_ENABLED', message: 'Two-factor authentication is not enabled' });
    const passwordOk = user.passwordHash && (await argon2.verify(user.passwordHash, password).catch(() => false));
    if (!passwordOk || !(await this.consumeSecondFactor(user, code))) {
      throw new BadRequestException({ code: 'INVALID_CREDENTIALS', message: 'Invalid password or code' });
    }
    await this.db.db
      .update(users)
      .set({ mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryCodes: [], mfaLastCounter: 0 })
      .where(eq(users.id, userId));
    await this.audit.security('mfa_disabled', { userId });
  }

  /** Loads everything the guards need for a request in one round-trip per scope. */
  async resolveMembership(userId: string, tenantId: string) {
    return this.db.tenant(async (tx) => {
      const [row] = await tx
        .select({
          membershipId: memberships.id,
          status: memberships.status,
          propertyIds: memberships.propertyIds,
          roleId: roles.id,
          roleKey: roles.key,
          permissions: roles.permissions,
          tenantStatus: tenants.status,
          requireMfa: tenants.requireMfa,
        })
        .from(memberships)
        .innerJoin(roles, eq(roles.id, memberships.roleId))
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)));
      if (!row) return null;
      return { ...row, permissions: new Set(row.permissions.filter(isPermission) as Permission[]) };
    }, tenantId);
  }
}
