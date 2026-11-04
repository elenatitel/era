import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { addDays } from '@pms/shared';
import { Client, startDatabase } from './harness.js';

const ORIGIN = 'http://localhost:3000';
const DEMO_PASSWORD = 'Demo-password-123';

let db: Awaited<ReturnType<typeof startDatabase>>;
let app: INestApplication;
let base: string;

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
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  await seedDemo(app.get(DbService), DEMO_PASSWORD);
});

after(async () => {
  await app?.close();
  await db?.stop();
});

async function setup() {
  const mgr = await new Client(base, ORIGIN).init();
  assert.equal((await mgr.post('/auth/login', { email: 'manager@demo.test', password: DEMO_PASSWORD })).status, 200);
  const [property] = (await mgr.get('/properties')).body as { id: string; businessDate: string }[];
  const today = property!.businessDate;
  const search = (await mgr.get(`/availability?propertyId=${property!.id}&arrival=${addDays(today, 40)}&departure=${addDays(today, 42)}&adults=2`)).body;
  const offer = search.roomTypes.find((t: any) => t.available > 1 && t.fitsOccupancy && t.offers.some((o: any) => o.sellable));
  const plan = offer.offers.find((o: any) => o.sellable);
  const rooms = ((await mgr.get(`/rooms?propertyId=${property!.id}`)).body as { id: string; number: string; roomTypeId: string }[]).filter((r) => r.roomTypeId === offer.roomType.id);
  const book = async (arrival: string, departure: string, roomId: string | null, notes?: string) => {
    const res = await mgr.post('/reservations', {
      propertyId: property!.id,
      roomTypeId: offer.roomType.id,
      ratePlanId: plan.ratePlanId,
      roomId,
      arrival,
      departure,
      adults: 2,
      notes,
      guest: { firstName: 'Mutare', lastName: 'Test' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body as { id: string; totalAmount: number };
  };
  return { mgr, today, rooms, book };
}

test('moving a stay checks the room it ends up in, and previews before saving', async () => {
  const { mgr, today, rooms, book } = await setup();
  const [a, b] = rooms;
  const day = (n: number) => addDays(today, 40 + n);
  const stay = await book(day(0), day(2), a!.id, 'Vine cu un cățel');
  await book(day(5), day(7), b!.id);

  // Nothing is saved by the preview, and the agreed nights keep their price.
  const free = { arrival: day(1), departure: day(3), roomId: b!.id };
  const preview = await mgr.post(`/reservations/${stay.id}/move-preview`, free);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(
    { from: preview.body.before.roomNumber, to: preview.body.after.roomNumber, arrival: preview.body.after.arrival, was: preview.body.before.total },
    { from: a!.number, to: b!.number, arrival: day(1), was: stay.totalAmount },
  );
  const untouched = (await mgr.get(`/reservations/${stay.id}`)).body;
  assert.equal(untouched.arrival, day(0));
  assert.equal(untouched.roomId, a!.id);

  // The target room is the one that must be free, in the preview as well as on save.
  const clash = { arrival: day(4), departure: day(6), roomId: b!.id };
  const refused = await mgr.post(`/reservations/${stay.id}/move-preview`, clash);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'ROOM_CONFLICT');
  assert.equal((await mgr.patch(`/reservations/${stay.id}`, clash)).status, 409);

  // A room that is free on the new dates is fine even when the old room is taken then.
  await book(day(10), day(12), a!.id);
  const away = { arrival: day(10), departure: day(12), roomId: b!.id };
  const moved = await mgr.patch(`/reservations/${stay.id}`, away);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.roomId, b!.id);
  assert.equal(moved.body.notes, 'Vine cu un cățel', 'a move leaves the notes alone');
  assert.equal(moved.body.arrival, day(10));

  // Taking the stay off a room, and into the past, follow the same rules.
  const unassigned = await mgr.patch(`/reservations/${stay.id}`, { roomId: null });
  assert.equal(unassigned.status, 200);
  assert.equal(unassigned.body.roomId, null);
  assert.equal((await mgr.post(`/reservations/${stay.id}/move-preview`, { arrival: addDays(today, -1), departure: addDays(today, 1) })).status, 422);
});

test('moves need permission to change reservations', async () => {
  const { book, today } = await setup();
  const stay = await book(addDays(today, 50), addDays(today, 51), null);
  const hk = await new Client(base, ORIGIN).init();
  assert.equal((await hk.post('/auth/login', { email: 'housekeeper@demo.test', password: DEMO_PASSWORD })).status, 200);
  assert.equal((await hk.post(`/reservations/${stay.id}/move-preview`, { arrival: addDays(today, 51), departure: addDays(today, 52) })).status, 403);
});
