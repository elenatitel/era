import { Controller, Get, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { AuditService } from '../db/audit.service.js';
import { AuthService } from './auth.service.js';
import { Public } from './decorators.js';
import { KeycloakService } from './keycloak.service.js';

@Public()
@Controller('auth/oidc')
export class OidcController {
  constructor(
    private readonly keycloak: KeycloakService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}
  private enabled(res: Response) {
    if (config().AUTH_PROVIDER !== 'keycloak') {
      res.status(404).json({ error: { code: 'NOT_FOUND' } });
      return false;
    }
    res.setHeader('Referrer-Policy', 'no-referrer');
    return true;
  }
  @Get('login')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async login(@Req() req: Request, @Res() res: Response) {
    if (!this.enabled(res)) return;
    const invite = typeof req.query.invite === 'string' && /^[A-Za-z0-9_-]{30,100}$/.test(req.query.invite) ? req.query.invite : undefined;
    try {
      return res.redirect(302, await this.keycloak.login(res, req.query.reauth === 'true', invite));
    } catch {
      return res.redirect(303, `${config().WEB_ORIGIN}/login?error=oidc_unavailable`);
    }
  }
  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response) {
    if (!this.enabled(res)) return;
    this.keycloak.clearFlow(res);
    try {
      const { identity, provider, invite } = await this.keycloak.exchange(req);
      const user = invite ? await this.auth.acceptOidcInvitation(invite, identity) : await this.keycloak.mappedUser(identity);
      if (!user) {
        await this.audit.security('oidc_access_denied');
        return res.redirect(303, `${config().WEB_ORIGIN}/login?error=access_denied`);
      }
      const memberships = await this.auth.listTenants(user.id);
      if (!user.isPlatformAdmin && !memberships.some((m) => m.status === 'active'))
        return res.redirect(303, `${config().WEB_ORIGIN}/login?error=access_denied`);
      const session = await this.auth.completeLogin(res, user, provider);
      const target = session.tenantSelected
        ? '/dashboard'
        : user.isPlatformAdmin && !memberships.length
          ? '/platform'
          : '/select-organization';
      return res.redirect(303, config().WEB_ORIGIN + target);
    } catch (error) {
      await this.audit.security('oidc_login_failed');
      return res.redirect(303, `${config().WEB_ORIGIN}/login?error=oidc_failed`);
    }
  }
  @Get('logged-out')
  loggedOut(@Req() req: Request, @Res() res: Response) {
    if (!this.enabled(res)) return;
    this.keycloak.clearFlow(res);
    try {
      this.keycloak.loggedOut(req);
      res.redirect(303, `${config().WEB_ORIGIN}/login`);
    } catch {
      res.redirect(303, `${config().WEB_ORIGIN}/login?error=logout_failed`);
    }
  }
}
