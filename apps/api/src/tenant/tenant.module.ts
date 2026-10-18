import { Controller, Delete, Get, HttpCode, Injectable, Module, Patch, Post, Put } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ALL_PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSIONS,
  type Permission,
  inviteUserSchema,
  pagination,
  roleSchema,
  updateMembershipSchema,
  updateTenantSettingsSchema,
} from '@pms/shared';
import { ctx, requireTenant } from '../common/context.js';
import { randomToken, sha256 } from '../common/crypto.js';
import { conflict, forbidden, notFound, unprocessable } from '../common/errors.js';
import { IdParam, ZBody, ZQuery } from '../common/zod.js';
import { Perms } from '../auth/decorators.js';
import { AuditService } from '../db/audit.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { auditLogs, invitations, memberships, properties, roles, tenants, users } from '../db/schema.js';
import { MailService } from '../mail/mail.service.js';
import { INVITATION_TTL_MS } from '../platform/platform.module.js';
import { TokensService } from '../auth/tokens.service.js';
import { AuthModule } from '../auth/auth.module.js';

const isOwner = () => ctx().roleKey === 'owner';

/** Prevents privilege escalation: you can only hand out permissions you hold yourself. */
function assertCanGrant(permissions: string[], roleKey?: string | null) {
  if (isOwner()) return;
  if (roleKey === 'owner') throw forbidden('Only owners can grant the owner role');
  const own = ctx().permissions ?? new Set();
  const excess = permissions.filter((p) => !own.has(p as Permission));
  if (excess.length) throw forbidden(`You cannot grant permissions you do not have: ${excess.join(', ')}`);
}

async function assertPropertiesExist(tx: Tx, ids: string[]) {
  if (!ids.length) return;
  const rows = await tx.select({ id: properties.id }).from(properties).where(inArray(properties.id, ids));
  if (rows.length !== new Set(ids).size) throw unprocessable('Unknown property in propertyIds');
}

async function countActiveOwners(tx: Tx) {
  const [row] = await tx
    .select({ n: count() })
    .from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(and(eq(roles.key, 'owner'), eq(memberships.status, 'active')));
  return row?.n ?? 0;
}

