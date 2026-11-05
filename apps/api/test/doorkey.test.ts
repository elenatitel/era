import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import { Client, startDatabase } from "./harness.js";
let db: Awaited<ReturnType<typeof startDatabase>>,
  app: INestApplication,
  base: string,
  owner: Client,
  hk: Client,
  tenantId: string,
  propertyId: string,
  roomId: string;
const token = randomBytes(32).toString("base64url"),
  password = "DoorKey-test-password-123";
let latestScope: any;
const client = () => new Client(base, "http://localhost:3000").init();
async function fixture(status = "checked_in") {
  const room = (
    await db.superQuery<any>(
      "INSERT INTO rooms(tenant_id,property_id,room_type_id,number) SELECT tenant_id,property_id,room_type_id,$2 FROM rooms WHERE id=$1 RETURNING id",
      [roomId, randomUUID()],
    )
  )[0];
  return (
    await db.superQuery<any>(
      `INSERT INTO reservations(tenant_id,property_id,code,guest_id,room_type_id,room_id,rate_plan_id,status,arrival,departure) SELECT tenant_id,property_id,$2,guest_id,room_type_id,$3,rate_plan_id,$4,CURRENT_DATE-1,CURRENT_DATE+3 FROM reservations WHERE property_id=$1 LIMIT 1 RETURNING id,room_id`,
      [propertyId, randomUUID(), room.id, status],
    )
  )[0];
}
async function validate(scope = latestScope, credential = token) {
  const r = await fetch(base + "/api/internal/doorkey/validate", {
    method: "POST",
    headers: {
      authorization: "Bearer " + credential,
      "content-type": "application/json",
    },
    body: JSON.stringify(scope),
  });
  return { status: r.status, body: await r.json() };
}
before(async () => {
  db = await startDatabase();
  const { runMigrations } = await import("../src/db/migrate.js");
  await runMigrations(
    db.ownerUrl,
    db.appUrl,
    fileURLToPath(new URL("../../drizzle", import.meta.url)),
  );
  Object.assign(process.env, {
    NODE_ENV: "test",
    AUTH_PROVIDER: "local",
    DATABASE_URL: db.appUrl,
    JWT_SECRET: randomBytes(32).toString("hex"),
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    WEB_ORIGIN: "http://localhost:3000",
    COOKIE_SECURE: "false",
    LOG_LEVEL: "error",
    TRUST_PROXY: "0",
    DOORKEY_SERVICE_TOKEN: token,
  });
  const { createApp } = await import("../src/bootstrap.js"),
    { DbService } = await import("../src/db/db.service.js"),
    { seedDemo } = await import("../src/db/seed.js"),
    { DoorKeyService } = await import("../src/doorkey/doorkey.module.js");
  app = await createApp();
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  await seedDemo(app.get(DbService), password);
  owner = await client();
  await owner.post("/auth/login", { email: "owner@demo.test", password });
  hk = await client();
  await hk.post("/auth/login", { email: "housekeeper@demo.test", password });
  const p = (await owner.get("/properties")).body[0];
  propertyId = p.id;
  tenantId = p.tenantId;
  roomId = (await owner.get("/rooms?propertyId=" + propertyId)).body[0].id;
  // No manager or physical door calls: exercise the complete ERA auth, RLS and lifecycle boundary.
  app.get(DoorKeyService).manager = async (path, body?: any) => {
    if (path === "/internal/invitations") {
      latestScope = body;
      assert.equal((await validate(body)).status, 200);
      return {
        url:
          "https://keys.example.com/enroll#invite=" +
          randomBytes(32).toString("base64url"),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      };
    }
    if (path.startsWith("/internal/access/")) return { devices: [] };
    return { saved: true };
  };
});
after(async () => {
  await app?.close();
  await db?.stop();
});
test("ERA issues a QR only after check-in and native callback requires the service token", async () => {
  const f = await fixture("confirmed");
  assert.equal(
    (await owner.post(`/reservations/${f.id}/doorkey/invitations`)).status,
    422,
  );
  await db.superQuery(
    "UPDATE reservations SET status='checked_in' WHERE id=$1",
    [f.id],
  );
  const r = await owner.post(`/reservations/${f.id}/doorkey/invitations`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.qr.startsWith("data:image/png;base64,"));
  assert.equal((await validate(latestScope, "wrong")).status, 401);
  assert.equal((await validate()).status, 200);
  assert.equal(
    (await hk.post(`/reservations/${f.id}/doorkey/invitations`)).status,
    403,
  );
  assert.equal(
    (
      await owner.req(
        "POST",
        `/reservations/${f.id}/doorkey/invitations`,
        {},
        { csrf: false },
      )
    ).status,
    403,
  );
  assert.equal(
    (await validate({ ...latestScope, tenantId: randomUUID() })).status,
    401,
  );
  assert.equal(
    (await validate({ ...latestScope, roomId: roomId })).status,
    401,
  );
});
test("revocation and reissue change the access version so old permits and pending QRs stay invalid", async () => {
  const f = await fixture();
  await owner.post(`/reservations/${f.id}/doorkey/invitations`);
  const original = { ...latestScope };
  assert.equal(
    (await owner.post(`/reservations/${f.id}/doorkey/revoke`)).status,
    200,
  );
  assert.equal((await validate(original)).status, 401);
  await owner.post(`/reservations/${f.id}/doorkey/invitations`);
  assert.ok(latestScope.version > original.version);
  assert.equal((await validate(original)).status, 401);
  assert.equal((await validate()).status, 200);
});
test("checkout, cancellation, room moves, tenant suspension and shortened dates are enforced on each use", async () => {
  for (const terminal of ["checked_out", "cancelled", "no_show"]) {
    const f = await fixture();
    await owner.post(`/reservations/${f.id}/doorkey/invitations`);
    const s = { ...latestScope };
    await db.superQuery("UPDATE reservations SET status=$2 WHERE id=$1", [
      f.id,
      terminal,
    ]);
    assert.equal((await validate(s)).status, 401);
    await db.superQuery(
      "UPDATE reservations SET status='checked_in' WHERE id=$1",
      [f.id],
    );
    assert.equal((await validate(s)).status, 401);
  }
  const f = await fixture();
  await owner.post(`/reservations/${f.id}/doorkey/invitations`);
  const s = { ...latestScope };
  await db.superQuery(
    "UPDATE reservations SET arrival=CURRENT_DATE-5,departure=CURRENT_DATE-1 WHERE id=$1",
    [f.id],
  );
  assert.equal((await validate(s)).status, 401);
  await db.superQuery(
    "UPDATE reservations SET departure=CURRENT_DATE+5 WHERE id=$1",
    [f.id],
  );
  assert.equal((await validate(s)).status, 200);
  await db.superQuery("UPDATE tenants SET status='suspended' WHERE id=$1", [
    tenantId,
  ]);
  assert.equal((await validate(s)).status, 401);
  await db.superQuery("UPDATE tenants SET status='active' WHERE id=$1", [
    tenantId,
  ]);
  await db.superQuery("UPDATE reservations SET room_id=NULL WHERE id=$1", [
    f.id,
  ]);
  assert.equal((await validate(s)).status, 401);
});
test("legacy browser PIN endpoints are disabled by default and DoorKey access is RLS isolated", async () => {
  assert.equal((await owner.get(`/rooms/${roomId}/door`)).status, 410);
  assert.equal(
    (
      await (
        await client()
      ).post("/public/doors/" + "x".repeat(43) + "/session", { pin: "123456" })
    ).status,
    410,
  );
  const pg = (await import("pg")).default,
    c = new pg.Client({ connectionString: db.appUrl });
  await c.connect();
  try {
    assert.equal(
      (await c.query("SELECT count(*)::int AS n FROM doorkey_access")).rows[0]
        .n,
      0,
    );
  } finally {
    await c.end();
  }
  const { checkoutEpoch } = await import("../src/doorkey/doorkey.module.js");
  assert.equal(
    checkoutEpoch("2026-10-24", "12:00", "Europe/Bucharest"),
    Date.parse("2026-10-24T09:00:00Z") / 1000,
  );
  assert.equal(
    checkoutEpoch("2026-10-25", "12:00", "Europe/Bucharest"),
    Date.parse("2026-10-25T10:00:00Z") / 1000,
  );
});
