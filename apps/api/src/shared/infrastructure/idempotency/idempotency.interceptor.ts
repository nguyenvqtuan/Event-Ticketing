import { createHash } from 'node:crypto';
import {
  type CallHandler,
  ConflictException,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { type Request, type Response } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { firstValueFrom, of, type Observable } from 'rxjs';
import { DatabaseContext } from '../database/database.module.js';
import { idempotencyKeys } from '../database/schema.js';

const HEADER = 'idempotency-key';
const RETENTION_HOURS = 24;

/**
 * Request-level idempotency for unsafe endpoints.
 *
 * A client that retries after a timeout must not create a second event. The
 * seat-level `ON CONFLICT` in the repository already prevents duplicate SEATS,
 * but only this stops a duplicate *event* with a fresh id — the two mechanisms
 * cover different failures, which is why both exist.
 *
 * Flow:
 *   no key            → proceed unprotected (the header is opt-in)
 *   key, unseen       → reserve it, run, store the response
 *   key, same request → replay the stored response, do not re-execute
 *   key, different    → 409; the same key must not mean two different things
 *
 * The reservation INSERT is what makes this safe under concurrency: the
 * primary key on `key` means two simultaneous retries cannot both proceed.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly context: DatabaseContext) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const key = request.header(HEADER);

    if (!key) {
      return next.handle();
    }

    const requestHash = hashRequest(request);
    const db = this.context.rootDb;

    // Reserve the key. Losing this race means someone else got here first.
    const reserved = await db
      .insert(idempotencyKeys)
      .values({
        key,
        requestHash,
        expiresAt: new Date(Date.now() + RETENTION_HOURS * 3_600_000),
      })
      .onConflictDoNothing({ target: idempotencyKeys.key })
      .returning({ key: idempotencyKeys.key });

    if (reserved.length === 0) {
      return of(await this.replay(key, requestHash, http.getResponse<Response>()));
    }

    const body = await firstValueFrom(next.handle() as Observable<unknown>);

    await db
      .update(idempotencyKeys)
      .set({
        responseStatus: http.getResponse<Response>().statusCode,
        responseBody: body as Record<string, unknown>,
      })
      .where(eq(idempotencyKeys.key, key));

    return of(body);
  }

  /** Returns the stored response, or rejects a key reused for a different request. */
  private async replay(key: string, requestHash: string, response: Response): Promise<unknown> {
    const [existing] = await this.context.rootDb
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.key, key), sql`true`))
      .limit(1);

    if (!existing) {
      // Reserved then expired between the two statements. Vanishingly rare.
      throw new ConflictException(`Idempotency key ${key} is being processed; retry shortly`);
    }

    if (existing.requestHash !== requestHash) {
      throw new ConflictException(
        `Idempotency key ${key} was already used with a different request body`,
      );
    }

    if (existing.responseStatus === null || existing.responseBody === null) {
      // Key reserved but the original request has not finished (or crashed
      // mid-flight). Telling the client to retry is safer than running it again.
      throw new ConflictException(`Idempotency key ${key} is being processed; retry shortly`);
    }

    this.logger.log(`Replaying stored response for idempotency key ${key}`);
    response.status(existing.responseStatus);

    return existing.responseBody;
  }
}

/** Method + path + body, so the same key with a different request is detectable. */
function hashRequest(request: Request): string {
  return createHash('sha256')
    .update(`${request.method}\n${request.originalUrl}\n${JSON.stringify(request.body ?? {})}`)
    .digest('hex');
}