@Injectable()
export class TenantService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly tokens: TokensService,
  ) {}

  // ---------- settings
  async getSettings() {
    const [t] = await this.db.db.select().from(tenants).where(eq(tenants.id, requireTenant()));
    return t;
  }

  async updateSettings(data: { name?: string; requireMfa?: boolean; defaultLocale?: 'ro' | 'en' }) {
    if (data.requireMfa && !ctx().mfaEnabled) {
      throw unprocessable('Enable two-factor authentication on your own account before requiring it for everyone');
    }
    const [t] = await this.db.db.update(tenants).set(data).where(eq(tenants.id, requireTenant())).returning();
    await this.db.tenant((tx) => this.audit.log(tx, 'tenant.settings_updated', 'tenant', t!.id, data));
    return t;
  }

  // ---------- members
  listMembers() {
    return this.db.tenant((tx) =>
      tx
        .select({
          id: memberships.id,
          userId: users.id,
          name: users.name,
          email: users.email,
          mfaEnabled: users.mfaEnabled,
          lastLoginAt: users.lastLoginAt,
          status: memberships.status,
          propertyIds: memberships.propertyIds,
          roleId: roles.id,
          roleName: roles.name,
          roleKey: roles.key,
          createdAt: memberships.createdAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .innerJoin(roles, eq(roles.id, memberships.roleId))
        .orderBy(users.name),
    );
  }

  async updateMember(id: string, data: { roleId?: string; propertyIds?: string[]; status?: 'active' | 'disabled' }) {
    const result = await this.db.tenant(async (tx) => {
      const [m] = await tx
        .select({ membership: memberships, roleKey: roles.key })
        .from(memberships)
        .innerJoin(roles, eq(roles.id, memberships.roleId))
        .where(eq(memberships.id, id));
      if (!m) throw notFound('Member');
      if (m.membership.userId === ctx().userId) throw forbidden('You cannot change your own access');
      if (m.roleKey === 'owner' && !isOwner()) throw forbidden('Only owners can modify other owners');
      let newRoleKey = m.roleKey;
      if (data.roleId) {
        const [role] = await tx.select().from(roles).where(eq(roles.id, data.roleId));
        if (!role) throw notFound('Role');
        assertCanGrant(role.permissions, role.key);
        newRoleKey = role.key;
      }
      if (data.propertyIds) await assertPropertiesExist(tx, data.propertyIds);
      const [updated] = await tx.update(memberships).set(data).where(eq(memberships.id, id)).returning();
      const removesOwner = m.roleKey === 'owner' && (newRoleKey !== 'owner' || data.status === 'disabled');
      if (removesOwner && (await countActiveOwners(tx)) < 1) {
        throw conflict('LAST_OWNER', 'An organization must keep at least one active owner');
      }
      await this.audit.log(tx, 'member.updated', 'membership', id, data);
      return { updated: updated!, userId: m.membership.userId };
    });
    if (data.status === 'disabled') await this.tokens.revokeAllForUser(result.userId, 'membership_disabled');
    return result.updated;
  }

  async removeMember(id: string) {
    const userId = await this.db.tenant(async (tx) => {
      const [m] = await tx
        .select({ membership: memberships, roleKey: roles.key })
        .from(memberships)
        .innerJoin(roles, eq(roles.id, memberships.roleId))
        .where(eq(memberships.id, id));
      if (!m) throw notFound('Member');
      if (m.membership.userId === ctx().userId) throw forbidden('You cannot remove yourself');
      if (m.roleKey === 'owner' && !isOwner()) throw forbidden('Only owners can remove other owners');
      await tx.delete(memberships).where(eq(memberships.id, id));
      if (m.roleKey === 'owner' && (await countActiveOwners(tx)) < 1) {
        throw conflict('LAST_OWNER', 'An organization must keep at least one active owner');
      }
      await this.audit.log(tx, 'member.removed', 'membership', id, { userId: m.membership.userId });
      return m.membership.userId;
    });
    await this.tokens.revokeAllForUser(userId, 'membership_removed');
  }

  // ---------- invitations
  listInvitations() {
    return this.db.db
      .select({
        id: invitations.id,
        email: invitations.email,
        roleId: invitations.roleId,
        propertyIds: invitations.propertyIds,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .where(and(eq(invitations.tenantId, requireTenant()), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
      .orderBy(desc(invitations.createdAt));
  }

  async invite(input: { email: string; roleId: string; propertyIds: string[] }) {
    const tenantId = requireTenant();
    const token = randomToken(32);
    const invitation = await this.db.tenant(async (tx) => {
      const [role] = await tx.select().from(roles).where(eq(roles.id, input.roleId));
      if (!role) throw notFound('Role');
      assertCanGrant(role.permissions, role.key);
      await assertPropertiesExist(tx, input.propertyIds);
      const [existing] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(sql`lower(${users.email}) = ${input.email}`);
      if (existing) throw conflict('ALREADY_MEMBER', 'This person is already a member');
      // Supersede any pending invitation for the same address.
      await tx
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(and(eq(invitations.tenantId, tenantId), eq(invitations.email, input.email), isNull(invitations.acceptedAt)));
      const [inv] = await tx
        .insert(invitations)
        .values({
          tenantId,
          email: input.email,
          roleId: role.id,
          propertyIds: input.propertyIds,
          tokenHash: sha256(token),
          invitedById: ctx().userId,
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        })
        .returning({ id: invitations.id, email: invitations.email, expiresAt: invitations.expiresAt });
      await this.audit.log(tx, 'member.invited', 'invitation', inv!.id, { email: input.email, role: role.name });
      return inv!;
    });
    const [tenant] = await this.db.db.select().from(tenants).where(eq(tenants.id, tenantId));
    await this.mail.sendInvitation(input.email, tenant!.name, token, tenant!.defaultLocale === 'en' ? 'en' : 'ro');
    return invitation;
  }

  async revokeInvitation(id: string) {
    const [inv] = await this.db.db
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(and(eq(invitations.id, id), eq(invitations.tenantId, requireTenant()), isNull(invitations.acceptedAt)))
      .returning({ id: invitations.id });
    if (!inv) throw notFound('Invitation');
    await this.db.tenant((tx) => this.audit.log(tx, 'invitation.revoked', 'invitation', id));
  }

  // ---------- roles
  listRoles() {
    return this.db.tenant((tx) =>
      tx
        .select({
          id: roles.id,
          key: roles.key,
          name: roles.name,
          description: roles.description,
          permissions: roles.permissions,
          system: roles.system,
          members: sql<number>`(select count(*)::int from ${memberships} m where m.role_id = ${roles.id})`,
        })
        .from(roles)
        .orderBy(roles.name),
    );
  }

  async createRole(input: { name: string; description: string | null; permissions: string[] }) {
    assertCanGrant(input.permissions);
    return this.db.tenant(async (tx) => {
      const [role] = await tx
        .insert(roles)
        .values({ tenantId: requireTenant(), name: input.name, description: input.description, permissions: [...new Set(input.permissions)] })
        .returning();
      await this.audit.log(tx, 'role.created', 'role', role!.id, { name: input.name, permissions: input.permissions });
      return role;
    });
  }

  async updateRole(id: string, input: { name: string; description: string | null; permissions: string[] }) {
    assertCanGrant(input.permissions);
    return this.db.tenant(async (tx) => {
      const [existing] = await tx.select().from(roles).where(eq(roles.id, id));
      if (!existing) throw notFound('Role');
      if (existing.system) throw forbidden('System roles cannot be modified');
      if (existing.id === ctx().roleId) throw forbidden('You cannot modify your own role');
      const [role] = await tx
        .update(roles)
        .set({ name: input.name, description: input.description, permissions: [...new Set(input.permissions)] })
        .where(eq(roles.id, id))
        .returning();
      await this.audit.log(tx, 'role.updated', 'role', id, { before: existing.permissions, after: input.permissions });
      return role;
    });
  }

  async deleteRole(id: string) {
    await this.db.tenant(async (tx) => {
      const [existing] = await tx.select().from(roles).where(eq(roles.id, id));
      if (!existing) throw notFound('Role');
      if (existing.system) throw forbidden('System roles cannot be deleted');
      const [{ n }] = (await tx.select({ n: count() }).from(memberships).where(eq(memberships.roleId, id))) as [{ n: number }];
      if (n > 0) throw conflict('IN_USE', 'Reassign the members of this role before deleting it');
      await tx.delete(roles).where(eq(roles.id, id));
      await this.audit.log(tx, 'role.deleted', 'role', id, { name: existing.name });
    });
  }

  // ---------- audit log
  auditLog(q: { page: number; pageSize: number; entityType?: string; before?: string }) {
    return this.db.tenant(async (tx) => {
      const where = and(
        q.entityType ? eq(auditLogs.entityType, q.entityType) : undefined,
        q.before ? lt(auditLogs.createdAt, new Date(q.before)) : undefined,
      );
      const rows = await tx
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          metadata: auditLogs.metadata,
          ip: auditLogs.ip,
          createdAt: auditLogs.createdAt,
          userName: users.name,
          userEmail: users.email,
        })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.userId))
        .where(where)
        .orderBy(desc(auditLogs.createdAt))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize);
      return { items: rows };
    });
  }
}

