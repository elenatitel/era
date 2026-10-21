import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SKIP_CSRF } from '../auth/decorators.js';
import type { Request } from 'express';
import { ERROR_CODES } from '@pms/shared';
import { config } from '../config.js';
import { safeEqual } from './crypto.js';
import { CSRF_COOKIE } from '../auth/tokens.service.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence in depth on top of SameSite=Strict cookies:
 *  1. Origin (or Referer) of state-changing requests must be the web app origin.
 *  2. Double-submit token: X-CSRF-Token header must equal the pms_csrf cookie.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE.has(req.method)) return true;
    if (this.reflector.getAllAndOverride<boolean>(SKIP_CSRF, [context.getHandler(), context.getClass()])) return true;
    const origin = req.headers.origin ?? refererOrigin(req.headers.referer);
    if (origin && origin !== config().WEB_ORIGIN) {
      throw new ForbiddenException({ code: ERROR_CODES.CSRF, message: 'Cross-origin request blocked' });
    }
    const cookie = req.cookies?.[CSRF_COOKIE] as string | undefined;
    const header = req.headers['x-csrf-token'];
    if (!cookie || typeof header !== 'string' || !safeEqual(cookie, header)) {
      throw new ForbiddenException({ code: ERROR_CODES.CSRF, message: 'Missing or invalid CSRF token' });
    }
    return true;
  }
}

function refererOrigin(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return 'invalid';
  }
}
