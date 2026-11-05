import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Starts a throwaway PostgreSQL with separate owner (migrations) and app (runtime, RLS-bound) roles. */
export async function startDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "pms-pg-"));
  const port = await freePort();
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    port,
    user: "postgres",
    password: "postgres",
    persistent: false,
    onLog: () => {},
  });
  await server.initialise();
  await server.start();
  const admin = server.getPgClient();
  await admin.connect();
  await admin.query(
    `CREATE ROLE pms_owner LOGIN PASSWORD 'owner_pw' NOSUPERUSER NOBYPASSRLS`,
  );
  await admin.query(
    `CREATE ROLE pms_app LOGIN PASSWORD 'app_pw' NOSUPERUSER NOBYPASSRLS`,
  );
  await admin.query(`CREATE DATABASE pms_test OWNER pms_owner`);
  await admin.end();
  const url = (user: string, pw: string) =>
    `postgres://${user}:${pw}@127.0.0.1:${port}/pms_test`;
  return {
    ownerUrl: url("pms_owner", "owner_pw"),
    appUrl: url("pms_app", "app_pw"),
    superUrl: url("postgres", "postgres"),
    async superQuery<T extends pg.QueryResultRow>(
      text: string,
      params: unknown[] = [],
    ) {
      const c = new pg.Client({
        connectionString: url("postgres", "postgres"),
      });
      await c.connect();
      try {
        return (await c.query<T>(text, params)).rows;
      } finally {
        await c.end();
      }
    },
    async stop() {
      await server.stop().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
