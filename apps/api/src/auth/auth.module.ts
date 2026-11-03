import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TokensService } from './tokens.service.js';

import { KeycloakService } from './keycloak.service.js';
import { OidcController } from './oidc.controller.js';

@Module({
  controllers: [AuthController, OidcController],
  providers: [AuthService, TokensService, KeycloakService],
  exports: [AuthService, TokensService, KeycloakService],
})
export class AuthModule {}
