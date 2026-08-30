import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { PaymentModule } from './payment/payment.module.js';

/**
 * Root module. Feature modules map to bounded contexts — see docs/domain.md
 * for what each one owns and why the boundary falls where it does.
 */
@Module({
  imports: [AppConfigModule, HealthModule, InventoryModule, PaymentModule],
})
export class AppModule {}
