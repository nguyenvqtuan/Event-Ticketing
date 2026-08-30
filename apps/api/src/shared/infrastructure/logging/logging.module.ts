import { randomUUID } from 'node:crypto';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import {
  Global,
  Inject,
  Injectable,
  type LoggerService,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { CORRELATION_HEADER } from '@repo/contracts';
import pino, { type Logger as PinoLogger } from 'pino';
// Named import: pino-http's default does not resolve as callable under
// NodeNext module resolution, though the named export does.
import { pinoHttp } from 'pino-http';
import { AppConfigModule } from '../../../config/config.module.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { getCorrelationId, runWithCorrelationId } from './correlation.store.js';

/**
 * Accepted inbound correlation headers, in order of preference. The canonical
 * one comes from `@repo/contracts`, so the API and its clients cannot spell it
 * differently — a mismatch would not error, it would silently lose the trace.
 */
const CORRELATION_HEADERS = [CORRELATION_HEADER, 'x-request-id'] as const;

/** Injection token for the shared pino instance, so tests can redirect it. */
export const PINO_INSTANCE = Symbol('PINO_INSTANCE');

/**
 * Maps this app's LOG_LEVEL vocabulary onto pino's.
 *
 * `log` is Nest's name for what pino calls `info`; without this mapping a
 * perfectly valid LOG_LEVEL=log would silence pino entirely.
 */
const PINO_LEVELS: Record<string, pino.Level> = {
  error: 'error',
  warn: 'warn',
  log: 'info',
  debug: 'debug',
  verbose: 'trace',
};

/**
 * Builds the shared pino instance.
 *
 * `nestjs-pino` is the usual choice and the ticket names it, but it ships
 * CommonJS and `require()`s `@nestjs/common`, which is ESM-only from NestJS 12
 * — `require(esm)` inside a cycle is illegal, so it fails at import. Its peer
 * range (`^8 || ... || ^11`) says as much. pino and pino-http are used
 * directly instead; the glue below is the part nestjs-pino would have
 * provided.
 */
export function createPinoLogger(level: string, destination?: pino.DestinationStream): PinoLogger {
  return pino(
    {
      level: PINO_LEVELS[level] ?? 'info',

      // Runs for EVERY log line from any logger instance, which is what makes
      // a log emitted deep below the controller carry the correlation ID
      // without anyone threading it down.
      mixin: () => {
        const correlationId = getCorrelationId();
        return correlationId ? { correlationId } : {};
      },

      // Belt and braces. Bodies are not serialised at all (see below), so
      // this only matters if someone later logs an object deliberately.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          '*.cardNumber',
          '*.cvv',
          '*.password',
        ],
        remove: true,
      },
    },
    destination,
  );
}

/**
 * Bridges Nest's `Logger` onto pino, so `new Logger(Foo.name).log(...)`
 * anywhere in the app produces structured JSON with the correlation ID.
 */
@Injectable()
export class PinoLoggerService implements LoggerService {
  constructor(private readonly logger: PinoLogger) {}

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, String(message));
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }

  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }

  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
}

@Global()
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: PINO_INSTANCE,
      inject: [AppConfigService],
      // Level comes from LOG_LEVEL (TICK-2), so verbosity is deployment
      // configuration rather than a code change.
      useFactory: (config: AppConfigService) => createPinoLogger(config.logLevel),
    },
    {
      provide: PinoLoggerService,
      inject: [PINO_INSTANCE],
      useFactory: (logger: PinoLogger) => new PinoLoggerService(logger),
    },
  ],
  exports: [PINO_INSTANCE, PinoLoggerService],
})
export class LoggingModule implements NestModule {
  // Injected here rather than in AppModule: PINO_INSTANCE is this module's own
  // provider, so it is guaranteed resolvable at module-construction time.
  constructor(@Inject(PINO_INSTANCE) private readonly logger: PinoLogger) {}

  configure(consumer: MiddlewareConsumer): void {
    // Order matters. The correlation middleware runs FIRST so everything after
    // it — the request logger, guards, interceptors, controllers and every
    // repository below them — executes inside the correlation context.
    consumer
      .apply(correlationIdMiddleware, createHttpLoggerMiddleware(this.logger))
      // '{*path}' rather than '*': Express 5 / path-to-regexp v8, which
      // NestJS 11+ uses, no longer accepts a bare wildcard and silently
      // matches nothing — the middleware simply never runs.
      .forRoutes('{*path}');
  }
}

/**
 * Binds the correlation ID to the async context for the whole request.
 *
 * Registered before anything else, so guards, interceptors, controllers and
 * every repository below them run inside it.
 */
export function correlationIdMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  const inbound = CORRELATION_HEADERS.map((name) => req.headers[name]).find(Boolean);
  // Take the caller's id when offered so a trace spans services; otherwise
  // mint one, so every request is traceable whether or not a client helps.
  const correlationId = (Array.isArray(inbound) ? inbound[0] : inbound) ?? randomUUID();

  // Echo it back so a client can quote it in a bug report.
  res.setHeader(CORRELATION_HEADER, correlationId);

  runWithCorrelationId(correlationId, next);
}

/**
 * Request/response logging: one line per request with path, status, latency.
 *
 * Only an allow-list of fields is serialised — **the body is never logged**.
 * That is the safe default rather than a redaction list someone must remember
 * to extend when an endpoint starts accepting card details.
 */
export function createHttpLoggerMiddleware(logger: PinoLogger) {
  return pinoHttp({
    logger,
    customAttributeKeys: { responseTime: 'latencyMs' },
    customProps: (req: IncomingMessage) => ({
      path: (req as { originalUrl?: string; url?: string }).originalUrl ?? req.url,
    }),
    serializers: {
      req: (req: { method: string; url: string; headers: Record<string, unknown> }) => ({
        method: req.method,
        path: req.url,
        // The AC permits logging the idempotency key, and it is the single
        // most useful field when tracing a retry.
        idempotencyKey: req.headers['idempotency-key'],
      }),
      res: (res: { statusCode: number }) => ({ status: res.statusCode }),
    },
    // Health checks would otherwise dominate the log at one line every ten
    // seconds per container.
    autoLogging: {
      ignore: (req: IncomingMessage) => {
        const url = (req as { originalUrl?: string; url?: string }).originalUrl ?? req.url;
        return url === '/healthz' || url === '/readyz';
      },
    },
  });
}
