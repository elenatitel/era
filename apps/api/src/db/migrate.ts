import { fileURLToPath, pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/**
 * Applies migrations with the owner role, then grants the least privileges the
 * application role needs. The app role never owns tables and cannot alter RLS.
 */
export async function runMigrations(
  ownerUrl: string,
  appUrl?: string,
  migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url)),
) {
  const client = new pg.Client({ connectionString: ownerUrl, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
  await client.connect();
  try {
    await migrate(drizzle({ client }), { migrationsFolder });
    const appRole = appUrl ? decodeURIComponent(new URL(appUrl).username) : undefined;
    const { rows } = await client.query<{ current_user: string }>('select current_user');
    if (appRole && appRole !== rows[0]!.current_user) {
      const role = client.escapeIdentifier(appRole);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
      await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
      // Audit trails are append-only for the application.
      await client.query(`REVOKE UPDATE, DELETE ON audit_logs, security_events FROM ${role}`);
      await client.query(`REVOKE DELETE ON invoices, invoice_lines FROM ${role}`);
      await client.query(`REVOKE ALL ON SCHEMA drizzle FROM ${role}`).catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const owner = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!owner) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL is required');
  await runMigrations(owner, process.env.DATABASE_URL);
  console.log('Migrations applied');
}
