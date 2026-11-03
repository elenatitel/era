import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { Client, startDatabase } from './harness.js';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'Door-test-password-123';
let db: Awaited<ReturnType<typeof startDatabase>>;
let app: INestApplication;
let base: string;
let owner: Client;
let frontdesk: Client;
let propertyId: string;
let roomId: string;
let room2Id: string;
let tenantId: string;
let calls: { url: string; token: string; entity?: string }[] = [];
let fail = false;
const client = () => new Client(base, ORIGIN).init();
async function login(email: string) {
  const c = await client();
  assert.equal((await c.post('/auth/login', { email, password: PASSWORD })).status, 200);
  return c;
}
async function clearRates() {
  await db.superQuery('delete from door_rate_limits');
}
async function fixture(status = 'checked_in') {
  // A fresh isolated room per reservation avoids any overlap with demo stays.
  const room = (
    await db.superQuery<any>(
      `insert into rooms(tenant_id,property_id,room_type_id,number) select tenant_id,property_id,room_type_id,$2 from rooms where id=$1 returning *`,
      [roomId, randomUUID()],
    )
  )[0];
  const cfg = await owner.put(`/rooms/${room.id}/door`, {
    entityId: 'lock.test_room',
    enabled: true,
  });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.body));
  const info = (await owner.get(`/rooms/${room.id}/door`)).body;
  const r = (
    await db.superQuery<any>(
      `insert into reservations(tenant_id,property_id,code,guest_id,room_type_id,room_id,rate_plan_id,status,arrival,departure) select tenant_id,property_id,$2,guest_id,room_type_id,$3,rate_plan_id,$4,CURRENT_DATE-1,CURRENT_DATE+2 from reservations where property_id=$1 limit 1 returning id`,
      [propertyId, randomUUID(), room.id, status],
    )
  )[0];
  const issue = await frontdesk.post(`/reservations/${r.id}/door-access/pin`);
  assert.equal(issue.status, 200, JSON.stringify(issue.body));
  return {
    id: r.id,
    roomId: room.id,
    pin: issue.body.pin,
    publicId: info.url.split('/').at(-1),
    url: info.url,
  };
}
before(async () => {
  db = await startDatabase();
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations(db.ownerUrl, db.appUrl, fileURLToPath(new URL('../../drizzle', import.meta.url)));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    AUTH_PROVIDER: 'local',
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
  const { HomeAssistantService } = await import('../src/doors/homeassistant.service.js');
  app = await createApp();
  app.get(HomeAssistantService).call = async (url: string, token: string, entity?: string) => {
    calls.push({ url, token, entity });
    if (fail) throw new (await import('@nestjs/common')).ServiceUnavailableException('Simulated timeout');
  };
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  await seedDemo(app.get(DbService), PASSWORD);
  owner = await login('owner@demo.test');
  frontdesk = await login('frontdesk@demo.test');
  const p = (await owner.get('/properties')).body[0];
  propertyId = p.id;
  tenantId = p.tenantId;
  const rs = (await owner.get('/rooms?propertyId=' + propertyId)).body;
  roomId = rs[0].id;
  room2Id = rs[1].id;
  assert.equal(
    (
      await owner.put(`/properties/${propertyId}/home-assistant`, {
        url: 'https://ha.example.com',
        token: 'test-ha-token-private',
        enabled: true,
      })
    ).status,
    200,
  );
});
after(async () => {
  await app?.close();
  await db?.stop();
});

