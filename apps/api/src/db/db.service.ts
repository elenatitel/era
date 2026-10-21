import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config.js';
import { maybeCtx, requireTenant } from '../common/context.js';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

// Return DATE columns as plain 'YYYY-MM-DD' strings and BIGINT as numbers (amounts stay well below 2^53).
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));

export function createPool(url = config().DATABASE_URL) {
  return new pg.Pool({
    connectionString: url,
    max: config().DATABASE_POOL_MAX,
    ssl: config().DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 30_000,
    application_name: 'pms-api',
  });
}

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  readonly pool = createPool();
  /** Use only for global tables (tenants, users, sessions...). Tenant tables return no rows here. */
  readonly db: Database = drizzle({ client: this.pool, schema, casing: 'snake_case' });

  /**
   * Runs `fn` in a transaction bound to a tenant. RLS policies read `app.tenant_id`,
   * so every query inside only sees and writes rows of that tenant.
   */
  async tenant<T>(fn: (tx: Tx) => Promise<T>, tenantId: string = requireTenant()): Promise<T> {
    const userId = maybeCtx()?.userId ?? '';
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${userId}, true)`,
      );
      return fn(tx);
    });
  }

  /** Transaction scoped to a user without a tenant: can read only the user's own memberships. */
  async asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true), set_config('app.tenant_id', '', true)`);
      return fn(tx);
    });
  }

  /** Refuses to run with a role that silently disables tenant isolation. */
  async assertSafeRole(): Promise<void> {
    const { rows } = await this.pool.query<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
      'select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user',
    );
    const role = rows[0];
    if (role && (role.rolsuper || role.rolbypassrls)) {
      const message = `Database role "${role.rolname}" is a superuser or has BYPASSRLS; tenant isolation would be disabled.`;
      if (config().isProduction) throw new Error(message);
      this.logger.warn(`${message} Allowed outside production only.`);
    }
  }

  async ping(): Promise<boolean> {
    await this.pool.query('select 1');
    return true;
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

