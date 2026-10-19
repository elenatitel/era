import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  APP_NAME: z.string().default('era.'),
  /** Public URL of the web app, used for CORS/Origin checks and links in e-mails. */
  WEB_ORIGIN: z.url().default('http://localhost:3000'),
  /** Application role: must NOT be a superuser or have BYPASSRLS. */
  DATABASE_URL: z.string().min(1),
  /** Owner role used for migrations; defaults to DATABASE_URL. */
  DATABASE_MIGRATION_URL: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  DATABASE_SSL: bool.default(false),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /** 32 random bytes, base64-encoded. Used for AES-256-GCM encryption of secrets and PII. */
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes base64-encoded'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_IDLE_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  SESSION_MAX_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  COOKIE_SECURE: bool.optional(),
  /** Number of reverse-proxy hops to trust for client IPs. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: bool.default(false),
  MAIL_FROM: z.string().default('era. <no-reply@localhost>'),
  PLATFORM_ADMIN_EMAIL: z.string().optional(),
  PLATFORM_ADMIN_PASSWORD: z.string().optional(),
  LOG_LEVEL: z.enum(['error', 'warn', 'log', 'debug', 'verbose']).default('log'),
});

export type Config = z.infer<typeof schema> & { isProduction: boolean; cookieSecure: boolean };

let cached: Config | undefined;

export function config(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const isProduction = parsed.data.NODE_ENV === 'production';
  if (isProduction && /change-me|example|secret/i.test(parsed.data.JWT_SECRET)) {
    throw new Error('JWT_SECRET looks like a placeholder; generate a random value for production');
  }
  cached = {
    ...parsed.data,
    isProduction,
    cookieSecure: parsed.data.COOKIE_SECURE ?? isProduction,
  };
  return cached;
}

/** Test hook. */
export function resetConfig() {
  cached = undefined;
}