test('connection test does not issue a door action; API never discloses the token', async () => {
  calls = [];
  const result = await owner.post(`/properties/${propertyId}/home-assistant/test`);
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.entity, undefined);
  const config = await owner.get(`/properties/${propertyId}/home-assistant`);
  assert.equal(config.body.tokenConfigured, true);
  assert.ok(!JSON.stringify(config.body).includes('test-ha-token-private'));
  const rows = await db.superQuery<any>('select token_enc from door_integrations');
  assert.ok(rows[0].token_enc.startsWith('v1.'));
  assert.ok(!rows[0].token_enc.includes('test-ha-token-private'));
  assert.ok(!JSON.stringify((await owner.get('/properties')).body).includes('tokenEnc'));
  assert.equal((await frontdesk.get(`/properties/${propertyId}/home-assistant`)).status, 403);
});
test('URL/entity validation rejects SSRF shapes, reserved script services and arbitrary domains', async () => {
  for (const url of [
    'http://ha.example.com',
    'https://127.0.0.1',
    'https://ha.example.com:8443',
    'https://ha.example.com/api',
    'https://u:p@ha.example.com',
  ])
    assert.equal(
      (
        await owner.put(`/properties/${propertyId}/home-assistant`, {
          url,
          token: 'test-ha-token-private',
          enabled: true,
        })
      ).status,
      422,
      url,
    );
  for (const entityId of [
    'script.turn_on',
    'script.turn_off',
    'script.toggle',
    'script.reload',
    'switch.room',
    'lock.room/../all',
  ])
    assert.equal((await owner.put(`/rooms/${roomId}/door`, { entityId, enabled: true })).status, 422, entityId);
  const { HomeAssistantService } = await import('../src/doors/homeassistant.service.js');
  await assert.rejects(() => new HomeAssistantService().call('https://localhost', 'secret'), /public HTTPS/);
});
test('QR requires a PIN; activation never unlocks; three phones can use the reusable PIN', async () => {
  await clearRates();
  const f = await fixture();
  calls = [];
  const phones = await Promise.all([client(), client(), client()]);
  assert.equal((await phones[0]!.get(`/public/doors/${f.publicId}/session`)).status, 401);
  assert.equal((await phones[0]!.post(`/public/doors/${f.publicId}/unlock`)).status, 401);
  for (const c of phones)
    assert.equal((await c.post(`/public/doors/${f.publicId}/session`, { pin: f.pin })).status, 200);
  assert.equal(calls.length, 0);
  const key = phones[0]!.cookies.get('pms_door');
  assert.ok(key);
  const raw = await db.superQuery<any>('select pin_mac from door_grants where reservation_id=$1', [f.id]);
  assert.notEqual(raw[0].pin_mac, f.pin);
  const opened = await phones[0]!.post(`/public/doors/${f.publicId}/unlock`);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.entity, 'lock.test_room');
  assert.equal((await phones[1]!.post(`/public/doors/${f.publicId}/unlock`)).status, 429);
  const r = await db.superQuery<any>('select status,checked_in_at from reservations where id=$1', [f.id]);
  assert.equal(r[0].status, 'checked_in');
  assert.equal(r[0].checked_in_at, null);
});
test('PIN cannot activate before check-in or after the property checkout hour', async () => {
  await clearRates();
  const f = await fixture('confirmed');
  const c = await client();
  assert.equal((await c.post(`/public/doors/${f.publicId}/session`, { pin: f.pin })).status, 401);
  const { doorWindowActive } = await import('../src/doors/doors.service.js');
  const r = {
    status: 'checked_in',
    arrival: '2026-10-24',
    departure: '2026-10-25',
  };
  const p = { timezone: 'Europe/Bucharest', checkOutTime: '12:00' };
  assert.equal(doorWindowActive(r, p, new Date('2026-10-25T09:59:00Z')), true);
  assert.equal(doorWindowActive(r, p, new Date('2026-10-25T10:00:00Z')), false);
});
test('wrong PINs are limited by persisted counters even after staff session changes', async () => {
  await clearRates();
  const f = await fixture();
  const c = await client();
  const wrong = f.pin === '000000' ? '000001' : '000000';
  for (let i = 0; i < 10; i++)
    assert.equal((await c.post(`/public/doors/${f.publicId}/session`, { pin: wrong })).status, 401);
  assert.equal((await c.post(`/public/doors/${f.publicId}/session`, { pin: f.pin })).status, 429);
  assert.ok((await db.superQuery<any>('select attempts from door_rate_limits where attempts>10')).length);
});
test('device revocation, PIN rotation and whole-stay revocation invalidate old keys', async () => {
  await clearRates();
  const f = await fixture();
  const c = await client();
  await c.post(`/public/doors/${f.publicId}/session`, { pin: f.pin });
  const access = (await frontdesk.get(`/reservations/${f.id}/door-access`)).body;
  assert.equal(access.devices.length, 1);
  await frontdesk.post(`/reservations/${f.id}/door-access/devices/${access.devices[0].id}/revoke`);
  assert.equal((await c.get(`/public/doors/${f.publicId}/session`)).status, 401);
  await c.post(`/public/doors/${f.publicId}/session`, { pin: f.pin });
  const rotated = await frontdesk.post(`/reservations/${f.id}/door-access/pin`);
  assert.equal((await c.get(`/public/doors/${f.publicId}/session`)).status, 401);
  assert.equal((await c.post(`/public/doors/${f.publicId}/session`, { pin: f.pin })).status, 401);
  assert.equal(
    (
      await c.post(`/public/doors/${f.publicId}/session`, {
        pin: rotated.body.pin,
      })
    ).status,
    200,
  );
  await frontdesk.post(`/reservations/${f.id}/door-access/revoke`);
  assert.equal((await c.get(`/public/doors/${f.publicId}/session`)).status, 401);
});
test('checkout/cancellation and room changes permanently revoke keys at the database boundary', async () => {
  for (const status of ['checked_out', 'cancelled', 'no_show']) {
    await clearRates();
    const f = await fixture();
    const c = await client();
    await c.post(`/public/doors/${f.publicId}/session`, { pin: f.pin });
    await db.superQuery('update reservations set status=$2 where id=$1', [f.id, status]);
    assert.equal((await c.get(`/public/doors/${f.publicId}/session`)).status, 401);
    await db.superQuery("update reservations set status='checked_in' where id=$1", [f.id]);
    assert.equal((await c.post(`/public/doors/${f.publicId}/session`, { pin: f.pin })).status, 401);
  }
  await clearRates();
  const f = await fixture();
  await db.superQuery('update reservations set room_id=null where id=$1', [f.id]);
  await db.superQuery('update reservations set room_id=$2 where id=$1', [f.id, f.roomId]);
  assert.equal((await (await client()).post(`/public/doors/${f.publicId}/session`, { pin: f.pin })).status, 401);
});
test('shortening/extension is rechecked on each use, without trusting cookie expiry', async () => {
  await clearRates();
  const f = await fixture();
  const c = await client();
  await c.post(`/public/doors/${f.publicId}/session`, { pin: f.pin });
  await db.superQuery('update reservations set arrival=CURRENT_DATE-3,departure=CURRENT_DATE-1 where id=$1', [f.id]);
  assert.equal((await c.get(`/public/doors/${f.publicId}/session`)).status, 401);
  await db.superQuery('update reservations set departure=CURRENT_DATE+4 where id=$1', [f.id]);
  assert.equal((await c.get(`/public/doors/${f.publicId}/session`)).status, 200);
});
test('HA failure returns no success and is not retried; script and lock mapping stay server-side', async () => {
  await clearRates();
  const f = await fixture();
  await owner.put(`/rooms/${f.roomId}/door`, {
    entityId: 'script.test_pulse',
    enabled: true,
  });
  const issued = (await frontdesk.post(`/reservations/${f.id}/door-access/pin`)).body;
  const c = await client();
  await c.post(`/public/doors/${f.publicId}/session`, { pin: issued.pin });
  calls = [];
  fail = true;
  assert.equal((await c.post(`/public/doors/${f.publicId}/unlock`)).status, 503);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.entity, 'script.test_pulse');
  assert.equal((await c.post(`/public/doors/${f.publicId}/unlock`)).status, 429);
  assert.equal(calls.length, 1);
  fail = false;
});
test('guest keys are room scoped; no Keycloak or guest-portal cookie can substitute; CSRF enforced', async () => {
  await clearRates();
  const f = await fixture();
  const other = await fixture();
  const c = await client();
  await c.post(`/public/doors/${f.publicId}/session`, { pin: f.pin });
  assert.equal((await c.get(`/public/doors/${other.publicId}/session`)).status, 401);
  assert.equal((await c.req('POST', `/public/doors/${f.publicId}/unlock`, {}, { csrf: false })).status, 403);
  const outsider = await client();
  outsider.cookies.set('pms_guest', c.cookies.get('pms_door')!);
  assert.equal((await outsider.get(`/public/doors/${f.publicId}/session`)).status, 401);
  assert.equal((await c.post(`/public/doors/${f.publicId}/forget`)).status, 200);
  assert.equal((await c.get(`/public/doors/${f.publicId}/session`)).status, 401);
});
test('property restrictions, tenant RLS and housekeeping permissions protect settings and PINs', async () => {
  const hk = await login('housekeeper@demo.test');
  assert.equal((await hk.get(`/rooms/${roomId}/door`)).status, 403);
  const f = await fixture();
  assert.equal((await hk.post(`/reservations/${f.id}/door-access/pin`)).status, 403);
  const restricted = await login('manager@demo.test');
  const uid = (await restricted.get('/auth/me')).body.user.id;
  await db.superQuery('update memberships set property_ids=ARRAY[$2::uuid] where user_id=$1', [uid, randomUUID()]);
  assert.equal((await restricted.get(`/properties/${propertyId}/home-assistant`)).status, 403);
  assert.equal((await restricted.get(`/rooms/${roomId}/door`)).status, 403);
  assert.equal((await restricted.get(`/reservations/${f.id}/door-access`)).status, 403);
  const pg = (await import('pg')).default;
  const conn = new pg.Client({ connectionString: db.appUrl });
  await conn.connect();
  try {
    for (const table of ['door_integrations', 'door_rooms', 'door_grants', 'door_devices'])
      assert.equal((await conn.query(`select count(*)::int as n from ${table}`)).rows[0].n, 0);
  } finally {
    await conn.end();
  }
});
