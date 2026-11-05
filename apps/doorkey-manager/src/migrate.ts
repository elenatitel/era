import pg from "pg";
import { pathToFileURL } from "node:url";
export async function migrate(ownerUrl: string, appUrl: string) {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext('doorkey:migrate'))");
    await c.query(`
   CREATE TABLE IF NOT EXISTS dk_doors (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, room_id uuid NOT NULL,
    wire_id bigint UNIQUE NOT NULL CHECK (wire_id BETWEEN 1 AND 4294967295),
    public_key text UNIQUE NOT NULL, name text NOT NULL, enabled boolean NOT NULL DEFAULT true,
    UNIQUE(tenant_id,room_id));
   CREATE TABLE IF NOT EXISTS dk_invites (
    token_hash bytea PRIMARY KEY, tenant_id uuid NOT NULL, room_id uuid NOT NULL, reservation_id uuid NOT NULL,
    version integer NOT NULL, expires_at timestamptz NOT NULL, redeemed_at timestamptz);
   CREATE TABLE IF NOT EXISTS dk_permits (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, room_id uuid NOT NULL,
    reservation_id uuid NOT NULL, version integer NOT NULL, door_id uuid NOT NULL REFERENCES dk_doors(id),
    phone_public_key text NOT NULL, permit_hash bytea UNIQUE NOT NULL, expires_at timestamptz NOT NULL,
    revoked_at timestamptz, last_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
   CREATE INDEX IF NOT EXISTS dk_permits_stay ON dk_permits(tenant_id,reservation_id);
   CREATE TABLE IF NOT EXISTS dk_nonces (door_id uuid NOT NULL REFERENCES dk_doors(id), nonce bytea NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(door_id,nonce));
   CREATE TABLE IF NOT EXISTS dk_rates (key bytea PRIMARY KEY, bucket bigint NOT NULL, attempts integer NOT NULL);
   CREATE TABLE IF NOT EXISTS dk_audit (id bigserial PRIMARY KEY, event text NOT NULL, subject_id uuid, created_at timestamptz NOT NULL DEFAULT now());
  `);
    const role = c.escapeIdentifier(
      decodeURIComponent(new URL(appUrl).username),
    );
    await c.query(
      `GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}; REVOKE UPDATE,DELETE ON dk_audit FROM ${role}`,
    );
    await c.query("COMMIT");
  } finally {
    await c.end();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await migrate(process.env.DATABASE_MIGRATION_URL!, process.env.DATABASE_URL!);
  console.log("DoorKey migrations applied");
}
