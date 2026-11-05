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

test('the home follows a room from the guest leaving to the next one arriving', async () => {
  const mgr = await new Client(base, ORIGIN).init();
  assert.equal((await mgr.post('/auth/login', { email: 'manager@demo.test', password: DEMO_PASSWORD })).status, 200);
  const [property] = (await mgr.get('/properties')).body as { id: string; businessDate: string }[];
  const today = property!.businessDate;
  const q = `propertyId=${property!.id}`;

  // One room type left to work with, all of it clean, empty and unbooked.
  await db.superQuery(`DELETE FROM reservations`);
  const search = (await mgr.get(`/availability?${q}&arrival=${today}&departure=${addDays(today, 2)}&adults=2`)).body;
  const offer = search.roomTypes.find((t: any) => t.available >= 3 && t.fitsOccupancy && t.offers.some((o: any) => o.sellable));
  const plan = offer.offers.find((o: any) => o.sellable);
  const rooms = ((await mgr.get(`/rooms?${q}`)).body as { id: string; number: string; roomTypeId: string }[]).filter((r) => r.roomTypeId === offer.roomType.id);
  const [leavingRoom, emptyRoom, cleanRoom] = rooms;
  await db.superQuery(`UPDATE rooms SET status = 'clean', occupancy = 'vacant'`);
  const others = rooms.slice(3).map((r) => `'${r.id}'`).join(',');
  if (others) await db.superQuery(`UPDATE rooms SET status = 'out_of_order' WHERE id IN (${others})`);
  const book = async (lastName: string, departure: string) => {
    const res = await mgr.post('/reservations', { propertyId: property!.id, roomTypeId: offer.roomType.id, ratePlanId: plan.ratePlanId, arrival: today, departure, adults: 2, guest: { firstName: 'Test', lastName } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.id as string;
  };

  // A guest who slept here last night and leaves today.
  const leaving = await book('Pleaca', addDays(today, 1));
  assert.equal((await mgr.post(`/reservations/${leaving}/check-in`, { roomId: leavingRoom!.id })).status, 200);
  await db.superQuery(`UPDATE reservations SET arrival = $1, departure = $2 WHERE id = $3`, [addDays(today, -1), today, leaving]);

  await db.superQuery(`UPDATE rooms SET status = 'out_of_order' WHERE id IN ('${emptyRoom!.id}', '${cleanRoom!.id}')`);
  const arrival = await book('Soseste', addDays(today, 2));
  const house = async () => (await mgr.get(`/dashboard/house?${q}`)).body;

  let h = await house();
  let [pick] = h.suggestions;
  assert.equal(pick.roomId, leavingRoom!.id, 'the only room left');
  assert.deepEqual([pick.step, pick.leavingGuest], ['leaving', 'Test Pleaca']);
  // Now the room holds a guest; tonight it holds only the arrival.
  assert.equal(h.counts.occupied, 1);
  assert.equal(h.counts.tonight, 1);
  assert.equal(h.counts.freeTonight, h.counts.sellable - 1);
  assert.equal(h.counts.departuresLeft, 1);

  await db.superQuery(`UPDATE rooms SET status = 'dirty' WHERE id = '${emptyRoom!.id}'`);
  h = await house();
  [pick] = h.suggestions;
  assert.deepEqual([pick.roomId, pick.step, pick.leavingGuest], [emptyRoom!.id, 'cleaning', null], 'empty beats still occupied');

  await db.superQuery(`UPDATE rooms SET status = 'clean' WHERE id = '${cleanRoom!.id}'`);
  h = await house();
  [pick] = h.suggestions;
  assert.deepEqual([pick.roomId, pick.step], [cleanRoom!.id, 'ready'], 'ready beats everything');

  // Two arrivals are never promised the same room.
  await book('Doi', addDays(today, 2));
  h = await house();
  assert.equal(h.suggestions.length, 2);
  assert.notEqual(h.suggestions[0].roomId, h.suggestions[1].roomId);
  assert.equal(h.counts.tonight, 2);

  // Once assigned to the room still in use, the arrival shows what it is waiting for.
  assert.equal((await mgr.patch(`/reservations/${arrival}`, { roomId: leavingRoom!.id })).status, 200);
  h = await house();
  const coming = h.arrivals.find((a: any) => a.reservationId === arrival);
  assert.equal(coming.roomStep, 'leaving');
  const room = h.rooms.find((r: any) => r.id === leavingRoom!.id);
  assert.equal(room.state, 'in_house');
  assert.equal(room.arrival.reservationId, arrival);
  assert.equal(room.stay.departsToday, true);
});
