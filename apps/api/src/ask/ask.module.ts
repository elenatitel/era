import { Controller, Get, HttpCode, Module, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { askSchema } from '@pms/shared';
import type { z } from 'zod';
import { Perms } from '../auth/decorators.js';
import { ZBody } from '../common/zod.js';
import { DashboardModule } from '../dashboard/dashboard.module.js';
import { ReservationsModule } from '../reservations/reservations.module.js';
import { AskService } from './ask.service.js';

@Controller('ask')
export class AskController {
  constructor(private readonly svc: AskService) {}

  @Get('status')
  @Perms('property.read')
  status() {
    return { enabled: this.svc.enabled };
  }

  @Post()
  @Perms('property.read')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  ask(@ZBody(askSchema) body: z.infer<typeof askSchema>) {
    return this.svc.ask(body);
  }
}

@Module({ imports: [DashboardModule, ReservationsModule], controllers: [AskController], providers: [AskService] })
export class AskModule {}
