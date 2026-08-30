import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';

/**
 * Root module. Feature modules map to bounded contexts — TICK-4 adds
 * `InventoryModule` and `PaymentModule` alongside `HealthModule`.
 */
@Module({
  imports: [HealthModule],
})
export class AppModule {}
