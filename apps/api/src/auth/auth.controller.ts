import { Controller, Get, HttpCode, Param, Post, Patch, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  acceptInvitationSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  mfaDisableSchema,
  mfaEnableSchema,
  mfaLoginSchema,
  resetPasswordSchema,
  switchTenantSchema,
  updateProfileSchema,
} from '@pms/shared';
import { ctx } from '../common/context.js';
import { ZBody } from '../common/zod.js';
import { AuthService } from './auth.service.js';
import { Public } from './decorators.js';
import { CSRF_COOKIE, REFRESH_COOKIE, TokensService } from './tokens.service.js';

const STRICT = { default: { limit: 10, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokensService,
  ) {}

  /** Issues the CSRF cookie; the web app calls this on load. */
  @Public()
  @Get('csrf')
  csrf(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const existing = req.cookies?.[CSRF_COOKIE] as string | undefined;
    return { csrfToken: existing ?? this.tokens.setCsrfCookie(res) };
  }

  @Public()
  @Throttle(STRICT)
  @Post('login')
  @HttpCode(200)
  login(@ZBody(loginSchema) body: { email: string; password: string }, @Res({ passthrough: true }) res: Response) {
    return this.auth.login(res, body.email, body.password);
  }

  @Public()
  @Throttle(STRICT)
  @Post('login/mfa')
  @HttpCode(200)
  loginMfa(@ZBody(mfaLoginSchema) body: { mfaToken: string; code: string }, @Res({ passthrough: true }) res: Response) {
    return this.auth.loginWithMfa(res, body.mfaToken, body.code);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(204)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.tokens.refresh(res, req.cookies?.[REFRESH_COOKIE] as string | undefined);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Res({ passthrough: true }) res: Response) {
    await this.tokens.revokeSession(ctx().sessionId!);
    this.tokens.clearCookies(res);
  }

  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(@Res({ passthrough: true }) res: Response) {
    await this.tokens.revokeAllForUser(ctx().userId!, 'logout_all');
    this.tokens.clearCookies(res);
  }

  @Get('me')
  me() {
    return this.auth.me();
  }

  @Patch('me')
  @HttpCode(204)
  updateProfile(@ZBody(updateProfileSchema) body: { name?: string; locale?: 'ro' | 'en' }) {
    return this.auth.updateProfile(body);
  }

  @Post('switch-tenant')
  @HttpCode(204)
  switchTenant(@ZBody(switchTenantSchema) body: { tenantId: string }, @Res({ passthrough: true }) res: Response) {
    return this.auth.switchTenant(res, body.tenantId);
  }

  @Throttle(STRICT)
  @Post('password/change')
  @HttpCode(204)
  changePassword(@ZBody(changePasswordSchema) body: { currentPassword: string; newPassword: string }) {
    return this.auth.changePassword(body.currentPassword, body.newPassword);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('password/forgot')
  @HttpCode(202)
  async forgotPassword(@ZBody(forgotPasswordSchema) body: { email: string }) {
    await this.auth.forgotPassword(body.email);
    return { ok: true };
  }

  @Public()
  @Throttle(STRICT)
  @Post('password/reset')
  @HttpCode(204)
  resetPassword(@ZBody(resetPasswordSchema) body: { token: string; password: string }) {
    return this.auth.resetPassword(body.token, body.password);
  }

  @Public()
  @Throttle(STRICT)
  @Get('invitations/:token')
  describeInvitation(@Param('token') token: string) {
    return this.auth.describeInvitation(token);
  }

  @Public()
  @Throttle(STRICT)
  @Post('invitations/accept')
  @HttpCode(200)
  acceptInvitation(@ZBody(acceptInvitationSchema) body: { token: string; name?: string; password?: string }) {
    return this.auth.acceptInvitation(body.token, body.name, body.password);
  }

  @Post('mfa/setup')
  @HttpCode(200)
  mfaSetup() {
    return this.auth.mfaSetup();
  }

  @Throttle(STRICT)
  @Post('mfa/enable')
  @HttpCode(200)
  mfaEnable(@ZBody(mfaEnableSchema) body: { code: string }) {
    return this.auth.mfaEnable(body.code);
  }

  @Throttle(STRICT)
  @Post('mfa/disable')
  @HttpCode(204)
  mfaDisable(@ZBody(mfaDisableSchema) body: { password: string; code: string }) {
    return this.auth.mfaDisable(body.password, body.code);
  }
}
