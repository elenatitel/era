import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { and, eq } from 'drizzle-orm';
import { startDatabase } from './harness.js';
import type { DbService } from '../src/db/db.service.js';
import { memberships, oidcSessions, roles, sessions, tenants, users } from '../src/db/schema.js';

let db: Awaited<ReturnType<typeof startDatabase>>, app: INestApplication, store: DbService, server: Server;
let issuer: string, base: string, tenantId: string, signingKey: CryptoKey, wrongKey: CryptoKey, jwk: object;
let overrides: Record<string, unknown> = {},
  badSignature = false,
  outage = false,
  revoked = false,
  tokenCalls = 0;
const codes = new Map<string, { subject: string; nonce: string; challenge: string }>();
const refreshes = new Map<string, string>();
const subjects = { frontdesk: randomUUID(), owner: randomUUID(), housekeeper: randomUUID() };
const ids: Record<string, string> = {};

class Browser {
  cookies = new Map<string, string>();
  async request(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + '/api' + path, {
      method,
      redirect: 'manual',
      headers: {
        origin: base,
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'x-csrf-token': this.cookies.get('pms_csrf') ?? '' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]!,
        index = pair.indexOf('='),
        name = pair.slice(0, index),
        value = pair.slice(index + 1);
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
  async init() {
    await this.request('/auth/csrf');
    return this;
  }
}
async function begin(browser: Browser, subject = subjects.frontdesk, query = '') {
  const response = await browser.request('/auth/oidc/login' + query);
  assert.equal(response.status, 302);
  const url = new URL(response.headers.get('location')!);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.has('client_secret'), false);
  const code = randomUUID();
  codes.set(code, { subject, nonce: url.searchParams.get('nonce')!, challenge: url.searchParams.get('code_challenge')! });
  return { code, state: url.searchParams.get('state')! };
}
async function finish(browser: Browser, params: { code: string; state: string }) {
  return browser.request('/auth/oidc/callback?' + new URLSearchParams(params));
}
async function login(subject = subjects.frontdesk) {
  const browser = await new Browser().init();
  const response = await finish(browser, await begin(browser, subject));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), base + '/dashboard');
  return browser;
}
async function forceRefresh(browser: Browser) {
  const jwt = decodeJwt(browser.cookies.get('pms_at')!);
  const [session] = await store.db
    .select()
    .from(sessions)
    .where(eq(sessions.id, jwt.sid as string));
  await store.db
    .update(oidcSessions)
    .set({ providerExpiresAt: new Date(1) })
    .where(eq(oidcSessions.familyId, session!.familyId));
  return session!;
}

