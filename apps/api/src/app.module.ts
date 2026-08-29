import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { PaymentModule } from './payment/payment.module.js';
import { DatabaseModule } from './shared/infrastructure/database/database.module.js';
import { LoggingModule } from './shared/infrastructure/logging/logging.module.js';
import { DomainErrorFilter } from './shared/interface/domain-error.filter.js';
import { PostgresErrorFilter } from './shared/interface/postgres-error.filter.js';

/**
 * Root module. Feature modules map to bounded contexts — see docs/domain.md
 * for what each one owns and why the boundary falls where it does.
 */
@Module({
  imports: [
    // First, so its middleware wraps every request.
    LoggingModule,
    ScheduleModule.forRoot(),
    AppConfigModule,
    DatabaseModule,
    HealthModule,
    InventoryModule,
    PaymentModule,
  ],
  providers: [
    // Order matters: Nest applies global filters last-registered-first, so
    // the Postgres backstop is declared first and the more specific domain
    // filter wins for DomainError.
    { provide: APP_FILTER, useClass: PostgresErrorFilter },
    // Registered globally so every controller maps domain errors to status
    // codes the same way, instead of repeating try/catch.
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
})
export class AppModule {}
