import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { Request, Response } from 'express';
import * as oidc from 'openid-client';
import { config } from '../config.js';
import { decrypt, encrypt, randomToken, safeEqual } from '../common/crypto.js';
import { DbService } from '../db/db.service.js';
import { oidcSessions, sessions, users } from '../db/schema.js';

export interface ProviderIdentity {
  iss: string;
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  amr?: string[];
}
export interface ProviderSession {
  issuer: string;
  subject: string;
  refreshTokenEnc: string;
  idTokenEnc: string;
  providerExpiresAt: Date;
  mfaVerified: boolean;
}
interface Flow {
  state: string;
  verifier?: string;
  nonce?: string;
  invite?: string;
  expires: number;
  kind: 'login' | 'logout';
}
const FLOW_COOKIE = 'era_oidc_flow';
const FLOW_PATH = '/api/auth/oidc';

@Injectable()
export class KeycloakService {
  private configuration?: Promise<oidc.Configuration>;
  constructor(private readonly db: DbService) {}

  client() {
    this.configuration ??= oidc
      .discovery(
        new URL(config().OIDC_ISSUER!),
        config().OIDC_CLIENT_ID!,
        { client_secret: config().OIDC_CLIENT_SECRET!, id_token_signed_response_alg: 'RS256' },
        oidc.ClientSecretBasic(config().OIDC_CLIENT_SECRET!),
        { timeout: 10, execute: [oidc.enableNonRepudiationChecks, ...(config().NODE_ENV === 'test' ? [oidc.allowInsecureRequests] : [])] },
      )
      .catch((error) => {
        this.configuration = undefined;
        throw error;
      });
    return this.configuration;
  }

  private cookie() {
    return { httpOnly: true, secure: config().cookieSecure, sameSite: 'lax' as const, path: FLOW_PATH, maxAge: 300_000 };
  }
  private writeFlow(res: Response, flow: Flow) {
    res.cookie(FLOW_COOKIE, encrypt(JSON.stringify(flow)), this.cookie());
  }
  clearFlow(res: Response) {
    res.clearCookie(FLOW_COOKIE, this.cookie());
  }
  private readFlow(req: Request, kind: Flow['kind']): Flow {
    try {
      const flow = JSON.parse(decrypt(req.cookies?.[FLOW_COOKIE] ?? '')) as Flow;
      if (flow.kind !== kind || !Number.isFinite(flow.expires) || flow.expires < Date.now() || !flow.state) throw new Error('expired');
      return flow;
    } catch {
      throw new UnauthorizedException({ code: 'OIDC_FAILED', message: 'Sign-in attempt expired; please try again' });
    }
  }
  callbackUrl() {
    return `${config().WEB_ORIGIN}/api/auth/oidc/callback`;
  }
  accountUrl() {
    return `${config().OIDC_ISSUER}/account/?referrer=${encodeURIComponent(config().OIDC_CLIENT_ID!)}&referrer_uri=${encodeURIComponent(config().WEB_ORIGIN)}`;
  }

  async login(res: Response, reauthenticate: boolean, invite?: string) {
    const client = await this.client();
    const verifier = oidc.randomPKCECodeVerifier(),
      nonce = oidc.randomNonce(),
      state = oidc.randomState();
    this.writeFlow(res, { state, verifier, nonce, invite, expires: Date.now() + 300_000, kind: 'login' });
    return oidc.buildAuthorizationUrl(client, {
      redirect_uri: this.callbackUrl(),
      scope: 'openid profile email',
      code_challenge_method: 'S256',
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      state,
      nonce,
      ...(reauthenticate ? { prompt: 'login' } : {}),
    }).href;
  }

  async exchange(req: Request) {
    const flow = this.readFlow(req, 'login');
    const url = new URL(this.callbackUrl());
    // Fixed origin/path; never trust proxy Host or an arbitrary callback URL.
    url.search = new URL(req.originalUrl, config().WEB_ORIGIN).search;
    const token = await oidc.authorizationCodeGrant(await this.client(), url, {
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      pkceCodeVerifier: flow.verifier,
      idTokenExpected: true,
    });
    const identity = token.claims() as unknown as ProviderIdentity;
    this.identity(identity);
    const provider = this.provider(token, identity);
    return { identity, provider, invite: flow.invite };
  }

