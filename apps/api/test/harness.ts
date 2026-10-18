import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

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
  const dir = mkdtempSync(join(tmpdir(), 'pms-pg-'));
  const port = await freePort();
  const server = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password: 'postgres', persistent: false, onLog: () => {} });
  await server.initialise();
  await server.start();
  const admin = server.getPgClient();
  await admin.connect();
  await admin.query(`CREATE ROLE pms_owner LOGIN PASSWORD 'owner_pw' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`CREATE ROLE pms_app LOGIN PASSWORD 'app_pw' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`CREATE DATABASE pms_test OWNER pms_owner`);
  await admin.end();
  const url = (user: string, pw: string) => `postgres://${user}:${pw}@127.0.0.1:${port}/pms_test`;
  return {
    ownerUrl: url('pms_owner', 'owner_pw'),
    appUrl: url('pms_app', 'app_pw'),
    superUrl: url('postgres', 'postgres'),
    async superQuery<T extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
      const c = new pg.Client({ connectionString: url('postgres', 'postgres') });
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

/** Minimal browser-like HTTP client: cookie jar + CSRF header + Origin. */
export class Client {
  cookies = new Map<string, string>();
  constructor(
    private readonly base: string,
    private readonly origin: string,
  ) {}

  private store(res: Response) {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const idx = pair!.indexOf('=');
      const name = pair!.slice(0, idx);
      const value = pair!.slice(idx + 1);
      if (/expires=Thu, 01 Jan 1970/i.test(raw) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async init() {
    await this.req('GET', '/auth/csrf');
    return this;
  }

  async req<T = any>(method: string, path: string, body?: unknown, opts: { csrf?: boolean } = {}) {
    const headers: Record<string, string> = { origin: this.origin };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (opts.csrf !== false && this.cookies.get('pms_csrf')) headers['x-csrf-token'] = this.cookies.get('pms_csrf')!;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${this.base}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    this.store(res);
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    return { status: res.status, body: json as T };
  }

  get = <T = any>(path: string) => this.req<T>('GET', path);
  post = <T = any>(path: string, body?: unknown) => this.req<T>('POST', path, body ?? {});
  patch = <T = any>(path: string, body?: unknown) => this.req<T>('PATCH', path, body ?? {});
  put = <T = any>(path: string, body?: unknown) => this.req<T>('PUT', path, body ?? {});
  del = <T = any>(path: string) => this.req<T>('DELETE', path);
}
