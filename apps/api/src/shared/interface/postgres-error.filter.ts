import { type ArgumentsHost, Catch, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { type Response } from 'express';

/** Postgres SQLSTATEs this application treats as caller-visible conflicts. */
const EXCLUSION_VIOLATION = '23P01';
const UNIQUE_VIOLATION = '23505';

interface PostgresError extends Error {
  code?: string;
  constraint?: string;
}

const isConflict = (error: unknown): error is PostgresError =>
  error instanceof Error &&
  ((error as PostgresError).code === EXCLUSION_VIOLATION ||
    (error as PostgresError).code === UNIQUE_VIOLATION);

/**
 * Backstop for the double-booking constraint.
 *
 * The hold path takes `FOR UPDATE` first, so in normal operation a conflict is
 * detected before any write and this filter never fires. It exists for the
 * case that matters: a writer that did NOT take the lock — a future code path,
 * a migration, a psql session — hitting the exclusion constraint instead.
 * Without it, that surfaces as a 500 and looks like a bug in the service
 * rather than the database correctly refusing a double booking.
 *
 * Extends `BaseExceptionFilter` rather than rethrowing. A catch-all filter
 * that rethrows breaks Nest's handling chain: the status survives but the
 * response body is lost, which silently stripped the field-level errors from
 * every validation 400 until it was fixed.
 */
@Catch()
export class PostgresErrorFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(PostgresErrorFilter.name);

  override catch(error: unknown, host: ArgumentsHost): void {
    if (!isConflict(error)) {
      // Everything else keeps Nest's default handling, bodies intact.
      super.catch(error, host);
      return;
    }

    // Worth a warning: reaching here means the lock was bypassed, so the
    // constraint did work the application should have done first.
    this.logger.warn(
      `Constraint ${error.constraint ?? '(unknown)'} rejected a write (${error.code}) — ` +
        'the exclusion constraint caught a conflict the lock did not',
    );

    host.switchToHttp().getResponse<Response>().status(HttpStatus.CONFLICT).json({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      message: 'One or more seats are no longer available',
    });
  }
}
