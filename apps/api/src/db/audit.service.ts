import { Injectable } from '@nestjs/common';
import { ctx, maybeCtx } from '../common/context.js';
import { auditLogs, securityEvents } from './schema.js';
import { DbService, type Tx } from './db.service.js';

@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  /** Records a business action inside the caller's tenant transaction (atomic with the change). */
  async log(tx: Tx, action: string, entityType: string, entityId: string | null, metadata: Record<string, unknown> = {}) {
    const c = ctx();
    await tx.insert(auditLogs).values({
      tenantId: c.tenantId!,
      userId: c.userId ?? null,
      action,
      entityType,
      entityId,
      metadata,
      ip: c.ip,
    });
  }

  /** Records an authentication / security event (global, not tenant-scoped). */
  async security(type: string, data: { userId?: string | null; tenantId?: string | null; metadata?: Record<string, unknown> } = {}) {
    const c = maybeCtx();
    await this.db.db.insert(securityEvents).values({
      type,
      userId: data.userId ?? c?.userId ?? null,
      tenantId: data.tenantId ?? c?.tenantId ?? null,
      ip: c?.ip ?? null,
      userAgent: c?.userAgent?.slice(0, 300) ?? null,
      metadata: data.metadata ?? {},
    });
  }
}
