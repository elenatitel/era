import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomBytes, type KeyObject } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import {
  approval,
  doorBytes,
  equal,
  hash,
  permit,
  publicKey,
  rawPublic,
  signature,
  verifies,
} from "./crypto.js";
export type Stay = {
  tenantId: string;
  roomId: string;
  reservationId: string;
  version: number;
};
export type LiveStay = { validUntil: number; roomName?: string; propertyName?: string; timezone?: string };
export type Options = {
  pool: pg.Pool;
  issuer: KeyObject;
  serviceToken: string;
  publicUrl: string;
  trustProxy: number;
  validate: (stay: Stay) => Promise<LiveStay>;
};
const uuid = z.uuid();
const hex = z
  .string()
  .regex(/^04[0-9a-f]{128}$/i)
  .transform((x) => x.toLowerCase());
const proof = z.string().regex(/^[0-9a-f]{128}$/i);
const scope = z.object({
  tenantId: uuid,
  roomId: uuid,
  reservationId: uuid,
  version: z.number().int().positive(),
});
const invalid = () =>
  Object.assign(new Error("Access invalid, expired or revoked"), {
    status: 401,
  });
export function createManager(o: Options) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", o.trustProxy);
  app.use(express.json({ limit: "8kb", strict: true }));
  app.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    });
    next();
  });
  app.get("/health", async (_req, res) => {
    await o.pool.query("SELECT 1");
    res.json({ status: "ok" });
  });
  app.get("/v1/config", (_req, res) =>
    res.json({
      protocol: 2,
      issuerPublicKey: rawPublic(o.issuer).toString("hex"),
    }),
  );
  // No cookies are accepted; internal APIs require a separate, constant-time checked service credential.
  app.use("/internal", (req, res, next) => {
    if (!equal(req.headers.authorization ?? "", `Bearer ${o.serviceToken}`)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });
  async function rate(key: string, limit: number) {
    const r = await o.pool.query(
      `INSERT INTO dk_rates(key,bucket,attempts) VALUES($1,$2,1)
   ON CONFLICT(key) DO UPDATE SET bucket=excluded.bucket,attempts=CASE WHEN dk_rates.bucket=excluded.bucket THEN dk_rates.attempts+1 ELSE 1 END RETURNING attempts`,
      [hash(key), Math.floor(Date.now() / 60000)],
    );
    if (randomBytes(1)[0] === 0) {
      await o.pool.query("DELETE FROM dk_rates WHERE bucket<$1", [
        Math.floor(Date.now() / 60000) - 2,
      ]);
      await o.pool.query(
        "DELETE FROM dk_invites WHERE expires_at<now()-interval '1 day'",
      );
    }
    if (r.rows[0].attempts > limit)
      throw Object.assign(new Error("Too many attempts"), { status: 429 });
  }
  app.use("/v1", async (req, _res, next) => {
    try {
      if (req.method === "POST") await rate("ip:" + req.ip, 120);
      next();
    } catch (e) {
      next(e);
    }
  });
  app.post("/internal/doors", async (req, res) => {
    const b = z
      .object({
        tenantId: uuid,
        roomId: uuid,
        wireId: z.number().int().min(1).max(0xffffffff),
        publicKey: hex,
        name: z.string().trim().min(1).max(29),
        enabled: z.boolean(),
      })
      .strict()
      .parse(req.body);
    try {
      publicKey(b.publicKey);
    } catch {
      throw Object.assign(new Error("Invalid key"), { status: 422 });
    }
    // A room cannot be silently moved onto a different reader/key. Explicitly disable/revoke before replacement.
    const r = await o.pool.query(
      `INSERT INTO dk_doors(tenant_id,room_id,wire_id,public_key,name,enabled) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(tenant_id,room_id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled
    WHERE dk_doors.wire_id=excluded.wire_id AND dk_doors.public_key=excluded.public_key RETURNING id`,
      [b.tenantId, b.roomId, b.wireId, b.publicKey, b.name, b.enabled],
    );
    if (!r.rowCount) {
      res
        .status(409)
        .json({
          error:
            "Reader identity is immutable. Revoke access before replacing hardware.",
        });
      return;
    }
    await o.pool.query("INSERT INTO dk_audit(event,subject_id) VALUES($1,$2)", [
      "door.configured",
      r.rows[0].id,
    ]);
    res.json({ saved: true });
  });
  app.get("/internal/doors/:tenantId/:roomId", async (req, res) => {
    const tenantId = uuid.parse(req.params.tenantId),
      roomId = uuid.parse(req.params.roomId);
    const r = await o.pool.query(
      "SELECT wire_id,public_key,name,enabled FROM dk_doors WHERE tenant_id=$1 AND room_id=$2",
      [tenantId, roomId],
    );
    const d = r.rows[0];
    res.json(
      d
        ? {
            wireId: Number(d.wire_id),
            publicKey: d.public_key,
            name: d.name,
            enabled: d.enabled,
          }
        : null,
    );
  });
  app.post("/internal/invitations", async (req, res) => {
    const b = scope.strict().parse(req.body);
    await o.validate(b);
    const d = await o.pool.query(
      "SELECT id FROM dk_doors WHERE tenant_id=$1 AND room_id=$2 AND enabled",
      [b.tenantId, b.roomId],
    );
    if (!d.rowCount)
      throw Object.assign(new Error("Configure the room reader first"), {
        status: 422,
      });
    await rate("invite:" + b.tenantId + ":" + b.reservationId, 20);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 10 * 60000);
    await o.pool.query(
      "INSERT INTO dk_invites(token_hash,tenant_id,room_id,reservation_id,version,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
      [
        hash(token),
        b.tenantId,
        b.roomId,
        b.reservationId,
        b.version,
        expiresAt,
      ],
    );
    res.json({
      url: `${o.publicUrl}/enroll#invite=${token}`,
      expiresAt: expiresAt.toISOString(),
    });
  });
  app.get("/internal/access/:tenantId/:reservationId", async (req, res) => {
    const r = await o.pool.query(
      `SELECT id,created_at,last_used_at,expires_at,revoked_at,version FROM dk_permits WHERE tenant_id=$1 AND reservation_id=$2 ORDER BY created_at`,
      [uuid.parse(req.params.tenantId), uuid.parse(req.params.reservationId)],
    );
    res.json({
      devices: r.rows.map((d) => ({
        id: d.id,
        version: d.version,
        createdAt: d.created_at,
        lastUsedAt: d.last_used_at,
        expiresAt: d.expires_at,
        revokedAt: d.revoked_at,
      })),
    });
  });
  app.post("/internal/revoke", async (req, res) => {
    const b = z
      .object({
        tenantId: uuid,
        reservationId: uuid,
        deviceId: uuid.optional(),
      })
      .strict()
      .parse(req.body);
    await o.pool.query(
      "UPDATE dk_permits SET revoked_at=now() WHERE tenant_id=$1 AND reservation_id=$2 AND ($3::uuid IS NULL OR id=$3)",
      [b.tenantId, b.reservationId, b.deviceId ?? null],
    );
    res.json({ revoked: true });
  });
  app.post("/v1/redeem", async (req, res) => {
    const b = z
      .object({
        invite: z.string().regex(/^[\w-]{43}$/),
        publicKey: hex,
        signature: proof,
      })
      .strict()
      .parse(req.body);
    let phone: KeyObject;
    try {
      phone = publicKey(b.publicKey);
    } catch {
      throw Object.assign(new Error("Invalid key"), { status: 422 });
    }
    if (
      !verifies(
        phone,
        Buffer.concat([
          Buffer.from("DoorKey-redeem-v1"),
          Buffer.from(b.invite),
          Buffer.from(b.publicKey, "hex"),
        ]),
        b.signature,
      )
    )
      throw invalid();
    const c = await o.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await c.query(
        "SELECT * FROM dk_invites WHERE token_hash=$1 AND redeemed_at IS NULL AND expires_at>now() FOR UPDATE",
        [hash(b.invite)],
      );
      const i = r.rows[0];
      if (!i) throw invalid();
      // Serialize device-count enforcement for all invitations to this reservation.
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        i.reservation_id,
      ]);
      const live = await o.validate({
        tenantId: i.tenant_id,
        roomId: i.room_id,
        reservationId: i.reservation_id,
        version: i.version,
      });
      const dr = await c.query(
        "SELECT * FROM dk_doors WHERE tenant_id=$1 AND room_id=$2 AND enabled FOR SHARE",
        [i.tenant_id, i.room_id],
      );
      const d = dr.rows[0];
      if (!d) throw invalid();
      const count = await c.query(
        "SELECT count(*)::int AS n FROM dk_permits WHERE tenant_id=$1 AND reservation_id=$2 AND version=$3 AND revoked_at IS NULL AND expires_at>now()",
        [i.tenant_id, i.reservation_id, i.version],
      );
      if (count.rows[0].n >= 20) throw invalid();
      const now = Math.floor(Date.now() / 1000);
      const until = Math.min(live.validUntil, now + 30 * 86400);
      if (until <= now) throw invalid();
      const wire = Number(d.wire_id);
      const p = permit(
        o.issuer,
        wire,
        Buffer.from(b.publicKey, "hex"),
        now - 30,
        until,
      );
      const pr = await c.query(
        "INSERT INTO dk_permits(tenant_id,room_id,reservation_id,version,door_id,phone_public_key,permit_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        [
          i.tenant_id,
          i.room_id,
          i.reservation_id,
          i.version,
          d.id,
          b.publicKey,
          hash(p),
          new Date(until * 1000),
        ],
      );
      await c.query(
        "UPDATE dk_invites SET redeemed_at=now() WHERE token_hash=$1",
        [hash(b.invite)],
      );
      await c.query("INSERT INTO dk_audit(event,subject_id) VALUES($1,$2)", [
        "permit.issued",
        pr.rows[0].id,
      ]);
      await c.query("COMMIT");
      const cert = Buffer.concat([
        Buffer.from("DoorKey-device-v1"),
        doorBytes(wire),
        Buffer.from(d.public_key, "hex"),
      ]);
      res.json({
        deviceId: pr.rows[0].id,
        protocol: 2,
        permit: p.toString("base64"),
        validUntil: until,
        room: { name: live.roomName ?? null, propertyName: live.propertyName ?? null, timezone: live.timezone ?? null },
        door: {
          id: wire,
          name: d.name,
          publicKey: d.public_key,
          certificate: signature(o.issuer, cert).toString("base64"),
        },
      });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  });
  app.post("/v1/authorize", async (req, res) => {
    const b = z
      .object({
        permit: z.string().regex(/^[A-Za-z0-9+/]{200}$/),
        challenge: z.string().regex(/^[0-9a-f]{168}$/i),
        signature: proof,
      })
      .strict()
      .parse(req.body);
    const permitBytes = Buffer.from(b.permit, "base64"),
      permitHash = hash(permitBytes),
      challenge = Buffer.from(b.challenge, "hex");
    const r = await o.pool.query(
      `SELECT p.*,d.wire_id,d.public_key AS door_public_key,d.enabled FROM dk_permits p JOIN dk_doors d ON d.id=p.door_id WHERE p.permit_hash=$1`,
      [permitHash],
    );
    const p = r.rows[0];
    if (
      !p ||
      p.revoked_at ||
      !p.enabled ||
      new Date(p.expires_at).getTime() <= Date.now()
    )
      throw invalid();
    const wire = Number(p.wire_id);
    const nonce = challenge.subarray(4, 20);
    if (
      challenge.readUInt32LE(0) !== wire ||
      !verifies(
        publicKey(p.door_public_key),
        Buffer.concat([
          Buffer.from("DoorKey-door-v1"),
          challenge.subarray(0, 20),
        ]),
        challenge.subarray(20).toString("hex"),
      )
    )
      throw invalid();
    if (
      !verifies(
        publicKey(p.phone_public_key),
        Buffer.concat([
          Buffer.from("DoorKey-authorize-v2"),
          permitHash,
          challenge,
        ]),
        b.signature,
      )
    )
      throw invalid();
    const live = await o.validate({
      tenantId: p.tenant_id,
      roomId: p.room_id,
      reservationId: p.reservation_id,
      version: p.version,
    });
    const now = Math.floor(Date.now() / 1000);
    if (live.validUntil <= now) throw invalid();
    const c = await o.pool.connect();
    try {
      await c.query("BEGIN");
      const current = await c.query(
        "SELECT id FROM dk_permits WHERE id=$1 AND revoked_at IS NULL AND expires_at>now() FOR UPDATE",
        [p.id],
      );
      if (!current.rowCount) throw invalid();
      await c.query("DELETE FROM dk_nonces WHERE expires_at<now()");
      const used = await c.query(
        "INSERT INTO dk_nonces(door_id,nonce,expires_at) VALUES($1,$2,now()+interval '10 minutes') ON CONFLICT DO NOTHING RETURNING door_id",
        [p.door_id, nonce],
      );
      if (!used.rowCount) throw invalid();
      await c.query("UPDATE dk_permits SET last_used_at=now() WHERE id=$1", [
        p.id,
      ]);
      await c.query("INSERT INTO dk_audit(event,subject_id) VALUES($1,$2)", [
        "access.authorized",
        p.id,
      ]);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    res.json({
      protocol: 2,
      timeProof: approval(o.issuer, wire, nonce, now, permitHash).toString(
        "base64",
      ),
    });
  });
  // Enrollment links carry secrets in the fragment, never the request/log/query string.
  app.get("/enroll", (_req, res) =>
    res
      .type("text/plain")
      .send(
        "Open this invitation with the DoorKey mobile app. Invitation tokens are single-use and expire after 10 minutes.",
      ),
  );
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const e = error as { status?: number; code?: string };
      const status =
        error instanceof z.ZodError
          ? 422
          : (e.status ?? (e.code === "23505" ? 409 : 503));
      res
        .status(status)
        .json({
          error:
            status === 503
              ? "Service unavailable"
              : status === 422
                ? "Invalid request"
                : status === 409
                  ? "Reader identity already registered"
                  : status === 401
                    ? "Access invalid, expired or revoked"
                    : "Request rejected",
        });
    },
  );
  return app;
}
