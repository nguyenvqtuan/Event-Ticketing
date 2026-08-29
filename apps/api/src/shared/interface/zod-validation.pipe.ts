import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { type ZodType } from 'zod';

/**
 * Validates and parses a request payload against a Zod schema.
 *
 * Zod rather than class-validator so the codebase has one validation library
 * (config already uses it, see TICK-2) and the DTO type is inferred from the
 * schema with `z.infer` — the type and the check cannot drift apart.
 *
 * Returns the PARSED value, so coercions and defaults declared in the schema
 * reach the controller: `limit` arrives as a number, not the string Express
 * pulled off the query string.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        // Field-level detail: a caller should not have to guess which field
        // was wrong, and every problem is reported at once.
        errors: result.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      });
    }

    return result.data;
  }
}
