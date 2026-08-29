import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { type Response } from 'express';
import { DomainError, InvalidStateTransition, InvariantViolation } from '../domain/domain-error.js';
import { EventNotFound } from '../../inventory/application/get-event-overview.use-case.js';

/**
 * Translates domain errors into HTTP status codes.
 *
 * This mapping lives at the edge on purpose: the domain throws meaningful
 * errors and stays ignorant of HTTP, and this is the single place that decides
 * what each one means over the wire. Without it, every controller would repeat
 * try/catch blocks and drift.
 */
@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter<DomainError> {
  private readonly logger = new Logger(DomainErrorFilter.name);

  catch(error: DomainError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = this.statusFor(error);

    if (status >= 500) {
      this.logger.error(`Unmapped domain error: ${error.name}: ${error.message}`);
    }

    response.status(status).json({
      statusCode: status,
      error: error.name,
      message: error.message,
    });
  }

  private statusFor(error: DomainError): number {
    if (error instanceof EventNotFound) return HttpStatus.NOT_FOUND;

    // A caller asked for something the current state forbids — e.g. confirming
    // an expired reservation. 409 rather than 400: the request was well-formed,
    // it just conflicts with reality.
    if (error instanceof InvalidStateTransition) return HttpStatus.CONFLICT;

    // Input the domain refused. The request was malformed in a way the schema
    // could not catch, so it is still the caller's problem.
    if (error instanceof InvariantViolation) return HttpStatus.BAD_REQUEST;

    return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}
