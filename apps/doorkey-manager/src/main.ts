import { z } from "zod";
import pg from "pg";
import { createManager } from "./app.js";
import { issuerKey } from "./crypto.js";
const c = z
  .object({
    DATABASE_URL: z.string().min(1),
    ISSUER_PRIVATE_KEY: z.string(),
    SERVICE_TOKEN: z.string().min(43),
    ERA_VALIDATION_URL: z.url(),
    PUBLIC_URL: z.url(),
    PORT: z.coerce.number().default(4001),
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
  })
  .parse(process.env);
if (!c.PUBLIC_URL.startsWith("https://"))
  throw new Error("PUBLIC_URL must use HTTPS");
const pool = new pg.Pool({
  connectionString: c.DATABASE_URL,
  max: 10,
  statement_timeout: 10000,
  idle_in_transaction_session_timeout: 15000,
});
const app = createManager({
  pool,
  issuer: issuerKey(c.ISSUER_PRIVATE_KEY),
  serviceToken: c.SERVICE_TOKEN,
  publicUrl: c.PUBLIC_URL.replace(/\/$/, ""),
  trustProxy: c.TRUST_PROXY,
  validate: async (stay) => {
    const r = await fetch(c.ERA_VALIDATION_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${c.SERVICE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(stay),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!r.ok)
      throw Object.assign(new Error("Stay unavailable"), {
        status: r.status === 401 ? 401 : 503,
      });
    return z
      .object({ validUntil: z.number().int().positive() })
      .parse(await r.json());
  },
});
const server = app.listen(c.PORT, () =>
  console.log(`DoorKey Manager listening on ${c.PORT}`),
);
for (const s of ["SIGINT", "SIGTERM"])
  process.on(s, () => {
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  });
