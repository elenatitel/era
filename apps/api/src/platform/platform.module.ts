import { Controller, Get, HttpCode, Injectable, Module, Patch, Post } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { ROLE_TEMPLATES } from '@pms/shared';
import { randomToken, sha256 } from '../common/crypto.js';
import { conflict, notFound } from '../common/errors.js';
import { IdParam, ZBody } from '../common/zod.js';
import { createTenantSchema, updateTenantStatusSchema } from '@pms/shared';
import { PlatformAdmin } from '../auth/decorators.js';
import { AuditService } from '../db/audit.service.js';
import { DbService, type Tx } from '../db/db.service.js';
import { invitations, roles, sessions, tenants } from '../db/schema.js';
import { MailService } from '../mail/mail.service.js';
import { ctx } from '../common/context.js';

export const INVITATION_TTL_MS = 7 * 86_400_000;

/** Creates the default roles of a tenant. Must run inside that tenant's transaction. */
export async function seedTenantRoles(tx: Tx, tenantId: string) {
  return tx
    .insert(roles)
    .values(
      ROLE_TEMPLATES.map((t) => ({
        tenantId,
        key: t.key,
        name: t.name,
        description: t.description,
        permissions: t.permissions,
        system: t.system ?? false,
      })),
    )
    .returning();
}

@Injectable()
export class PlatformService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  list() {
    return this.db.db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        status: tenants.status,
        requireMfa: tenants.requireMfa,
        createdAt: tenants.createdAt,
        // Counts come from a global table only; tenant data stays behind RLS.
        activeSessions: sql<number>`(select count(*)::int from ${sessions} s where s.tenant_id = ${tenants.id} and s.revoked_at is null)`,
      })
      .from(tenants)
      .orderBy(desc(tenants.createdAt));
  }

  async create(input: { name: string; slug: string; ownerEmail: string; ownerName: string; locale: 'ro' | 'en' }) {
    const [existing] = await this.db.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, input.slug));
    if (existing) throw conflict('DUPLICATE', 'This slug is already taken');
    const [tenant] = await this.db.db
      .insert(tenants)
      .values({ name: input.name, slug: input.slug, defaultLocale: input.locale })
      .returning();
    const token = randomToken(32);
    await this.db.tenant(async (tx) => {
      const created = await seedTenantRoles(tx, tenant!.id);
      const owner = created.find((r) => r.key === 'owner')!;
      await tx.insert(invitations).values({
        tenantId: tenant!.id,
        email: input.ownerEmail,
        roleId: owner.id,
        tokenHash: sha256(token),
        invitedById: ctx().userId,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      });
    }, tenant!.id);
    await this.mail.sendInvitation(input.ownerEmail, input.name, token, input.locale);
    await this.audit.security('tenant_created', { tenantId: tenant!.id, metadata: { slug: input.slug, owner: input.ownerEmail } });
    return tenant;
  }

  async setStatus(id: string, status: 'active' | 'suspended') {
    const [tenant] = await this.db.db.update(tenants).set({ status }).where(eq(tenants.id, id)).returning();
    if (!tenant) throw notFound('Organization');
    await this.audit.security(`tenant_${status}`, { tenantId: id });
    return tenant;
  }
}

@PlatformAdmin()
@Controller('platform/tenants')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get()
  list() {
    return this.platform.list();
  }

  @Post()
  create(@ZBody(createTenantSchema) body: { name: string; slug: string; ownerEmail: string; ownerName: string; locale: 'ro' | 'en' }) {
    return this.platform.create(body);
  }

  @Patch(':id/status')
  @HttpCode(200)
  setStatus(@IdParam() id: string, @ZBody(updateTenantStatusSchema) body: { status: 'active' | 'suspended' }) {
    return this.platform.setStatus(id, body.status);
  }
}

@Module({ controllers: [PlatformController], providers: [PlatformService], exports: [PlatformService] })
export class PlatformModule {}