const auditQuery = pagination.extend({ entityType: z.string().max(40).optional(), before: z.iso.datetime().optional() });

@Controller()
export class TenantController {
  constructor(private readonly svc: TenantService) {}

  @Get('permissions')
  @Perms('roles.manage')
  catalogue() {
    return { permissions: ALL_PERMISSIONS.map((key) => ({ key, description: PERMISSIONS[key] })), groups: PERMISSION_GROUPS };
  }

  @Get('tenant/settings')
  @Perms('tenant.settings')
  settings() {
    return this.svc.getSettings();
  }

  @Patch('tenant/settings')
  @Perms('tenant.settings')
  updateSettings(@ZBody(updateTenantSettingsSchema) body: { name?: string; requireMfa?: boolean; defaultLocale?: 'ro' | 'en' }) {
    return this.svc.updateSettings(body);
  }

  @Get('members')
  @Perms('users.read')
  members() {
    return this.svc.listMembers();
  }

  @Patch('members/:id')
  @Perms('users.manage')
  updateMember(@IdParam() id: string, @ZBody(updateMembershipSchema) body: { roleId?: string; propertyIds?: string[]; status?: 'active' | 'disabled' }) {
    return this.svc.updateMember(id, body);
  }

  @Delete('members/:id')
  @Perms('users.manage')
  @HttpCode(204)
  removeMember(@IdParam() id: string) {
    return this.svc.removeMember(id);
  }

  @Get('invitations')
  @Perms('users.manage')
  invitations() {
    return this.svc.listInvitations();
  }

  @Post('invitations')
  @Perms('users.manage')
  invite(@ZBody(inviteUserSchema) body: { email: string; roleId: string; propertyIds: string[] }) {
    return this.svc.invite(body);
  }

  @Delete('invitations/:id')
  @Perms('users.manage')
  @HttpCode(204)
  revokeInvitation(@IdParam() id: string) {
    return this.svc.revokeInvitation(id);
  }

  @Get('roles')
  @Perms('users.read')
  roles() {
    return this.svc.listRoles();
  }

  @Post('roles')
  @Perms('roles.manage')
  createRole(@ZBody(roleSchema) body: { name: string; description: string | null; permissions: string[] }) {
    return this.svc.createRole(body);
  }

  @Put('roles/:id')
  @Perms('roles.manage')
  updateRole(@IdParam() id: string, @ZBody(roleSchema) body: { name: string; description: string | null; permissions: string[] }) {
    return this.svc.updateRole(id, body);
  }

  @Delete('roles/:id')
  @Perms('roles.manage')
  @HttpCode(204)
  deleteRole(@IdParam() id: string) {
    return this.svc.deleteRole(id);
  }

  @Get('audit-log')
  @Perms('audit.read')
  auditLog(@ZQuery(auditQuery) q: z.infer<typeof auditQuery>) {
    return this.svc.auditLog(q);
  }
}

@Module({ imports: [AuthModule], controllers: [TenantController], providers: [TenantService] })
export class TenantModule {}

