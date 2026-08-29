import { createHash } from 'node:crypto';
import {
  BadRequestException,
  type CallHandler,
  ConflictException,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Request, type Response } from 'express';
import { eq } from 'drizzle-orm';
import { firstValueFrom, of, type Observable } from 'rxjs';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '../../domain/transaction-runner.port.js';
import { DatabaseContext } from '../database/database.module.js';
import { isPostgresErrorWithCode, UNIQUE_VIOLATION } from '../database/postgres-error.js';
import { idempotencyKeys } from '../database/schema.js';
import { IDEMPOTENCY_REQUIRED } from './idempotency.decorator.js';

const HEADER = 'idempotency-key';
const RETENTION_HOURS = 24;

/**
 * Request-level idempotency, backed by `idempotency_keys`.
 *
 * A client that retries after a timeout must not charge twice, and must get
 * the original answer rather than a fresh one. Three properties make that
 * true, and all three matter:
 *
 * **1. The key row is written in the SAME transaction as the side effect.**
 * The handler's own `transaction.run()` joins this one (AsyncLocalStorage, see
 * DatabaseModule), so either both land or neither does. Storing the key in a
 * separate transaction leaves a window where the side effect committed but the
 * record of it did not — and the next retry runs it again.
 *
 * **2. A concurrent duplicate WAITS, then replays.** The insert is a plain
 * INSERT, not `ON CONFLICT DO NOTHING`: Postgres blocks a duplicate key until
 * the first transaction commits or aborts. The loser therefore does not guess
 * — it learns the outcome and returns the winner's stored response. If the
 * winner rolled back, the loser's insert succeeds and it becomes the winner.
 *
 * **3. The request is hashed.** Reusing a key with a different body is a
 * client bug, and returning the old response would hide it.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly context: DatabaseContext,
    private readonly reflector: Reflector,
    @Inject(TRANSACTION_RUNNER) private readonly transaction: TransactionRunner,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const key = request.header(HEADER);

    const required = this.reflector.getAllAndOverride<boolean>(IDEMPOTENCY_REQUIRED, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!key) {
      if (required) {
        throw new BadRequestException(`The ${HEADER} header is required for this endpoint`);
      }
      return next.handle();
    }

    const requestHash = hashRequest(request);

    try {
      const body = await this.transaction.run(async () => {
        // Plain insert: a concurrent duplicate blocks here until we commit or
        // abort, which is exactly the serialisation point we want.
        await this.context.db.insert(idempotencyKeys).values({
          key,
          requestHash,
          expiresAt: new Date(Date.now() + RETENTION_HOURS * 3_600_000),
        });

        // The side effect. Its own transaction.run() joins this one.
        const result = (await firstValueFrom(next.handle() as Observable<unknown>)) as unknown;

        await this.context.db
          .update(idempotencyKeys)
          .set({
            responseStatus: response.statusCode,
            responseBody: result as Record<string, unknown>,
          })
          .where(eq(idempotencyKeys.key, key));

        return result;
      });

      return of(body);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      // Someone else owns this key and has now committed. Replay their answer.
      return of(await this.replay(key, requestHash, response));
    }
  }

  private async replay(key: string, requestHash: string, response: Response): Promise<unknown> {
    const [stored] = await this.context.rootDb
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key))
      .limit(1);

    if (!stored) {
      // The holder rolled back and its row vanished between our conflict and
      // this read. Retrying is safe — nothing was committed.
      throw new ConflictException(`Idempotency key ${key} is unresolved; please retry`);
    }

    if (stored.requestHash !== requestHash) {
      throw new ConflictException(
        `Idempotency key ${key} was already used with a different request body`,
      );
    }

    if (stored.responseStatus === null) {
      // Row committed without a response: the side effect failed after the key
      // was written. Reusing the key would replay a result that never existed.
      throw new ConflictException(`Idempotency key ${key} did not complete; use a new key`);
    }

    this.logger.log(`Replaying stored response for idempotency key ${key}`);
    response.status(stored.responseStatus);

    return stored.responseBody;
  }
}

/** Method + path + body, so the same key with a different request is detectable. */
function hashRequest(request: Request): string {
  return createHash('sha256')
    .update(`${request.method}\n${request.originalUrl}\n${JSON.stringify(request.body ?? {})}`)
    .digest('hex');
}

/**
 * Drizzle wraps driver errors, so the SQLSTATE lives on `cause` rather than on
 * the error we catch. Checking the top level alone misses every duplicate key.
 */
function isUniqueViolation(error: unknown): boolean {
  return isPostgresErrorWithCode(error, UNIQUE_VIOLATION);
}
