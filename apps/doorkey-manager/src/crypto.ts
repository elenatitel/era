import {
  ECDH,
  createECDH,
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
export const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest();
export const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export function publicKey(hex: string): KeyObject {
  if (!/^04[0-9a-f]{128}$/i.test(hex))
    throw new Error("Invalid P-256 public key");
  const raw = Buffer.from(hex, "hex");
  // OpenSSL validates that the point belongs to this curve.
  const key = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
  ECDH.convertKey(raw, "prime256v1");
  return key;
}
export function issuerKey(hex: string): KeyObject {
  if (!/^[0-9a-f]{64}$/i.test(hex))
    throw new Error(
      "Issuer must be a P-256 private scalar (64 hex characters)",
    );
  const ec = createECDH("prime256v1");
  ec.setPrivateKey(Buffer.from(hex, "hex"));
  const raw = ec.getPublicKey();
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: Buffer.from(hex, "hex").toString("base64url"),
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
}
export function rawPublic(key: KeyObject) {
  const jwk = createPublicKey(key).export({ format: "jwk" });
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from(jwk.y!, "base64url"),
  ]);
}
export const signature = (key: KeyObject, message: Buffer) =>
  sign("sha256", message, { key, dsaEncoding: "ieee-p1363" });
export function verifies(
  key: KeyObject,
  message: Buffer,
  signatureHex: string,
) {
  return (
    /^[0-9a-f]{128}$/i.test(signatureHex) &&
    verify(
      "sha256",
      message,
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signatureHex, "hex"),
    )
  );
}
export function doorBytes(id: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(id);
  return b;
}
export function permit(
  key: KeyObject,
  door: number,
  phone: Buffer,
  from: number,
  until: number,
) {
  const head = Buffer.alloc(21);
  head[0] = 1;
  head.writeUInt32LE(door, 1);
  head.writeBigUInt64LE(BigInt(from), 5);
  head.writeBigUInt64LE(BigInt(until), 13);
  const payload = Buffer.concat([head, phone]);
  return Buffer.concat([payload, signature(key, payload)]);
}
/** V2 binds the approval to ONE permit: a valid guest cannot lend time proofs to a revoked phone. */
export function approval(
  key: KeyObject,
  door: number,
  nonce: Buffer,
  now: number,
  permitHash: Buffer,
) {
  const stamp = Buffer.alloc(8);
  stamp.writeBigUInt64LE(BigInt(now));
  return Buffer.concat([
    stamp,
    signature(
      key,
      Buffer.concat([
        Buffer.from("DoorKey-time-v2"),
        doorBytes(door),
        nonce,
        stamp,
        permitHash,
      ]),
    ),
  ]);
}