before(async () => {
  const legitimate = await generateKeyPair('RS256', { extractable: true });
  signingKey = legitimate.privateKey;
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  wrongKey = privateKey;
  // jwk must correspond to the legitimate signing key.
  jwk = { ...(await exportJWK(legitimate.publicKey)), kid: 'provider-key', use: 'sig', alg: 'RS256' };
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://provider');
      res.setHeader('content-type', 'application/json');
      if (url.pathname.endsWith('/.well-known/openid-configuration'))
        return void res.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: issuer + '/authorize',
            token_endpoint: issuer + '/token',
            jwks_uri: issuer + '/jwks',
            end_session_endpoint: issuer + '/logout',
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            token_endpoint_auth_methods_supported: ['client_secret_basic'],
          }),
        );
      if (url.pathname.endsWith('/jwks')) return void res.end(JSON.stringify({ keys: [jwk] }));
      if (!url.pathname.endsWith('/token')) {
        res.statusCode = 404;
        return void res.end('{}');
      }
      tokenCalls++;
      if (outage) {
        res.statusCode = 503;
        return void res.end(JSON.stringify({ error: 'temporarily_unavailable' }));
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const data = new URLSearchParams(raw);
      assert.deepEqual(Buffer.from(req.headers.authorization!.slice(6), 'base64').toString().split(':').map(decodeURIComponent), [
        'era-test',
        'test-client-secret',
      ]);
      let subject: string, nonce: string | undefined;
      if (data.get('grant_type') === 'authorization_code') {
        const code = codes.get(data.get('code')!);
        codes.delete(data.get('code')!);
        if (!code) {
          res.statusCode = 400;
          return void res.end('{"error":"invalid_grant"}');
        }
        assert.equal(createHash('sha256').update(data.get('code_verifier')!).digest('base64url'), code.challenge);
        assert.equal(data.get('redirect_uri'), base + '/api/auth/oidc/callback');
        subject = code.subject;
        nonce = code.nonce;
      } else {
        assert.equal(data.get('grant_type'), 'refresh_token');
        const found = refreshes.get(data.get('refresh_token')!);
        if (revoked || !found) {
          res.statusCode = 400;
          return void res.end('{"error":"invalid_grant"}');
        }
        refreshes.delete(data.get('refresh_token')!);
        subject = found;
      }
      const refresh = randomUUID();
      refreshes.set(refresh, subject);
      const now = Math.floor(Date.now() / 1000);
      const id_token = await new SignJWT({
        iss: issuer,
        sub: subject,
        aud: 'era-test',
        iat: now,
        exp: now + 300,
        nonce,
        email: 'frontdesk@demo.test',
        email_verified: true,
        name: 'OIDC Person',
        preferred_username: 'admin',
        realm_access: { roles: ['admin', 'owner'] },
        amr: ['pwd'],
        ...overrides,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'provider-key' })
        .sign(badSignature ? wrongKey : signingKey);
      res.end(
        JSON.stringify({ access_token: 'provider-access-token', refresh_token: refresh, id_token, token_type: 'Bearer', expires_in: 300 }),
      );
    } catch (error) {
      console.error('FAKE provider error', error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'server_error' }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}/realms/staging`;
  db = await startDatabase();
  const { runMigrations } = await import('../src/db/migrate.js');
  await runMigrations(db.ownerUrl, db.appUrl, fileURLToPath(new URL('../../drizzle', import.meta.url)));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    AUTH_PROVIDER: 'keycloak',
    DATABASE_URL: db.appUrl,
    JWT_SECRET: randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    WEB_ORIGIN: 'http://localhost:3000',
    COOKIE_SECURE: 'false',
    LOG_LEVEL: 'error',
    TRUST_PROXY: '0',
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: 'era-test',
    OIDC_CLIENT_SECRET: 'test-client-secret',
    PLATFORM_ADMIN_REQUIRE_MFA: 'true',
  });
  const { createApp } = await import('../src/bootstrap.js');
  const { DbService } = await import('../src/db/db.service.js');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  process.env.WEB_ORIGIN = base;
  (await import('../src/config.js')).resetConfig();
  store = app.get(DbService);
  await (await import('../src/db/seed.js')).seedDemo(store, 'Local-demo-password-123');
  for (const [name, subject] of Object.entries(subjects)) {
    const email = name === 'owner' ? 'owner@demo.test' : name === 'frontdesk' ? 'frontdesk@demo.test' : 'housekeeper@demo.test';
    const [user] = await store.db.update(users).set({ oidcIssuer: issuer, oidcSubject: subject }).where(eq(users.email, email)).returning();
    ids[name] = user!.id;
  }
  tenantId = (await store.db.select().from(tenants))[0]!.id;
});
after(async () => {
  await app?.close();
  await db?.stop();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});
beforeEach(() => {
  overrides = {};
  badSignature = false;
  outage = false;
  revoked = false;
});

test('real OIDC library verifies code/PKCE and keeps provider credentials server-side', async () => {
  const browser = await login();
  const me = await (await browser.request('/auth/me')).json();
  assert.equal(me.role.key, 'front_desk');
  assert.equal(me.user.authProvider, 'keycloak');
  assert.equal((await browser.request('/platform/tenants')).status, 403);
  assert.equal((await browser.request('/members')).status, 403);
  assert.ok(!JSON.stringify([...browser.cookies]).includes('provider-access-token'));
  const sid = decodeJwt(browser.cookies.get('pms_at')!).sid as string;
  const [session] = await store.db.select().from(sessions).where(eq(sessions.id, sid));
  const [provider] = await store.db.select().from(oidcSessions).where(eq(oidcSessions.familyId, session!.familyId));
  assert.ok(provider!.refreshTokenEnc.startsWith('v1.'));
  assert.ok(provider!.idTokenEnc.startsWith('v1.'));
});
test('unmapped verified email and claimed administrator role cannot claim existing access', async () => {
  const browser = await new Browser().init();
  const response = await finish(browser, await begin(browser, randomUUID()));
  assert.equal(response.headers.get('location'), base + '/login?error=access_denied');
  assert.equal(browser.cookies.has('pms_at'), false);
});
test('state mismatch fails before exchanging an authorization code', async () => {
  const browser = await new Browser().init(),
    params = await begin(browser),
    calls = tokenCalls;
  const response = await finish(browser, { ...params, state: 'wrong' });
  assert.equal(response.headers.get('location'), base + '/login?error=oidc_failed');
  assert.equal(tokenCalls, calls);
});
for (const [label, claims] of Object.entries({
  nonce: { nonce: 'wrong' },
  issuer: { iss: 'https://wrong.test' },
  audience: { aud: 'other-client' },
  expired: { exp: 1 },
}))
  test('rejects invalid ID token ' + label, async () => {
    const browser = await new Browser().init(),
      params = await begin(browser);
    overrides = claims;
    assert.equal((await finish(browser, params)).headers.get('location'), base + '/login?error=oidc_failed');
    assert.equal(browser.cookies.has('pms_at'), false);
  });
test('rejects a forged ID token signature against provider JWKS', async () => {
  const browser = await new Browser().init();
  badSignature = true;
  assert.equal((await finish(browser, await begin(browser))).headers.get('location'), base + '/login?error=oidc_failed');
  assert.equal(browser.cookies.has('pms_at'), false);
});
test('missing or tampered browser flow cookie fails closed', async () => {
  const browser = await new Browser().init(),
    params = await begin(browser);
  browser.cookies.set('era_oidc_flow', 'tampered');
  assert.equal((await finish(browser, params)).headers.get('location'), base + '/login?error=oidc_failed');
});
test('local password, recovery and MFA endpoints are disabled in Keycloak mode', async () => {
  const browser = await new Browser().init();
  for (const [path, body] of [
    ['/auth/login', { email: 'owner@demo.test', password: 'Local-demo-password-123' }],
    ['/auth/password/forgot', { email: 'owner@demo.test' }],
    ['/auth/login/mfa', { mfaToken: 'local-token', code: '123456' }],
  ]) {
    const response = await browser.request(path as string, 'POST', body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'KEYCLOAK_MANAGED');
  }
});
test('previous local application JWTs and refresh cookies cannot bypass Keycloak', async () => {
  const { TokensService } = await import('../src/auth/tokens.service.js');
  const tokens = app.get(TokensService);
  const response = { cookie: (name: string, value: string) => browser.cookies.set(name, value) };
  const browser = await new Browser().init();
  await tokens.createSession(response as never, ids.frontdesk!, tenantId);
  assert.equal((await browser.request('/auth/me')).status, 401);
  assert.equal((await browser.request('/auth/refresh', 'POST')).status, 401);
});
test('real provider refresh persists even when the subsequent authorization is denied', async () => {
  const browser = await login(),
    session = await forceRefresh(browser),
    calls = tokenCalls;
  assert.equal((await browser.request('/members')).status, 403);
  const [provider] = await store.db.select().from(oidcSessions).where(eq(oidcSessions.familyId, session.familyId));
  assert.ok(provider!.providerExpiresAt > new Date());
  assert.equal((await browser.request('/auth/me')).status, 200);
  assert.equal(tokenCalls, calls + 1);
});
test('provider outage fails closed with 503 and preserves the session for retry', async () => {
  const browser = await login(),
    session = await forceRefresh(browser);
  outage = true;
  assert.equal((await browser.request('/auth/me')).status, 503);
  assert.equal((await store.db.select().from(sessions).where(eq(sessions.id, session.id)))[0]!.revokedAt, null);
  outage = false;
  assert.equal((await browser.request('/auth/me')).status, 200);
});
test('revoked provider sessions immediately fail when revalidation is due', async () => {
  const browser = await login(),
    session = await forceRefresh(browser);
  revoked = true;
  assert.equal((await browser.request('/auth/me')).status, 401);
  assert.ok((await store.db.select().from(sessions).where(eq(sessions.id, session.id)))[0]!.revokedAt);
});
test('refresh cannot change the linked identity', async () => {
  const browser = await login();
  await forceRefresh(browser);
  overrides = { sub: randomUUID() };
  assert.equal((await browser.request('/auth/me')).status, 401);
});
test('MFA policy requires verified provider methods, never the legacy enrollment flag', async () => {
  await store.db.update(tenants).set({ requireMfa: true }).where(eq(tenants.id, tenantId));
  await store.db.update(users).set({ mfaEnabled: true }).where(eq(users.id, ids.frontdesk!));
  try {
    const browser = await new Browser().init();
    const response = await finish(browser, await begin(browser));
    assert.equal(response.headers.get('location'), base + '/select-organization');
    assert.equal((await browser.request('/guests')).status, 403);
    assert.equal((await browser.request('/auth/switch-tenant', 'POST', { tenantId })).status, 403);
    overrides = { amr: ['pwd', 'otp'] };
    const strong = await login();
    assert.equal((await strong.request('/guests')).status, 200);
  } finally {
    await store.db.update(tenants).set({ requireMfa: false }).where(eq(tenants.id, tenantId));
    await store.db.update(users).set({ mfaEnabled: false }).where(eq(users.id, ids.frontdesk!));
  }
});
test('logout revokes locally even with an expired access cookie and unavailable provider', async () => {
  const browser = await login(),
    sid = decodeJwt(browser.cookies.get('pms_at')!).sid as string;
  await forceRefresh(browser);
  browser.cookies.set('pms_at', 'expired');
  outage = true;
  const result = await browser.request('/auth/logout', 'POST');
  assert.equal(result.status, 200);
  assert.equal(browser.cookies.has('pms_at'), false);
  assert.ok((await store.db.select().from(sessions).where(eq(sessions.id, sid)))[0]!.revokedAt);
  const body = await result.json();
  if (body.logoutUrl) {
    const state = new URL(body.logoutUrl).searchParams.get('state')!;
    assert.equal((await browser.request('/auth/oidc/logged-out?state=' + state)).headers.get('location'), base + '/login');
  }
});
test('guest booking routes remain independent of staff sign-in', async () => {
  const browser = new Browser();
  assert.equal((await browser.request('/public/sites/not-a-real-hotel')).status, 404);
});
test('OIDC invitation requires verified matching email and never links an existing email implicitly', async () => {
  const owner = await login(subjects.owner);
  const roleRows = await (await owner.request('/roles')).json();
  const role = roleRows.find((r: any) => r.key === 'front_desk');
  const invite = await owner.request('/invitations', 'POST', { email: 'invitee@example.test', roleId: role.id, propertyIds: [] });
  assert.equal(invite.status, 201);
  const { MailService } = await import('../src/mail/mail.service.js');
  const message = app.get(MailService).outbox.at(-1)!;
  const token = /\/invite\/([\w-]+)/.exec(message.text)![1]!;
  const subject = randomUUID();
  const browser = await new Browser().init();
  overrides = { email: 'invitee@example.test', email_verified: false };
  assert.equal(
    (await finish(browser, await begin(browser, subject, '?invite=' + token))).headers.get('location'),
    base + '/login?error=oidc_failed',
  );
  overrides = { email: 'invitee@example.test', email_verified: true };
  assert.equal((await finish(browser, await begin(browser, subject, '?invite=' + token))).headers.get('location'), base + '/dashboard');
  assert.equal((await browser.request('/auth/me')).status, 200);
  assert.equal(
    (await finish(browser, await begin(browser, subject, '?invite=' + token))).headers.get('location'),
    base + '/login?error=oidc_failed',
  );
});

test('a verified invitation cannot bind an existing global account by email', async () => {
  const { randomToken, sha256 } = await import('../src/common/crypto.js');
  const { invitations } = await import('../src/db/schema.js');
  const { seedTenantRoles } = await import('../src/platform/platform.module.js');
  const [tenant] = await store.db.insert(tenants).values({ name: 'Invitation isolation', slug: 'invite-isolation' }).returning();
  const created = await store.tenant((tx) => seedTenantRoles(tx, tenant!.id), tenant!.id);
  const token = randomToken(32);
  await store.db
    .insert(invitations)
    .values({
      tenantId: tenant!.id,
      email: 'manager@demo.test',
      roleId: created.find((r) => r.key === 'front_desk')!.id,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + 60_000),
    });
  overrides = { email: 'manager@demo.test', email_verified: true };
  const browser = await new Browser().init();
  assert.equal(
    (await finish(browser, await begin(browser, randomUUID(), '?invite=' + token))).headers.get('location'),
    base + '/login?error=oidc_failed',
  );
  const [legacy] = await store.db.select().from(users).where(eq(users.email, 'manager@demo.test'));
  assert.equal(legacy!.oidcSubject, null);
  assert.equal(browser.cookies.has('pms_at'), false);
});
test('ERA platform administration requires its local flag and verified MFA', async () => {
  await store.db.update(users).set({ isPlatformAdmin: true, mfaEnabled: true }).where(eq(users.id, ids.owner!));
  try {
    const passwordOnly = await login(subjects.owner);
    assert.equal((await passwordOnly.request('/platform/tenants')).status, 403);
    overrides = { amr: ['pwd', 'otp'] };
    const strong = await login(subjects.owner);
    assert.equal((await strong.request('/platform/tenants')).status, 200);
  } finally {
    await store.db.update(users).set({ isPlatformAdmin: false, mfaEnabled: false }).where(eq(users.id, ids.owner!));
  }
});
test('logout callback rejects forged state while keeping the local session revoked', async () => {
  const browser = await login();
  assert.equal((await browser.request('/auth/logout', 'POST')).status, 200);
  assert.equal((await browser.request('/auth/oidc/logged-out?state=forged')).headers.get('location'), base + '/login?error=logout_failed');
  assert.equal((await browser.request('/auth/me')).status, 401);
});
