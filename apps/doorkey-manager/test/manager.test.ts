import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import type { Server } from "node:http";
import { startDatabase } from "./harness.js";
import { migrate } from "../src/migrate.js";
import { createManager, type Stay } from "../src/app.js";
import {
  approval,
  doorBytes,
  hash,
  issuerKey,
  publicKey,
  rawPublic,
  signature,
  verifies,
} from "../src/crypto.js";
let db: Awaited<ReturnType<typeof startDatabase>>,
  pool: pg.Pool,
  server: Server,
  base: string;
const scalar = () => {
  const e = createECDH("prime256v1");
  e.generateKeys();
  return e.getPrivateKey().toString("hex");
};
const issuer = issuerKey(scalar()),
  door = issuerKey(scalar()),
  phone = issuerKey(scalar()),
  otherPhone = issuerKey(scalar());
const tenantId = randomUUID(),
  roomId = randomUUID(),
  reservationId = randomUUID(),
  token = randomBytes(32).toString("base64url");
let active = true,
  version = 1,
  until = Math.floor(Date.now() / 1000) + 3 * 86400,
  deviceId: string,
  encoded: string;
const stay: Stay = { tenantId, roomId, reservationId, version: 1 };
async function req(path: string, body?: unknown, auth = true) {
  const r = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
}
function redemption(invite: string, key = phone) {
  const pub = rawPublic(key);
  return {
    invite,
    publicKey: pub.toString("hex"),
    signature: signature(
      key,
      Buffer.concat([
        Buffer.from("DoorKey-redeem-v1"),
        Buffer.from(invite),
        pub,
      ]),
    ).toString("hex"),
  };
}
function authRequest(p = encoded, phoneKey = phone) {
  const nonce = randomBytes(16);
  const msg = Buffer.concat([doorBytes(12), nonce]);
  const challenge = Buffer.concat([
    msg,
    signature(door, Buffer.concat([Buffer.from("DoorKey-door-v1"), msg])),
  ]);
  return {
    permit: p,
    challenge: challenge.toString("hex"),
    signature: signature(
      phoneKey,
      Buffer.concat([
        Buffer.from("DoorKey-authorize-v2"),
        hash(Buffer.from(p, "base64")),
        challenge,
      ]),
    ).toString("hex"),
  };
}
before(async () => {
  db = await startDatabase();
  await migrate(db.ownerUrl, db.appUrl);
  await migrate(db.ownerUrl, db.appUrl);
  pool = new pg.Pool({ connectionString: db.appUrl });
  const app = createManager({
    pool,
    issuer,
    serviceToken: token,
    publicUrl: "https://keys.example.com",
    trustProxy: 0,
    validate: async (s) => {
      if (
        !active ||
        s.tenantId !== tenantId ||
        s.roomId !== roomId ||
        s.reservationId !== reservationId ||
        s.version !== version
      )
        throw Object.assign(new Error("Denied"), { status: 401 });
      return { validUntil: until };
    },
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await pool?.end();
  await db?.stop();
});
test("health/config are public, internal APIs require service credential, no legacy signing oracle", async () => {
  assert.equal((await req("/health", undefined, false)).status, 200);
  const cfg = await req("/v1/config", undefined, false);
  assert.equal(cfg.body.protocol, 2);
  assert.equal(cfg.body.issuerPublicKey, rawPublic(issuer).toString("hex"));
  assert.equal((await req("/internal/doors", {}, false)).status, 401);
  assert.equal((await fetch(base + "/time", { method: "POST" })).status, 404);
  assert.equal((await fetch(base + "/permit", { method: "POST" })).status, 404);
});
test("reader mapping is unique and immutable; configuration never signs or issues a permit", async () => {
  const b = {
    tenantId,
    roomId,
    wireId: 12,
    publicKey: rawPublic(door).toString("hex"),
    name: "Door-12",
    enabled: true,
  };
  assert.equal((await req("/internal/doors", b)).status, 200);
  assert.equal(
    (await req("/internal/doors", { ...b, name: "Room 12" })).status,
    200,
  );
  assert.equal(
    (await req("/internal/doors", { ...b, wireId: 13 })).status,
    409,
  );
  assert.equal(
    (
      await req("/internal/doors", {
        ...b,
        tenantId: randomUUID(),
        roomId: randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM dk_permits")).rows[0].n,
    0,
  );
});
test("single-use QR binds a signed permit to the phone key, with proof of possession and stay validity", async () => {
  const invite = await req("/internal/invitations", stay);
  assert.equal(invite.status, 200);
  const t = new URL(invite.body.url).hash.slice("#invite=".length);
  const bad = redemption(t);
  bad.signature = "00".repeat(64);
  assert.equal((await req("/v1/redeem", bad, false)).status, 401);
  const redeemed = await req("/v1/redeem", redemption(t), false);
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
  encoded = redeemed.body.permit;
  deviceId = redeemed.body.deviceId;
  const bytes = Buffer.from(encoded, "base64");
  assert.equal(bytes.length, 150);
  assert.equal(bytes.readUInt32LE(1), 12);
  assert.deepEqual(bytes.subarray(21, 86), rawPublic(phone));
  assert.equal(Number(bytes.readBigUInt64LE(13)), until);
  assert.ok(
    verifies(
      publicKey(rawPublic(issuer).toString("hex")),
      bytes.subarray(0, 86),
      bytes.subarray(86).toString("hex"),
    ),
  );
  assert.equal((await req("/v1/redeem", redemption(t), false)).status, 401);
  const row = (await pool.query("SELECT * FROM dk_invites")).rows[0];
  assert.ok(row.redeemed_at);
  assert.ok(!JSON.stringify(row).includes(t));
});
test("approval requires both door and phone proofs; V2 signature is permit-bound and rejects replay", async () => {
  assert.equal(
    (await req("/v1/authorize", authRequest(encoded, otherPhone), false))
      .status,
    401,
  );
  const b = authRequest();
  const damaged = { ...b, challenge: "00" + b.challenge.slice(2) };
  assert.equal((await req("/v1/authorize", damaged, false)).status, 401);
  const r = await req("/v1/authorize", b, false);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const proof = Buffer.from(r.body.timeProof, "base64");
  const nonce = Buffer.from(b.challenge, "hex").subarray(4, 20);
  const message = Buffer.concat([
    Buffer.from("DoorKey-time-v2"),
    doorBytes(12),
    nonce,
    proof.subarray(0, 8),
    hash(Buffer.from(encoded, "base64")),
  ]);
  assert.ok(
    verifies(
      publicKey(rawPublic(issuer).toString("hex")),
      message,
      proof.subarray(8).toString("hex"),
    ),
  );
  assert.equal((await req("/v1/authorize", b, false)).status, 401);
});
test("every authorization and enrollment rechecks ERA; revoked stay and changed grant version fail closed", async () => {
  active = false;
  assert.equal((await req("/v1/authorize", authRequest(), false)).status, 401);
  assert.equal((await req("/internal/invitations", stay)).status, 401);
  active = true;
  version++;
  assert.equal((await req("/v1/authorize", authRequest(), false)).status, 401);
  version--;
  until = Math.floor(Date.now() / 1000) - 1;
  assert.equal((await req("/v1/authorize", authRequest(), false)).status, 401);
  until += 86400;
});
test("specific-device revocation and disabled readers prevent authorization", async () => {
  const r = await req("/internal/access/" + tenantId + "/" + reservationId);
  assert.equal(r.body.devices.length, 1);
  assert.ok(!JSON.stringify(r.body).includes(encoded));
  await req("/internal/doors", {
    tenantId,
    roomId,
    wireId: 12,
    publicKey: rawPublic(door).toString("hex"),
    name: "Door-12",
    enabled: false,
  });
  assert.equal((await req("/v1/authorize", authRequest(), false)).status, 401);
  await req("/internal/doors", {
    tenantId,
    roomId,
    wireId: 12,
    publicKey: rawPublic(door).toString("hex"),
    name: "Door-12",
    enabled: true,
  });
  await req("/internal/revoke", { tenantId, reservationId, deviceId });
  assert.equal((await req("/v1/authorize", authRequest(), false)).status, 401);
});
test("expired QR and malformed key/body are refused; audit is append-only for runtime", async () => {
  const invite = await req("/internal/invitations", stay);
  const t = new URL(invite.body.url).hash.slice(8);
  await pool.query(
    "UPDATE dk_invites SET expires_at=now()-interval '1 second'",
  );
  assert.equal((await req("/v1/redeem", redemption(t), false)).status, 401);
  assert.equal(
    (await req("/v1/redeem", { ...redemption(t), extra: "x" }, false)).status,
    422,
  );
  await assert.rejects(
    () => pool.query("DELETE FROM dk_audit"),
    /permission denied/,
  );
});
