import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { AppConfigService } from './config/app-config.service.js';
import { LOG_LEVELS } from './config/log-levels.js';

async function bootstrap(): Promise<void> {
  // Buffer logs until the config is validated, so the logger can be
  // configured from it rather than guessing a level first.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const config = app.get(AppConfigService);

  app.useLogger(LOG_LEVELS[config.logLevel]);
  app.enableCors({ origin: config.corsOrigin });
  app.enableShutdownHooks();

  await app.listen(config.port);

  new Logger('Bootstrap').log(
    `API listening on http://localhost:${config.port} [${config.nodeEnv}]`,
  );
}

void bootstrap();