  private identity(identity: ProviderIdentity | undefined) {
    if (!identity || identity.iss !== config().OIDC_ISSUER || !identity.sub) throw new Error('Invalid identity');
  }
  private provider(token: Awaited<ReturnType<typeof oidc.refreshTokenGrant>>, identity: ProviderIdentity): ProviderSession {
    if (!token.refresh_token || !token.id_token || !Number.isFinite(token.expires_in)) throw new Error('Missing provider session');
    const methods = Array.isArray(identity.amr) ? identity.amr : [];
    return {
      issuer: identity.iss,
      subject: identity.sub,
      refreshTokenEnc: encrypt(token.refresh_token),
      idTokenEnc: encrypt(token.id_token),
      providerExpiresAt: new Date(Date.now() + Math.max(1, Math.min(token.expires_in!, 300)) * 1000),
      // Configured authenticator references, from a verified ID token, not user
      // attributes, enrollment flags, roles, or a client-supplied boolean.
      mfaVerified: methods.includes('pwd') && methods.includes('otp'),
    };
  }

  async mappedUser(identity: ProviderIdentity) {
    return (
      await this.db.db
        .select()
        .from(users)
        .where(and(eq(users.oidcIssuer, identity.iss), eq(users.oidcSubject, identity.sub)))
    )[0];
  }

  async validate(familyId: string, userId: string): Promise<boolean> {
    // Persist rotating provider tokens in their own transaction even when the
    // subsequent application operation is denied. Serialize across replicas.
    const result = await this.db.db.transaction(async (tx) => {
      const [provider] = await tx.select().from(oidcSessions).where(eq(oidcSessions.familyId, familyId)).for('update');
      const [user] = await tx.select().from(users).where(eq(users.id, userId));
      let invalid =
        !provider ||
        !user ||
        provider.userId !== userId ||
        provider.expiresAt <= new Date() ||
        provider.issuer !== config().OIDC_ISSUER ||
        user.oidcIssuer !== provider.issuer ||
        user.oidcSubject !== provider.subject;
      let mfa = provider?.mfaVerified ?? false;
      if (!invalid && provider!.providerExpiresAt <= new Date()) {
        try {
          const token = await oidc.refreshTokenGrant(await this.client(), decrypt(provider!.refreshTokenEnc));
          const identity = token.claims() as unknown as ProviderIdentity;
          this.identity(identity);
          if (identity.sub !== provider!.subject) throw new Error('Identity changed');
          const next = this.provider(token, identity);
          await tx.update(oidcSessions).set(next).where(eq(oidcSessions.familyId, familyId));
          mfa = next.mfaVerified;
        } catch (error) {
          if (error instanceof oidc.ResponseBodyError && error.error === 'invalid_grant') invalid = true;
          else if (
            (error instanceof oidc.ResponseBodyError &&
              (error.status >= 500 || ['server_error', 'temporarily_unavailable', 'invalid_client'].includes(error.error))) ||
            error instanceof TypeError ||
            (error instanceof oidc.ClientError &&
              (['OAUTH_TIMEOUT', 'OAUTH_ABORT'].includes(error.code ?? '') ||
                error.cause instanceof TypeError ||
                (error.cause instanceof Response && error.cause.status >= 500))) ||
            (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
          )
            throw new ServiceUnavailableException({ code: 'IDP_UNAVAILABLE', message: 'Sign-in service unavailable; try again' });
          else invalid = true;
        }
      }
      if (invalid) {
        await tx
          .update(sessions)
          .set({ revokedAt: new Date(), revokedReason: 'provider_revoked' })
          .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)));
        if (provider) await tx.delete(oidcSessions).where(eq(oidcSessions.familyId, familyId));
        return null;
      }
      return mfa;
    });
    if (result === null) throw new UnauthorizedException({ code: 'SESSION_REVOKED', message: 'Sign in with Keycloak again' });
    return result;
  }

  async logout(res: Response, familyId: string) {
    const [provider] = await this.db.db.select().from(oidcSessions).where(eq(oidcSessions.familyId, familyId));
    const state = randomToken(32);
    try {
      const url = oidc.buildEndSessionUrl(await this.client(), {
        client_id: config().OIDC_CLIENT_ID!,
        post_logout_redirect_uri: `${config().WEB_ORIGIN}/api/auth/oidc/logged-out`,
        state,
        ...(provider ? { id_token_hint: decrypt(provider.idTokenEnc) } : {}),
      });
      this.writeFlow(res, { state, kind: 'logout', expires: Date.now() + 300_000 });
      return url.href;
    } catch {
      return null;
    } finally {
      await this.db.db.delete(oidcSessions).where(eq(oidcSessions.familyId, familyId));
    }
  }
  loggedOut(req: Request) {
    const flow = this.readFlow(req, 'logout');
    if (typeof req.query.state !== 'string' || !safeEqual(flow.state, req.query.state)) throw new Error('Invalid logout state');
  }
}
