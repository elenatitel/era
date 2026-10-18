import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthModule } from './auth/auth.module.js';
import { CsrfGuard } from './common/csrf.guard.js';
import { AllExceptionsFilter } from './common/http-exception.filter.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { DbModule } from './db/db.module.js';
import { FinanceModule } from './finance/finance.module.js';
import { GuestsModule } from './guests/guests.module.js';
import { HealthModule } from './health/health.module.js';
import { HousekeepingModule } from './housekeeping/housekeeping.module.js';
import { MailModule } from './mail/mail.service.js';
import { PlatformModule } from './platform/platform.module.js';
import { PropertiesModule } from './properties/properties.module.js';
import { ReservationsModule } from './reservations/reservations.module.js';
import { TenantModule } from './tenant/tenant.module.js';

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    DbModule,
    MailModule,
    AuthModule,
    PlatformModule,
    TenantModule,
    PropertiesModule,
    GuestsModule,
    ReservationsModule,
    FinanceModule,
    HousekeepingModule,
    DashboardModule,
    HealthModule,
  ],
  providers: [
    // Order matters: rate limit → CSRF → authentication/authorization.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
