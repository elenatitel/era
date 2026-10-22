import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators.js';
import { DbService } from '../db/db.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Public()
  @SkipThrottle()
  @Get()
  async health() {
    try {
      await this.db.ping();
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ code: 'UNHEALTHY', message: 'Database unavailable' });
    }
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
