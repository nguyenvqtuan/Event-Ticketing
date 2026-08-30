import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service.js';
import { validateEnv } from './env.schema.js';

/**
 * Global so feature modules can inject `AppConfigService` without importing
 * this module every time. Configuration is a genuine cross-cutting concern —
 * one of the few things that earns `@Global()`.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      // `validate` runs at module init, before the server listens.
      validate: validateEnv,
      envFilePath: ['.env'],
      cache: true,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
