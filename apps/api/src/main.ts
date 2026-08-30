import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

// TICK-2 replaces these reads with a validated, typed ConfigService.
const DEFAULT_PORT = 3000;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  await app.listen(port);

  console.log(`API listening on http://localhost:${port}`);
}

void bootstrap();
