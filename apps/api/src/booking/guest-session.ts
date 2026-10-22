import type { CookieOptions, Request, Response } from 'express';
import { jwtVerify, SignJWT } from 'jose';
import { config } from '../config.js';

/**
 * A short guest session proves the browser may change one booking: it is set right after the
 * guest books (they just paid), or after they enter the 6-digit code e-mailed to them.
 * It is scoped to the public API path and to a single guest link.
 */
export const GUEST_COOKIE = 'pms_guest';
const AUDIENCE = 'pms-guest';
const TTL_SECONDS = 2 * 60 * 60;

const key = () => new TextEncoder().encode(config().JWT_SECRET);

const cookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: config().cookieSecure,
  sameSite: 'strict',
  path: '/api/public',
  maxAge: TTL_SECONDS * 1000,
});

export async function setGuestSession(res: Response, guestLinkId: string) {
  const token = await new SignJWT({ typ: 'guest' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(guestLinkId)
    .setIssuer('pms-api')
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(key());
  res.cookie(GUEST_COOKIE, token, cookieOptions());
}

/** The guest link id this browser is verified for, or null. */
export async function guestSessionLinkId(req: Request): Promise<string | null> {
  const token = req.cookies?.[GUEST_COOKIE] as string | undefined;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { issuer: 'pms-api', audience: AUDIENCE, algorithms: ['HS256'] });
    return payload.typ === 'guest' && typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}
