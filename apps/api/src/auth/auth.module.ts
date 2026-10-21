import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TokensService } from './tokens.service.js';

@Module({
  controllers: [AuthController],
  providers: [AuthService, TokensService],
  exports: [AuthService, TokensService],
})
export class AuthModule {}
