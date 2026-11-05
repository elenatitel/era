import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DOORKEY_MANAGER_URL: z.url().optional(),
  DOORKEY_SERVICE_TOKEN: z.string().min(43).optional(),
  LEGACY_DOOR_ACCESS: bool.default(false),
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
  AUTH_PROVIDER: z.enum(['local', 'keycloak']).default('local'),
  OIDC_ISSUER: z.string().transform(v=>v.replace(/\/+$/, '')).optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_BOOTSTRAP_SUBJECT: z.string().optional(),
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
  /** Platform administrators must enable 2FA before using the platform. Disable only on test environments. */
  PLATFORM_ADMIN_REQUIRE_MFA: bool.default(true),
  /** Minutes an unpaid online booking holds its room. */
  BOOKING_HOLD_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
  /** Turns on AI summaries of guest profiles. Without it the feature stays off and nothing leaves the system. */
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-opus-5-5'),
  /** Testing only: send Claude API calls to a local fake. Ignored in production. */
  ANTHROPIC_API_BASE: z.url().optional(),
  /** Testing only: send Stripe API calls to a local fake (e.g. http://127.0.0.1:12111). Ignored in production. */
  STRIPE_API_BASE: z.url().optional(),
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
  if (parsed.data.AUTH_PROVIDER === 'keycloak') {
    const issuer = new URL(parsed.data.OIDC_ISSUER ?? 'invalid:');
    if ((issuer.protocol !== 'https:' && !(parsed.data.NODE_ENV === 'test' && issuer.protocol === 'http:')) || issuer.search || issuer.hash || issuer.username || !issuer.host
        || !parsed.data.OIDC_CLIENT_ID || !parsed.data.OIDC_CLIENT_SECRET) {
      throw new Error('Keycloak requires a fixed HTTPS issuer, client ID and client secret');
    }
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
