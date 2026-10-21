// Local PostgreSQL without Docker (development only).
// Usage: node scripts/local-db.mjs  -> keeps running; Ctrl+C to stop. Data persists in ./.pg-dev
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PGPORT ?? 5432);
// fileURLToPath, not .pathname: a folder name with spaces must not become %20.
const dir = fileURLToPath(new URL('../.pg-dev', import.meta.url));
const fresh = !existsSync(dir);
const pg = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password: 'postgres', persistent: true, onLog: () => {} });
if (fresh) await pg.initialise();
await pg.start();
if (fresh) {
  const c = pg.getPgClient();
  await c.connect();
  await c.query(`CREATE ROLE pms_owner LOGIN PASSWORD 'pms_owner' NOSUPERUSER NOBYPASSRLS`);
  await c.query(`CREATE ROLE pms_app LOGIN PASSWORD 'pms_app' NOSUPERUSER NOBYPASSRLS`);
  await c.query(`CREATE DATABASE pms OWNER pms_owner`);
  await c.end();
}
console.log(`PostgreSQL ready on 127.0.0.1:${port}
  DATABASE_URL=postgres://pms_app:pms_app@127.0.0.1:${port}/pms
  DATABASE_MIGRATION_URL=postgres://pms_owner:pms_owner@127.0.0.1:${port}/pms`);
const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
