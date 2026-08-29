/**
 * Evaluated before anything else so that Nest's ESM packages are finished
 * loading by the time a suite links `@nestjs/terminus`, whose CommonJS build
 * `require()`s them. Jest's ESM runtime rejects `require()` of an ESM module
 * that is still being linked ("a cycle involving require(esm)"); real Node
 * evaluates the same graph without complaint, which is why this is confined
 * to the test harness rather than worked around in the application.
 */
import '@nestjs/common';
import '@nestjs/core';

/**
 * Runs before any test module is imported (jest `setupFiles`).
 *
 * This matters because `ConfigModule.forRoot({ validate })` executes when
 * `config.module.ts` is *imported*, not when the module is compiled — so any
 * suite that imports AppModule needs a valid environment already in place.
 * Setting it inside a `beforeAll` would be far too late.
 */
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/event_ticketing';
process.env.NODE_ENV ??= 'test';
