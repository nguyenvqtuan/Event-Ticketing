import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { AppConfigService } from './config/app-config.service.js';
import { PinoLoggerService } from './shared/infrastructure/logging/logging.module.js';

async function bootstrap(): Promise<void> {
  // Buffer logs until the config is validated, so the logger can be
  // configured from it rather than guessing a level first.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const config = app.get(AppConfigService);

  // Pino replaces Nest's default logger, so framework logs are JSON too and
  // carry the correlation ID like everything else.
  app.useLogger(app.get(PinoLoggerService));
  app.enableCors({ origin: config.corsOrigin });
  app.enableShutdownHooks();

  await app.listen(config.port);

  app
    .get(PinoLoggerService)
    .log(`API listening on http://localhost:${config.port} [${config.nodeEnv}]`, 'Bootstrap');
}

void bootstrap();
