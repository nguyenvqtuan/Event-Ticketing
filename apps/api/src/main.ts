import 'reflect-metadata';

import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type Logger as PinoLogger } from 'pino';

import { AppModule } from './app.module.js';
import { AppConfigService } from './config/app-config.service.js';
import { PinoLoggerService, PINO_INSTANCE } from './shared/infrastructure/logging/logging.module.js';

/** Signals an orchestrator uses to ask for a clean stop. */
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/**
 * Stops the app without dropping work in progress (TICK-19).
 *
 * `app.close()` runs Nest's full teardown in order: it marks the adapter as
 * shutting down (so in-flight responses carry `Connection: close` and clients
 * stop reusing sockets), calls `server.close()` — which refuses NEW connections
 * while letting the ones already being served finish — and only then runs
 * `onApplicationShutdown`, where `DatabaseContext` ends the pool. That ordering
 * matters: draining before the pool closes is what lets an in-flight request
 * finish its query rather than die on a closed connection.
 *
 * Nest's own `enableShutdownHooks()` is deliberately NOT used to listen for
 * signals. It re-raises the signal after teardown (`process.kill(pid, signal)`),
 * so the process dies BY SIGTERM — exit code 143, not 0 — and it has no
 * timeout, so a single stuck request would hang the container until the
 * platform SIGKILLs it. Calling `app.close()` here runs exactly the same
 * lifecycle hooks while leaving both of those decisions to us.
 */
function installShutdownHandlers(app: INestApplication, logger: PinoLoggerService): void {
  const { shutdownTimeoutMs } = app.get(AppConfigService);
  // The raw pino instance, not the Nest wrapper: `flush` is pino's own.
  const pino = app.get<PinoLogger>(PINO_INSTANCE);

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    // A second SIGTERM must not start a second teardown on top of the first.
    if (shuttingDown) {
      logger.warn(`${signal} received again — already shutting down`, 'Shutdown');
      return;
    }
    shuttingDown = true;

    logger.log(`${signal} received — draining in-flight requests`, 'Shutdown');

    // The deadline is the whole point: `server.close()` waits for in-flight
    // requests, and a request that never finishes would otherwise wait forever.
    // `unref` so a drain that completes early is not held open by this timer.
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      logger.error(
        `In-flight requests did not finish within ${shutdownTimeoutMs}ms — exiting anyway`,
        undefined,
        'Shutdown',
      );
      // Non-zero: work was abandoned. A clean drain is the 0 below, and the
      // two outcomes should not look the same to whatever collects exit codes.
      pino.flush();
      process.exit(1);
    }, shutdownTimeoutMs);
    deadline.unref();

    try {
      await app.close();
    } catch (error) {
      logger.error(`Shutdown failed: ${(error as Error).message}`, undefined, 'Shutdown');
      pino.flush();
      process.exit(1);
    }

    clearTimeout(deadline);
    if (timedOut) return;

    logger.log('Drained cleanly; connection pool closed', 'Shutdown');

    // pino buffers, and `process.exit` does not wait for pending writes. Flush
    // before exiting or the shutdown log lines are the ones that get lost.
    pino.flush();

    // Explicit 0: this was an orderly stop that a deployment asked for, and it
    // should not be reported as a failure.
    process.exit(0);
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => void shutdown(signal));
  }
}

async function bootstrap(): Promise<void> {
  // Buffer logs until the config is validated, so the logger can be
  // configured from it rather than guessing a level first.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const config = app.get(AppConfigService);
  const logger = app.get(PinoLoggerService);

  // Pino replaces Nest's default logger, so framework logs are JSON too and
  // carry the correlation ID like everything else.
  app.useLogger(logger);
  app.enableCors({ origin: config.corsOrigin });

  installShutdownHandlers(app, logger);

  await app.listen(config.port);

  logger.log(`API listening on http://localhost:${config.port} [${config.nodeEnv}]`, 'Bootstrap');
}

void bootstrap();
