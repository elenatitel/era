import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { addDays, todayIn } from '@pms/shared';
import { Client, startDatabase } from './harness.js';

const ORIGIN = 'http://localhost:3000';
const DEMO_PASSWORD = 'Demo-password-123';

let db: Awaited<ReturnType<typeof startDatabase>>;
let app: INestApplication;
let base: string;
let seedMockData: typeof import('../src/db/mock-data.js').seedMockData;
let dbs: import('../src/db/db.service.js').DbService;

before(async () => {
  db = await startDatabase();
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations(db.ownerUrl, db.appUrl, fileURLToPath(new URL('../../drizzle', import.meta.url)));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: db.appUrl,
    JWT_SECRET: randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    WEB_ORIGIN: ORIGIN,
    COOKIE_SECURE: 'false',
    LOG_LEVEL: 'error',
    TRUST_PROXY: '0',
  });
  const { createApp } = await import('../src/bootstrap.js');
  const { DbService } = await import('../src/db/db.service.js');
  const { seedDemo } = await import('../src/db/seed.js');
  ({ seedMockData } = await import('../src/db/mock-data.js'));
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  dbs = app.get(DbService);
  await seedDemo(dbs, DEMO_PASSWORD);
});

after(async () => {
  await app?.close();
  await db?.stop();
});

test('mock data fills the demo hotel once and catches up a stale business date', async (t) => {
  const today = todayIn('Europe/Bucharest');
  // A demo seeded days ago, with no night audits since.
  await db.superQuery(`UPDATE properties SET business_date = $1`, [addDays(today, -3)]);
  await db.superQuery(`UPDATE reservations SET arrival = arrival - 3, departure = departure - 3`);

  const first = await seedMockData(dbs);
  assert.equal(first.skipped, false);
  if (first.skipped) return;
  t.diagnostic(JSON.stringify(first));
  assert.equal(first.businessDate, today);
  assert.ok(first.reservations > 150, `only ${first.reservations} reservations`);
  assert.ok(first.invoices > 50 && first.payments > first.invoices);
  assert.equal((await seedMockData(dbs)).skipped, true);

  const [overlap] = await db.superQuery<{ n: number }>(`
    SELECT count(*)::int AS n FROM reservations a JOIN reservations b
      ON a.room_id = b.room_id AND a.id < b.id AND a.arrival < b.departure AND b.arrival < a.departure
    WHERE a.status NOT IN ('cancelled', 'no_show') AND b.status NOT IN ('cancelled', 'no_show')`);
  assert.equal(overlap!.n, 0);
  const [unbalanced] = await db.superQuery<{ n: number }>(`
    SELECT count(*)::int AS n FROM reservations r WHERE r.status = 'checked_out' AND
      (SELECT coalesce(sum(amount), 0) FROM folio_items f WHERE f.reservation_id = r.id AND f.voided_at IS NULL) <>
      (SELECT coalesce(sum(amount), 0) FROM payments p WHERE p.reservation_id = r.id)`);
  assert.equal(unbalanced!.n, 0);
  const [demo] = await db.superQuery<{ arrival: string }>(`SELECT to_char(arrival, 'YYYY-MM-DD') AS arrival FROM reservations WHERE code = 'DEMO0002'`);
  assert.equal(demo!.arrival, today);

  const owner = await new Client(base, ORIGIN).init();
  assert.equal((await owner.post('/auth/login', { email: 'owner@demo.test', password: DEMO_PASSWORD })).status, 200);
  const [property] = (await owner.get('/properties')).body as { id: string }[];
  const q = `propertyId=${property!.id}`;
  for (const path of ['/dashboard', '/dashboard/house', '/dashboard/day', '/dashboard/night', '/front-desk', `/reservations/calendar?from=${addDays(today, -7)}&to=${addDays(today, 21)}&`, '/invoices?', `/payments?from=${addDays(today, -30)}&to=${today}&`, '/housekeeping/board?']) {
    const url = path.includes('?') ? `${path}${path.endsWith('?') || path.endsWith('&') ? '' : '&'}${q}` : `${path}?${q}`;
    const res = await owner.get(url);
    assert.equal(res.status, 200, `${url}: ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  const night = (await owner.get(`/dashboard/night?${q}`)).body as { tonight: { occupied: number } };
  t.diagnostic(JSON.stringify({ tonight: night.tonight, overview: (await owner.get(`/dashboard?${q}`)).body }).slice(0, 1500));
  assert.ok(night.tonight.occupied > 3, `occupied tonight: ${night.tonight.occupied}`);
});
